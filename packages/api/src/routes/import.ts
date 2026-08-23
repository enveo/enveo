import {
  type Account,
  aiLocaleSchema,
  type Category,
  type ChatRequest,
  type Envelope,
  type ImportHistoryRecord,
  type ImportRecognitionResult,
  runImportRecognitionPipeline,
  type Transaction,
} from "@enveo/shared";
import { and, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { aiBudgetExhaustedBody, meteredOperatorChat, operatorChatPayload, SpendDenied } from "../aiSpend/transport";
import { requireTier, sessionUserId } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import { env } from "../env";
import { transportFailureJson, UpstreamHttpError } from "../openaiHttp";
import { assertBudgetFks } from "../sync/apply";
import { buildDupIndex, classifyDup } from "./import-dedupe";
import { budgetAssertionFails } from "./sync";

/**
 * Expense import from screenshots (Apple Wallet / bank history).
 *
 * Two steps (with /import/extract retained as the compatibility wire):
 *  1. POST /import/recognize — screenshots → OpenAI (structured output) → evidence and proposals for review.
 *  2. POST /import/apply — dry-run duplicate classification for client review.
 *     Writes were retired: current clients create through their local replica.
 */
export const importRoutes = new Hono();

const importImagesInput = z.object({
  images: z
    .array(z.string().regex(/^data:image\//, "expected an image data-URL"))
    .min(1)
    .max(6),
  /* Any BCP-47 tag (the UI ships ten languages since 2.2.0). Omitted → English, the language
     the app itself is written in; every current client sends its UI language explicitly. */
  locale: aiLocaleSchema.optional(),
});
export const legacyExtractInput = importImagesInput;
export const recognizeInput = importImagesInput.extend({ accountId: z.string().uuid() });

/* ── Cycle 1: vision — only facts from the screenshot; prompt+schema+parsing in shared/aiPrompts ── */

/** Loads normalized ledger history without making an assignment decision. */
export async function loadImportHistory(budgetId: string, currency: string): Promise<ImportHistoryRecord[]> {
  const [txns, envs, cats, plcs] = await Promise.all([
    db
      .select({
        accountId: s.transactions.accountId,
        name: s.transactions.name,
        envelopeId: s.transactions.envelopeId,
        categoryId: s.transactions.categoryId,
        placeId: s.transactions.placeId,
        tag: s.transactions.tag,
        sourceRef: s.transactions.sourceRef,
        type: s.transactions.type,
        isRefund: s.transactions.isRefund,
        toAccountId: s.transactions.toAccountId,
      })
      .from(s.transactions)
      .where(eq(s.transactions.budgetId, budgetId)),
    db.select().from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId)),
    db.select().from(s.categories).where(eq(s.categories.budgetId, budgetId)),
    db.select().from(s.places).where(eq(s.places.budgetId, budgetId)),
  ]);
  const envName = new Map(envs.map((e) => [e.id, e.name]));
  const catName = new Map(cats.map((x) => [x.id, x.name]));
  const plcName = new Map(plcs.map((x) => [x.id, x.name]));

  return txns.map((transaction) => ({
    accountId: transaction.accountId,
    currency,
    sourceRef: transaction.sourceRef,
    tag: transaction.tag,
    place: transaction.placeId ? (plcName.get(transaction.placeId) ?? null) : null,
    name: transaction.name,
    envelope: transaction.envelopeId ? (envName.get(transaction.envelopeId) ?? null) : null,
    category: transaction.categoryId ? (catName.get(transaction.categoryId) ?? null) : null,
    type: transaction.type as ImportHistoryRecord["type"],
    isRefund: transaction.type === "expense" && transaction.isRefund,
    toAccountId: transaction.type === "transfer" ? transaction.toAccountId : null,
  }));
}

/** `timeoutMs` per cycle: vision (cycle 1) gets AI_VISION_TIMEOUT_MS — multi-screenshot
 *  extraction is legitimately slow and AI-only (no fallback to hide a premature cut);
 *  the enrichment chat (cycle 2) stays on the default chat cap. Each call is ONE metered
 *  attempt (backlog §1): cycle 1 and cycle 2 are checked/recorded separately, so a cycle-1
 *  charge that exhausts the allowance denies cycle 2 (SpendDenied → the caller's fallback). */
async function openaiJson(req: ChatRequest, userId: string | undefined, timeoutMs?: number): Promise<string> {
  const out = await meteredOperatorChat({ userId, payload: operatorChatPayload(req), timeoutMs });
  if (out.kind === "denied") throw new SpendDenied(out.retryAfterSeconds);
  if (out.kind === "upstream_error") {
    console.error("openai:", out.status, out.detail.slice(0, 500));
    throw new UpstreamHttpError(out.status);
  }
  if (out.kind === "invalid_body") throw new Error("openai: unreadable 2xx body");
  return out.content || "{}";
}

export type ImportModelChat = (request: ChatRequest, timeoutMs?: number) => Promise<string>;

export class ImportCycleOneFailure extends Error {
  constructor(readonly reason: unknown) {
    super("import_cycle_one_failed");
  }
}

export interface ServerImportRecognitionAdapterInput {
  images: string[];
  locale: string;
  today: string;
  budgetCurrency: string;
  accountId: string;
  accountRows: Array<Omit<Account, "type"> & { type: string }>;
  envelopeRows: Envelope[];
  categoryRows: Category[];
  transactionRows: Array<Omit<Transaction, "type" | "items"> & { type: string }>;
  historyRecords: ImportHistoryRecord[];
  chat: ImportModelChat;
}

/** Production server boundary: normalize database row types, then enter the
 * provider-neutral recognition pipeline used by unlocked E2EE clients too. */
export function runServerImportRecognitionAdapter(input: ServerImportRecognitionAdapterInput) {
  const accounts: Account[] = input.accountRows.map((account) => ({ ...account, type: account.type as Account["type"] }));
  const transactions: Transaction[] = input.transactionRows.map((transaction) => ({
    ...transaction,
    type: transaction.type as Transaction["type"],
    items: [],
  }));
  return runImportRecognitionPipeline({
    images: input.images,
    locale: input.locale,
    today: input.today,
    budgetCurrency: input.budgetCurrency,
    accountId: input.accountId,
    accounts,
    envelopes: input.envelopeRows,
    categories: input.categoryRows,
    transactions,
    historyRecords: input.historyRecords,
    chat: input.chat,
  });
}

/** Shared operator/BYOK import pipeline. Prompt construction and both parsing cycles stay in
 * one place; only the request-scoped model transport differs. */
export async function extractImportForBudget(input: { budgetId: string; accountId: string; images: string[]; locale: string; chat: ImportModelChat }) {
  const { budgetId, accountId, images, locale, chat } = input;
  const today = new Date().toISOString().slice(0, 10);
  const [[budgetRow], accountRows, envelopeRows, categoryRows, transactionRows] = await Promise.all([
    db.select({ currency: s.budgets.currency }).from(s.budgets).where(eq(s.budgets.id, budgetId)),
    db.select().from(s.accounts).where(eq(s.accounts.budgetId, budgetId)),
    db.select().from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId)),
    db.select().from(s.categories).where(eq(s.categories.budgetId, budgetId)),
    db.select().from(s.transactions).where(eq(s.transactions.budgetId, budgetId)),
  ]);
  const currency = budgetRow?.currency ?? "EUR";
  const historyRecords = await loadImportHistory(budgetId, currency);
  try {
    return await runServerImportRecognitionAdapter({
      images,
      locale,
      today,
      budgetCurrency: currency,
      accountId,
      accountRows,
      envelopeRows,
      categoryRows,
      transactionRows,
      historyRecords,
      chat,
    });
  } catch (reason) {
    throw new ImportCycleOneFailure(reason);
  }
}

/** Compatibility-window adapter: no account was present on the old wire, so no
 * ledger/history context is consulted. Only universally safe selected rows are
 * projected back into the old `{items}` response. This preserves the wire, not
 * the former assignment quality: a clear row that needs no cycle two may have a
 * blank generated name, so old clients must retain their raw-place fallback. */
export async function extractLegacyImportForBudget(input: { budgetId: string; images: string[]; locale: string; chat: ImportModelChat }) {
  const [budgetRow] = await db.select({ currency: s.budgets.currency }).from(s.budgets).where(eq(s.budgets.id, input.budgetId));
  const legacyAccount: Account = {
    id: "legacy-no-history",
    name: "Legacy import",
    color: "#000000",
    icon: "wallet",
    type: "checking",
    onBudget: true,
    initialBalance: 0,
    archived: false,
    sort: 0,
    automaticEnvelopeId: null,
  };
  try {
    return await runImportRecognitionPipeline({
      images: input.images,
      locale: input.locale,
      today: new Date().toISOString().slice(0, 10),
      budgetCurrency: budgetRow?.currency ?? "EUR",
      accountId: legacyAccount.id,
      accounts: [legacyAccount],
      envelopes: [],
      categories: [],
      transactions: [],
      historyRecords: [],
      chat: input.chat,
    });
  } catch (reason) {
    throw new ImportCycleOneFailure(reason);
  }
}

export function legacyItemsFromRecognition(result: ImportRecognitionResult) {
  const rowsById = new Map(result.rows.map((row) => [row.rowId, row]));
  return result.proposals.flatMap((proposal) => {
    if (
      !proposal.selected ||
      proposal.reviewReasons.length > 0 ||
      proposal.disposition !== "candidate" ||
      proposal.date === null ||
      proposal.amount === null ||
      proposal.type === null
    ) {
      return [];
    }
    const sourceRef = proposal.sourceRows
      .flatMap((rowId) => rowsById.get(rowId)?.rawTextLines ?? [])
      .join("\n")
      .trim();
    return [
      {
        date: proposal.date,
        amount: proposal.amount,
        type: proposal.type,
        isRefund: proposal.isRefund,
        toAccountId: proposal.toAccountId,
        name: proposal.name,
        tag: proposal.tag,
        rawPlace: sourceRef,
        envelopeId: proposal.envelopeId,
        envelopeName: null,
        categoryId: proposal.categoryId,
        categoryName: null,
        placeName: proposal.placeName,
        currency: proposal.currency ?? undefined,
        fxOriginal: "",
      },
    ];
  });
}

const importFailureResponse = (c: Context, error: unknown) => {
  if (!(error instanceof ImportCycleOneFailure)) throw error;
  const reason = error.reason;
  if (reason instanceof SpendDenied) return c.json(aiBudgetExhaustedBody(reason.retryAfterSeconds), 429, { "Retry-After": String(reason.retryAfterSeconds) });
  console.error("import recognition cycle 1 failed:", (reason as Error).message);
  const failure = transportFailureJson(reason);
  if (failure) return c.json(failure.body, failure.status);
  return c.json({ error: "ai_upstream_error", ...(reason instanceof UpstreamHttpError ? { status: reason.status } : {}) }, 502);
};

/* The API answers with stable machine CODES (never prose): the client owns the wording
   in every locale (web/lib/api.ts → i18n). Structured detail travels in its own field. */
importRoutes.post("/import/extract", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "ai_unavailable" }, 503);
  const budgetId = (await requireTier(c, "plain")).id;
  const { images, locale: rawLocale } = legacyExtractInput.parse(await c.req.json());
  const userId = sessionUserId(c);
  try {
    const result = await extractLegacyImportForBudget({
      budgetId,
      images,
      locale: rawLocale ?? "en",
      chat: (request, timeoutMs) => openaiJson(request, userId, timeoutMs),
    });
    return c.json({ items: legacyItemsFromRecognition(result) });
  } catch (error) {
    return importFailureResponse(c, error);
  }
});

importRoutes.post("/import/recognize", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "ai_unavailable" }, 503);
  const budgetId = (await requireTier(c, "plain")).id;
  const { accountId, images, locale: rawLocale } = recognizeInput.parse(await c.req.json());
  const userId = sessionUserId(c);
  try {
    return c.json(
      await extractImportForBudget({
        budgetId,
        accountId,
        images,
        locale: rawLocale ?? "en",
        chat: (request, timeoutMs) => openaiJson(request, userId, timeoutMs),
      }),
    );
  } catch (error) {
    return importFailureResponse(c, error);
  }
});

export const applyInput = z.object({
  accountId: z.string().uuid(),
  /** The budget the CLIENT believes it is writing to — the same PER-REQUEST tenant
   *  assertion as /sync/push (budgetAssertionFails): the server resolves the target
   *  budget from the session cookie alone, and the cookie can be swapped in another
   *  tab while the import sheet is open. Optional: a pre-fix client omits it. */
  budgetId: z.string().uuid().optional(),
  dryRun: z.boolean().optional(),
  items: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        amount: z.number().int().positive(),
        type: z.enum(["expense", "income", "transfer"]),
        name: z.string().default(""),
        tag: z.string(),
        rawPlace: z.string().nullable().optional(), // raw bank description → source_ref
        envelopeId: z.string().uuid().nullable(),
        categoryId: z.string().uuid().nullable().optional(),
        placeName: z.string().nullable().optional(),
        // ADDITIVE extension (editing an item before adding) — old clients
        // don't send these fields and get the previous behavior.
        accountId: z.string().uuid().optional(), // overrides the global account
        toAccountId: z.string().uuid().nullable().optional(), // required for transfer
        isRefund: z.boolean().optional(), // expense only; otherwise ignored
        note: z.string().max(2000).optional(),
        /* Deliberate add despite a sure duplicate (the user edited an
           "already exists" item in review) — skips classifyDup for this item. */
        force: z.boolean().optional(),
        /* PRESENTATION-ONLY (fx/refund review, ImportSheet): accepted so the round-trip of an
           item echoed back from screenshot recognition validates, but never stored — there is no
           `currency`/`fx_original` column on `transactions` (money is always the budget's
           currency; source_ref already carries what we persist about the raw row). */
        currency: z.string().optional(),
        fxOriginal: z.string().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export type ApplyItem = z.infer<typeof applyInput>["items"][number];

export interface ExistingImportEvidence {
  accountId: string;
  date: string;
  amount: number;
  sourceRef: string | null;
}

/** Pure account-scoped dry-run classifier shared by the route tests and handler. */
export function planImportDryRun(input: { globalAccountId: string; items: ApplyItem[]; existing: ExistingImportEvidence[] }) {
  const duplicateIndexes = new Map<string, ReturnType<typeof buildDupIndex>>();
  const duplicateIndexFor = (accountId: string) => {
    let index = duplicateIndexes.get(accountId);
    if (!index) {
      index = buildDupIndex(input.existing.filter((row) => row.accountId === accountId).map(({ date, amount, sourceRef }) => ({ date, amount, sourceRef })));
      duplicateIndexes.set(accountId, index);
    }
    return index;
  };
  let added = 0;
  let skipped = 0;
  const results: Array<ApplyItem & { status: "added" | "exists" | "probable" }> = [];
  for (const item of input.items) {
    const duplicateIndex = duplicateIndexFor(item.accountId ?? input.globalAccountId);
    const status = item.force ? "new" : classifyDup({ date: item.date, amount: item.amount, rawPlace: item.rawPlace }, duplicateIndex);
    if (status === "exists") {
      skipped++;
      results.push({ ...item, status });
      continue;
    }
    if (status === "probable") {
      results.push({ ...item, status });
      continue;
    }
    duplicateIndex.markSeen({ date: item.date, amount: item.amount, rawPlace: item.rawPlace });
    added++;
    results.push({ ...item, status: "added" });
  }
  return { added, skipped, dryRun: true as const, results };
}

/** Transfer validation error in a batch: a transfer without a target account
 *  or with a target account equal to the item's account. Null when all valid. */
export function findTransferError(items: ApplyItem[], globalAccountId: string): { error: "transfer_invalid"; index: number } | null {
  const index = items.findIndex((it) => it.type === "transfer" && (!it.toAccountId || it.toAccountId === (it.accountId ?? globalAccountId)));
  return index === -1 ? null : { error: "transfer_invalid", index };
}

importRoutes.post("/import/apply", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = applyInput.parse(await c.req.json());

  // PER-REQUEST tenant assertion BEFORE any write (same as /sync/push): the batch
  // creates FRESH transactions, which pass every FK guard — a cookie swapped in
  // another tab would land user A's extracted items in user B's budget. The client
  // names the budget it verified; a mismatch is refused and nothing is written.
  if (budgetAssertionFails(body.budgetId, budgetId)) {
    return c.json({ error: "budget_mismatch" }, 409);
  }
  if (body.dryRun !== true) return c.json({ error: "client_write_required" }, 410);

  // transfer validation BEFORE any write — whole-batch error with the item index
  const transferErr = findTransferError(body.items, body.accountId);
  if (transferErr) return c.json(transferErr, 400);

  // budget-scope guard BEFORE any write: every FK in the batch must belong to
  // the caller's budget (cross-tenant ids → ScopeViolation → 400 foreign_ref)
  for (const it of body.items) {
    await assertBudgetFks(db, budgetId, {
      accountId: it.accountId ?? body.accountId,
      toAccountId: it.toAccountId,
      envelopeId: it.envelopeId,
      categoryId: it.categoryId,
    });
  }

  const dates = [...new Set(body.items.map((i) => i.date))];
  const existing = await db
    .select({ accountId: s.transactions.accountId, date: s.transactions.date, amount: s.transactions.amount, sourceRef: s.transactions.sourceRef })
    .from(s.transactions)
    .where(and(eq(s.transactions.budgetId, budgetId), inArray(s.transactions.date, dates)));
  return c.json(planImportDryRun({ globalAccountId: body.accountId, items: body.items, existing }));
});

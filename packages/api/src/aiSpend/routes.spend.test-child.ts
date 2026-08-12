/**
 * Child process for the DB-backed spend ROUTE coverage in routes.spend.test.ts — NOT a test
 * file itself (bun's runner only picks up *.test.ts).
 *
 * Exercises the REAL route handlers (Hono sub-apps + real requireTier + the REAL Postgres
 * counter) with only the upstream fetch stubbed via `operatorAiDeps.fetchChat`; nothing here
 * ever contacts OpenAI. Runs as a child for the same pooled-db-pinning reason as the other
 * `*.test-child.ts` drivers, and additionally because the spend policy reads `env` frozen at
 * import: the child sets DEPLOYMENT=cloud + an operator key + a PRICED model in process.env
 * BEFORE the lazy imports, which no in-process test could do.
 */
import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__AI_SPEND_ROUTES_CHILD__";

export type SpendRoutesChildOutput = {
  proxyOk: {
    status: number;
    /** The 1:1 proxy forwards the upstream JSON with usage intact. */
    usagePreserved: boolean;
    /** The REAL counter recorded exactly the usage-derived nano-USD. */
    chargedExactCost: boolean;
    checks: number;
    records: number;
  };
  proxyDenied: {
    status: number;
    body: { error?: string; retryAfterSeconds?: number };
    retryAfterHeaderMatchesBody: boolean;
    retryAfterIsPositiveInt: boolean;
    /** No upstream request was made for a denied attempt. */
    upstreamNotCalled: boolean;
    /** …and nothing was recorded. */
    records: number;
  };
  deprecatedChatDenied: { status: number; error: string | undefined; hasRetryAfterHeader: boolean };
  deprecatedChatOk: { status: number; content: string | undefined; charged: boolean };
  suggestDenied: {
    status: number;
    source: string | undefined;
    warnsAiUnavailable: boolean;
    /** Denied suggest = local rules; the model is never fetched. */
    upstreamNotCalled: boolean;
  };
  importDeniedBeforeCycle1: { status: number; error: string | undefined; hasRetryAfterHeader: boolean; upstreamNotCalled: boolean };
  importCycle2Denied: {
    status: number;
    /** Raw extracted items came back through the graceful fallback. */
    itemCount: number;
    firstItemTag: string | undefined;
    /** Exactly one upstream call (cycle 1); the denied cycle 2 never fetched. */
    upstreamCalls: number;
    /** Two independent checks, one record (cycle 1 charged, cycle 2 denied). */
    checks: number;
    records: number;
  };
};

async function main() {
  // BEFORE any app import: the spend policy and the operator model are frozen into `env`.
  process.env.DEPLOYMENT = "cloud";
  process.env.OPENAI_API_KEY = "sk-test-never-used-upstream-is-stubbed";
  process.env.OPENAI_MODEL = "gpt-5.6-luna";

  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);
  const { db, sql: pooled } = await import("../db/client");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const s = await import("../db/schema");
  const { Hono } = await import("hono");
  const { budgetSuggestRoutes } = await import("../routes/budgetSuggest");
  const { importRoutes } = await import("../routes/import");
  const { operatorAiDeps } = await import("./transport");
  const { checkSpend, recordSpend, SPEND_POLICY, spendThresholdNanoUsd } = await import("./counter");

  await migrate(drizzle(pooled, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

  const THRESHOLD = spendThresholdNanoUsd(SPEND_POLICY.operatorAi);
  if (!operatorAiDeps.meteringActive()) throw new Error("expected metering active under DEPLOYMENT=cloud + operator key");

  /* real counter adapters, instrumented */
  const counters = { checks: 0, records: 0 };
  operatorAiDeps.checkSpend = async (i) => {
    counters.checks++;
    return checkSpend(i);
  };
  operatorAiDeps.recordSpend = async (i) => {
    counters.records++;
    return recordSpend(i);
  };

  /* scripted upstream (never the network) */
  let upstreamCalls = 0;
  let script: Array<Record<string, unknown>> = [];
  operatorAiDeps.fetchChat = async () => {
    upstreamCalls++;
    const body = script.shift();
    if (!body) throw new Error("upstream stub exhausted");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_stub" } });
  };

  const USAGE = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
  const COST = 1000n * 200n + 100n * 1_200n; // 320_000 nanoUsd at Luna rates
  const chatBody = (content: string) => ({ model: "gpt-5.6-luna", choices: [{ message: { role: "assistant", content } }], usage: USAGE });

  const newUser = async (tag: string) => {
    const [u] = await db
      .insert(s.users)
      .values({ email: `spend-routes-${tag}-${crypto.randomUUID()}@test.local` })
      .returning({ id: s.users.id });
    const [b] = await db.insert(s.budgets).values({ userId: u!.id, name: "B" }).returning({ id: s.budgets.id });
    return { userId: u!.id, budgetId: b!.id };
  };
  const spentOf = async (userId: string): Promise<bigint> => {
    const rows = await pooled<{ spent: string }[]>`
      select spent_nano_usd::text as spent from ai_user_monthly_spend where user_id = ${userId}
      order by period_key desc limit 1`;
    return BigInt(rows[0]?.spent ?? "-1");
  };
  const exhaust = async (userId: string) => {
    const check = await checkSpend({ policy: SPEND_POLICY.operatorAi, userId }); // lazy row
    await pooled`update ai_user_monthly_spend set spent_nano_usd = ${THRESHOLD.toString()}::bigint
      where user_id = ${userId} and period_key = ${check.periodKey}`;
  };

  const appFor = (userId: string) => {
    const app = new Hono<{ Variables: { userId?: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", userId);
      await next();
    });
    app.route("/", budgetSuggestRoutes);
    app.route("/", importRoutes);
    return app;
  };
  const post = (app: ReturnType<typeof appFor>, path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const ACC = "11111111-1111-1111-1111-111111111111";
  const GRP = "22222222-2222-2222-2222-222222222222";
  const ENV1 = "33333333-3333-3333-3333-333333333333";
  const ledgerFixture = {
    accounts: [{ id: ACC, name: "K", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 1000_00, archived: false, sort: 0 }],
    budgets: [],
    groups: [{ id: GRP, name: "G", sort: 0 }],
    envelopes: [
      { id: ENV1, groupId: GRP, name: "Food", color: "#fff", icon: "tag", note: null, sort: 0, archived: false, monthlyTarget: null, isSavings: false },
    ],
    categories: [],
    places: [],
    allocations: [],
    transactions: [],
  };

  /* ── 1. proxy success: forwarded JSON + exact charge ── */
  const u1 = await newUser("proxy-ok");
  const app1 = appFor(u1.userId);
  script = [chatBody("hello")];
  const c0 = { ...counters };
  const res1 = await post(app1, "/ai/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
  const res1json = (await res1.json()) as { usage?: unknown };
  const proxyOk: SpendRoutesChildOutput["proxyOk"] = {
    status: res1.status,
    usagePreserved: JSON.stringify(res1json.usage) === JSON.stringify(USAGE),
    chargedExactCost: (await spentOf(u1.userId)) === COST,
    checks: counters.checks - c0.checks,
    records: counters.records - c0.records,
  };

  /* ── 2. proxy denial: stable 429 + Retry-After, no upstream call ── */
  const u2 = await newUser("proxy-denied");
  await exhaust(u2.userId);
  const app2 = appFor(u2.userId);
  const callsBefore = upstreamCalls;
  const recBefore = counters.records;
  const res2 = await post(app2, "/ai/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
  const body2 = (await res2.json()) as { error?: string; retryAfterSeconds?: number };
  const proxyDenied: SpendRoutesChildOutput["proxyDenied"] = {
    status: res2.status,
    body: body2,
    retryAfterHeaderMatchesBody: res2.headers.get("retry-after") === String(body2.retryAfterSeconds),
    retryAfterIsPositiveInt: Number.isSafeInteger(body2.retryAfterSeconds) && (body2.retryAfterSeconds ?? 0) >= 1,
    upstreamNotCalled: upstreamCalls === callsBefore,
    records: counters.records - recBefore,
  };

  /* ── 3. deprecated /ai/chat: same denial contract; then a success ── */
  const res3 = await post(app2, "/ai/chat", { messages: [{ role: "user", content: "hi" }] });
  const body3 = (await res3.json()) as { error?: string };
  const deprecatedChatDenied = { status: res3.status, error: body3.error, hasRetryAfterHeader: res3.headers.get("retry-after") !== null };

  const u3 = await newUser("chat-ok");
  const app3 = appFor(u3.userId);
  script = [chatBody("plain answer")];
  const res4 = await post(app3, "/ai/chat", { messages: [{ role: "user", content: "hi" }] });
  const body4 = (await res4.json()) as { content?: string };
  const deprecatedChatOk = { status: res4.status, content: body4.content, charged: (await spentOf(u3.userId)) === COST };

  /* ── 4. suggest denial → local rules fallback, no upstream call ── */
  const u4 = await newUser("suggest-denied");
  await exhaust(u4.userId);
  const app4 = appFor(u4.userId);
  const before4 = upstreamCalls;
  const res5 = await post(app4, "/budget/suggest", { month: "2026-08", profile: "historical", useAi: true, ledger: ledgerFixture });
  const body5 = (await res5.json()) as { source?: string; warnings?: string[] };
  const suggestDenied = {
    status: res5.status,
    source: body5.source,
    warnsAiUnavailable: (body5.warnings ?? []).includes("warn.aiUnavailable"),
    upstreamNotCalled: upstreamCalls === before4,
  };

  /* ── 5. import denied before cycle 1 → 429 (AI-only, nothing to fall back to) ── */
  const u5 = await newUser("import-denied");
  await exhaust(u5.userId);
  const app5 = appFor(u5.userId);
  const before5 = upstreamCalls;
  const res6 = await post(app5, "/import/extract", { images: ["data:image/png;base64,AAAA"], locale: "en" });
  const body6 = (await res6.json()) as { error?: string };
  const importDeniedBeforeCycle1 = {
    status: res6.status,
    error: body6.error,
    hasRetryAfterHeader: res6.headers.get("retry-after") !== null,
    upstreamNotCalled: upstreamCalls === before5,
  };

  /* ── 6. cycle-1 charge exhausts the allowance → cycle 2 denied → RAW items fallback ── */
  const u6 = await newUser("import-c2");
  const app6 = appFor(u6.userId);
  const check6 = await checkSpend({ policy: SPEND_POLICY.operatorAi, userId: u6.userId });
  // one nano-USD of headroom: cycle 1 is admitted, its recorded cost crosses the threshold
  await pooled`update ai_user_monthly_spend set spent_nano_usd = ${(THRESHOLD - 1n).toString()}::bigint
    where user_id = ${u6.userId} and period_key = ${check6.periodKey}`;
  const visionItems = {
    transactions: [
      { date: "2026-08-01", amount: 1234, type: "expense", rawPlace: "LIDL SP. Z O.O.", tag: "LIDL", currency: "EUR", fxOriginal: "" },
      { date: "2026-08-02", amount: 999, type: "income", rawPlace: "EMPLOYER GMBH", tag: "EMPLOYER", currency: "EUR", fxOriginal: "" },
    ],
  };
  script = [chatBody(JSON.stringify(visionItems))];
  const before6 = { calls: upstreamCalls, checks: counters.checks, records: counters.records };
  const res7 = await post(app6, "/import/extract", { images: ["data:image/png;base64,AAAA"], locale: "en" });
  const body7 = (await res7.json()) as { items?: Array<{ tag?: string }> };
  const importCycle2Denied = {
    status: res7.status,
    itemCount: body7.items?.length ?? -1,
    firstItemTag: body7.items?.[0]?.tag,
    upstreamCalls: upstreamCalls - before6.calls,
    checks: counters.checks - before6.checks,
    records: counters.records - before6.records,
  };

  const out: SpendRoutesChildOutput = {
    proxyOk,
    proxyDenied,
    deprecatedChatDenied,
    deprecatedChatOk,
    suggestDenied,
    importDeniedBeforeCycle1,
    importCycle2Denied,
  };
  await emitChildResult(SENTINEL, out);
  await pooled.end({ timeout: 5 });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

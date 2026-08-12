/**
 * The ONE metered operator-key transport (backlog §1) — the ONLY allowed path to
 * `openAiChatFetch` outside this module (transport.noUnmeteredPath.test.ts enforces it).
 * Every actual upstream ATTEMPT — not merely each HTTP route — is checked against the user's
 * monthly allowance and, when possible, recorded afterwards:
 *
 *   check (deny only when recorded >= $5) → fetch → parse → best-effort record.
 *
 * Ordering contract with the routes: session, tenant/tier assertion, body schema, input/image
 * bounds and key presence complete BEFORE the spend check and network egress — an invalid body
 * or a known-exhausted counter makes no OpenAI request.
 *
 * FAIL OPEN, for this feature only: a counter read/write failure logs a safe reason and lets
 * the attempt proceed / the answer through. A timeout, abort, upstream non-2xx, unreadable
 * body, malformed/missing usage, unknown response model or price failure produces NO charge and
 * never turns a successful answer into an error. Nothing here stores prompts, images, response
 * bodies, emails, keys or per-request billing events; the upstream `x-request-id` is captured
 * for diagnostics logs only, never persisted.
 *
 * Selfhost (closed or ALLOW_SIGNUPS=1) bypasses the counter entirely via
 * `operatorAiSpendLimited` — the check/record adapters are never invoked there.
 */
import { type ChatRequest, supportsReasoningEffort } from "@enveo/shared";
import { operatorAiSpendLimited } from "../authPolicy";
import { env } from "../env";
import { openAiChatFetch } from "../openaiHttp";
import { parseChatCompletion } from "./chatCompletion";
import { checkSpend, recordSpend, SPEND_POLICY, type SpendCheck } from "./counter";
import { assertOperatorModelPriced, chatCostNanoUsd, priceEntryFor } from "./pricing";
import { safetyIdentifierFor } from "./safetyIdentifier";

/** Thrown by route-local helpers when an attempt is denied — routes map it to the stable
 *  429 `{error:"ai_budget_exhausted", retryAfterSeconds}` + `Retry-After` contract. */
export class SpendDenied extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("ai_budget_exhausted");
  }
}

export type OperatorChatOutcome =
  /** Denied BEFORE any upstream request — the allowance for this UTC month is used up. */
  | { kind: "denied"; retryAfterSeconds: number }
  /** OpenAI answered non-2xx; `detail` is for the server log only. No charge. */
  | { kind: "upstream_error"; status: number; detail: string; requestId: string | null }
  /** 2xx whose body is not a JSON object. No charge. */
  | { kind: "invalid_body"; requestId: string | null }
  /** Success. `json` is the ORIGINAL upstream body (usage preserved — the 1:1 proxy forwards
   *  it); `content` is `choices[0].message.content` or "". The charge, if any, was recorded. */
  | { kind: "ok"; json: Record<string, unknown>; content: string; requestId: string | null };

/**
 * Injectable seams for tests ONLY — production code never swaps these. Kept on one mutable
 * object because ES module bindings are read-only; the transport reads them at call time.
 */
export const operatorAiDeps = {
  fetchChat: openAiChatFetch,
  checkSpend,
  recordSpend,
  safetyIdentifier: safetyIdentifierFor,
  meteringActive: (): boolean =>
    operatorAiSpendLimited({ deployment: env.DEPLOYMENT, allowSignups: env.ALLOW_SIGNUPS, operatorKeyPresent: env.OPENAI_API_KEY.length > 0 }),
};

/** Bounded budget for the post-success increment: recording must never hold a finished answer
 *  hostage to a slow database — past this, the answer returns and the charge is dropped. */
const RECORD_TIMEOUT_MS = 2_000;

/** The one payload builder for operator-key requests (model comes from env, NEVER the client). */
export function operatorChatPayload(req: ChatRequest): Record<string, unknown> & { model: string } {
  return {
    model: env.OPENAI_MODEL,
    messages: req.messages,
    ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
    ...(req.reasoningEffort && supportsReasoningEffort(env.OPENAI_MODEL) ? { reasoning_effort: req.reasoningEffort } : {}),
  };
}

/**
 * One metered upstream attempt. Throws only the two classified transport failures
 * (`UpstreamTimeoutError`/`UpstreamNetworkError` from openAiChatFetch) — everything else is a
 * typed outcome. `userId` is the session user; undefined (non-HTTP callers) is never metered.
 */
export async function meteredOperatorChat(opts: {
  userId: string | undefined;
  payload: Record<string, unknown> & { model: string };
  timeoutMs?: number;
}): Promise<OperatorChatOutcome> {
  const metering = opts.userId !== undefined && operatorAiDeps.meteringActive();
  let admitted: Extract<SpendCheck, { allowed: true }> | null = null;
  if (metering) {
    try {
      const check = await operatorAiDeps.checkSpend({ policy: SPEND_POLICY.operatorAi, userId: opts.userId as string });
      if (!check.allowed) return { kind: "denied", retryAfterSeconds: check.retryAfterSeconds };
      admitted = check;
    } catch (e) {
      // FAIL OPEN: a broken counter must not take AI down. Safe metadata only — no user id.
      console.error("ai-spend: counter read failed — allowing the attempt (fail open):", (e as Error).message);
    }
  }

  const payload = { ...opts.payload };
  const sid = operatorAiDeps.safetyIdentifier(opts.userId);
  if (sid) payload.safety_identifier = sid;

  const res = await operatorAiDeps.fetchChat(payload, { apiKey: env.OPENAI_API_KEY, timeoutMs: opts.timeoutMs });
  const requestId = res.headers.get("x-request-id");
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { kind: "upstream_error", status: res.status, detail, requestId };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "invalid_body", requestId };
  }
  const parsed = parseChatCompletion(body);
  if (parsed === null) return { kind: "invalid_body", requestId };

  if (admitted) await recordAttemptCost(opts.payload.model, parsed, admitted, opts.userId as string, requestId);
  return { kind: "ok", json: parsed.json, content: parsed.content, requestId };
}

/** Best-effort accounting AFTER a successful answer — never fabricates usage, never throws. */
async function recordAttemptCost(
  requestModel: string,
  parsed: { responseModel: string | null; usage: unknown },
  admitted: { periodKey: string },
  userId: string,
  requestId: string | null,
): Promise<void> {
  const entry = priceEntryFor(requestModel);
  if (!entry) {
    // Reachable only if the boot assert is bypassed (selfhost flipping cloud without restart is
    // not a thing — but a warning beats silent free usage in any unforeseen path).
    console.warn(`ai-spend: no price entry for request model "${requestModel}" — answer returned, no charge`, requestId ? { requestId } : {});
    return;
  }
  const cost = chatCostNanoUsd(entry, parsed.responseModel ?? "", parsed.usage);
  if (!cost.ok) {
    console.warn(
      `ai-spend: ${cost.reason} (response model "${parsed.responseModel ?? "<absent>"}") — answer returned, no charge`,
      requestId ? { requestId } : {},
    );
    return;
  }
  try {
    await withDeadline(
      operatorAiDeps.recordSpend({ policy: SPEND_POLICY.operatorAi, userId, periodKey: admitted.periodKey, actualNanoUsd: cost.nanoUsd }),
      RECORD_TIMEOUT_MS,
      "ai-spend record",
    );
  } catch (e) {
    console.error("ai-spend: counter write failed — answer returned uncharged (fail open):", (e as Error).message);
  }
}

/** Race a promise against a deadline; the timer is cleared once settled. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(handle)) as Promise<T>;
}

/**
 * Boot-time guard (index.ts, real boot only): when the cloud spend budget is active the
 * configured operator model must have a registered price entry, and the safety-identifier
 * secret must be DEDICATED (never the auth secret). Inputs are parameters so tests need no
 * process-env mutation; production passes `env`.
 */
export function assertAiSpendEnv(
  i: {
    deployment: "selfhost" | "cloud";
    allowSignups: string;
    openaiApiKey: string;
    openaiModel: string;
    aiSafetyIdentifierSecret: string;
    betterAuthSecret: string;
  } = {
    deployment: env.DEPLOYMENT,
    allowSignups: env.ALLOW_SIGNUPS,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    aiSafetyIdentifierSecret: env.AI_SAFETY_IDENTIFIER_SECRET,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
  },
): void {
  if (i.aiSafetyIdentifierSecret && i.aiSafetyIdentifierSecret === i.betterAuthSecret) {
    throw new Error("AI_SAFETY_IDENTIFIER_SECRET must be a DEDICATED secret — never reuse BETTER_AUTH_SECRET. Generate one with: openssl rand -hex 32");
  }
  if (operatorAiSpendLimited({ deployment: i.deployment, allowSignups: i.allowSignups, operatorKeyPresent: i.openaiApiKey.length > 0 })) {
    assertOperatorModelPriced(i.openaiModel);
  }
}

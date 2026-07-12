/**
 * "Suggest" agent tools (function calling) — OpenAI definitions + a PURE
 * executor shared by web (byok) and api (server). The agent ONLY reads
 * (no mutations); the `submit_allocation` final is handled by the loop
 * (agentLoop), not the executor.
 *
 * Executor contract: arguments validated with zod; a validation error is
 * RETURNED as the tool result `{error: "..."}` (the model sees the error and
 * corrects itself, the loop does NOT crash). The JSON.stringify'd result is
 * ≤ TOOL_RESULT_LIMIT chars — on overflow lists are trimmed to the first N
 * elements that fit + `truncated: true`.
 */
import { z } from "zod";
import { computeBudgetState, prevMonth } from "./budget";
import { goalProgress } from "./goals";
import { computeSpendingByDimension } from "./reports";
import { computeStateResponse } from "./stateResponse";
import type { ClientLedger } from "./types";

/** Length limit of the tool-result JSON (chars). */
export const TOOL_RESULT_LIMIT = 8000;

/* ── Argument validation (zod — second line of defense behind strict:true) ── */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthSchema = z.string().regex(MONTH_RE, "expected YYYY-MM");

const getMonthStateArgs = z.object({ month: monthSchema }).strict();
const getHistoryArgs = z.object({ months: z.number().int().min(1).max(24) }).strict();
const getSpendingArgs = z
  .object({
    dimension: z.enum(["envelope", "group", "category", "place"]),
    fromMonth: monthSchema,
    toMonth: monthSchema,
  })
  .strict();
const getGoalsArgs = z.object({ month: monthSchema }).strict();

/* ── Tool definitions (OpenAI, all strict:true) ──────────────────────── */

const MONTH_PARAM = {
  type: "string",
  pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
  description: "Month in YYYY-MM format",
} as const;

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_month_state",
      description:
        "Read the budget state for a month: toBeBudgeted and every envelope with its allocated, spent, available, carry-in, monthly target and savings flag. Amounts are integer minor units (grosze).",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { month: MONTH_PARAM },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_history",
      description:
        "Read per-envelope allocation and spending history for the last N fully elapsed months before the budgeted month (current month excluded). Returns aligned arrays, oldest month first. Amounts are integer minor units (grosze).",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          months: {
            type: "integer",
            minimum: 1,
            maximum: 24,
            description: "How many past months to include (1-24)",
          },
        },
        required: ["months"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_spending",
      description:
        "Break down spending in a month range by one dimension (envelope, group, category or place). Rows sorted by amount descending with a share (pct 0..1). Savings-envelope spending is excluded (it is not consumption). Amounts are integer minor units (grosze).",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          dimension: { type: "string", enum: ["envelope", "group", "category", "place"] },
          fromMonth: MONTH_PARAM,
          toMonth: MONTH_PARAM,
        },
        required: ["dimension", "fromMonth", "toMonth"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_goals",
      description:
        "Read monthly-target progress for a month: every active envelope that has a monthly target, with target, allocated so far, pct (0-100), funded flag and the missing amount. Amounts are integer minor units (grosze).",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { month: MONTH_PARAM },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_allocation",
      description:
        "Submit the FINAL allocation proposal and finish. items = envelopes to fund with non-negative integer amounts in minor units (grosze). This is the only way to finish the task.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                envelopeId: { type: "string" },
                amount: { type: "integer", minimum: 0, description: "Integer minor units (grosze), >= 0" },
              },
              required: ["envelopeId", "amount"],
            },
          },
          rationale: { type: ["string", "null"], description: "Optional short overall rationale" },
        },
        required: ["items", "rationale"],
      },
    },
  },
] as const;

/* ── Executor ─────────────────────────────────────────────────────────── */

export interface AgentToolResult {
  result: unknown;
  truncated?: boolean;
}

const errResult = (message: string): AgentToolResult => ({ result: { error: message } });

const zodError = (tool: string, e: z.ZodError): AgentToolResult =>
  errResult(
    `Invalid arguments for ${tool}: ` +
      e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  );

/** Trim the list under `key` to the first N elements that fit the limit. */
function fitList<T extends Record<string, unknown>>(result: T, key: keyof T & string): AgentToolResult {
  if (JSON.stringify(result).length <= TOOL_RESULT_LIMIT) return { result };
  const list = result[key] as unknown[];
  for (let n = list.length - 1; n >= 0; n--) {
    const trimmed = { ...result, [key]: list.slice(0, n) };
    if (JSON.stringify(trimmed).length <= TOOL_RESULT_LIMIT) return { result: trimmed, truncated: true };
  }
  return { result: { ...result, [key]: [] }, truncated: true };
}

/** Like fitList, but for a result that is a bare array. */
function fitArray(rows: unknown[]): AgentToolResult {
  if (JSON.stringify(rows).length <= TOOL_RESULT_LIMIT) return { result: rows };
  for (let n = rows.length - 1; n >= 0; n--) {
    const trimmed = rows.slice(0, n);
    if (JSON.stringify(trimmed).length <= TOOL_RESULT_LIMIT) return { result: trimmed, truncated: true };
  }
  return { result: [], truncated: true };
}

/**
 * Execute a read tool on the replica. `ctx.month` = the budgeted month —
 * reference point of the `get_history` window (defaults to the current calendar month).
 * `submit_allocation` is NOT executed here (it ends the loop in agentLoop) —
 * invoked via the executor it returns {error}.
 */
export function runAgentTool(
  ledger: ClientLedger,
  name: string,
  argsRaw: unknown,
  ctx?: { month?: string },
): AgentToolResult {
  switch (name) {
    case "get_month_state": {
      const p = getMonthStateArgs.safeParse(argsRaw);
      if (!p.success) return zodError(name, p.error);
      const s = computeStateResponse(ledger, p.data.month);
      const groupName = new Map(s.groups.map((g) => [g.id, g.name]));
      return fitList(
        {
          month: s.month,
          toBeBudgeted: s.toBeBudgeted,
          envelopes: s.envelopes.map((e) => ({
            id: e.id,
            name: e.name,
            group: groupName.get(e.groupId) ?? null,
            allocated: e.allocated,
            spent: e.spent,
            available: e.available,
            carryIn: e.carryIn,
            monthlyTarget: e.monthlyTarget,
            isSavings: e.isSavings,
          })),
        },
        "envelopes",
      );
    }

    case "get_history": {
      const p = getHistoryArgs.safeParse(argsRaw);
      if (!p.success) return zodError(name, p.error);
      const ref = ctx?.month ?? new Date().toISOString().slice(0, 7);
      const window: string[] = [];
      let m = prevMonth(ref);
      for (let i = 0; i < p.data.months; i++) {
        window.unshift(m);
        m = prevMonth(m);
      }
      const states = window.map((mm) => {
        const st = computeBudgetState(ledger, mm);
        return new Map(st.envelopes.map((e) => [e.envelope.id, e]));
      });
      return fitList(
        {
          months: window,
          envelopes: ledger.envelopes.map((e) => ({
            id: e.id,
            name: e.name,
            allocated: states.map((st) => st.get(e.id)?.allocated ?? 0),
            spent: states.map((st) => st.get(e.id)?.spent ?? 0),
          })),
        },
        "envelopes",
      );
    }

    case "get_spending": {
      const p = getSpendingArgs.safeParse(argsRaw);
      if (!p.success) return zodError(name, p.error);
      return fitArray(computeSpendingByDimension(ledger, p.data.fromMonth, p.data.toMonth, p.data.dimension));
    }

    case "get_goals": {
      const p = getGoalsArgs.safeParse(argsRaw);
      if (!p.success) return zodError(name, p.error);
      const state = computeBudgetState(ledger, p.data.month);
      const rows: unknown[] = [];
      for (const e of state.envelopes) {
        if (e.envelope.archived) continue;
        const gp = goalProgress({ monthlyTarget: e.envelope.monthlyTarget, allocated: e.allocated });
        if (!gp) continue;
        rows.push({
          envelopeId: e.envelope.id,
          name: e.envelope.name,
          target: e.envelope.monthlyTarget,
          allocated: e.allocated,
          pct: gp.pct,
          funded: gp.funded,
          missing: gp.missing,
        });
      }
      return fitArray(rows);
    }

    case "submit_allocation":
      return errResult("submit_allocation is finalized by the agent loop, not executed as a data tool.");

    default:
      return errResult(`Unknown tool: ${name}`);
  }
}

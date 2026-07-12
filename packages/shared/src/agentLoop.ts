/**
 * "Suggest" agent loop (tool calling) — PURE, shared by web (byok)
 * and api (server); the `chat` transport is injected. Contract:
 *  - rounds 1..maxRounds; in the LAST round tool_choice is forced to
 *    submit_allocation;
 *  - ALL tool_calls are executed (parallel ones too) via runAgentTool,
 *    results appended as one {role:"tool"} per call in tool_calls order;
 *  - `submit_allocation` ENDS the loop (other calls alongside — ignored, but
 *    recorded in trace); an invalid/unparsable submit → deltas=[]
 *    (downstream: agent_empty in normalizeAgentSuggestion);
 *  - a response without tool_calls (content only) → a reminder user-msg
 *    (consumes a round);
 *  - tool_calls arguments are a JSON STRING — garbage is parsed safely and
 *    {"error":...} is returned to the model as the tool result;
 *  - transport error (chat throws) → the exception propagates to the caller.
 * Trace = [{tool, args}] in call order (without results) — for UI and logs.
 */
import { z } from "zod";
import type { ProposedEnvelopeDelta } from "./aiBudget";
import { buildAgentLoopMessages, type AiLocale, type AssistantToolsMessage, type ChatToolsMessage, type ChatToolsRequest, type ToolCall } from "./aiPrompts";
import { AGENT_TOOLS, runAgentTool, type AgentToolResult } from "./aiTools";
import type { ClientLedger } from "./types";

/** Default round limit (chat calls) of the agent loop. */
export const AGENT_MAX_ROUNDS = 6;

/** Reminder after a response without tool_calls (consumes a round). */
export const AGENT_REMINDER =
  "Do not answer in plain text. Call the data tools if you need more facts and " +
  "finish by calling the submit_allocation tool with your final allocation.";

export interface AgentTraceEntry {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentLoopResult {
  deltas: ProposedEnvelopeDelta[];
  trace: AgentTraceEntry[];
}

export interface RunAgentLoopArgs {
  chat: (p: ChatToolsRequest) => Promise<AssistantToolsMessage>;
  ledger: ClientLedger;
  month: string;
  /** Amount to distribute (int minor units). */
  amount: number;
  directive: string;
  locale: AiLocale;
  maxRounds?: number;
}

/* Final validation (second line of defense behind strict:true; unknown fields
   ignored — zod strips them). Invalid shape → deltas=[]. */
const submitArgsSchema = z.object({
  items: z.array(z.object({ envelopeId: z.string(), amount: z.number().int().min(0) })),
  rationale: z.string().nullable().optional(),
});

type ParsedArgs = { ok: true; value: unknown } | { ok: false };

const parseArgs = (raw: string): ParsedArgs => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Args for trace: the parsed object or {} (garbage/non-object). */
const traceArgs = (p: ParsedArgs): Record<string, unknown> => (p.ok && isRecord(p.value) ? p.value : {});

/** Final step: submit_allocation → deltas (invalid arguments → []). */
function finalizeSubmit(parsed: ParsedArgs): ProposedEnvelopeDelta[] {
  if (!parsed.ok) return [];
  const sp = submitArgsSchema.safeParse(parsed.value);
  if (!sp.success) return [];
  return sp.data.items.map((i) => ({ envelopeId: i.envelopeId, proposedDelta: i.amount }));
}

export async function runAgentLoop(args: RunAgentLoopArgs): Promise<AgentLoopResult> {
  const { chat, ledger, month, amount, directive, locale } = args;
  const maxRounds = Math.max(1, args.maxRounds ?? AGENT_MAX_ROUNDS);
  const messages: ChatToolsMessage[] = buildAgentLoopMessages({ ledger, month, amount, directive, locale });
  const trace: AgentTraceEntry[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const forced = round === maxRounds;
    const msg = await chat({
      messages: [...messages],
      tools: AGENT_TOOLS,
      toolChoice: forced ? { type: "function", function: { name: "submit_allocation" } } : "auto",
      parallelToolCalls: true,
    });

    const calls: ToolCall[] = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // Content only → reminder; counts as a round (after forcing, the loop
      // ends with deltas=[] by exiting the for anyway).
      messages.push({ role: "assistant", content: msg.content ?? "" });
      messages.push({ role: "user", content: AGENT_REMINDER });
      continue;
    }

    const parsed = calls.map((c) => parseArgs(c.function.arguments));
    for (let i = 0; i < calls.length; i++) trace.push({ tool: calls[i]!.function.name, args: traceArgs(parsed[i]!) });

    const submitIdx = calls.findIndex((c) => c.function.name === "submit_allocation");
    if (submitIdx >= 0) {
      // Final — other calls alongside are ignored (already in trace).
      return { deltas: finalizeSubmit(parsed[submitIdx]!), trace };
    }

    // Execute ALL calls; tool-msgs in tool_calls order.
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]!;
      const p = parsed[i]!;
      const res: AgentToolResult = p.ok
        ? runAgentTool(ledger, c.function.name, p.value, { month })
        : { result: { error: `Invalid JSON in arguments for ${c.function.name}.` } };
      const body = res.truncated ? { truncated: true, result: res.result } : res.result;
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(body) });
    }
  }

  // Still no valid submit after forcing → agent_empty in normalization.
  return { deltas: [], trace };
}

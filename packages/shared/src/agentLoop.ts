
















import { z } from "zod";
import type { ProposedEnvelopeDelta } from "./aiBudget";
import { buildAgentLoopMessages, type AiLocale, type AssistantToolsMessage, type ChatToolsMessage, type ChatToolsRequest, type ToolCall } from "./aiPrompts";
import { AGENT_TOOLS, runAgentTool, type AgentToolResult } from "./aiTools";
import type { ClientLedger } from "./types";

 
export const AGENT_MAX_ROUNDS = 6;

 
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
   
  amount: number;
  directive: string;
  locale: AiLocale;
  maxRounds?: number;
}



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

 
const traceArgs = (p: ParsedArgs): Record<string, unknown> => (p.ok && isRecord(p.value) ? p.value : {});

 
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
      

      messages.push({ role: "assistant", content: msg.content ?? "" });
      messages.push({ role: "user", content: AGENT_REMINDER });
      continue;
    }

    const parsed = calls.map((c) => parseArgs(c.function.arguments));
    for (let i = 0; i < calls.length; i++) trace.push({ tool: calls[i]!.function.name, args: traceArgs(parsed[i]!) });

    const submitIdx = calls.findIndex((c) => c.function.name === "submit_allocation");
    if (submitIdx >= 0) {
       
      return { deltas: finalizeSubmit(parsed[submitIdx]!), trace };
    }

     
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

   
  return { deltas: [], trace };
}

import { describe, expect, test } from "bun:test";
import { AGENT_MAX_ROUNDS, AGENT_REMINDER, runAgentLoop } from "./agentLoop";
import { buildAgentLoopMessages, type AssistantToolsMessage, type ChatToolsRequest, type ToolCall } from "./aiPrompts";
import { AGENT_TOOLS, runAgentTool, TOOL_RESULT_LIMIT } from "./aiTools";
import { acc, alloc, asClientLedger, env, grp, tx } from "./test-helpers";
import type { ClientLedger } from "./types";

/** Small deterministic ledger: 2 envelopes, allocations and expenses 2026-05..07. */
function seedLedger(): ClientLedger {
  const g1 = grp({ id: "G1", name: "Życie" });
  const e1 = env("G1", { id: "E1", name: "Jedzenie" });
  const e2 = env("G1", { id: "E2", name: "Rachunki", monthlyTarget: 300_00 });
  return asClientLedger({
    accounts: [acc({ id: "A1", onBudget: true, initialBalance: 5_000_00 })],
    groups: [g1],
    envelopes: [e1, e2],
    allocations: [alloc("E1", "2026-05", 400_00), alloc("E1", "2026-06", 420_00), alloc("E2", "2026-06", 150_00)],
    transactions: [
      tx({ type: "income", accountId: "A1", amount: 2_000_00, date: "2026-05-01" }),
      tx({ type: "expense", accountId: "A1", envelopeId: "E1", amount: 380_00, date: "2026-05-12" }),
      tx({ type: "expense", accountId: "A1", envelopeId: "E2", amount: 90_00, date: "2026-06-05" }),
    ],
  });
}

/** Ledger with many envelopes — forces truncated:true in get_month_state. */
function bigLedger(n = 200): ClientLedger {
  const g = grp({ id: "G1", name: "Grupa" });
  const envelopes = Array.from({ length: n }, (_, i) =>
    env("G1", { id: `ENV_${String(i).padStart(3, "0")}`, name: `Koperta o zdecydowanie za długiej nazwie numer ${i}` }),
  );
  return asClientLedger({
    accounts: [acc({ id: "A1", onBudget: true, initialBalance: 10_000_00 })],
    groups: [g],
    envelopes,
    allocations: envelopes.map((e, i) => alloc(e.id, "2026-06", 10_00 + i)),
    transactions: [],
  });
}

const ledger = seedLedger();

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

const submitCall = (id: string, items: Array<{ envelopeId: string; amount: number }>, rationale: string | null = null): ToolCall =>
  call(id, "submit_allocation", { items, rationale });

const asst = (tool_calls?: ToolCall[], content: string | null = null): AssistantToolsMessage => ({ content, tool_calls });

/** Fake chat: scripted responses + a payload log for assertions. */
function scriptedChat(responses: AssistantToolsMessage[]) {
  const payloads: ChatToolsRequest[] = [];
  const chat = async (p: ChatToolsRequest): Promise<AssistantToolsMessage> => {
    payloads.push(structuredClone(p));
    const r = responses[payloads.length - 1];
    if (!r) throw new Error(`fake chat: no response for round ${payloads.length}`);
    return r;
  };
  return { chat, payloads };
}

const baseArgs = { ledger, month: "2026-07", amount: 100_00, directive: "Zasil jedzenie i rachunki", locale: "pl" as const };

describe("buildAgentLoopMessages", () => {
  test("system: submit_allocation contract + language directives; seed = exact get_month_state result", () => {
    const msgs = buildAgentLoopMessages({ ledger, month: "2026-07", amount: 100_00, directive: "Priorytet: rachunki", locale: "pl" });
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe("system");
    const sys = msgs[0]!.content as string;
    expect(sys).toContain("submit_allocation");
    expect(sys).toContain("PRIMARY decision criterion");
    expect(sys).toContain("Write all text you GENERATE (names, notes, rationales) in Polish.");
    expect(sys).toContain("do not translate data values");
    expect(msgs[1]!.role).toBe("user");
    const seed = JSON.parse(msgs[1]!.content as string) as Record<string, unknown>;
    expect(seed.month).toBe("2026-07");
    expect(seed.amountToDistribute).toBe(100_00);
    expect(seed.directive).toBe("Priorytet: rachunki");
    // FULL month state — exactly the executor result, no logic duplication
    expect(seed.currentMonthState).toEqual(runAgentTool(ledger, "get_month_state", { month: "2026-07" }).result as Record<string, unknown>);
  });

  test("locale en → English directive", () => {
    const msgs = buildAgentLoopMessages({ ...baseArgs, locale: "en" });
    expect(msgs[0]!.content as string).toContain("in English.");
  });
});

describe("runAgentLoop — scenarios", () => {
  test("(1) 1 round: immediate submit_allocation → deltas + trace; round-1 payload complete", async () => {
    const { chat, payloads } = scriptedChat([
      asst([submitCall("c1", [{ envelopeId: "E1", amount: 70_00 }, { envelopeId: "E2", amount: 30_00 }], "priorytety usera")]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, chat });
    expect(payloads.length).toBe(1);
    const p = payloads[0]!;
    expect(p.tools).toEqual(AGENT_TOOLS as unknown as ChatToolsRequest["tools"]);
    expect(p.toolChoice).toBe("auto");
    expect(p.parallelToolCalls).toBe(true);
    expect(p.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(res.deltas).toEqual([
      { envelopeId: "E1", proposedDelta: 70_00 },
      { envelopeId: "E2", proposedDelta: 30_00 },
    ]);
    expect(res.trace).toEqual([
      { tool: "submit_allocation", args: { items: [{ envelopeId: "E1", amount: 70_00 }, { envelopeId: "E2", amount: 30_00 }], rationale: "priorytety usera" } },
    ]);
  });

  test("(2) 2 rounds: parallel [get_history, get_spending] → submit; tool-msgs in tool_calls order; trace in call order", async () => {
    const historyArgs = { months: 2 };
    const spendingArgs = { dimension: "group", fromMonth: "2026-05", toMonth: "2026-06" };
    const { chat, payloads } = scriptedChat([
      asst([call("c1", "get_history", historyArgs), call("c2", "get_spending", spendingArgs)]),
      asst([submitCall("c3", [{ envelopeId: "E2", amount: 100_00 }])]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, chat });
    expect(payloads.length).toBe(2);
    const msgs2 = payloads[1]!.messages;
    // system, user-seed, assistant(tool_calls), tool c1, tool c2
    expect(msgs2.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    const asstMsg = msgs2[2] as { role: "assistant"; tool_calls?: ToolCall[] };
    expect(asstMsg.tool_calls?.map((c) => c.id)).toEqual(["c1", "c2"]);
    const t1 = msgs2[3] as { role: "tool"; tool_call_id: string; content: string };
    const t2 = msgs2[4] as { role: "tool"; tool_call_id: string; content: string };
    expect(t1.tool_call_id).toBe("c1");
    expect(t2.tool_call_id).toBe("c2");
    // results 1:1 from the executor
    expect(JSON.parse(t1.content)).toEqual(runAgentTool(ledger, "get_history", historyArgs, { month: "2026-07" }).result as Record<string, unknown>);
    expect(JSON.parse(t2.content)).toEqual(runAgentTool(ledger, "get_spending", spendingArgs).result as unknown[]);
    expect(res.deltas).toEqual([{ envelopeId: "E2", proposedDelta: 100_00 }]);
    expect(res.trace.map((t) => t.tool)).toEqual(["get_history", "get_spending", "submit_allocation"]);
    expect(res.trace[0]!.args).toEqual(historyArgs);
    expect(res.trace[1]!.args).toEqual(spendingArgs);
  });

  test("(3) invalid arguments → {error} as the result → the model corrects itself; a garbage JSON string too → {error}", async () => {
    const { chat, payloads } = scriptedChat([
      asst([call("c1", "get_history", { months: 0 }), call("c2", "get_spending", "{to nie jest json")]),
      asst([call("c3", "get_history", { months: 2 })]),
      asst([submitCall("c4", [{ envelopeId: "E1", amount: 100_00 }])]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, chat });
    expect(payloads.length).toBe(3);
    const msgs2 = payloads[1]!.messages;
    const errZod = JSON.parse((msgs2[3] as { content: string }).content) as { error?: string };
    expect(errZod.error).toContain("months");
    const errJson = JSON.parse((msgs2[4] as { content: string }).content) as { error?: string };
    expect(errJson.error).toContain("Invalid JSON");
    // round 3 gets a valid get_history result
    const msgs3 = payloads[2]!.messages;
    const ok = JSON.parse((msgs3[6] as { content: string }).content) as { months: string[] };
    expect(ok.months).toEqual(["2026-05", "2026-06"]);
    expect(res.deltas).toEqual([{ envelopeId: "E1", proposedDelta: 100_00 }]);
    // garbage arguments in trace as {}
    expect(res.trace.map((t) => t.tool)).toEqual(["get_history", "get_spending", "get_history", "submit_allocation"]);
    expect(res.trace[1]!.args).toEqual({});
  });

  test("(4) content without tool_calls → a reminder user-msg (consumes a round) → submit", async () => {
    const { chat, payloads } = scriptedChat([
      asst(undefined, "Proponuję zasilić jedzenie."),
      asst([submitCall("c1", [{ envelopeId: "E1", amount: 100_00 }])]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, chat });
    expect(payloads.length).toBe(2);
    const msgs2 = payloads[1]!.messages;
    expect(msgs2.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect((msgs2[2] as { content: string | null }).content).toBe("Proponuję zasilić jedzenie.");
    expect((msgs2[3] as { content: string }).content).toBe(AGENT_REMINDER);
    expect(res.deltas).toEqual([{ envelopeId: "E1", proposedDelta: 100_00 }]);
    expect(res.trace).toEqual([{ tool: "submit_allocation", args: { items: [{ envelopeId: "E1", amount: 100_00 }], rationale: null } }]);
  });

  test("(5a) last round = forced tool_choice submit_allocation (payload assertion); submit after forcing works", async () => {
    const { chat, payloads } = scriptedChat([
      asst([call("c1", "get_history", { months: 3 })]),
      asst([submitCall("c2", [{ envelopeId: "E2", amount: 100_00 }])]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, chat, maxRounds: 2 });
    expect(payloads[0]!.toolChoice).toBe("auto");
    expect(payloads[1]!.toolChoice).toEqual({ type: "function", function: { name: "submit_allocation" } });
    expect(res.deltas).toEqual([{ envelopeId: "E2", proposedDelta: 100_00 }]);
  });

  test("(5b) still missing/invalid submit after forcing → deltas=[] (trace kept)", async () => {
    // no submit (content-only in the forced round)
    const a = scriptedChat([asst([call("c1", "get_goals", { month: "2026-07" })]), asst(undefined, "nie umiem")]);
    const resA = await runAgentLoop({ ...baseArgs, chat: a.chat, maxRounds: 2 });
    expect(a.payloads.length).toBe(2);
    expect(resA.deltas).toEqual([]);
    expect(resA.trace).toEqual([{ tool: "get_goals", args: { month: "2026-07" } }]);
    // invalid submit (items not an array)
    const b = scriptedChat([asst([call("c1", "submit_allocation", { items: "wszystko na jedzenie", rationale: null })])]);
    const resB = await runAgentLoop({ ...baseArgs, chat: b.chat, maxRounds: 1 });
    expect(b.payloads[0]!.toolChoice).toEqual({ type: "function", function: { name: "submit_allocation" } });
    expect(resB.deltas).toEqual([]);
    // submit with a garbage JSON string
    const c = scriptedChat([asst([call("c1", "submit_allocation", "{zepsute")])]);
    const resC = await runAgentLoop({ ...baseArgs, chat: c.chat, maxRounds: 1 });
    expect(resC.deltas).toEqual([]);
    expect(resC.trace).toEqual([{ tool: "submit_allocation", args: {} }]);
  });

  test("(5c) default maxRounds=6: without a submit the loop makes exactly 6 calls and ends with deltas=[]", async () => {
    const responses = Array.from({ length: AGENT_MAX_ROUNDS }, () => asst(undefined, "hmm"));
    const { chat, payloads } = scriptedChat(responses);
    const res = await runAgentLoop({ ...baseArgs, chat });
    expect(payloads.length).toBe(AGENT_MAX_ROUNDS);
    expect(payloads[AGENT_MAX_ROUNDS - 1]!.toolChoice).toEqual({ type: "function", function: { name: "submit_allocation" } });
    expect(res.deltas).toEqual([]);
  });

  test("(6) a submit with an unknown envelopeId passes through (drop in normalizeAgentSuggestion, not in the loop)", async () => {
    const { chat } = scriptedChat([
      asst([submitCall("c1", [{ envelopeId: "NOPE", amount: 60_00 }, { envelopeId: "E1", amount: 40_00 }])]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, chat });
    expect(res.deltas).toEqual([
      { envelopeId: "NOPE", proposedDelta: 60_00 },
      { envelopeId: "E1", proposedDelta: 40_00 },
    ]);
  });

  test("(7) truncated in a tool result does not crash the loop; the result is wrapped {truncated:true, result}", async () => {
    const big = bigLedger(200);
    const { chat, payloads } = scriptedChat([
      asst([call("c1", "get_month_state", { month: "2026-06" })]),
      asst([submitCall("c2", [{ envelopeId: "ENV_000", amount: 100_00 }])]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, ledger: big, chat });
    const toolMsg = payloads[1]!.messages[3] as { role: "tool"; content: string };
    const body = JSON.parse(toolMsg.content) as { truncated?: boolean; result: { envelopes: unknown[] } };
    expect(body.truncated).toBe(true);
    expect(toolMsg.content.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT + 100); // limit + the {truncated,result} wrapper
    expect(body.result.envelopes.length).toBeGreaterThan(0);
    expect(res.deltas).toEqual([{ envelopeId: "ENV_000", proposedDelta: 100_00 }]);
  });

  test("(8) chat throws → the exception propagates (the caller maps it to warn.aiUnavailable)", async () => {
    const chat = async (): Promise<AssistantToolsMessage> => {
      throw new Error("openai 500");
    };
    await expect(runAgentLoop({ ...baseArgs, chat })).rejects.toThrow("openai 500");
  });

  test("a submit alongside other calls → ends the loop, other calls are NOT executed but are in trace", async () => {
    const { chat, payloads } = scriptedChat([
      asst([call("c1", "get_history", { months: 2 }), submitCall("c2", [{ envelopeId: "E1", amount: 100_00 }])]),
    ]);
    const res = await runAgentLoop({ ...baseArgs, chat });
    expect(payloads.length).toBe(1);
    expect(res.deltas).toEqual([{ envelopeId: "E1", proposedDelta: 100_00 }]);
    expect(res.trace.map((t) => t.tool)).toEqual(["get_history", "submit_allocation"]);
  });
});

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { type SuggestEnvelope, suggestFromPreset, suggestTopUpNegatives } from "./budgetSuggest";
import type { AllocationPreset } from "./preferences";

const BILLS = "11111111-1111-4111-8111-111111111111";
const GROCERIES = "22222222-2222-4222-8222-222222222222";
const PETS = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";

const envelope = (id: string, over: Partial<SuggestEnvelope> = {}): SuggestEnvelope => ({ id, archived: false, allocated: 0, available: 0, ...over });

const payday = (mode: AllocationPreset["mode"]): AllocationPreset => ({
  id: "55555555-5555-4555-8555-555555555555",
  name: "Payday",
  mode,
  amounts: [
    { envelopeId: BILLS, amount: 1200_00 },
    { envelopeId: GROCERIES, amount: 450_00 },
    { envelopeId: PETS, amount: 80_00 },
  ],
});

const deltas = (r: { items: Array<{ envelopeId: string; proposedDelta: number }> }) =>
  Object.fromEntries(r.items.map((it) => [it.envelopeId, it.proposedDelta]));

/** Applies a suggestion the way the sheet does: allocated += delta, available += delta. */
const applied = (envs: SuggestEnvelope[], r: { items: Array<{ envelopeId: string; proposedDelta: number }> }): SuggestEnvelope[] =>
  envs.map((e) => {
    const d = deltas(r)[e.id] ?? 0;
    return { ...e, allocated: e.allocated + d, available: e.available + d };
  });

describe("suggestFromPreset", () => {
  const envs = [envelope(BILLS, { allocated: 200_00 }), envelope(GROCERIES), envelope(PETS, { allocated: 100_00 })];

  it("add: every amount goes on top of this month's allocation, and a second payday adds it again", () => {
    const first = suggestFromPreset(envs, payday("add"), 5000_00);
    expect(deltas(first)).toEqual({ [BILLS]: 1200_00, [GROCERIES]: 450_00, [PETS]: 80_00 });
    expect(first.distributed).toBe(1730_00);
    expect(first.undistributed).toBe(3270_00);

    const second = suggestFromPreset(applied(envs, first), payday("add"), first.undistributed);
    expect(deltas(second)).toEqual(deltas(first));
  });

  it("topUp: fills each allocation up to its amount, never down, and a re-run proposes nothing", () => {
    const first = suggestFromPreset(envs, payday("topUp"), 5000_00);
    expect(deltas(first)).toEqual({ [BILLS]: 1000_00, [GROCERIES]: 450_00 });

    const again = suggestFromPreset(applied(envs, first), payday("topUp"), first.undistributed);
    expect(again.items).toEqual([]);
    expect(again.distributed).toBe(0);
  });

  it("skips missing and archived envelopes and counts them", () => {
    const preset = { ...payday("add"), amounts: [...payday("add").amounts, { envelopeId: GONE, amount: 10_00 }] };
    const r = suggestFromPreset([envelope(BILLS), envelope(GROCERIES, { archived: true }), envelope(PETS)], preset, 5000_00);
    expect(Object.keys(deltas(r)).sort()).toEqual([BILLS, PETS].sort());
    expect(r.skipped).toBe(2);
  });

  it("is not scaled to the pool: the full amounts come back with the shortfall", () => {
    const r = suggestFromPreset(envs, payday("add"), 1000_00);
    expect(r.distributed).toBe(1730_00);
    expect(r.over).toBe(730_00);
    expect(r.undistributed).toBe(0);
  });

  it("property: deltas are exactly the preset amounts per mode", () => {
    const ids = [BILLS, GROCERIES, PETS, GONE];
    fc.assert(
      fc.property(
        fc.constantFrom<AllocationPreset["mode"]>("add", "topUp"),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 4, maxLength: 4 }),
        fc.array(fc.record({ allocated: fc.integer({ min: -100_000, max: 1_000_000 }), archived: fc.boolean() }), { minLength: 3, maxLength: 3 }),
        fc.integer({ min: -100_000, max: 5_000_000 }),
        (mode, amounts, states, pool) => {
          const envList = states.map((st, i) => envelope(ids[i]!, { ...st, available: st.allocated }));
          const preset: AllocationPreset = { id: GONE, name: "P", mode, amounts: ids.map((envelopeId, i) => ({ envelopeId, amount: amounts[i]! })) };
          const r = suggestFromPreset(envList, preset, pool);
          for (const [i, id] of ids.entries()) {
            const e = envList.find((x) => x.id === id);
            const expected = !e || e.archived ? 0 : mode === "add" ? amounts[i]! : Math.max(0, amounts[i]! - e.allocated);
            expect(deltas(r)[id] ?? 0).toBe(expected);
          }
          for (const it of r.items) expect(Number.isInteger(it.proposedDelta) && it.proposedDelta > 0).toBe(true);
          expect(r.skipped).toBe(1 + envList.filter((e) => e.archived).length);
        },
      ),
    );
  });
});

describe("suggestTopUpNegatives", () => {
  it("brings every envelope in the red back to zero when the pool covers it", () => {
    const r = suggestTopUpNegatives(
      [envelope(BILLS, { available: -30_00 }), envelope(GROCERIES, { available: 20_00 }), envelope(PETS, { available: -5_00 })],
      100_00,
    );
    expect(deltas(r)).toEqual({ [BILLS]: 30_00, [PETS]: 5_00 });
    expect(r.undistributed).toBe(65_00);
  });

  it("splits a short pool proportionally to the deficits, to the last cent, and ignores archived envelopes", () => {
    const r = suggestTopUpNegatives(
      [envelope(BILLS, { available: -100 }), envelope(GROCERIES, { available: -200 }), envelope(PETS, { available: -900, archived: true })],
      100,
    );
    expect(deltas(r)).toEqual({ [BILLS]: 33, [GROCERIES]: 67 });
    expect(r.distributed).toBe(100);
  });

  it("proposes nothing without funds", () => {
    expect(suggestTopUpNegatives([envelope(BILLS, { available: -10_00 })], -5_00).items).toEqual([]);
  });

  it("property: non-negative integer deltas, Σ ≤ pool and each ≤ its deficit", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ available: fc.integer({ min: -1_000_000, max: 1_000_000 }), archived: fc.boolean() }), { maxLength: 12 }),
        fc.integer({ min: -100_000, max: 5_000_000 }),
        (states, pool) => {
          const envList = states.map((st, i) => envelope(`E${i}`, st));
          const r = suggestTopUpNegatives(envList, pool);
          for (const it of r.items) {
            const e = envList.find((x) => x.id === it.envelopeId)!;
            expect(Number.isInteger(it.proposedDelta) && it.proposedDelta > 0).toBe(true);
            expect(e.archived).toBe(false);
            expect(it.proposedDelta).toBeLessThanOrEqual(-e.available);
          }
          expect(r.distributed).toBeLessThanOrEqual(Math.max(0, pool));
          expect(r.over).toBe(0);
        },
      ),
    );
  });
});

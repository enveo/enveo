import { describe, expect, it } from "bun:test";
import { parseQuickAdd, type QuickAddRefs } from "./quickadd";

const refs: QuickAddRefs = {
  envelopes: [{ id: "E1", name: "Jedzenie" }],
  places: [{ id: "P1", name: "Biedronka" }],
  categories: [],
};
const TODAY = "2026-07-07"; // Tuesday

describe("parseQuickAdd — PL dates", () => {
  it("resolves Polish 'yesterday / day before yesterday / today' keywords", () => {
    expect(parseQuickAdd("Biedronka 47,30 jedzenie wczoraj", refs, TODAY).date).toBe("2026-07-06");
    expect(parseQuickAdd("kawa 12 przedwczoraj", refs, TODAY).date).toBe("2026-07-05");
    expect(parseQuickAdd("obiad 30 dzisiaj", refs, TODAY).date).toBe("2026-07-07");
  });

  it("amount + place + envelope", () => {
    const r = parseQuickAdd("Biedronka 47,30 jedzenie wczoraj", refs, TODAY);
    expect(r.amount).toBe(4730);
    expect(r.placeId).toBe("P1");
    expect(r.envelopeId).toBe("E1");
  });
});

describe("parseQuickAdd — EN dates", () => {
  it("'coffee 12.50 yesterday' resolves the date", () => {
    const r = parseQuickAdd("coffee 12.50 yesterday", refs, TODAY);
    expect(r.date).toBe("2026-07-06");
    expect(r.amount).toBe(1250);
  });

  it("'groceries 30 monday' resolves to the most recent Monday", () => {
    expect(parseQuickAdd("groceries 30 monday", refs, TODAY).date).toBe("2026-07-06");
  });

  it("'lunch 25 day before yesterday' and 'dinner 40 tomorrow'", () => {
    expect(parseQuickAdd("lunch 25 day before yesterday", refs, TODAY).date).toBe("2026-07-05");
    expect(parseQuickAdd("dinner 40 tomorrow", refs, TODAY).date).toBe("2026-07-08");
  });
});

describe("parseQuickAdd — PL weekdays", () => {
  it("'zakupy 30 piątek' (PL input) → the most recent past Friday", () => {
    expect(parseQuickAdd("zakupy 30 piątek", refs, TODAY).date).toBe("2026-07-03");
  });
});

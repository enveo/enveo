import { describe, expect, test } from "bun:test";
import { buildDupIndex, classifyDup } from "./import-dedupe";

const rows = [
   
  { date: "2031-04-16", amount: 4250, sourceRef: "EXAMPLE CITY SANITATION" },
   
  { date: "2031-04-12", amount: 7350, sourceRef: null },
];

const idx = buildDupIndex(rows);

describe("classifyDup — import duplicates without nondeterministic fields", () => {
  test("re-import of the same item (same rawPlace+date+amount) → exists, regardless of tag/envelope", () => {
    expect(classifyDup({ date: "2031-04-16", amount: 4250, rawPlace: "EXAMPLE CITY SANITATION" }, idx)).toBe("exists");
    expect(classifyDup({ date: "2031-04-16", amount: 4250, rawPlace: "  example city sanitation  " }, idx)).toBe("exists");
  });

  test("same date+amount, but the existing one was added manually (no source_ref) → probable", () => {
    expect(classifyDup({ date: "2031-04-12", amount: 7350, rawPlace: "MAPLE HARBOR MEMBERSHIP" }, idx)).toBe("probable");
  });

  test("same date+amount, different rawPlace than the stored source_ref → probable, not exists", () => {
    expect(classifyDup({ date: "2031-04-16", amount: 4250, rawPlace: "EXAMPLE BOOKS" }, idx)).toBe("probable");
  });

  test("an empty rawPlace does not strong-match an empty source_ref — only probable by date+amount", () => {
    expect(classifyDup({ date: "2031-04-12", amount: 7350, rawPlace: null }, idx)).toBe("probable");
    expect(classifyDup({ date: "2031-04-12", amount: 7350 }, idx)).toBe("probable");
  });

  test("nothing similar → new (different amount or different date)", () => {
    expect(classifyDup({ date: "2031-04-12", amount: 7500, rawPlace: "MAPLE HARBOR MEMBERSHIP" }, idx)).toBe("new");
    expect(classifyDup({ date: "2031-04-13", amount: 7350, rawPlace: "MAPLE HARBOR MEMBERSHIP" }, idx)).toBe("new");
  });

  test("markSeen: the strong key blocks a repeat within the same batch, the weak one does NOT (two different 50 USD expenses on the same day)", () => {
    const i2 = buildDupIndex([]);
    i2.markSeen({ date: "2031-04-03", amount: 5000, rawPlace: "LINDEN MARKET 123" });
    expect(classifyDup({ date: "2031-04-03", amount: 5000, rawPlace: "LINDEN MARKET 123" }, i2)).toBe("exists");
     
    expect(classifyDup({ date: "2031-04-03", amount: 5000, rawPlace: "PRAIRIE FUEL 77" }, i2)).toBe("new");
  });
});

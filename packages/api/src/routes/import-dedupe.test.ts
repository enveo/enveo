import { describe, expect, test } from "bun:test";
import { buildDupIndex, classifyDup } from "./import-dedupe";

const rows = [
  // added by an earlier import (has a source_ref from the bank)
  { date: "2026-07-09", amount: 9600, sourceRef: "UM HALINOW OPLATA GOSP ODPADAMI" },
  // added MANUALLY (source_ref null) — a Zen subscription
  { date: "2026-07-07", amount: 20000, sourceRef: null },
];

const idx = buildDupIndex(rows);

describe("classifyDup — import duplicates without nondeterministic fields", () => {
  test("re-import of the same item (same rawPlace+date+amount) → exists, regardless of tag/envelope", () => {
    expect(classifyDup({ date: "2026-07-09", amount: 9600, rawPlace: "UM HALINOW OPLATA GOSP ODPADAMI" }, idx)).toBe("exists");
    expect(classifyDup({ date: "2026-07-09", amount: 9600, rawPlace: "  um halinow oplata gosp odpadami  " }, idx)).toBe("exists");
  });

  test("same date+amount, but the existing one was added manually (no source_ref) → probable (the Zen case)", () => {
    expect(classifyDup({ date: "2026-07-07", amount: 20000, rawPlace: "ZEN COM PRZELEW" }, idx)).toBe("probable");
  });

  test("same date+amount, different rawPlace than the stored source_ref → probable, not exists", () => {
    expect(classifyDup({ date: "2026-07-09", amount: 9600, rawPlace: "INNY SKLEP" }, idx)).toBe("probable");
  });

  test("an empty rawPlace does not strong-match an empty source_ref — only probable by date+amount", () => {
    expect(classifyDup({ date: "2026-07-07", amount: 20000, rawPlace: null }, idx)).toBe("probable");
    expect(classifyDup({ date: "2026-07-07", amount: 20000 }, idx)).toBe("probable");
  });

  test("nothing similar → new (different amount or different date)", () => {
    expect(classifyDup({ date: "2026-07-07", amount: 20100, rawPlace: "ZEN COM PRZELEW" }, idx)).toBe("new");
    expect(classifyDup({ date: "2026-07-08", amount: 20000, rawPlace: "ZEN COM PRZELEW" }, idx)).toBe("new");
  });

  test("markSeen: the strong key blocks a repeat within the same batch, the weak one does NOT (two different 50 zł expenses on the same day)", () => {
    const i2 = buildDupIndex([]);
    i2.markSeen({ date: "2026-07-01", amount: 5000, rawPlace: "LIDL 123" });
    expect(classifyDup({ date: "2026-07-01", amount: 5000, rawPlace: "LIDL 123" }, i2)).toBe("exists");
    // a different store, same amount/day in ONE batch → passes as new (both were on the screenshot)
    expect(classifyDup({ date: "2026-07-01", amount: 5000, rawPlace: "ORLEN 77" }, i2)).toBe("new");
  });
});

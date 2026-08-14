import { describe, expect, it } from "bun:test";
import { buildImportDupIndex, classifyImportDup } from "./importDedupe";

describe("shared import duplicate classification", () => {
  const index = buildImportDupIndex([
    { date: "2026-07-09", amount: 9600, sourceRef: "UM HALINOW" },
    { date: "2026-07-07", amount: 20000, sourceRef: null },
  ]);

  it("classifies strong, weak and new matches exactly like the API contract", () => {
    expect(classifyImportDup({ date: "2026-07-09", amount: 9600, rawPlace: "  um halinow " }, index)).toBe("exists");
    expect(classifyImportDup({ date: "2026-07-09", amount: 9600, rawPlace: "OTHER" }, index)).toBe("probable");
    expect(classifyImportDup({ date: "2026-07-07", amount: 20000 }, index)).toBe("probable");
    expect(classifyImportDup({ date: "2026-07-08", amount: 20000, rawPlace: "OTHER" }, index)).toBe("new");
  });

  it("deduplicates a repeated raw row inside one batch without blocking equal-value rows from different places", () => {
    const empty = buildImportDupIndex([]);
    empty.markSeen({ date: "2026-07-01", amount: 5000, rawPlace: "LIDL 123" });
    expect(classifyImportDup({ date: "2026-07-01", amount: 5000, rawPlace: "LIDL 123" }, empty)).toBe("exists");
    expect(classifyImportDup({ date: "2026-07-01", amount: 5000, rawPlace: "ORLEN 77" }, empty)).toBe("new");
  });
});

import { describe, expect, test } from "bun:test";
import { decideAssignment } from "./import-match";

describe("history never overrides extracted assignment facts", () => {
  test("an extracted enrichment proposal remains in control", () => {
    const model = { name: "Visible purchase", place: "Visible merchant", envelope: "Visible envelope", category: "Visible category" };

    expect(decideAssignment("BANK*REFERENCE", model)).toEqual(model);
  });

  test("missing enrichment falls back to the visible source text, not a historical assignment", () => {
    expect(decideAssignment("BANK*REFERENCE", undefined)).toEqual({
      name: "BANK*REFERENCE",
      place: null,
      envelope: null,
      category: null,
    });
  });
});

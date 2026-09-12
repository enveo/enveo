import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Like the report charts, every receipt amount must pass through the shared discreet mask.
test("historical balances and foreign transaction amounts stay under the discreet-mode mask", () => {
  const source = readFileSync(new URL("./ImportCompletionDetails.tsx", import.meta.url), "utf8");
  expect(source).toContain("useMask()");
  expect(source).toContain("M(value, currency)");
  expect(source).not.toContain("formatMoney");
});

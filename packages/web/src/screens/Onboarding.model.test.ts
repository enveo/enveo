import { describe, expect, test } from "bun:test";
import { clearOnboardingDraft, onboardingDraft } from "./Onboarding";

// The draft itself is the pure part of the fold/desktop remount fix (see its own comment in
// Onboarding.tsx): a module-level object the wizard's useState initializers read from and an
// effect mirrors into, so crossing the phone/wide viewport boundary mid-flow — which remounts
// the whole component — resumes instead of restarting. This only pins the round-trip and the
// reset; the remount behaviour itself needs a real browser (verified separately).
describe("onboardingDraft", () => {
  test("starts empty/step 0, with currency/rows/drafts unset", () => {
    expect(onboardingDraft).toEqual({ step: 0, accName: "", accBal: "", currency: null, rows: null, drafts: null });
  });

  test("round-trips every field a mode-flip remount would otherwise discard", () => {
    onboardingDraft.step = 2;
    onboardingDraft.accName = "Checking";
    onboardingDraft.accBal = "1,234.56";
    onboardingDraft.currency = "EUR";
    onboardingDraft.rows = [[{ name: "Groceries" as never, checked: false, color: "#123456", icon: "cart" }]];
    onboardingDraft.drafts = ["custom envelope"];

    // A fresh `useState(onboardingDraft.step)`-style read after the remount sees exactly this —
    // the whole point of the singleton surviving where component-local state would not.
    expect(onboardingDraft.step).toBe(2);
    expect(onboardingDraft.accName).toBe("Checking");
    expect(onboardingDraft.accBal).toBe("1,234.56");
    expect(onboardingDraft.currency).toBe("EUR");
    expect(onboardingDraft.rows).toEqual([[{ name: "Groceries", checked: false, color: "#123456", icon: "cart" }]]);
    expect(onboardingDraft.drafts).toEqual(["custom envelope"]);
  });

  test("clearOnboardingDraft resets every field so the NEXT wizard run starts clean", () => {
    onboardingDraft.step = 1;
    onboardingDraft.accName = "Savings";
    onboardingDraft.accBal = "500";
    onboardingDraft.currency = "GBP";
    onboardingDraft.rows = [[{ custom: "Pets", checked: true, color: "#abcdef", icon: "tag" }]];
    onboardingDraft.drafts = ["x"];

    clearOnboardingDraft();

    expect(onboardingDraft).toEqual({ step: 0, accName: "", accBal: "", currency: null, rows: null, drafts: null });
  });
});

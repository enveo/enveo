import { describe, expect, it } from "bun:test";
import type { AccountView, EnvelopeView } from "@enveo/shared";
import {
  automaticEnvelopePreview,
  currentReconciliationAccount,
  expenseEnvelopeAfterAccountChange,
  expenseEnvelopeAfterSplitCancel,
  expenseEnvelopeSelection,
  expenseEnvelopeSelectionForImport,
  explicitExpenseEnvelopeSelection,
  formatAutomaticEnvelopeEffect,
  reconciliationActualValueAfterAccountRefresh,
  reconciliationEnvelopeAfterAccountRefresh,
  reconciliationTxnPayload,
} from "./automaticEnvelopeUi";

const account = (id: string, automaticEnvelopeId: string | null): AccountView => ({
  id,
  name: id,
  color: "#fff",
  icon: "bank",
  type: "checking",
  onBudget: true,
  initialBalance: 0,
  archived: false,
  sort: 0,
  automaticEnvelopeId,
  balance: 0,
});

const envelope = (id: string, name: string): EnvelopeView => ({
  id,
  groupId: "G",
  name,
  color: "#fff",
  icon: "tag",
  note: null,
  monthlyTarget: null,
  isSavings: false,
  sort: 0,
  archived: false,
  carryIn: 0,
  allocated: 0,
  spent: 0,
  available: 0,
});

const state = {
  accounts: [account("A-checking", null), account("A-savings", "E-savings"), account("A-travel", "E-travel"), account("A-shared", "E-savings")],
  envelopes: [envelope("E-savings", "Savings"), envelope("E-travel", "Travel"), envelope("E-recorded", "Recorded plan")],
};

describe("automatic envelope transaction preview", () => {
  it("shows a destination envelope increase and the opposite Ready to assign decrease", () => {
    

    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-checking", toAccountId: "A-savings" }, 500_00);

     
    expect(preview).toEqual({
      rows: [{ envelopeId: "E-savings", name: "Savings", amount: 500_00 }],
      readyToAssignDelta: -500_00,
      neutral: false,
    });
  });

  it("shows a source envelope decrease and the opposite Ready to assign increase", () => {
    

    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-checking" }, 200_00);

     
    expect(preview).toEqual({
      rows: [{ envelopeId: "E-savings", name: "Savings", amount: -200_00 }],
      readyToAssignDelta: 200_00,
      neutral: false,
    });
  });

  it("shows both signed envelope rows while a transfer between different links leaves Ready to assign unchanged", () => {
    

    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-travel" }, 300_00);

     
    expect(preview).toEqual({
      rows: [
        { envelopeId: "E-savings", name: "Savings", amount: -300_00 },
        { envelopeId: "E-travel", name: "Travel", amount: 300_00 },
      ],
      readyToAssignDelta: 0,
      neutral: false,
    });
  });

  it("marks a transfer between accounts linked to the same envelope as explicitly neutral", () => {
    

    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-shared" }, 125_00);

     
    expect(preview).toEqual({ rows: [], readyToAssignDelta: 0, neutral: true });
  });

  it("shows linked income as an envelope increase funded from Ready to assign", () => {
    

    const preview = automaticEnvelopePreview(state, { type: "income", accountId: "A-savings" }, 1_000_00);

     
    expect(preview).toEqual({
      rows: [{ envelopeId: "E-savings", name: "Savings", amount: 1_000_00 }],
      readyToAssignDelta: -1_000_00,
      neutral: false,
    });
  });

  it("preserves the recorded flow for an unchanged edited route after the account link changes", () => {
     
    const previous = {
      type: "income" as const,
      accountId: "A-savings",
      toAccountId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: "E-recorded",
    };

     
    const preview = automaticEnvelopePreview(state, { type: "income", accountId: "A-savings" }, 750_00, previous);

    // then: the preview describes the preserved recorded flow, not the account's current link
    expect(preview).toEqual({
      rows: [{ envelopeId: "E-recorded", name: "Recorded plan", amount: 750_00 }],
      readyToAssignDelta: -750_00,
      neutral: false,
    });
  });
});

describe("expense envelope selection provenance", () => {
  it("starts a fresh expense from the selected account's automatic envelope", () => {
    

    const selection = expenseEnvelopeSelection("E-savings");

     
    expect(selection).toEqual({ envelopeId: "E-savings", provenance: "automatic" });
  });

  it("replaces an automatic default when the account changes", () => {
     
    const current = expenseEnvelopeSelection("E-savings");

     
    const changed = expenseEnvelopeAfterAccountChange(current, "E-travel", false);

     
    expect(changed).toEqual({ envelopeId: "E-travel", provenance: "automatic" });
  });

  it("never overwrites an explicit user choice when the account changes", () => {
     
    const current = explicitExpenseEnvelopeSelection("E-savings");

     
    const changed = expenseEnvelopeAfterAccountChange(current, "E-travel", false);

     
    expect(changed).toEqual({ envelopeId: "E-savings", provenance: "explicit" });
  });

  it("treats edit and saved-draft presets, including null, as explicit values", () => {
     
    const selected = expenseEnvelopeSelection("E-savings", { envelopeId: "E-travel" });
    const empty = expenseEnvelopeSelection("E-savings", { envelopeId: null });

     
    expect(selected).toEqual({ envelopeId: "E-travel", provenance: "explicit" });
    expect(empty).toEqual({ envelopeId: null, provenance: "explicit" });
  });

  it("does not replace an automatic selection while the expense is split", () => {
     
    const current = expenseEnvelopeSelection("E-savings");

     
    const changed = expenseEnvelopeAfterAccountChange(current, "E-travel", true);

     
    expect(changed).toEqual(current);
  });

  it("defaults a missing imported expense but preserves explicit imports and non-expenses", () => {
    

    const missingExpense = expenseEnvelopeSelectionForImport("expense", null, "E-savings");
    const explicitExpense = expenseEnvelopeSelectionForImport("expense", "E-travel", "E-savings");
    const income = expenseEnvelopeSelectionForImport("income", null, "E-savings");

     
    expect(missingExpense).toEqual({ envelopeId: "E-savings", provenance: "automatic" });
    expect(explicitExpense).toEqual({ envelopeId: "E-travel", provenance: "explicit" });
    expect(income).toEqual({ envelopeId: null, provenance: "explicit" });
  });

  it("submits the current account default after a split is cancelled", () => {
     
    const beforeSplit = expenseEnvelopeSelection("E-savings");
    const hiddenDuringSplit = expenseEnvelopeAfterAccountChange(beforeSplit, "E-travel", true);

     
    const afterCancel = expenseEnvelopeAfterSplitCancel(hiddenDuringSplit, "E-travel");
    const submittedEnvelopeId = afterCancel.envelopeId;

    // then: the ordinary transaction uses account B's default, not account A's stale value
    expect(submittedEnvelopeId).toBe("E-travel");
    expect(afterCancel).toEqual({ envelopeId: "E-travel", provenance: "automatic" });
  });

  it("keeps a true explicit ordinary choice when a split is cancelled", () => {
     
    const explicit = explicitExpenseEnvelopeSelection("E-recorded");

     
    const afterCancel = expenseEnvelopeAfterSplitCancel(explicit, "E-travel");

     
    expect(afterCancel).toBe(explicit);
  });
});

describe("automatic envelope effect presentation data", () => {
  it("formats signed envelope and Ready to assign rows before they reach the component", () => {
     
    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-travel" }, 300_00);

     
    const data = formatAutomaticEnvelopeEffect(preview, (amount) => `${amount / 100} EUR`, {
      heading: "Automatic envelope effect",
      readyToAssign: "Ready to assign",
      noEnvelopeChange: "No envelope change",
      noChange: "No change",
    });

     
    expect(data).toEqual({
      heading: "Automatic envelope effect",
      rows: [
        { name: "Savings", amount: "−300 EUR", tone: "negative" },
        { name: "Travel", amount: "+300 EUR", tone: "positive" },
      ],
      readyToAssign: { name: "Ready to assign", amount: "No change", tone: "neutral" },
      neutral: false,
      noEnvelopeChange: "No envelope change",
    });
  });
});

describe("reconciliation transaction preparation", () => {
  it("preserves the entered actual balance when only the live account link changes", () => {
     
    const opened = { id: "A-savings", balance: 100_00 };

     
    const refreshed = reconciliationActualValueAfterAccountRefresh("125", opened, { ...opened });

     
    expect(refreshed).toBe("125");
  });

  it("preserves a user envelope choice when the same account data is presented again", () => {
     
    const chosen = {
      accountId: "A-savings",
      automaticEnvelopeId: "E-savings",
      envelopeId: "E-travel",
      provenance: "explicit" as const,
    };

     
    const refreshed = reconciliationEnvelopeAfterAccountRefresh(chosen, "A-savings", "E-savings");

    // then: a render refresh cannot overwrite the user's choice
    expect(refreshed).toBe(chosen);
  });

  it("follows a live relink only for the untouched negative-adjustment default", () => {
     
    const chosen = {
      accountId: "A-savings",
      automaticEnvelopeId: "E-savings",
      envelopeId: "E-savings",
      provenance: "automatic" as const,
    };

     
    const refreshed = reconciliationEnvelopeAfterAccountRefresh(chosen, "A-savings", "E-travel");

     
    expect(refreshed).toEqual({
      accountId: "A-savings",
      automaticEnvelopeId: "E-travel",
      envelopeId: "E-travel",
      provenance: "automatic",
    });
  });

  it("preserves an explicit negative-adjustment choice across a live relink", () => {
    const chosen = {
      accountId: "A-savings",
      automaticEnvelopeId: "E-savings",
      envelopeId: "E-recorded",
      provenance: "explicit" as const,
    };

    expect(reconciliationEnvelopeAfterAccountRefresh(chosen, "A-savings", "E-travel")).toEqual({
      ...chosen,
      automaticEnvelopeId: "E-travel",
    });
  });

  it("resolves the current account by stored ID so a positive preview follows a relink while open", () => {
    const openedAccountId = "A-savings";
    const accountsNow = state.accounts.map((row) => (row.id === openedAccountId ? { ...row, automaticEnvelopeId: "E-travel" } : row));

    const liveAccount = currentReconciliationAccount(accountsNow, openedAccountId);
    expect(liveAccount?.automaticEnvelopeId).toBe("E-travel");
    expect(
      automaticEnvelopePreview(
        { accounts: liveAccount ? [liveAccount] : [], envelopes: state.envelopes },
        { type: "income", accountId: openedAccountId },
        45_00,
      ).rows,
    ).toEqual([{ envelopeId: "E-travel", name: "Travel", amount: 45_00 }]);
  });

  it("creates a positive difference as ordinary income for central flow stamping", () => {
     
    const payload = reconciliationTxnPayload({
      accountId: "A-savings",
      difference: 45_00,
      envelopeId: "E-savings",
      date: "2026-08-16",
      note: "Balance adjustment",
    });

     
    expect(payload).toMatchObject({
      type: "income",
      accountId: "A-savings",
      amount: 45_00,
      envelopeId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });
  });

  it("creates a negative difference as an expense in the editable selected envelope", () => {
     
    const payload = reconciliationTxnPayload({
      accountId: "A-savings",
      difference: -30_00,
      envelopeId: "E-savings",
      date: "2026-08-16",
      note: "Balance adjustment",
    });

     
    expect(payload).toMatchObject({
      type: "expense",
      accountId: "A-savings",
      amount: 30_00,
      envelopeId: "E-savings",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });
  });
});

import { describe, expect, it } from "bun:test";
import type { AccountView, EnvelopeView } from "@enveo/shared";
import {
  automaticEnvelopePreview,
  expenseEnvelopeAfterAccountChange,
  expenseEnvelopeSelection,
  expenseEnvelopeSelectionForImport,
  explicitExpenseEnvelopeSelection,
  formatAutomaticEnvelopeEffect,
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
    // given: only the transfer destination has an automatic envelope
    // when: money is transferred to that account
    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-checking", toAccountId: "A-savings" }, 500_00);

    // then: the signed envelope and Ready to assign effects are opposites
    expect(preview).toEqual({
      rows: [{ envelopeId: "E-savings", name: "Savings", amount: 500_00 }],
      readyToAssignDelta: -500_00,
      neutral: false,
    });
  });

  it("shows a source envelope decrease and the opposite Ready to assign increase", () => {
    // given: only the transfer source has an automatic envelope
    // when: money leaves that account
    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-checking" }, 200_00);

    // then: the envelope releases the same amount to Ready to assign
    expect(preview).toEqual({
      rows: [{ envelopeId: "E-savings", name: "Savings", amount: -200_00 }],
      readyToAssignDelta: 200_00,
      neutral: false,
    });
  });

  it("shows both signed envelope rows while a transfer between different links leaves Ready to assign unchanged", () => {
    // given: source and destination accounts have different automatic envelopes
    // when: money moves between them
    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-travel" }, 300_00);

    // then: the envelope effects cancel only in Ready to assign
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
    // given: both accounts share one automatic envelope
    // when: money moves between them
    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-shared" }, 125_00);

    // then: no envelope row or Ready to assign change remains
    expect(preview).toEqual({ rows: [], readyToAssignDelta: 0, neutral: true });
  });

  it("shows linked income as an envelope increase funded from Ready to assign", () => {
    // given: income enters an account with an automatic envelope
    // when: the income amount is entered
    const preview = automaticEnvelopePreview(state, { type: "income", accountId: "A-savings" }, 1_000_00);

    // then: the destination envelope receives the income automatically
    expect(preview).toEqual({
      rows: [{ envelopeId: "E-savings", name: "Savings", amount: 1_000_00 }],
      readyToAssignDelta: -1_000_00,
      neutral: false,
    });
  });

  it("preserves the recorded flow for an unchanged edited route after the account link changes", () => {
    // given: the edited income recorded a different historical envelope than the account now links
    const previous = {
      type: "income" as const,
      accountId: "A-savings",
      toAccountId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: "E-recorded",
    };

    // when: only its amount or date is being edited
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
    // given: a fresh expense has no preset envelope
    // when: its initial selection is derived for a linked account
    const selection = expenseEnvelopeSelection("E-savings");

    // then: the editable value records that it came from the account default
    expect(selection).toEqual({ envelopeId: "E-savings", provenance: "automatic" });
  });

  it("replaces an automatic default when the account changes", () => {
    // given: the current value came from the previous account link
    const current = expenseEnvelopeSelection("E-savings");

    // when: another linked account is selected
    const changed = expenseEnvelopeAfterAccountChange(current, "E-travel", false);

    // then: the new account's automatic envelope becomes the editable default
    expect(changed).toEqual({ envelopeId: "E-travel", provenance: "automatic" });
  });

  it("never overwrites an explicit user choice when the account changes", () => {
    // given: the user picked an ordinary envelope, even if it matches the old automatic default
    const current = explicitExpenseEnvelopeSelection("E-savings");

    // when: the account changes
    const changed = expenseEnvelopeAfterAccountChange(current, "E-travel", false);

    // then: provenance protects the user's choice
    expect(changed).toEqual({ envelopeId: "E-savings", provenance: "explicit" });
  });

  it("treats edit and saved-draft presets, including null, as explicit values", () => {
    // given/when: a caller supplies a persisted envelope value instead of asking for a default
    const selected = expenseEnvelopeSelection("E-savings", { envelopeId: "E-travel" });
    const empty = expenseEnvelopeSelection("E-savings", { envelopeId: null });

    // then: neither value is presented as an account-derived default
    expect(selected).toEqual({ envelopeId: "E-travel", provenance: "explicit" });
    expect(empty).toEqual({ envelopeId: null, provenance: "explicit" });
  });

  it("does not replace an automatic selection while the expense is split", () => {
    // given: a split was entered from an automatic envelope default
    const current = expenseEnvelopeSelection("E-savings");

    // when: the account changes while split items own the envelope choices
    const changed = expenseEnvelopeAfterAccountChange(current, "E-travel", true);

    // then: the hidden ordinary-envelope value stays stable
    expect(changed).toEqual(current);
  });

  it("defaults a missing imported expense but preserves explicit imports and non-expenses", () => {
    // given: review items can have an explicit envelope or no assignment
    // when: their editable expense selection is prepared
    const missingExpense = expenseEnvelopeSelectionForImport("expense", null, "E-savings");
    const explicitExpense = expenseEnvelopeSelectionForImport("expense", "E-travel", "E-savings");
    const income = expenseEnvelopeSelectionForImport("income", null, "E-savings");

    // then: only the missing expense receives the account default
    expect(missingExpense).toEqual({ envelopeId: "E-savings", provenance: "automatic" });
    expect(explicitExpense).toEqual({ envelopeId: "E-travel", provenance: "explicit" });
    expect(income).toEqual({ envelopeId: null, provenance: "explicit" });
  });
});

describe("automatic envelope effect presentation data", () => {
  it("formats signed envelope and Ready to assign rows before they reach the component", () => {
    // given: a transfer moves allocation between two envelopes without changing Ready to assign
    const preview = automaticEnvelopePreview(state, { type: "transfer", accountId: "A-savings", toAccountId: "A-travel" }, 300_00);

    // when: callback-free presentation data is prepared with localized labels and money formatting
    const data = formatAutomaticEnvelopeEffect(preview, (amount) => `${amount / 100} EUR`, {
      heading: "Automatic envelope effect",
      readyToAssign: "Ready to assign",
      noEnvelopeChange: "No envelope change",
      noChange: "No change",
    });

    // then: signs are already resolved and the zero Ready effect is explicit
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
  it("preserves a user envelope choice when the same account data is presented again", () => {
    // given: the user replaced the account's automatic reconciliation envelope
    const chosen = {
      accountId: "A-savings",
      automaticEnvelopeId: "E-savings",
      envelopeId: "E-travel",
    };

    // when: the parent presents the same account and link through a fresh view array
    const refreshed = reconciliationEnvelopeAfterAccountRefresh(chosen, "A-savings", "E-savings");

    // then: a render refresh cannot overwrite the user's choice
    expect(refreshed).toBe(chosen);
  });

  it("starts from the new automatic envelope when the reconciliation account route changes", () => {
    // given: a prior reconciliation choice belonged to another account link
    const chosen = {
      accountId: "A-savings",
      automaticEnvelopeId: "E-savings",
      envelopeId: "E-travel",
    };

    // when: the account or its automatic link changes
    const refreshed = reconciliationEnvelopeAfterAccountRefresh(chosen, "A-travel", "E-travel");

    // then: the new account link supplies the fresh editable default
    expect(refreshed).toEqual({
      accountId: "A-travel",
      automaticEnvelopeId: "E-travel",
      envelopeId: "E-travel",
    });
  });

  it("creates a positive difference as ordinary income for central flow stamping", () => {
    // given/when: the bank balance is 45 EUR above the ledger balance
    const payload = reconciliationTxnPayload({
      accountId: "A-savings",
      difference: 45_00,
      envelopeId: "E-savings",
      date: "2026-08-16",
      note: "Balance adjustment",
    });

    // then: income has no ordinary envelope and carries no competing pre-stamped flow
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
    // given/when: the bank balance is 30 EUR below the ledger and the user keeps the account default
    const payload = reconciliationTxnPayload({
      accountId: "A-savings",
      difference: -30_00,
      envelopeId: "E-savings",
      date: "2026-08-16",
      note: "Balance adjustment",
    });

    // then: the ordinary expense envelope is written and automatic-flow fields stay null
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

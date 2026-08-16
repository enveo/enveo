import { describe, expect, it } from "bun:test";
import {
  accountFormPayload,
  canConfigureAutomaticEnvelope,
  linkedAccountNames,
  selectableAutomaticEnvelopes,
  visibleAutomaticEnvelopeName,
} from "./automaticEnvelopeAccountUi";

const envelope = (id: string, name: string, overrides: Partial<{ archived: boolean; isSavings: boolean }> = {}) => ({
  id,
  name,
  archived: false,
  isSavings: false,
  ...overrides,
});

const account = (id: string, name: string, automaticEnvelopeId: string | null, overrides: Partial<{ archived: boolean; onBudget: boolean }> = {}) => ({
  id,
  name,
  automaticEnvelopeId,
  archived: false,
  onBudget: true,
  ...overrides,
});

describe("automatic-envelope account configuration", () => {
  it("offers automatic-envelope configuration only to on-budget accounts", () => {
    // given: otherwise equivalent accounts on and off the budget
    const onBudget = account("checking", "Checking", null);
    const offBudget = account("brokerage", "Brokerage", null, { onBudget: false });

     
    expect(canConfigureAutomaticEnvelope(onBudget)).toBe(true);
    expect(canConfigureAutomaticEnvelope(offBudget)).toBe(false);
  });

  it("offers every active envelope, including wealth envelopes, but never archived envelopes", () => {
     
    const envelopes = [envelope("food", "Food"), envelope("investing", "Investing", { isSavings: true }), envelope("old", "Old plan", { archived: true })];

     
    const choices = selectableAutomaticEnvelopes(envelopes);

     
    expect(choices.map(({ id }) => id)).toEqual(["food", "investing"]);
  });

  it("allows several accounts to link to the same envelope", () => {
     
    const accounts = [account("checking", "Checking", "travel"), account("card", "Credit card", "travel")];

     
    const names = linkedAccountNames(accounts, "travel");

     
    expect(names).toEqual(["Checking", "Credit card"]);
  });

  it("keeps an account link visible while the account is archived and after it is restored", () => {
     
    const envelopes = [envelope("travel", "Travel")];
    const archived = account("checking", "Checking", "travel", { archived: true });
    const restored = account("checking", "Checking", "travel", { archived: false });

    // when/then: account archival does not change link discoverability
    expect(visibleAutomaticEnvelopeName(archived, envelopes)).toBe("Travel");
    expect(visibleAutomaticEnvelopeName(restored, envelopes)).toBe("Travel");
  });

  it("does not show a stale label for a missing or archived linked envelope", () => {
     
    const linked = account("checking", "Checking", "missing");
    const archivedTarget = [envelope("missing", "Old plan", { archived: true })];

     
    expect(visibleAutomaticEnvelopeName(linked, [])).toBeNull();
    expect(visibleAutomaticEnvelopeName(linked, archivedTarget)).toBeNull();
  });

  it("builds one account payload for a non-zero starting balance and automatic envelope", () => {
     
    const form = {
      name: "Checking",
      color: "#123456",
      icon: "bank",
      onBudget: true,
      automaticEnvelopeId: "travel",
      initialBalance: 12_345,
      sort: 2,
    };

     
    const payload = accountFormPayload(form);

     
    expect(payload).toEqual({
      name: "Checking",
      color: "#123456",
      icon: "bank",
      onBudget: true,
      automaticEnvelopeId: "travel",
      initialBalance: 12_345,
      sort: 2,
    });
  });

  it("clears the link in the same payload when an account becomes off-budget", () => {
     
    const form = {
      name: "Brokerage",
      color: "#123456",
      icon: "chart",
      onBudget: false,
      automaticEnvelopeId: "investing",
      archived: false,
    };

     
    const payload = accountFormPayload(form);

     
    expect(payload).toEqual({
      name: "Brokerage",
      color: "#123456",
      icon: "chart",
      onBudget: false,
      automaticEnvelopeId: null,
      archived: false,
    });
  });
});

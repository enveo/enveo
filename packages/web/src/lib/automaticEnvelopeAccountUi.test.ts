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

    // when/then: budget participation controls whether the form offers the setting
    expect(canConfigureAutomaticEnvelope(onBudget)).toBe(true);
    expect(canConfigureAutomaticEnvelope(offBudget)).toBe(false);
  });

  it("offers every active envelope, including wealth envelopes, but never archived envelopes", () => {
    // given: active spending and wealth envelopes plus an archived envelope
    const envelopes = [envelope("food", "Food"), envelope("investing", "Investing", { isSavings: true }), envelope("old", "Old plan", { archived: true })];

    // when: the account form builds its automatic-envelope choices
    const choices = selectableAutomaticEnvelopes(envelopes);

    // then: lifecycle is the only eligibility rule
    expect(choices.map(({ id }) => id)).toEqual(["food", "investing"]);
  });

  it("allows several accounts to link to the same envelope", () => {
    // given: two accounts sharing one automatic envelope
    const accounts = [account("checking", "Checking", "travel"), account("card", "Credit card", "travel")];

    // when: the envelope archive guard resolves linked accounts
    const names = linkedAccountNames(accounts, "travel");

    // then: neither account is excluded as a duplicate link
    expect(names).toEqual(["Checking", "Credit card"]);
  });

  it("keeps an account link visible while the account is archived and after it is restored", () => {
    // given: the same linked account in archived and active lifecycle states
    const envelopes = [envelope("travel", "Travel")];
    const archived = account("checking", "Checking", "travel", { archived: true });
    const restored = account("checking", "Checking", "travel", { archived: false });

    // when/then: account archival does not change link discoverability
    expect(visibleAutomaticEnvelopeName(archived, envelopes)).toBe("Travel");
    expect(visibleAutomaticEnvelopeName(restored, envelopes)).toBe("Travel");
  });

  it("reads an account row written before 3.8 (no automaticEnvelopeId key at all) as unlinked", () => {
    // given: a legacy account row from before automaticEnvelopeId existed — no key at all, not
    // even an explicit null (the ?? null boundary pitfall, shared/automaticEnvelope.ts's docblock;
    // this is that same fixture, pinned on the WEB boundary every Accounts consumer goes through)
    const legacy = { name: "Old", onBudget: true, archived: false, automaticEnvelopeId: null } as {
      name: string;
      onBudget: boolean;
      archived: boolean;
      automaticEnvelopeId: string | null;
    };
    delete (legacy as { automaticEnvelopeId?: string | null }).automaticEnvelopeId;

    // when/then: the falsy check treats the missing key exactly like an explicit null
    expect(visibleAutomaticEnvelopeName(legacy, [{ id: "e1", name: "Fuel", archived: false, isSavings: false }])).toBeNull();
  });

  it("does not show a stale label for a missing or archived linked envelope", () => {
    // given: a link whose target is absent or no longer active
    const linked = account("checking", "Checking", "missing");
    const archivedTarget = [envelope("missing", "Old plan", { archived: true })];

    // when/then: only a current active target produces a label
    expect(visibleAutomaticEnvelopeName(linked, [])).toBeNull();
    expect(visibleAutomaticEnvelopeName(linked, archivedTarget)).toBeNull();
  });

  it("builds one account payload for a non-zero starting balance and automatic envelope", () => {
    // given: a new on-budget account with both account-only values configured
    const form = {
      name: "Checking",
      color: "#123456",
      icon: "bank",
      onBudget: true,
      automaticEnvelopeId: "travel",
      initialBalance: 12_345,
      sort: 2,
    };

    // when: the form is converted to the local account mutation payload
    const payload = accountFormPayload(form);

    // then: balance and link remain fields of that single account mutation
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
    // given: a linked account form changing to off-budget
    const form = {
      name: "Brokerage",
      color: "#123456",
      icon: "chart",
      onBudget: false,
      automaticEnvelopeId: "investing",
      archived: false,
    };

    // when: the form is converted to the local update payload
    const payload = accountFormPayload(form);

    // then: the server-valid final state is sent atomically
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

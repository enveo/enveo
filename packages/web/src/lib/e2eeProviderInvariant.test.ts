import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences, type SyncOp } from "@enveo/shared";
import type { AiProviderKind } from "./aiProvider/contracts";
import * as e2ee from "./e2ee";
import { ensureE2eeProviderPreference, replayPendingWithE2eeProviderPreference } from "./e2eeProviderInvariant";
import * as outbox from "./outbox";
import { store } from "./store";
import "./sync";

const BUDGET_ID = "00000000-0000-4000-8000-000000000001";

const ledger = (provider: AiProviderKind): ClientLedger => ({
  budgets: [{ id: BUDGET_ID, name: "Budget", currency: "EUR", preferences: { ...createDefaultBudgetPreferences(), aiProvider: provider } }],
  accounts: [],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
  transactions: [],
  allocations: [],
});

const preferenceOp = (opId: string, provider: AiProviderKind): SyncOp => ({
  opId,
  kind: "budget.preferences.update",
  payload: { id: BUDGET_ID, patch: { aiProvider: provider } },
});

const queuedProviders = (): AiProviderKind[] =>
  outbox.snapshot().flatMap(({ op }) => {
    if (op.kind !== "budget.preferences.update") return [];
    const provider = (op as SyncOp<"budget.preferences.update">).payload.patch.aiProvider;
    return provider ? [provider] : [];
  });

beforeEach(async () => {
  outbox.clearAll();
  await outbox.flushed();
  store.replace(ledger("rules"), 0, BUDGET_ID);
  e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
});

afterEach(async () => {
  outbox.clearAll();
  await outbox.flushed();
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
});

describe("E2EE provider recovery invariant", () => {
  it("appends one terminal rules op after lost-success pending work is replayed", () => {
    // The server committed an E2EE snapshot with rules, but this device missed the response;
    // on unlock its preserved pre-enable Enveo preference replays over that snapshot.
    outbox.add(preferenceOp("old-enveo", "enveo"));

    expect(replayPendingWithE2eeProviderPreference()).toBe(true);

    expect(store.getLedger()!.budgets[0]!.preferences.aiProvider).toBe("rules");
    expect(queuedProviders()).toEqual(["enveo", "rules"]);
    expect(ensureE2eeProviderPreference()).toBe(false);
    expect(queuedProviders()).toEqual(["enveo", "rules"]);
  });

  it("wins after a later peer preference by appending rules at the end of reconciled order", () => {
    outbox.add(preferenceOp("earlier-rules", "rules"));
    outbox.add(preferenceOp("late-peer-enveo", "enveo"));

    expect(replayPendingWithE2eeProviderPreference()).toBe(true);

    expect(queuedProviders()).toEqual(["rules", "enveo", "rules"]);
    expect(store.getLedger()!.budgets[0]!.preferences.aiProvider).toBe("rules");
  });
});

/**
 * Fixture builders + fast-check generators shared by the shared-package tests.
 * NOT exported from the package (index.ts) — for `*.test.ts` only.
 * Name deliberately without ".test." — bun test does not treat the file as a suite.
 */
import fc from "fast-check";
import type { OpKind, OpPayload, SyncOp } from "./ops";
import type {
  Account,
  Allocation,
  ClientLedger,
  Envelope,
  EnvelopeGroup,
  Ledger,
  Transaction,
} from "./types";

let idc = 0;
export const uid = (p: string) => `${p}_${idc++}`;

export function acc(over: Partial<Account> = {}): Account {
  return {
    id: uid("a"),
    name: "Konto",
    color: "#fff",
    icon: "wallet",
    type: "checking",
    onBudget: true,
    initialBalance: 0,
    archived: false,
    sort: 0,
    ...over,
  };
}

export function env(groupId: string, over: Partial<Envelope> = {}): Envelope {
  return {
    id: uid("e"),
    groupId,
    name: "Koperta",
    color: "#fff",
    icon: "tag",
    note: null,
    monthlyTarget: null,
    isSavings: false,
    sort: 0,
    archived: false,
    ...over,
  };
}

export const grp = (over: Partial<EnvelopeGroup> = {}): EnvelopeGroup => ({
  id: uid("g"),
  name: "Grupa",
  sort: 0,
  ...over,
});

export function tx(over: Partial<Transaction>): Transaction {
  return {
    id: uid("t"),
    type: "expense",
    accountId: "",
    toAccountId: null,
    amount: 0,
    date: "2026-06-10",
    confirmed: true,
    isRefund: false,
    envelopeId: null,
    placeId: null,
    categoryId: null,
    name: null,
    note: null,
    tag: null,
    planned: false,
    recurrenceId: null,
    items: [],
    createdAt: "2026-06-10T00:00:00Z",
    ...over,
  };
}

export function alloc(envelopeId: string, month: string, amount: number): Allocation {
  return { id: uid("al"), envelopeId, month, amount };
}

/** Ledger → full client replica (empty dictionaries). */
export const asClientLedger = (l: Ledger): ClientLedger => ({
  ...l,
  budgets: [],
  categories: [],
  places: [],
  recurrences: [],
});

export const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07"] as const;

/** Random consistent ledger (moved verbatim from budget.test.ts). */
export function ledgerArb(): fc.Arbitrary<Ledger> {
  const months = [...MONTHS];
  return fc
    .record({
      nAcc: fc.integer({ min: 1, max: 4 }),
      nEnv: fc.integer({ min: 1, max: 5 }),
    })
    .chain(({ nAcc, nEnv }) => {
      const accounts: Account[] = Array.from({ length: nAcc }, (_, i) => acc({ id: `A${i}` }));
      // first account always on-budget; the rest random
      return fc
        .tuple(
          fc.array(fc.boolean(), { minLength: nAcc, maxLength: nAcc }),
          fc.array(fc.integer({ min: 0, max: 500_00 }), { minLength: nAcc, maxLength: nAcc }),
          fc.array(
            fc.record({
              envIdx: fc.integer({ min: 0, max: nEnv - 1 }),
              month: fc.constantFrom(...months),
              amount: fc.integer({ min: 0, max: 300_00 }),
            }),
            { maxLength: 12 },
          ),
          fc.array(
            fc.record({
              kind: fc.constantFrom("expense", "income", "transfer", "refund"),
              accIdx: fc.integer({ min: 0, max: nAcc - 1 }),
              toIdx: fc.integer({ min: 0, max: nAcc - 1 }),
              envIdx: fc.integer({ min: 0, max: nEnv - 1 }),
              withEnv: fc.boolean(),
              month: fc.constantFrom(...months),
              amount: fc.integer({ min: 1, max: 200_00 }),
            }),
            { maxLength: 30 },
          ),
        )
        .map(([onBudgetFlags, initials, allocSpecs, txSpecs]) => {
          const g = grp();
          const accs: Account[] = accounts.map((a, i) => ({
            ...a,
            onBudget: i === 0 ? true : onBudgetFlags[i]!,
            initialBalance: initials[i]!,
          }));
          const envs: Envelope[] = Array.from({ length: nEnv }, (_, i) => env(g.id, { id: `E${i}` }));
          const allocations: Allocation[] = allocSpecs.map((s) =>
            alloc(envs[s.envIdx]!.id, s.month, s.amount),
          );
          const transactions: Transaction[] = txSpecs.map((s) => {
            const day = "10";
            const date = `${s.month}-${day}`;
            if (s.kind === "transfer") {
              const to = s.toIdx === s.accIdx ? (s.toIdx + 1) % nAcc : s.toIdx;
              return tx({
                type: "transfer",
                accountId: accs[s.accIdx]!.id,
                toAccountId: accs[to]!.id,
                amount: s.amount,
                date,
              });
            }
            if (s.kind === "income") {
              return tx({
                type: "income",
                accountId: accs[s.accIdx]!.id,
                amount: s.amount,
                envelopeId: s.withEnv ? envs[s.envIdx]!.id : null,
                date,
              });
            }
            // expense / refund — always with an envelope (domain requirement)
            return tx({
              type: "expense",
              accountId: accs[s.accIdx]!.id,
              amount: s.amount,
              envelopeId: envs[s.envIdx]!.id,
              isRefund: s.kind === "refund",
              date,
            });
          });
          const ledger: Ledger = {
            accounts: accs,
            groups: [g],
            envelopes: envs,
            allocations,
            transactions,
          };
          return ledger;
        });
    });
}

/** Deep freeze — a reducer mutating the input will throw TypeError. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/* ── Generator of random, domain-VALID op sequences ───────────────────
 * Shared by applyOp.test.ts (invariant §2.3) and edge.test.ts
 * (fullResync replay idempotency). Specs are ledger-independent (`Spec[]`);
 * `interpret` materializes them against the CURRENT ledger (indexes → real ids),
 * skipping domain-invalid ops (e.g. deleting an envelope that has an expense). */

export const mkOp = <K extends OpKind>(kind: K, payload: OpPayload<K>): SyncOp =>
  ({ opId: uid("op"), kind, payload }) as SyncOp;

export type Spec =
  | {
      k: "txnCreate";
      kind2: "expense" | "income" | "transfer" | "refund";
      ai: number;
      ti: number;
      ei: number;
      withEnv: boolean;
      split: boolean;
      m: string;
      amount: number;
    }
  | { k: "txnUpdate"; xi: number; ai: number; ei: number; m: string; amount: number }
  | { k: "txnDelete"; xi: number }
  | { k: "allocSet"; ei: number; m: string; amount: number }
  | { k: "accCreate"; onBudget: boolean; initial: number }
  | { k: "accUpdate"; ai: number; onBudget: boolean }
  | { k: "accDelete"; ai: number }
  | { k: "envCreate"; gi: number }
  | { k: "envUpdate"; ei: number }
  | { k: "envDelete"; ei: number }
  | { k: "grpCreate" }
  | { k: "grpDelete"; gi: number }
  | { k: "catCreate" }
  | { k: "placeCreate" }
  | { k: "recCreate" };

const idxArb = fc.nat(999);
const monthArb = fc.constantFrom(...MONTHS);
const amountArb = fc.integer({ min: 2, max: 200_00 });

export const specArb: fc.Arbitrary<Spec> = fc.oneof(
  fc.record({
    k: fc.constant("txnCreate" as const),
    kind2: fc.constantFrom("expense" as const, "income" as const, "transfer" as const, "refund" as const),
    ai: idxArb,
    ti: idxArb,
    ei: idxArb,
    withEnv: fc.boolean(),
    split: fc.boolean(),
    m: monthArb,
    amount: amountArb,
  }),
  fc.record({ k: fc.constant("txnUpdate" as const), xi: idxArb, ai: idxArb, ei: idxArb, m: monthArb, amount: amountArb }),
  fc.record({ k: fc.constant("txnDelete" as const), xi: idxArb }),
  fc.record({ k: fc.constant("allocSet" as const), ei: idxArb, m: monthArb, amount: fc.integer({ min: 0, max: 300_00 }) }),
  fc.record({ k: fc.constant("accCreate" as const), onBudget: fc.boolean(), initial: fc.integer({ min: 0, max: 500_00 }) }),
  fc.record({ k: fc.constant("accUpdate" as const), ai: idxArb, onBudget: fc.boolean() }),
  fc.record({ k: fc.constant("accDelete" as const), ai: idxArb }),
  fc.record({ k: fc.constant("envCreate" as const), gi: idxArb }),
  fc.record({ k: fc.constant("envUpdate" as const), ei: idxArb }),
  fc.record({ k: fc.constant("envDelete" as const), ei: idxArb }),
  fc.record({ k: fc.constant("grpCreate" as const) }),
  fc.record({ k: fc.constant("grpDelete" as const), gi: idxArb }),
  fc.record({ k: fc.constant("catCreate" as const) }),
  fc.record({ k: fc.constant("placeCreate" as const) }),
  fc.record({ k: fc.constant("recCreate" as const) }),
);

const pick = <T>(arr: readonly T[], i: number): T | undefined =>
  arr.length > 0 ? arr[i % arr.length] : undefined;

/**
 * An envelope is safe to delete when no expense references it (directly or
 * via a split) — SET NULL on an expense orphans the amount and BREAKS the
 * invariant on the server too (domain requirement: an expense has an envelope).
 * References from income are OK (SET NULL moves the amount to toBeBudgeted).
 */
export const envDeletable = (l: ClientLedger, envId: string): boolean =>
  !l.transactions.some(
    (t) =>
      (t.type === "expense" && t.envelopeId === envId) ||
      t.items.some((i) => i.envelopeId === envId),
  );

/** Spec → a concrete, DOMAIN-VALID op against the current ledger (or null → skip). */
export function interpret(l: ClientLedger, s: Spec, nextId: () => string): SyncOp | null {
  switch (s.k) {
    case "txnCreate": {
      const a = pick(l.accounts, s.ai);
      if (!a) return null;
      const common = {
        id: nextId(),
        accountId: a.id,
        amount: s.amount,
        date: `${s.m}-10`,
        createdAt: "2026-06-01T10:00:00.000Z",
      };
      if (s.kind2 === "transfer") {
        if (l.accounts.length < 2) return null;
        const to = pick(l.accounts, s.ti)!;
        const toId = to.id === a.id ? pick(l.accounts, s.ti + 1)!.id : to.id;
        return mkOp("txn.create", { ...common, type: "transfer", toAccountId: toId });
      }
      if (s.kind2 === "income") {
        const e = s.withEnv ? pick(l.envelopes, s.ei) : undefined;
        return mkOp("txn.create", { ...common, type: "income", envelopeId: e?.id ?? null });
      }
      const e = pick(l.envelopes, s.ei);
      if (!e) return null; // an expense always has an envelope (domain requirement)
      if (s.split) {
        const e2 = pick(l.envelopes, s.ei + 1)!;
        const a1 = Math.floor(s.amount / 2);
        return mkOp("txn.create", {
          ...common,
          type: "expense",
          isRefund: s.kind2 === "refund",
          items: [
            { envelopeId: e.id, amount: a1 },
            { envelopeId: e2.id, amount: s.amount - a1 },
          ],
        });
      }
      return mkOp("txn.create", {
        ...common,
        type: "expense",
        isRefund: s.kind2 === "refund",
        envelopeId: e.id,
      });
    }
    case "txnUpdate": {
      const t = pick(l.transactions, s.xi);
      const a = pick(l.accounts, s.ai);
      const e = pick(l.envelopes, s.ei);
      if (!t || !a || !e) return null;
      return mkOp("txn.update", {
        id: t.id,
        type: "expense",
        accountId: a.id,
        amount: s.amount,
        date: `${s.m}-12`,
        envelopeId: e.id,
      });
    }
    case "txnDelete": {
      const t = pick(l.transactions, s.xi);
      return t ? mkOp("txn.delete", { id: t.id }) : null;
    }
    case "allocSet": {
      const e = pick(l.envelopes, s.ei);
      return e ? mkOp("alloc.set", { envelopeId: e.id, month: s.m, amount: s.amount }) : null;
    }
    case "accCreate":
      return mkOp("account.create", {
        id: nextId(),
        name: "Konto",
        onBudget: s.onBudget,
        initialBalance: s.initial,
      });
    case "accUpdate": {
      const a = pick(l.accounts, s.ai);
      return a ? mkOp("account.update", { id: a.id, onBudget: s.onBudget }) : null;
    }
    case "accDelete": {
      const a = pick(l.accounts, s.ai);
      return a ? mkOp("account.delete", { id: a.id }) : null;
    }
    case "envCreate": {
      const g = pick(l.groups, s.gi);
      return g ? mkOp("envelope.create", { id: nextId(), groupId: g.id, name: "Koperta" }) : null;
    }
    case "envUpdate": {
      const e = pick(l.envelopes, s.ei);
      return e ? mkOp("envelope.update", { id: e.id, name: "Zmieniona", archived: true }) : null;
    }
    case "envDelete": {
      const e = pick(l.envelopes.filter((x) => envDeletable(l, x.id)), s.ei);
      return e ? mkOp("envelope.delete", { id: e.id }) : null;
    }
    case "grpCreate":
      return mkOp("group.create", { id: nextId(), name: "Grupa" });
    case "grpDelete": {
      const g = pick(
        l.groups.filter((x) =>
          l.envelopes.filter((e) => e.groupId === x.id).every((e) => envDeletable(l, e.id)),
        ),
        s.gi,
      );
      return g ? mkOp("group.delete", { id: g.id }) : null;
    }
    case "catCreate":
      return mkOp("category.create", { id: nextId(), name: "Kategoria" });
    case "placeCreate":
      return mkOp("place.create", { id: nextId(), name: "Miejsce" });
    case "recCreate":
      return mkOp("recurrence.create", { id: nextId(), rule: "monthly", startDate: "2026-06-01" });
  }
}

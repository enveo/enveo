# Architecture

How Enveo is built, and why it behaves the way it does. Contributor-level
detail (invariants, pitfalls, conventions) lives in [AGENTS.md](../AGENTS.md);
this page is the map.

## Domain model

Money physically sits in **accounts**; budgeting means distributing it into
virtual **envelopes**. The core invariant:

```
Σ(envelope available) + To Be Budgeted = Σ(on-budget account balances)
```

Balances and "available" are **derived** from the transaction + allocation
ledger — never stored. Amounts are integer minor units end to end (1/100 of the
major unit), which is why only two-decimal currencies are offered. Negative
envelope balances carry over into the next month as a negative carry-in — no
floor at zero.

## Local-first sync

The client is the source of truth; the server is a sync and convenience layer.

- The full ledger is replicated to IndexedDB; every screen boots and works
  offline from that replica.
- A write is applied to the local mirror immediately and queued in an outbox;
  the sync engine pushes ops (idempotent by `opId`), pulls changes with a
  cursor, and recovers via snapshot resync.
- The server-side change journal is driven by Postgres triggers — imports and
  FK cascades are captured too, not just route handlers.
- Conflicts: last-write-wins per entity, delete wins.
- Every server write carries a per-request tenant assertion (the client names
  the budget/user it verified; a mismatch is refused with 409 before anything
  is written) — one device can hold one user's replica while another user signs
  in, and nothing may cross between them.

## End-to-end encryption (optional)

A budget is either `plain` or `e2ee`. With E2EE on, the client encrypts the
oplog before pushing; the server stores and relays ciphertexts and never holds
a key. All crypto lives in the web client (`packages/web/src/lib/crypto.ts`);
the data-encryption key stays on the device, wrapped by a password-derived key.

## Monorepo

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript, PWA (`vite-plugin-pwa`), TanStack Query |
| Backend | bun + Hono, REST, `zod` validation |
| ORM / DB | Drizzle ORM + PostgreSQL 16 (amounts in **minor units**, BIGINT) |
| Domain | `packages/shared` (`@enveo/shared`) — pure functions + property tests, shared by client and server |
| Runtime | Docker Compose (db + app); one image serves API and frontend |

`packages/shared` is the load-bearing piece: the same ledger math and mutation
reducers run on the client and the server, so replica and database can never
disagree about what a budget means.

## Tests

```bash
bun test packages/shared packages/api packages/web/src/lib
```

Property tests guard the budget invariant, carry-over semantics, client↔server
FK-cascade parity, and outbox replay idempotency.

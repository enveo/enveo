-- Drop the `confirmed` transaction flag.
--
-- The column had no domain meaning since 3.4: nothing in the app produced unconfirmed rows (the
-- reconciliation UI that once set/read it was retired), so every row was already `confirmed =
-- true` in practice, and `computeBudgetState` counted every transaction toward account balances
-- regardless of this flag. All code references were removed in Tasks 1-2 (web mutators/UI, shared
-- domain + ops, API routes). No data cleanup is needed here — unlike migration 0018's `planned`
-- row DELETE, dropping this column loses only the boolean markers, not any rows or amounts.
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "confirmed";

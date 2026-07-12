-- changes.budget_id — the delta journal becomes PER-TENANT.
--
-- `changes` had no budget at all (0004): /sync/pull selected `seq > since` with NO budget
-- filter, and only the UPSERT branch was scoped by content (loadCurrentRows returns nothing for
-- a foreign row → skipped). The DELETE branch pushed every row unconditionally, so every tenant
-- received { table, row_id, seq } for every row EVERY OTHER tenant deleted — metadata, but
-- across the tenant boundary, on the primary sync path. With mandatory accounts (2.0) a single
-- instance is multi-tenant by default, so the journal is now attributed at the source (the
-- trigger) and filtered in the pull.
--
-- budget_id stays NULLABLE: pre-0015 rows can only be backfilled unambiguously when exactly one
-- budget exists (single-budget installs — the norm pre-2.0). Rows that stay NULL (a multi-budget
-- upgrade) belong to nobody and would be invisible to a filtered delta, so /sync/pull refuses to
-- serve a delta from below them and answers resetRequired (snapshot) instead — see
-- legacyChangesWatermark in routes/sync.ts. New rows always carry budget_id.
--
-- Deliberately NO foreign key to budgets: `changes` is an append-only log, and ON DELETE CASCADE
-- would race the AFTER DELETE trigger that logs the budget row's own removal.
ALTER TABLE "changes" ADD COLUMN "budget_id" uuid;--> statement-breakpoint
UPDATE "changes" SET "budget_id" = (SELECT id FROM "budgets" LIMIT 1)
  WHERE (SELECT count(*) FROM "budgets") = 1;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "changes_budget_seq_idx" ON "changes" USING btree ("budget_id","seq");--> statement-breakpoint
-- makes the legacy watermark (MAX(seq) WHERE budget_id IS NULL) free on every pull
CREATE UNIQUE INDEX IF NOT EXISTS "changes_legacy_seq_idx" ON "changes" USING btree ("seq") WHERE "budget_id" is null;--> statement-breakpoint
-- The log writers: budget_id comes from the changed row itself. The row is read through
-- to_jsonb() rather than as NEW.budget_id, because ONE generic trigger function serves tables
-- that have that column AND `budgets` (its own trigger since 0009), which does not — and
-- plpgsql resolves record fields against the actual rowtype, so a literal OLD.budget_id would
-- fail on `budgets`. There the row's own id IS the tenant, which is exactly the COALESCE below.
-- The shared advisory lock (0005/0013) stays: it is the cursor barrier, and its key must keep
-- matching routes/sync.ts.
CREATE OR REPLACE FUNCTION log_change() RETURNS trigger AS $$
DECLARE row_json jsonb;
DECLARE bid uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('enveo:changes')::bigint);
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
  END IF;
  bid := COALESCE(row_json ->> 'budget_id', row_json ->> 'id')::uuid;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO changes (table_name, row_id, op, budget_id) VALUES (TG_TABLE_NAME, OLD.id, 'delete', bid);
    RETURN OLD;
  END IF;
  INSERT INTO changes (table_name, row_id, op, budget_id) VALUES (TG_TABLE_NAME, NEW.id, 'upsert', bid);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- txn_items have no budget of their own — they log an 'upsert' of their PARENT transaction,
-- whose budget_id we read in the same lookup that guards against logging a cascade-deleted parent.
CREATE OR REPLACE FUNCTION log_txn_item_change() RETURNS trigger AS $$
DECLARE tid uuid;
DECLARE bid uuid;
BEGIN
  tid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT budget_id INTO bid FROM transactions WHERE id = tid;
  -- guard: on a parent DELETE cascade the parent is already gone — do not log
  -- (its own 'delete' entry is enough)
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('enveo:changes')::bigint);
    INSERT INTO changes (table_name, row_id, op, budget_id) VALUES ('transactions', tid, 'upsert', bid);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

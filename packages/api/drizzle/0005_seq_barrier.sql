-- Sync cursor barrier (fixes the MAX(seq) vs in-flight transactions race).
--
-- `changes.seq` (BIGSERIAL) is assigned at INSERT, but becomes visible only
-- after COMMIT — commit order does NOT match seq order. A cursor computed as
-- MAX(seq) could therefore skip past the seq of a transaction that had not
-- committed yet (e.g. a long import): the client received a cursor > N before
-- N became visible and would then NEVER fetch that change again (a permanent,
-- silent replica divergence).
--
-- Solution: every writer to the log takes a SHARED advisory xact lock BEFORE
-- it is assigned a seq (here, in the triggers — this covers REST, push,
-- imports, seed and FK cascades); the cursor reader (snapshot/pull in
-- routes/sync.ts) takes the same lock EXCLUSIVELY, so it waits until all
-- started writes have finished and holds off new ones for the duration of the
-- read — MAX(seq) then sees every assigned seq. Lock key:
-- hashtext('enveo:changes') — it must match routes/sync.ts.
CREATE OR REPLACE FUNCTION log_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('enveo:changes')::bigint);
  IF TG_OP = 'DELETE' THEN
    INSERT INTO changes (table_name, row_id, op) VALUES (TG_TABLE_NAME, OLD.id, 'delete');
    RETURN OLD;
  END IF;
  INSERT INTO changes (table_name, row_id, op) VALUES (TG_TABLE_NAME, NEW.id, 'upsert');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION log_txn_item_change() RETURNS trigger AS $$
DECLARE tid uuid;
BEGIN
  tid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  -- guard: on a parent DELETE cascade the parent is already gone — do not log
  -- (its own 'delete' entry is enough)
  IF EXISTS (SELECT 1 FROM transactions WHERE id = tid) THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('enveo:changes')::bigint);
    INSERT INTO changes (table_name, row_id, op) VALUES ('transactions', tid, 'upsert');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

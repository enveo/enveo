-- Rebranding of the sync barrier advisory lock key: hashtext('enveo:changes').
--
-- The functions from 0005 are already deployed on existing databases with the
-- OLD key — this migration replaces them (CREATE OR REPLACE) so that the key
-- matches routes/sync.ts after the rename. On fresh databases this is a
-- semantic no-op (0005 already creates them with the new key). The key value
-- itself is arbitrary — it only has to be IDENTICAL on the writer side
-- (triggers) and in the cursor reader.
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

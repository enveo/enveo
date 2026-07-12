CREATE TABLE IF NOT EXISTS "changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"op" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_ops" (
	"op_id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_op_check" CHECK ("op" IN ('upsert','delete'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION log_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO changes (table_name, row_id, op) VALUES (TG_TABLE_NAME, OLD.id, 'delete');
    RETURN OLD;
  END IF;
  INSERT INTO changes (table_name, row_id, op) VALUES (TG_TABLE_NAME, NEW.id, 'upsert');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER accounts_log_change AFTER INSERT OR UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE TRIGGER envelope_groups_log_change AFTER INSERT OR UPDATE OR DELETE ON envelope_groups FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE TRIGGER envelopes_log_change AFTER INSERT OR UPDATE OR DELETE ON envelopes FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE TRIGGER categories_log_change AFTER INSERT OR UPDATE OR DELETE ON categories FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE TRIGGER places_log_change AFTER INSERT OR UPDATE OR DELETE ON places FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE TRIGGER recurrences_log_change AFTER INSERT OR UPDATE OR DELETE ON recurrences FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE TRIGGER transactions_log_change AFTER INSERT OR UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE TRIGGER allocations_log_change AFTER INSERT OR UPDATE OR DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION log_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION log_txn_item_change() RETURNS trigger AS $$
DECLARE tid uuid;
BEGIN
  tid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  -- strażnik: przy kaskadzie DELETE rodzica rodzic już nie istnieje —
  -- nie loguj (wystarczy jego własny wpis 'delete')
  IF EXISTS (SELECT 1 FROM transactions WHERE id = tid) THEN
    INSERT INTO changes (table_name, row_id, op) VALUES ('transactions', tid, 'upsert');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER txn_items_log_change AFTER INSERT OR UPDATE OR DELETE ON txn_items FOR EACH ROW EXECUTE FUNCTION log_txn_item_change();

ALTER TABLE "budgets" ADD COLUMN "currency" text DEFAULT 'PLN' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER budgets_log_change AFTER INSERT OR UPDATE OR DELETE ON budgets FOR EACH ROW EXECUTE FUNCTION log_change();

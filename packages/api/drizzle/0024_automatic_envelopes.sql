ALTER TABLE "accounts" ADD COLUMN "automatic_envelope_id" uuid;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "allocation_from_envelope_id" uuid;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "allocation_to_envelope_id" uuid;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_automatic_envelope_id_envelopes_id_fk" FOREIGN KEY ("automatic_envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_allocation_from_envelope_id_envelopes_id_fk" FOREIGN KEY ("allocation_from_envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_allocation_to_envelope_id_envelopes_id_fk" FOREIGN KEY ("allocation_to_envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "accounts_automatic_envelope_idx" ON "accounts" USING btree ("automatic_envelope_id");
--> statement-breakpoint
CREATE INDEX "txn_allocation_from_envelope_idx" ON "transactions" USING btree ("allocation_from_envelope_id");
--> statement-breakpoint
CREATE INDEX "txn_allocation_to_envelope_idx" ON "transactions" USING btree ("allocation_to_envelope_id");

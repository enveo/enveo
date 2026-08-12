-- Cloud operator-key AI spend budget (backlog §1): one aggregate row per (policy, user, UTC
-- calendar month). The counter is check-then-record with NO reservations: `spent_nano_usd` only
-- ever grows by atomic upsert-increments of ACTUAL usage-derived cost, may overshoot the policy
-- threshold (accepted), and is read before each upstream attempt. Amounts are integer nano-USD
-- (1 USD = 1e9) — never floats. The period key is derived from Postgres time ('YYYY-MM', UTC);
-- period_start/period_end pin the half-open [monthStartUtc, nextMonthStartUtc) interval.
-- Deliberately NO cleanup/retention job in this implementation, and no per-request billing
-- ledger — the product accepts approximate enforcement.
-- (Statements are drizzle-kit-generated from schema.ts so meta/0020_snapshot.json agrees with
-- this file; `bun run db:generate` on this tree must emit no new migration.)
CREATE TABLE "ai_user_monthly_spend" (
	"policy" text NOT NULL,
	"user_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_user_monthly_spend_policy_user_id_period_key_pk" PRIMARY KEY("policy","user_id","period_key"),
	CONSTRAINT "ai_user_monthly_spend_nonneg" CHECK ("ai_user_monthly_spend"."spent_nano_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_user_monthly_spend" ADD CONSTRAINT "ai_user_monthly_spend_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
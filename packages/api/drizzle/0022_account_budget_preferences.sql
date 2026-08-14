-- Durable settings scopes: account preferences follow the authenticated user; budget
-- preferences follow a plain replica. E2EE rows deliberately remain NULL so their settings
-- exist only inside encrypted operations/checkpoints.
CREATE TABLE "account_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"lang" text NOT NULL,
	"theme_mode" text NOT NULL,
	"accent_theme" text NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_preferences_lang_valid" CHECK ("account_preferences"."lang" IN ('en','pl','de','es','fr','it','nl','pt-BR','cs','sv')),
	CONSTRAINT "account_preferences_theme_mode_valid" CHECK ("account_preferences"."theme_mode" IN ('light','dark','auto')),
	CONSTRAINT "account_preferences_accent_theme_valid" CHECK ("account_preferences"."accent_theme" IN ('teal','duet')),
	CONSTRAINT "account_preferences_revision_nonnegative" CHECK ("account_preferences"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_preferences" ADD CONSTRAINT "account_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "preferences" jsonb;

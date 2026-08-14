-- One protected OpenAI credential per budget. Plain-tier rows use server-side envelope
-- encryption; E2EE rows contain only browser-produced v2 ciphertext. No plaintext, key
-- fragment, or display prefix is stored.
CREATE TABLE "budget_ai_credentials" (
	"budget_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"storage_kind" text NOT NULL,
	"framing_version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"wrapped_record_dek" text,
	"master_key_id" text,
	"e2ee_epoch" integer,
	"record_version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_ai_credentials_provider_valid" CHECK ("budget_ai_credentials"."provider" = 'openai'),
	CONSTRAINT "budget_ai_credentials_ciphertext_nonempty" CHECK (char_length("budget_ai_credentials"."ciphertext") > 0),
	CONSTRAINT "budget_ai_credentials_record_version_positive" CHECK ("budget_ai_credentials"."record_version" > 0),
	CONSTRAINT "budget_ai_credentials_storage_shape_valid" CHECK (
		("budget_ai_credentials"."storage_kind" = 'server_vault'
			AND "budget_ai_credentials"."framing_version" = 1
			AND "budget_ai_credentials"."wrapped_record_dek" IS NOT NULL
			AND char_length("budget_ai_credentials"."wrapped_record_dek") > 0
			AND "budget_ai_credentials"."master_key_id" IS NOT NULL
			AND char_length("budget_ai_credentials"."master_key_id") > 0
			AND "budget_ai_credentials"."e2ee_epoch" IS NULL)
		OR
		("budget_ai_credentials"."storage_kind" = 'e2ee_ciphertext'
			AND "budget_ai_credentials"."framing_version" = 2
			AND "budget_ai_credentials"."wrapped_record_dek" IS NULL
			AND "budget_ai_credentials"."master_key_id" IS NULL
			AND "budget_ai_credentials"."e2ee_epoch" >= 0)
	)
);
--> statement-breakpoint
ALTER TABLE "budget_ai_credentials" ADD CONSTRAINT "budget_ai_credentials_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;

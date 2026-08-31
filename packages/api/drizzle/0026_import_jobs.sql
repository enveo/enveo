CREATE TABLE "import_job_images" (
	"job_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_length" integer NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "import_job_images_job_id_position_pk" PRIMARY KEY("job_id","position"),
	CONSTRAINT "import_job_images_position_nonnegative" CHECK ("import_job_images"."position" >= 0),
	CONSTRAINT "import_job_images_sha256_valid" CHECK ("import_job_images"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_job_images_byte_length_valid" CHECK ("import_job_images"."byte_length" > 0 AND octet_length("import_job_images"."content") = "import_job_images"."byte_length")
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"locale" text NOT NULL,
	"tier" text NOT NULL,
	"epoch" integer NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"resume_phase" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"extraction" jsonb,
	"result" jsonb,
	"proposal_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"retry_at" timestamp with time zone,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "import_jobs_client_nonempty" CHECK (char_length("import_jobs"."client_id") > 0),
	CONSTRAINT "import_jobs_model_nonempty" CHECK (char_length("import_jobs"."model") > 0),
	CONSTRAINT "import_jobs_locale_nonempty" CHECK (char_length("import_jobs"."locale") > 0),
	CONSTRAINT "import_jobs_request_hash_valid" CHECK ("import_jobs"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_jobs_provider_valid" CHECK ("import_jobs"."provider" IN ('enveo', 'openai')),
	CONSTRAINT "import_jobs_tier_valid" CHECK ("import_jobs"."tier" IN ('plain', 'e2ee')),
	CONSTRAINT "import_jobs_status_valid" CHECK ("import_jobs"."status" IN ('queued', 'running', 'ready', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "import_jobs_phase_valid" CHECK ("import_jobs"."phase" IN ('preparing', 'uploading', 'queued', 'extracting', 'validating', 'enriching', 'reconciling', 'ready', 'applying', 'completed', 'waiting_for_network', 'waiting_for_device', 'waiting_for_unlock', 'retry_scheduled')),
	CONSTRAINT "import_jobs_resume_phase_valid" CHECK ("import_jobs"."resume_phase" IS NULL OR "import_jobs"."resume_phase" IN ('extracting', 'validating', 'enriching', 'reconciling')),
	CONSTRAINT "import_jobs_error_code_valid" CHECK ("import_jobs"."error_code" IS NULL OR "import_jobs"."error_code" IN ('network', 'ai_timeout', 'ai_budget_exhausted', 'ai_key_invalid', 'ai_model_unavailable', 'malformed_model_response', 'budget_mismatch', 'tier_mismatch', 'account_unavailable', 'expired')),
	CONSTRAINT "import_jobs_counters_nonnegative" CHECK ("import_jobs"."epoch" >= 0 AND "import_jobs"."attempt" >= 0 AND "import_jobs"."proposal_count" >= 0 AND "import_jobs"."applied_count" >= 0 AND "import_jobs"."skipped_count" >= 0),
	CONSTRAINT "import_jobs_lease_shape_valid" CHECK (("import_jobs"."lease_owner" IS NULL AND "import_jobs"."lease_token" IS NULL AND "import_jobs"."lease_expires_at" IS NULL) OR ("import_jobs"."lease_owner" IS NOT NULL AND char_length("import_jobs"."lease_owner") > 0 AND "import_jobs"."lease_token" IS NOT NULL AND "import_jobs"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "import_jobs_expiry_valid" CHECK ("import_jobs"."expires_at" > "import_jobs"."created_at")
);
--> statement-breakpoint
ALTER TABLE "import_job_images" ADD CONSTRAINT "import_job_images_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_user_updated_idx" ON "import_jobs" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_jobs_claim_idx" ON "import_jobs" USING btree ("status","retry_at","lease_expires_at");--> statement-breakpoint
CREATE FUNCTION "enforce_ready_import_job_has_no_images"() RETURNS trigger AS $$
BEGIN
	IF NEW.status = 'ready' AND EXISTS (SELECT 1 FROM import_job_images WHERE job_id = NEW.id) THEN
		RAISE EXCEPTION 'ready_import_job_has_images' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "import_jobs_ready_without_images"
	AFTER INSERT OR UPDATE OF status ON "import_jobs"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "enforce_ready_import_job_has_no_images"();--> statement-breakpoint
CREATE FUNCTION "enforce_import_job_image_parent_not_ready"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM import_jobs WHERE id = NEW.job_id AND status = 'ready') THEN
		RAISE EXCEPTION 'ready_import_job_has_images' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "import_job_images_parent_not_ready"
	AFTER INSERT OR UPDATE ON "import_job_images"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "enforce_import_job_image_parent_not_ready"();

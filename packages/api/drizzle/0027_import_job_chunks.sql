ALTER TABLE "import_jobs" ADD COLUMN "screenshot_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "screenshots_read" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "screenshots_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "partial_retry_job_id" uuid;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "partial_image_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_partial_retry_job_id_import_jobs_id_fk" FOREIGN KEY ("partial_retry_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_screenshot_counters_valid" CHECK ("import_jobs"."screenshot_total" >= 0 AND "import_jobs"."screenshots_read" >= 0 AND "import_jobs"."screenshots_failed" >= 0 AND "import_jobs"."screenshots_read" + "import_jobs"."screenshots_failed" <= "import_jobs"."screenshot_total" AND "import_jobs"."partial_image_count" >= 0);--> statement-breakpoint
CREATE TABLE "import_job_chunks" (
	"job_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"image_start" integer NOT NULL,
	"image_end" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"retry_at" timestamp with time zone,
	"extraction" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_job_chunks_job_id_chunk_index_pk" PRIMARY KEY("job_id","chunk_index"),
	CONSTRAINT "import_job_chunks_range_valid" CHECK ("import_job_chunks"."chunk_index" >= 0 AND "import_job_chunks"."image_start" >= 0 AND "import_job_chunks"."image_end" > "import_job_chunks"."image_start"),
	CONSTRAINT "import_job_chunks_status_valid" CHECK ("import_job_chunks"."status" IN ('pending', 'extracted', 'failed')),
	CONSTRAINT "import_job_chunks_attempt_nonnegative" CHECK ("import_job_chunks"."attempt" >= 0),
	CONSTRAINT "import_job_chunks_error_code_valid" CHECK ("import_job_chunks"."error_code" IS NULL OR "import_job_chunks"."error_code" IN ('network', 'ai_timeout', 'ai_budget_exhausted', 'ai_key_invalid', 'ai_model_unavailable', 'malformed_model_response', 'budget_mismatch', 'tier_mismatch', 'account_unavailable', 'expired')),
	CONSTRAINT "import_job_chunks_extraction_shape" CHECK (("import_job_chunks"."status" = 'extracted') = ("import_job_chunks"."extraction" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "import_job_chunks" ADD CONSTRAINT "import_job_chunks_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Jobs created before chunking that still wait for cycle one get one pending chunk row per
-- window of six retained screenshots, so the chunked worker resumes them without a re-upload.
INSERT INTO "import_job_chunks" ("job_id", "chunk_index", "image_start", "image_end", "status", "updated_at")
SELECT j."id", gs."i", gs."i" * 6, LEAST(c."n", gs."i" * 6 + 6), 'pending', now()
FROM "import_jobs" j
JOIN (SELECT "job_id", count(*)::integer AS "n" FROM "import_job_images" GROUP BY "job_id") c ON c."job_id" = j."id"
CROSS JOIN LATERAL generate_series(0, ((c."n" + 5) / 6) - 1) AS gs("i")
WHERE j."extraction" IS NULL AND j."status" IN ('queued', 'running', 'failed');--> statement-breakpoint
UPDATE "import_jobs" j SET "screenshot_total" = c."n"
FROM (SELECT "job_id", count(*)::integer AS "n" FROM "import_job_images" GROUP BY "job_id") c
WHERE c."job_id" = j."id" AND j."extraction" IS NULL AND j."status" IN ('queued', 'running', 'failed');

-- 4.7.0: the account colour theme gains "auto" (Duet on phones, Cisza on wider screens) and it
-- becomes the default. Rows holding the OLD default ('teal') move to 'auto': 'teal' was the value
-- every row was created with, so it never distinguished a deliberate Cisza choice from "never
-- touched"; anyone who wants Cisza on the phone picks it again in Settings. The revision bump makes
-- every device adopt the new value on its next preference sync instead of trusting its cache.
ALTER TABLE "account_preferences" DROP CONSTRAINT "account_preferences_accent_theme_valid";--> statement-breakpoint
ALTER TABLE "account_preferences" ADD CONSTRAINT "account_preferences_accent_theme_valid" CHECK ("account_preferences"."accent_theme" IN ('auto','teal','duet'));--> statement-breakpoint
UPDATE "account_preferences" SET "accent_theme" = 'auto', "revision" = "revision" + 1, "updated_at" = now() WHERE "accent_theme" = 'teal';

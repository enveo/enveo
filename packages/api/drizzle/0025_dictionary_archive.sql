ALTER TABLE "categories" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;

ALTER TABLE "containers" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "containers" ADD COLUMN "detail_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "compose_projects" ADD COLUMN "detail_observed_at" timestamp with time zone;

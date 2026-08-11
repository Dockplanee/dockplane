ALTER TABLE "hosts" ADD COLUMN "agent_version" text;--> statement-breakpoint
ALTER TABLE "containers" ADD COLUMN "snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "compose_projects" ADD COLUMN "services" jsonb;--> statement-breakpoint
ALTER TABLE "compose_projects" ADD COLUMN "snapshot_id" uuid;

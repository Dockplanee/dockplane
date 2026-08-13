--
-- Deploying a stack, as something that is written down before it happens.
--
-- A deployment reaches a host, creates containers and may stop halfway. The
-- record of the attempt has to exist before any of that, or a control server
-- that dies mid-deployment leaves containers on a host with nothing saying they
-- were meant to be there.
--
CREATE TABLE "stack_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	--
	-- Which kind of deployment this is. Only an initial deployment exists so
	-- far; the column is here because the guard below has to be able to
	-- distinguish them later without a migration that rewrites live rows.
	--
	"kind" text DEFAULT 'initial' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"action_id" uuid,
	"started_by" uuid,
	--
	-- Per service: what happened and where it stopped. Names and codes only,
	-- never a value from the plan.
	--
	"detail" jsonb,
	"failure_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "stack_deployments" ADD CONSTRAINT "stack_deployments_stack_id_fk"
	FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_deployments" ADD CONSTRAINT "stack_deployments_revision_id_fk"
	FOREIGN KEY ("revision_id") REFERENCES "public"."stack_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_deployments" ADD CONSTRAINT "stack_deployments_host_id_fk"
	FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_deployments" ADD CONSTRAINT "stack_deployments_started_by_fk"
	FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
--
-- One unfinished deployment per stack, enforced by the database.
--
-- The in-memory lock cannot answer this. It is empty after a restart, while the
-- containers a half-finished deployment created are still on the host — and a
-- second deployment started against that state would be creating a stack over
-- the remains of one nobody has looked at yet.
--
-- `needs_attention` counts as unfinished on purpose. A deployment that created
-- some of its containers and then stopped is not over; it is waiting for a
-- person.
--
CREATE UNIQUE INDEX "stack_deployments_unresolved_unique" ON "stack_deployments" ("stack_id")
	WHERE status IN ('pending', 'running', 'interrupted', 'needs_attention');--> statement-breakpoint
CREATE INDEX "stack_deployments_stack_idx" ON "stack_deployments" ("stack_id");--> statement-breakpoint
CREATE INDEX "stack_deployments_host_idx" ON "stack_deployments" ("host_id");--> statement-breakpoint
--
-- Which stack a container belongs to, and which service of it.
--
-- Written from the labels the agent set, so a container found by discovery is
-- attributed to the stack that created it rather than to a name that matched.
-- Nulled rather than deleted when a stack goes: the container may still be on
-- the host, and a row that vanished would make it look unmanaged.
--
ALTER TABLE "containers" ADD COLUMN "stack_id" uuid;--> statement-breakpoint
ALTER TABLE "containers" ADD COLUMN "stack_service" text;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_stack_id_fk"
	FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
--
-- One container per service of a stack.
--
-- A service is one container in this product, and the resource behind it is
-- stable across replacements. Two rows claiming the same service would mean
-- nothing could say which container a service is.
--
CREATE UNIQUE INDEX "containers_stack_service_unique" ON "containers" ("stack_id", "stack_service")
	WHERE stack_id IS NOT NULL AND stack_service IS NOT NULL;--> statement-breakpoint
CREATE INDEX "containers_stack_idx" ON "containers" ("stack_id");

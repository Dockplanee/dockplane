--
-- Starting, stopping and restarting a stack that is already deployed.
--
-- Its own table rather than a row in `stack_deployments`, because it is not a
-- deployment: no revision is applied, no container is created or recreated, and
-- neither the newest saved revision nor the deployed one changes. Recording it
-- as a deployment would make the history say a revision was applied when none
-- was, and every query that counts deployments would start counting restarts.
--
CREATE TABLE "stack_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"action_id" uuid,
	"started_by" uuid,
	"fingerprint" jsonb,
	"detail" jsonb,
	"failure_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "stack_operations" ADD CONSTRAINT "stack_operations_stack_id_fk"
	FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
--
-- The revision the operation is for.
--
-- An operation moves the containers of one revision. A host found running
-- another means the two sides disagree about what is deployed, which a start or
-- a stop must not paper over.
--
ALTER TABLE "stack_operations" ADD CONSTRAINT "stack_operations_revision_id_fk"
	FOREIGN KEY ("revision_id") REFERENCES "public"."stack_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_operations" ADD CONSTRAINT "stack_operations_host_id_fk"
	FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_operations" ADD CONSTRAINT "stack_operations_started_by_fk"
	FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stack_operations_stack_idx" ON "stack_operations" ("stack_id");--> statement-breakpoint
CREATE INDEX "stack_operations_host_idx" ON "stack_operations" ("host_id");--> statement-breakpoint
--
-- One unfinished operation per stack.
--
-- The in-memory lock covers one running process; this covers the restart that
-- clears it, where the containers an unfinished operation moved are still
-- exactly as it left them.
--
-- A deployment and an operation block each other as well. No index across two
-- tables can say that, so the guard every stack mutation goes through reads
-- both of them.
--
CREATE UNIQUE INDEX "stack_operations_unresolved_unique" ON "stack_operations" ("stack_id")
	WHERE status IN ('pending', 'running', 'interrupted');

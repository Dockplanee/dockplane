CREATE TABLE "stacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_type" text DEFAULT 'dockplane' NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"current_revision_id" uuid,
	"desired_revision_id" uuid,
	"created_by" uuid,
	"last_deployed_at" timestamp with time zone,
	"adopted_at" timestamp with time zone,
	"compose_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"compose_source_encrypted" text NOT NULL,
	"environment_snapshot" jsonb NOT NULL,
	"change_summary" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_environment_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"value_encrypted" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_revisions" ADD CONSTRAINT "stack_revisions_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_revisions" ADD CONSTRAINT "stack_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_environment_variables" ADD CONSTRAINT "stack_environment_variables_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_environment_variables" ADD CONSTRAINT "stack_environment_variables_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stacks_host_name_unique" ON "stacks" USING btree ("host_id","name");--> statement-breakpoint
CREATE INDEX "stacks_host_idx" ON "stacks" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stack_revisions_stack_number_unique" ON "stack_revisions" USING btree ("stack_id","number");--> statement-breakpoint
CREATE INDEX "stack_revisions_stack_idx" ON "stack_revisions" USING btree ("stack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stack_environment_stack_key_unique" ON "stack_environment_variables" USING btree ("stack_id","key");--> statement-breakpoint
CREATE INDEX "stack_environment_stack_idx" ON "stack_environment_variables" USING btree ("stack_id");--> statement-breakpoint
--
-- A secret has one place to live, and it is encrypted.
--
-- The application can be made to write the wrong column by a mistake nobody
-- notices; the database cannot. A secret variable must carry an envelope and no
-- plain value, and a non-secret must carry a plain value and no envelope.
--
ALTER TABLE "stack_environment_variables" ADD CONSTRAINT "stack_environment_secret_storage"
	CHECK (
		(is_secret = true AND value_encrypted IS NOT NULL AND value IS NULL)
		OR
		(is_secret = false AND value_encrypted IS NULL)
	);--> statement-breakpoint
--
-- Existing Compose projects stay exactly what they were.
--
-- Discovery keeps writing compose_projects and nothing in this migration reads
-- from it, creates a stack out of it, or marks it managed. A project becomes a
-- stack only by being adopted, which is a deliberate act by a person.
--
COMMENT ON TABLE "stacks" IS 'Stacks Dockplane deploys. Discovery never writes here; adoption is explicit.';

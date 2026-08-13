--
-- Saved and deployed are two different things.
--
-- The stack table already records which revision is deployed. It had no way to
-- say which one is the newest somebody saved, and those separate the moment a
-- stack can be edited without being deployed — which is every stack, until a
-- deployment exists at all.
--
ALTER TABLE "stacks" ADD COLUMN "latest_revision_id" uuid;--> statement-breakpoint
--
-- What the revision was checked against.
--
-- A revision is validated by the Compose compiler before it is stored, so it is
-- worth being able to say afterwards which contract it passed. Versions rather
-- than a product version: what matters is the shape of the agreement, not which
-- build happened to be running.
--
ALTER TABLE "stack_revisions" ADD COLUMN "compiler_protocol_version" integer;--> statement-breakpoint
ALTER TABLE "stack_revisions" ADD COLUMN "plan_version" integer;--> statement-breakpoint
ALTER TABLE "stack_revisions" ADD COLUMN "validated_at" timestamp with time zone;--> statement-breakpoint
--
-- What the revision would create, without any of the values.
--
-- Service, network and volume names, so a listing can describe a stack without
-- decrypting its source. Nothing from the environment: a summary that carried a
-- value would be a way to read one out of an endpoint that returns no values.
--
ALTER TABLE "stack_revisions" ADD COLUMN "summary" jsonb;--> statement-breakpoint
--
-- The environment belongs to the revision, not to the stack.
--
-- It was a JSON column on the revision and a mutable table on the stack. Neither
-- can carry the constraint that matters: a secret must have no column able to
-- hold it in the clear, and JSON has no columns at all. Rows can, and the
-- database enforces it here exactly as it does for a container's environment.
--
-- The old JSON column stops being required rather than being dropped: it is
-- part of a released schema, and nothing is served from it any more.
--
ALTER TABLE "stack_revisions" ALTER COLUMN "environment_snapshot" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE "stack_revision_environment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"value_encrypted" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "stack_revision_environment" ADD CONSTRAINT "stack_revision_environment_revision_id_fk"
	FOREIGN KEY ("revision_id") REFERENCES "public"."stack_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
--
-- A secret carries an envelope and no plain value; anything else carries a
-- plain value and no envelope. Enforced here rather than in whichever code path
-- happens to write the row, because a secret written into the wrong column is
-- not a bug anybody notices by reading the result.
--
ALTER TABLE "stack_revision_environment" ADD CONSTRAINT "stack_revision_environment_secret"
	CHECK (
		(is_secret AND value IS NULL AND value_encrypted IS NOT NULL)
		OR (NOT is_secret AND value_encrypted IS NULL)
	);--> statement-breakpoint
CREATE UNIQUE INDEX "stack_revision_environment_key_unique" ON "stack_revision_environment" USING btree ("revision_id","key");--> statement-breakpoint
CREATE INDEX "stack_revision_environment_revision_idx" ON "stack_revision_environment" USING btree ("revision_id");

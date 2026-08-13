--
-- Which revision an attempt moved the stack away from.
--
-- The last revision Dockplane had confirmed as running when the attempt was
-- requested, not whatever the host happened to look like: after a deployment
-- that stopped halfway a host can be mixed, and the thing an attempt has to be
-- judged against is the last state that was ever established.
--
-- Null for the first deployment of a stack, which came from nothing.
--
ALTER TABLE "stack_deployments" ADD COLUMN "from_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "stack_deployments" ADD CONSTRAINT "stack_deployments_from_revision_id_fk"
	FOREIGN KEY ("from_revision_id") REFERENCES "public"."stack_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
--
-- Needing attention is an answer, not an unfinished attempt.
--
-- It used to count as unresolved, which blocked the stack completely: the only
-- way out of a half-applied deployment is to apply a revision to it deliberately,
-- and that is a new attempt. What must stay impossible is a second attempt while
-- one is still running or its outcome is unknown.
--
-- The stack itself still reports that it needs attention, and direct container
-- operations on its services stay blocked until somebody resolves it.
--
DROP INDEX "stack_deployments_unresolved_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "stack_deployments_unresolved_unique" ON "stack_deployments" ("stack_id")
	WHERE status IN ('pending', 'running', 'interrupted');--> statement-breakpoint
--
-- The revision a container says it is running.
--
-- Read from the label the agent stamped on it. This is what makes "is this
-- stack revision B" a question about the host rather than an inference from a
-- configuration nobody can observe — a revision that changed only a secret is
-- indistinguishable in every other way.
--
ALTER TABLE "containers" ADD COLUMN "stack_revision_id" text;

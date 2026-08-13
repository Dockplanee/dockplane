--
-- A configuration gets an identity of its own, and a container may have two.
--
-- Replacing a container is a Docker side effect, and no database transaction
-- can roll one back. So the configuration a container is being asked to become
-- is written before the agent is asked to do anything, and becomes current only
-- once a container running it has actually been observed. A control server that
-- dies halfway through finds both on restart and can tell which one happened.
--
-- Telling them apart cannot be done by comparing observed configuration: a
-- replacement may change nothing but a secret, and observed state deliberately
-- contains no environment values at all. So the container carries the identity
-- of the configuration it represents, as a label, and recovery reads that
-- instead of guessing.
--
ALTER TABLE "container_desired_configs" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "container_desired_configs" ADD COLUMN "state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "container_desired_configs" ADD COLUMN "action_id" uuid;--> statement-breakpoint
--
-- Anything that existed before this migration is what its container is, by
-- definition: there was no way to record an intention that had not been applied.
--
UPDATE "container_desired_configs" SET "state" = 'current';--> statement-breakpoint
ALTER TABLE "container_desired_configs" DROP CONSTRAINT "container_desired_configs_pkey";--> statement-breakpoint
ALTER TABLE "container_desired_configs" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "container_desired_configs" ADD CONSTRAINT "container_desired_configs_state"
	CHECK (state IN ('current', 'pending'));--> statement-breakpoint
--
-- One of each per container. Two currents would mean nobody could say what a
-- container is supposed to be, and two pendings would mean two mutations were
-- in flight against one container.
--
CREATE UNIQUE INDEX "container_desired_current_unique" ON "container_desired_configs" USING btree ("container_id") WHERE state = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "container_desired_pending_unique" ON "container_desired_configs" USING btree ("container_id") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "container_desired_container_idx" ON "container_desired_configs" USING btree ("container_id");--> statement-breakpoint
--
-- Environment belongs to a configuration, not to a container.
--
-- While a replacement is pending a container has two configurations, and a
-- variable hanging off the container could not say which one it was part of —
-- which for a secret means not being able to say which value is running.
--
ALTER TABLE "container_environment_variables" ADD COLUMN "desired_config_id" uuid;--> statement-breakpoint
UPDATE "container_environment_variables" e
	SET "desired_config_id" = c."id"
	FROM "container_desired_configs" c
	WHERE c."container_id" = e."container_id" AND c."state" = 'current';--> statement-breakpoint
--
-- Fail closed. A variable that could not be resolved to exactly one current
-- configuration stops the migration rather than being dropped or attached to
-- whichever configuration came first: losing a secret quietly is worse than
-- refusing to upgrade.
--
ALTER TABLE "container_environment_variables" ALTER COLUMN "desired_config_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "container_environment_variables" DROP CONSTRAINT "container_environment_variables_container_id_containers_id_fk";--> statement-breakpoint
DROP INDEX "container_environment_container_key_unique";--> statement-breakpoint
DROP INDEX "container_environment_container_idx";--> statement-breakpoint
ALTER TABLE "container_environment_variables" DROP COLUMN "container_id";--> statement-breakpoint
ALTER TABLE "container_environment_variables" ADD CONSTRAINT "container_environment_variables_desired_config_id_fk" FOREIGN KEY ("desired_config_id") REFERENCES "public"."container_desired_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "container_environment_config_key_unique" ON "container_environment_variables" USING btree ("desired_config_id","key");--> statement-breakpoint
CREATE INDEX "container_environment_config_idx" ON "container_environment_variables" USING btree ("desired_config_id");

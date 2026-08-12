CREATE TABLE "container_desired_configs" (
	"container_id" uuid PRIMARY KEY NOT NULL,
	"image" text NOT NULL,
	"hostname" text,
	"command" jsonb,
	"entrypoint" jsonb,
	"ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"networks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restart_policy" text DEFAULT 'no' NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"healthcheck" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "container_environment_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"container_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"value_encrypted" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "container_desired_configs" ADD CONSTRAINT "container_desired_configs_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_desired_configs" ADD CONSTRAINT "container_desired_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_environment_variables" ADD CONSTRAINT "container_environment_variables_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "container_environment_container_key_unique" ON "container_environment_variables" USING btree ("container_id","key");--> statement-breakpoint
CREATE INDEX "container_environment_container_idx" ON "container_environment_variables" USING btree ("container_id");--> statement-breakpoint
--
-- A secret has one place to live, and it is encrypted. The same rule as a
-- stack's environment, enforced by the database rather than by whichever code
-- path happens to write the row.
--
ALTER TABLE "container_environment_variables" ADD CONSTRAINT "container_environment_secret_storage"
	CHECK (
		(is_secret = true AND value_encrypted IS NOT NULL AND value IS NULL)
		OR
		(is_secret = false AND value_encrypted IS NULL)
	);

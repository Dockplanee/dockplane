CREATE TABLE "host_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_hash" text NOT NULL,
	"ticket_expires_at" timestamp with time zone NOT NULL,
	"ticket_consumed_at" timestamp with time zone,
	"ticket_issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"enrollment_token_id" uuid,
	"agent_id" uuid,
	"host_id" uuid,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "host_setups" ADD CONSTRAINT "host_setups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_setups" ADD CONSTRAINT "host_setups_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "host_setups_ticket_hash_unique" ON "host_setups" USING btree ("ticket_hash");--> statement-breakpoint
CREATE INDEX "host_setups_created_idx" ON "host_setups" USING btree ("created_at");

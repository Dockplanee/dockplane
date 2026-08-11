CREATE INDEX "audit_action_occurred_idx" ON "audit_entries" USING btree ("action","occurred_at" DESC NULLS LAST);

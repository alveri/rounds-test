ALTER TABLE "competitors" ADD COLUMN "poll_lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "snapshots_previous_idx" ON "snapshots" USING btree ("previous_id");
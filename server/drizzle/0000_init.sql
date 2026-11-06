CREATE TYPE "public"."summary_status" AS ENUM('none', 'pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_poll_error" text
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"competitor_id" text NOT NULL,
	"previous_id" bigint,
	"fetched_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"tagline" text NOT NULL,
	"price" text NOT NULL,
	"description" text NOT NULL,
	"content_hash" text NOT NULL,
	"changed" boolean NOT NULL,
	"summary" text,
	"summary_status" "summary_status" DEFAULT 'none' NOT NULL,
	"summary_attempts" integer DEFAULT 0 NOT NULL,
	"summary_next_attempt_at" timestamp with time zone,
	"summary_error" text
);
--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_previous_id_snapshots_id_fk" FOREIGN KEY ("previous_id") REFERENCES "public"."snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitors_due_idx" ON "competitors" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "snapshots_timeline_idx" ON "snapshots" USING btree ("competitor_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "snapshots_pending_idx" ON "snapshots" USING btree ("summary_next_attempt_at") WHERE "snapshots"."summary_status" = 'pending';
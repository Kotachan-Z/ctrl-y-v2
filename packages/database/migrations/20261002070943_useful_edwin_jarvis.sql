CREATE TABLE "push_retry_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"task_name" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text NOT NULL,
	CONSTRAINT "push_retry_attempts_nonnegative" CHECK ("push_retry_queue"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "push_retry_queue" ADD CONSTRAINT "push_retry_queue_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_retry_due_idx" ON "push_retry_queue" USING btree ("next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "push_retry_parent_idx" ON "push_retry_queue" USING btree ("parent_id");
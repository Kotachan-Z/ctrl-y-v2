CREATE TYPE "public"."task_status" AS ENUM('TODO', 'IN_PROGRESS', 'WAIT_REVIEW', 'DONE');--> statement-breakpoint
CREATE TABLE "children" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "children_id_parent_unique" UNIQUE("id","parent_id")
);
--> statement-breakpoint
CREATE TABLE "parents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"keyword" text DEFAULT '' NOT NULL,
	"cutoff_day" boolean DEFAULT false NOT NULL,
	"pay_day" boolean DEFAULT false NOT NULL,
	"push_subscription" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parents_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "payroll" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"child_id" uuid NOT NULL,
	"month" date NOT NULL,
	"completed_task_count" integer DEFAULT 0 NOT NULL,
	"total_reward" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_child_month_unique" UNIQUE("child_id","month"),
	CONSTRAINT "payroll_month_start" CHECK (extract(day from "payroll"."month") = 1),
	CONSTRAINT "payroll_nonnegative" CHECK ("payroll"."completed_task_count" >= 0 and "payroll"."total_reward" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"child_id" uuid,
	"name" text NOT NULL,
	"memo" text,
	"reward" integer NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" "task_status" DEFAULT 'TODO' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_reward_nonnegative" CHECK ("tasks"."reward" >= 0)
);
--> statement-breakpoint
ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll" ADD CONSTRAINT "payroll_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_child_id_parent_id_children_id_parent_id_fk" FOREIGN KEY ("child_id","parent_id") REFERENCES "public"."children"("id","parent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "children_parent_idx" ON "children" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "tasks_child_idx" ON "tasks" USING btree ("child_id");
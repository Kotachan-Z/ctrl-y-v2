CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "push_retry_queue" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_parent_idx" ON "push_subscriptions" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "push_retry_queue" ADD CONSTRAINT "push_retry_queue_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "push_subscriptions" ("parent_id", "endpoint", "p256dh", "auth")
SELECT "id", "push_subscription"->>'endpoint',
       "push_subscription"->'keys'->>'p256dh',
       "push_subscription"->'keys'->>'auth'
FROM "parents"
WHERE "push_subscription"->>'endpoint' IS NOT NULL
  AND "push_subscription"->'keys'->>'p256dh' IS NOT NULL
  AND "push_subscription"->'keys'->>'auth' IS NOT NULL
ORDER BY "created_at", "id"
ON CONFLICT DO NOTHING;

ALTER TABLE "parents" ADD COLUMN "password_reset_hash" text;--> statement-breakpoint
ALTER TABLE "parents" ADD COLUMN "password_reset_expires_at" timestamp with time zone;
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"parent_id" uuid NOT NULL,
	"child_id" uuid,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"root_id" uuid NOT NULL,
	"previous_id" uuid,
	CONSTRAINT "refresh_tokens_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "refresh_tokens_previousId_unique" UNIQUE("previous_id"),
	CONSTRAINT "refresh_tokens_role_owner" CHECK (("refresh_tokens"."role" = 'parent' and "refresh_tokens"."child_id" is null) or ("refresh_tokens"."role" = 'child' and "refresh_tokens"."child_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_child_id_parent_id_children_id_parent_id_fk" FOREIGN KEY ("child_id","parent_id") REFERENCES "public"."children"("id","parent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_root_id_refresh_tokens_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_previous_id_refresh_tokens_id_fk" FOREIGN KEY ("previous_id") REFERENCES "public"."refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_root_idx" ON "refresh_tokens" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_parent_idx" ON "refresh_tokens" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_child_idx" ON "refresh_tokens" USING btree ("child_id");
CREATE TABLE "user_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"resend_domain_id" text NOT NULL,
	"region" text NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dns_check" jsonb,
	"last_verify_requested_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_domains_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_domains_name_unique" UNIQUE("name"),
	CONSTRAINT "user_domains_name_lowercase" CHECK ("user_domains"."name" = lower("user_domains"."name"))
);
--> statement-breakpoint
ALTER TABLE "user_domains" ADD CONSTRAINT "user_domains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_domains_resend_domain_id_idx" ON "user_domains" USING btree ("resend_domain_id");
CREATE TYPE "public"."agent_custody" AS ENUM('nanite', 'self');--> statement-breakpoint
CREATE TYPE "public"."arkiv_write_kind" AS ENUM('email', 'sent', 'extend');--> statement-breakpoint
CREATE TYPE "public"."arkiv_write_status" AS ENUM('queued', 'submitted', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."onboarding_state" AS ENUM('started', 'keys_created', 'name_claimed', 'done');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('allowed', 'denied');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processing', 'stored', 'dropped', 'failed');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"wallet_address" text NOT NULL,
	"ens_name" text NOT NULL,
	"resolver_address" text,
	"public_key" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"custody" "agent_custody" DEFAULT 'nanite' NOT NULL,
	"encrypted_private_key" "bytea",
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_user_derivation_unique" UNIQUE("user_id","derivation_index"),
	CONSTRAINT "agents_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "agents_ens_name_unique" UNIQUE("ens_name"),
	CONSTRAINT "agents_wallet_lowercase" CHECK ("agents"."wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "agents_name_label" CHECK ("agents"."name" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "agents_ens_name_lowercase" CHECK ("agents"."ens_name" = lower("agents"."ens_name")),
	CONSTRAINT "agents_resolver_lowercase" CHECK ("agents"."resolver_address" IS NULL OR "agents"."resolver_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "agents_derivation_index_nonneg" CHECK ("agents"."derivation_index" >= 0),
	CONSTRAINT "agents_self_custody_no_key" CHECK ("agents"."custody" <> 'self' OR "agents"."encrypted_private_key" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "arkiv_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "arkiv_write_kind" NOT NULL,
	"status" "arkiv_write_status" DEFAULT 'queued' NOT NULL,
	"entity_key" text,
	"tx_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"payload_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"endpoint" text NOT NULL,
	"status_code" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"wallet_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_nonces_nonce_unique" UNIQUE("nonce"),
	CONSTRAINT "auth_nonces_wallet_lowercase" CHECK ("auth_nonces"."wallet_address" IS NULL OR "auth_nonces"."wallet_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"name" text NOT NULL,
	"resend_domain_id" text,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"dns_records" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_name_unique" UNIQUE("name"),
	CONSTRAINT "domains_name_lowercase" CHECK ("domains"."name" = lower("domains"."name"))
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" "mailbox_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_address_lowercase" CHECK ("mailboxes"."address" = lower("mailboxes"."address"))
);
--> statement-breakpoint
CREATE TABLE "send_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"recipient_hash" text NOT NULL,
	"policy_decision" "policy_decision" NOT NULL,
	"policy_snapshot" jsonb,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"public_key" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"wrapped_private_key_wallet" "bytea" NOT NULL,
	"wrapped_private_key_recovery" "bytea" NOT NULL,
	"wrapped_seed_wallet" "bytea" NOT NULL,
	"wrapped_seed_recovery" "bytea" NOT NULL,
	"wallet_salt" "bytea" NOT NULL,
	"recovery_salt" "bytea" NOT NULL,
	"passphrase_mode" boolean DEFAULT false NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_keys_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_keys_key_version_positive" CHECK ("user_keys"."key_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"username" text NOT NULL,
	"ens_name" text,
	"onboarding_state" "onboarding_state" DEFAULT 'started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_wallet_lowercase" CHECK ("users"."wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "users_username_label" CHECK ("users"."username" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "users_ens_name_lowercase" CHECK ("users"."ens_name" IS NULL OR "users"."ens_name" = lower("users"."ens_name"))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"resend_email_id" text,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"arkiv_entity_key" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_unique" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_log" ADD CONSTRAINT "send_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_agent_id_idx" ON "api_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "arkiv_writes_status_created_idx" ON "arkiv_writes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "arkiv_writes_entity_key_idx" ON "arkiv_writes" USING btree ("entity_key");--> statement-breakpoint
CREATE INDEX "audit_log_agent_created_idx" ON "audit_log" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_nonces_expires_at_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "domains_owner_user_id_idx" ON "domains" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_unique" ON "mailboxes" USING btree ("address");--> statement-breakpoint
CREATE INDEX "mailboxes_agent_id_idx" ON "mailboxes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mailboxes_user_id_idx" ON "mailboxes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mailboxes_domain_id_idx" ON "mailboxes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "send_log_agent_created_idx" ON "send_log" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "send_log_agent_recipient_idx" ON "send_log" USING btree ("agent_id","recipient_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_keys_key_id_idx" ON "user_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "webhook_events_resend_email_id_idx" ON "webhook_events" USING btree ("resend_email_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");
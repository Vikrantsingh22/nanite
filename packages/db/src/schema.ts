/*
 * Nanite operational database schema (Postgres 17).
 *
 * NEVER stored in Postgres (enforced by review, not by the database):
 *   - email bodies, subjects, headers or raw mail (content lives encrypted on Arkiv)
 *   - plaintext private keys, the plaintext nanite seed, or wallet signatures
 *   - recovery codes (only the recovery-WRAPPED key material is stored)
 *   - the master key and the sender-hash HMAC secret (env / KMS only)
 *   - recipient email addresses in clear (send_log keeps an HMAC only)
 * Private key material appears only as ciphertext: user_keys.wrapped_* (wrapped by
 * wallet-derived or recovery-derived keys, client side) and agents.encrypted_private_key
 * (custody = 'nanite' only, encrypted under the server master key).
 * The database is meant to be rebuildable from Arkiv, ENS and the recovery code.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Lowercase 0x + 40 hex. */
const WALLET_RE = sql.raw(`'^0x[0-9a-f]{40}$'`);
/** ENS-label-safe: lowercase letters, digits, inner hyphens, 1-63 chars. */
const LABEL_RE = sql.raw(`'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`);

export const onboardingState = pgEnum("onboarding_state", [
  "started",
  "keys_created",
  "name_claimed",
  "done",
]);
export const domainStatus = pgEnum("domain_status", ["pending", "verified", "failed"]);
export const agentCustody = pgEnum("agent_custody", ["nanite", "self"]);
export const mailboxStatus = pgEnum("mailbox_status", ["active", "disabled"]);
export const webhookStatus = pgEnum("webhook_status", [
  "received",
  "processing",
  "stored",
  "dropped",
  "failed",
]);
export const arkivWriteKind = pgEnum("arkiv_write_kind", ["email", "sent", "extend"]);
export const arkivWriteStatus = pgEnum("arkiv_write_status", [
  "queued",
  "submitted",
  "confirmed",
  "failed",
]);
export const policyDecision = pgEnum("policy_decision", ["allowed", "denied"]);

export const users = pgTable(
  "users",
  {
    id: id(),
    walletAddress: text("wallet_address").notNull(),
    username: text("username").notNull(),
    ensName: text("ens_name"),
    onboardingState: onboardingState("onboarding_state").notNull().default("started"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("users_wallet_address_unique").on(t.walletAddress),
    unique("users_username_unique").on(t.username),
    check("users_wallet_lowercase", sql`${t.walletAddress} ~ ${WALLET_RE}`),
    check("users_username_label", sql`${t.username} ~ ${LABEL_RE}`),
    check("users_ens_name_lowercase", sql`${t.ensName} IS NULL OR ${t.ensName} = lower(${t.ensName})`),
  ],
);

/** Public key plus wrapped (encrypted) key material. Ciphertext only. */
export const userKeys = pgTable(
  "user_keys",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: bytea("public_key").notNull(),
    keyId: text("key_id").notNull(),
    wrappedPrivateKeyWallet: bytea("wrapped_private_key_wallet").notNull(),
    wrappedPrivateKeyRecovery: bytea("wrapped_private_key_recovery").notNull(),
    wrappedSeedWallet: bytea("wrapped_seed_wallet").notNull(),
    wrappedSeedRecovery: bytea("wrapped_seed_recovery").notNull(),
    walletSalt: bytea("wallet_salt").notNull(),
    recoverySalt: bytea("recovery_salt").notNull(),
    passphraseMode: boolean("passphrase_mode").notNull().default(false),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("user_keys_user_id_unique").on(t.userId),
    index("user_keys_key_id_idx").on(t.keyId),
    check("user_keys_key_version_positive", sql`${t.keyVersion} >= 1`),
  ],
);

export const domains = pgTable(
  "domains",
  {
    id: id(),
    /** Null for the shared demo domain. */
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    resendDomainId: text("resend_domain_id"),
    status: domainStatus("status").notNull().default("pending"),
    dnsRecords: jsonb("dns_records"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("domains_name_unique").on(t.name),
    index("domains_owner_user_id_idx").on(t.ownerUserId),
    check("domains_name_lowercase", sql`${t.name} = lower(${t.name})`),
  ],
);

/**
 * The mail domain every user adds during onboarding (T3.6). One per user. `records` is Resend's records array as
 * returned (DNS names and values are public data) and `dns_check` our own public-DNS lookup of each record
 * (`{ checkedAt, allFound, records: [{ key, found }] }`). `status` is stored as text: Resend's own values
 * (`not_started`, `pending`, `verified`, `failed`, `temporary_failure`) and whatever it adds later.
 */
export const userDomains = pgTable(
  "user_domains",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    resendDomainId: text("resend_domain_id").notNull(),
    region: text("region").notNull(),
    status: text("status").notNull().default("not_started"),
    records: jsonb("records").notNull().default(sql`'[]'::jsonb`),
    dnsCheck: jsonb("dns_check"),
    lastVerifyRequestedAt: timestamp("last_verify_requested_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("user_domains_user_id_unique").on(t.userId),
    unique("user_domains_name_unique").on(t.name),
    index("user_domains_resend_domain_id_idx").on(t.resendDomainId),
    check("user_domains_name_lowercase", sql`${t.name} = lower(${t.name})`),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ENS label, e.g. "alex". */
    name: text("name").notNull(),
    derivationIndex: integer("derivation_index").notNull(),
    walletAddress: text("wallet_address").notNull(),
    ensName: text("ens_name").notNull(),
    resolverAddress: text("resolver_address"),
    publicKey: bytea("public_key").notNull(),
    keyId: text("key_id").notNull(),
    custody: agentCustody("custody").notNull().default("nanite"),
    /** Only when custody = 'nanite', encrypted under the master key. Never plaintext. */
    encryptedPrivateKey: bytea("encrypted_private_key"),
    /** Address of the per-agent mail-signing key (published as ENS text `nanite.signer`). Null = unsigned mail. */
    signerAddress: text("signer_address"),
    /** The signing private key sealed under NANITE_MASTER_KEY (bound to the agent id). Never plaintext. */
    signerKeySealed: bytea("signer_key_sealed"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("agents_user_derivation_unique").on(t.userId, t.derivationIndex),
    unique("agents_wallet_address_unique").on(t.walletAddress),
    unique("agents_ens_name_unique").on(t.ensName),
    index("agents_user_id_idx").on(t.userId),
    check("agents_wallet_lowercase", sql`${t.walletAddress} ~ ${WALLET_RE}`),
    check("agents_name_label", sql`${t.name} ~ ${LABEL_RE}`),
    check("agents_ens_name_lowercase", sql`${t.ensName} = lower(${t.ensName})`),
    check(
      "agents_resolver_lowercase",
      sql`${t.resolverAddress} IS NULL OR ${t.resolverAddress} ~ ${WALLET_RE}`,
    ),
    check("agents_derivation_index_nonneg", sql`${t.derivationIndex} >= 0`),
    check(
      "agents_self_custody_no_key",
      sql`${t.custody} <> 'self' OR ${t.encryptedPrivateKey} IS NULL`,
    ),
  ],
);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: id(),
    address: text("address").notNull(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: mailboxStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Hot inbound lookup: WHERE address = lower($1). The unique index serves it.
    uniqueIndex("mailboxes_address_unique").on(t.address),
    index("mailboxes_agent_id_idx").on(t.agentId),
    index("mailboxes_user_id_idx").on(t.userId),
    index("mailboxes_domain_id_idx").on(t.domainId),
    check("mailboxes_address_lowercase", sql`${t.address} = lower(${t.address})`),
  ],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Hash of the token (e.g. SHA-256 hex). The token itself is shown once and never stored. */
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("api_tokens_token_hash_unique").on(t.tokenHash),
    index("api_tokens_agent_id_idx").on(t.agentId),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    resendEmailId: text("resend_email_id"),
    status: webhookStatus("status").notNull().default("received"),
    arkivEntityKey: text("arkiv_entity_key"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("webhook_events_provider_event_unique").on(t.provider, t.providerEventId),
    index("webhook_events_resend_email_id_idx").on(t.resendEmailId),
    index("webhook_events_status_idx").on(t.status),
  ],
);

/**
 * Write ledger for operator Arkiv writes. For inbound mail there is one row per (webhook event,
 * mailbox): it makes retries idempotent per recipient (a `confirmed` row is never written again).
 * Holds pointers, status and non-content error codes only: never ciphertext or plaintext.
 */
export const arkivWrites = pgTable(
  "arkiv_writes",
  {
    id: id(),
    kind: arkivWriteKind("kind").notNull(),
    status: arkivWriteStatus("status").notNull().default("queued"),
    /** Inbound writes only (null for sent/extend). */
    webhookEventId: uuid("webhook_event_id").references(() => webhookEvents.id, { onDelete: "cascade" }),
    /** Inbound writes only: the recipient mailbox this entity was written for. */
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, { onDelete: "cascade" }),
    entityKey: text("entity_key"),
    txHash: text("tx_hash"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Pointer (e.g. webhook_events.id or sent id). Never plaintext email content. */
    payloadRef: text("payload_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("arkiv_writes_status_created_idx").on(t.status, t.createdAt),
    index("arkiv_writes_entity_key_idx").on(t.entityKey),
    // Per-recipient idempotency. NULLs are distinct in Postgres, so non-inbound rows are unaffected.
    unique("arkiv_writes_event_mailbox_unique").on(t.webhookEventId, t.mailboxId),
  ],
);

/**
 * Outbound send audit. recipient_hash = hex HMAC-SHA256(recipient address, per-purpose
 * server secret), so the same recipient can be counted (rate limits, reply-only checks)
 * without the address being stored. Never bodies or subjects.
 */
export const sendLog = pgTable(
  "send_log",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    recipientHash: text("recipient_hash").notNull(),
    policyDecision: policyDecision("policy_decision").notNull(),
    /** The ENS records read (nanite.send, send-allow, send-limit) at decision time. */
    policySnapshot: jsonb("policy_snapshot"),
    providerMessageId: text("provider_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("send_log_agent_created_idx").on(t.agentId, t.createdAt),
    index("send_log_agent_recipient_idx").on(t.agentId, t.recipientHash),
  ],
);

/** SIWE nonces. Single use, short TTL. */
export const authNonces = pgTable(
  "auth_nonces",
  {
    id: id(),
    nonce: text("nonce").notNull(),
    walletAddress: text("wallet_address"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("auth_nonces_nonce_unique").on(t.nonce),
    index("auth_nonces_expires_at_idx").on(t.expiresAt),
    check(
      "auth_nonces_wallet_lowercase",
      sql`${t.walletAddress} IS NULL OR ${t.walletAddress} ~ ${WALLET_RE}`,
    ),
  ],
);

/** Server sessions (the session id is a random uuid; no signature is stored). */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    endpoint: text("endpoint").notNull(),
    statusCode: integer("status_code").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_agent_created_idx").on(t.agentId, t.createdAt)],
);

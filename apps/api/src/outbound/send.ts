/*
 * Outbound send (T3.5): POST /v1/emails/send, permitted per agent by ENS records.
 *
 * Privacy rules: the recipient address, subject and body live only in the request, the provider call and the
 * ENCRYPTED sent copy. Postgres (send_log) gets an HMAC of the recipient, the decision and a policy snapshot
 * (counts + a hash of the allowlist, never entries). Nothing here logs content or addresses.
 *
 * The policy is read FRESH from ENS on every request (no cache). A failed read answers 502 and sends nothing.
 */
import { createHash } from "node:crypto";
import type { EmailRecord } from "@nanite/arkiv";
import { decryptEmail, encryptEmail, senderHash, type EmailMeta, type Recipient } from "@nanite/crypto";
import {
  claimSentLedger,
  finishSentLedger,
  findSendContext,
  getAgentEncryptedKey,
  insertSendLog,
  markSendFailed,
  reserveSend,
  setSendLogProviderId,
  utcDayStart,
  type Db,
} from "@nanite/db";
import { signWithSealedSigner, unsealAgentPrivateKey } from "../agent-api/keys.js";
import { canonicalSendStringV2, SIG_VERSION, type SendPolicy } from "@nanite/ens";
import { createHmac } from "node:crypto";
import type { ArkivWriterPort } from "../arkiv/port.js";
import type { MailProvider } from "../mail/provider.js";
import { ProviderError } from "../mail/resend.js";
import type { AuthedAgent } from "../agent-api/tokens.js";

export const MAX_SEND_BODY_BYTES = 64 * 1024;
const MAX_SUBJECT = 998;
const ADDR_RE = /^[^\s@,;<>()"]{1,64}@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export interface OutboundReader {
  listInbox(o: {
    agentId: string;
    senderHash?: string;
    types?: readonly ("otp" | "conversation" | "sent")[];
    limit?: number;
    includeBytes?: boolean;
  }): Promise<{ items: EmailRecord[] }>;
  getEmail(k: `0x${string}`): Promise<EmailRecord | null>;
}

export interface OutboundEns {
  /** Fresh read of nanite.send / nanite.send-allow / nanite.send-limit (fails closed in the parser). */
  readSendPolicy(ensName: string): Promise<SendPolicy>;
  /** The `email` text record of an ENS name, or null (used for ENS names in the allowlist). */
  resolveEmail(ensName: string): Promise<string | null>;
}

export interface OutboundDeps {
  db: Db;
  provider: MailProvider;
  reader: OutboundReader;
  arkiv: ArkivWriterPort;
  ens: OutboundEns;
  /** SENDER_HASH_SECRET: keys the recipient HMAC (same function as the inbound senderHash). */
  senderHashSecret: string;
  /** SHARED_MAIL_DOMAIN: fallback From domain when the agent has no mailbox row. */
  sharedMailDomain?: string | undefined;
  /**
   * NANITE_MASTER_KEY: (a) to decrypt the mail being answered (threading; without it replies go out unthreaded) and
   * (b) to unseal the agent's mail-signing key for X-Nanite-Signature (without it mail goes out unsigned).
   */
  masterKey?: Uint8Array | undefined;
  /** DAILY_MAIL_QUOTA: Nanite-wide cap on mails sent + received per UTC day. Undefined = no global check. */
  dailyMailQuota?: number | undefined;
  now?: () => Date;
  /** Pause before the single provider retry (tests inject a recorder). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Structured log sink for config errors (fixed codes and Resend error names only, never content). */
  log?: ((fields: Record<string, unknown>) => void) | undefined;
}

export type SendOutcome =
  | {
      http: 200;
      body: {
        status: "sent";
        providerMessageId: string;
        entityKey: string | null;
        /** "signed": X-Nanite-Signature (v2) is attached; "unavailable": no signer (self custody / not set up) or signing failed. */
        signature: "signed" | "unavailable";
        sentCopy?: "failed";
        threading?: "unavailable";
      };
    }
  | { http: 400 | 403 | 404 | 409 | 429 | 502 | 503; body: { error: string } };

const fail = (http: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string): SendOutcome => ({ http, body: { error } });

function parseInput(raw: unknown):
  | { ok: true; to: string; subject: string; body: string; inReplyTo?: string }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_request" };
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== "string" || typeof r.subject !== "string" || typeof r.body !== "string") {
    return { ok: false, error: "invalid_request" };
  }
  const to = r.to.trim().toLowerCase();
  if (to.length > 254 || !ADDR_RE.test(to)) return { ok: false, error: "invalid_to" };
  if (r.subject.length === 0 || r.subject.length > MAX_SUBJECT || /[\r\n]/.test(r.subject)) {
    return { ok: false, error: "invalid_subject" };
  }
  if (r.body.length === 0) return { ok: false, error: "invalid_body" };
  if (r.inReplyTo !== undefined && (typeof r.inReplyTo !== "string" || !KEY_RE.test(r.inReplyTo))) {
    return { ok: false, error: "invalid_in_reply_to" };
  }
  return { ok: true, to, subject: r.subject, body: r.body, ...(r.inReplyTo ? { inReplyTo: r.inReplyTo.toLowerCase() } : {}) };
}

type Verdict = { allowed: true } | { allowed: false; code: "policy_off" | "policy_reply_only" | "policy_not_allowed" };

async function decide(
  deps: OutboundDeps,
  agent: AuthedAgent,
  policy: SendPolicy,
  to: string,
  recipientHash: string,
): Promise<Verdict> {
  switch (policy.policy) {
    case "off":
      return { allowed: false, code: "policy_off" };
    case "any":
      return { allowed: true };
    case "reply-only": {
      // Blind-index lookup: has someone with this exact (per-user HMAC) address written to this agent?
      const page = await deps.reader.listInbox({
        agentId: agent.ensName,
        senderHash: recipientHash,
        types: ["otp", "conversation"],
        limit: 1,
        includeBytes: false,
      });
      return page.items.length > 0 ? { allowed: true } : { allowed: false, code: "policy_reply_only" };
    }
    case "allowlist": {
      const domain = to.slice(to.lastIndexOf("@"));
      for (const entry of policy.allow) {
        if (entry === to) return { allowed: true };
        if (entry.startsWith("@") && entry === domain) return { allowed: true };
        if (entry.endsWith(".eth")) {
          const email = await deps.ens.resolveEmail(entry).catch(() => null);
          if (email && email.trim().toLowerCase() === to) return { allowed: true };
        }
      }
      return { allowed: false, code: "policy_not_allowed" };
    }
    default:
      return { allowed: false, code: "policy_off" }; // unknown mode: fail closed
  }
}

interface ThreadLinks {
  /** The Message-ID being answered. */
  inReplyTo: string;
  /** Its References (oldest first) followed by its own Message-ID. */
  references: string[];
}

/** One RFC 5322 msg-id: `<...>` with no whitespace, CR/LF or angle brackets inside. Anything else is dropped. */
const MSGID_RE = /^<[^<>\s]{1,200}>$/;
const MAX_REFERENCES = 20;
const MAX_REFERENCES_CHARS = 900;

/**
 * Threading headers for a reply, from the encrypted meta of the mail being answered, read exactly like
 * GET /v1/emails/:key does (the agent's own key; custody = nanite only). "unavailable" when the source has
 * no usable Message-ID or cannot be decrypted by the server; the mail is then sent without the headers.
 */
async function threadLinksFor(deps: OutboundDeps, agent: AuthedAgent, rec: EmailRecord): Promise<ThreadLinks | "unavailable"> {
  if (agent.custody !== "nanite" || !deps.masterKey) return "unavailable";
  let privateKey: Uint8Array | undefined;
  try {
    const blob = await getAgentEncryptedKey(deps.db, agent.agentId);
    if (!blob) return "unavailable";
    privateKey = await unsealAgentPrivateKey(deps.masterKey, agent.agentId, new Uint8Array(blob));
    const plain = await decryptEmail(rec, { keyId: agent.keyId, publicKey: agent.publicKey, privateKey });
    const id = plain.meta?.messageId;
    if (typeof id !== "string" || !MSGID_RE.test(id)) return "unavailable";
    const refs = Array.isArray(plain.meta?.references) ? plain.meta.references.filter((r): r is string => typeof r === "string" && MSGID_RE.test(r)) : [];
    const chain = [...new Set([...refs, id])]; // dedupe, keep order; the answered id is last
    while (chain.length > 2 && (chain.length > MAX_REFERENCES || chain.join(" ").length > MAX_REFERENCES_CHARS)) chain.splice(1, 1); // keep the root and the newest
    return { inReplyTo: id, references: chain };
  } catch {
    return "unavailable";
  } finally {
    privateKey?.fill(0);
  }
}

function snapshotOf(policy: SendPolicy, extra: Record<string, unknown> = {}) {
  return {
    policy: policy.policy,
    limit: policy.limit,
    allowCount: policy.allow.length,
    allowHash: createHash("sha256").update(policy.allow.join(",")).digest("hex"),
    ...extra,
  };
}

interface MappedSendError {
  http: 429 | 502 | 503;
  error: "quota_exhausted" | "rate_limited" | "send_failed" | "sender_domain_unverified" | "send_unavailable";
  /** Key / account configuration problem: logged as an error (the Resend error name only). */
  config?: boolean;
  providerError?: string;
}

const MAX_RETRY_AFTER_MS = 2000;
const DEFAULT_RETRY_AFTER_MS = 1000;

/**
 * Resend errors -> our contract (https://resend.com/docs/api-reference/errors). Only the status and the error NAME
 * are used; messages are never read.
 */
export function mapSendError(err: unknown): MappedSendError {
  if (!(err instanceof ProviderError)) return { http: 502, error: "send_failed" };
  const { status, name } = err.detail;
  const providerError = name ? { providerError: name } : {};
  if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return { http: 429, error: "quota_exhausted", ...providerError };
  if (name === "rate_limit_exceeded") return { http: 429, error: "rate_limited", ...providerError };
  if (status === 401 || name === "restricted_api_key" || name === "missing_api_key" || name === "suspended_api_key" || name === "invalid_permission") {
    return { http: 503, error: "send_unavailable", config: true, ...providerError };
  }
  if (status === 403 && name === "validation_error") return { http: 502, error: "sender_domain_unverified", ...providerError };
  return { http: 502, error: "send_failed", ...providerError };
}

/** Failures worth one more try with the SAME Idempotency-Key: rate limit, 5xx, network, an in-flight duplicate. */
function retryDelayMs(err: unknown): number | null {
  if (!(err instanceof ProviderError)) return null;
  const { status, name, retryAfterMs } = err.detail;
  if (name === "rate_limit_exceeded") return Math.min(retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
  if (err.code === "provider_unreachable" || (status !== undefined && status >= 500) || name === "concurrent_idempotent_requests") return DEFAULT_RETRY_AFTER_MS / 2;
  return null;
}

/** One send plus at most one retry (same idempotency key, so Resend never delivers twice for a duplicate). */
async function sendWithRetry(deps: OutboundDeps, message: Parameters<MailProvider["send"]>[0]) {
  try {
    return await deps.provider.send(message);
  } catch (err) {
    const delay = retryDelayMs(err);
    if (delay === null) throw err;
    await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
    return deps.provider.send(message);
  }
}

export async function sendEmail(deps: OutboundDeps, agent: AuthedAgent, rawBody: unknown): Promise<SendOutcome> {
  const input = parseInput(rawBody);
  if (!input.ok) return fail(400, input.error);
  const { to, subject, body } = input;
  const now = deps.now?.() ?? new Date();
  const { db } = deps;

  const ctx = await findSendContext(db, agent.agentId);
  if (!ctx || !ctx.userKeyId || !ctx.userPublicKey) return fail(409, "agent_not_ready");
  const from = ctx.mailboxAddress ?? (deps.sharedMailDomain ? `${ctx.agentName}@${deps.sharedMailDomain}` : undefined);
  if (!from) return fail(409, "no_mailbox");

  // 1. Policy, fresh from ENS on every request. Any failure: nothing is sent.
  let policy: SendPolicy;
  try {
    policy = await deps.ens.readSendPolicy(agent.ensName);
  } catch {
    return fail(502, "policy_unavailable");
  }

  const recipientHash = await senderHash(deps.senderHashSecret, ctx.userId, to);

  // 2. Policy decision.
  let verdict: Verdict;
  try {
    verdict = await decide(deps, agent, policy, to, recipientHash);
  } catch {
    return fail(502, "policy_unavailable");
  }
  if (!verdict.allowed) {
    await insertSendLog(db, { agentId: agent.agentId, recipientHash, decision: "denied", policySnapshot: snapshotOf(policy, { reason: verdict.code }) });
    return fail(403, verdict.code);
  }

  // 3. inReplyTo must be one of this agent's own entities (otherwise indistinguishable from missing).
  //    Done before the limits are reserved: a 404 must not consume quota, and no lock is held during the fetch.
  let thread: ThreadLinks | "unavailable" | undefined;
  if (input.inReplyTo) {
    let rec: EmailRecord | null = null;
    try {
      rec = await deps.reader.getEmail(input.inReplyTo as `0x${string}`);
    } catch {
      rec = null;
    }
    if (!rec || rec.agentId.toLowerCase() !== agent.ensName.toLowerCase()) return fail(404, "not_found");
    thread = await threadLinksFor(deps, agent, rec);
  }

  // 4. Limits, atomically: per-agent daily cap (ENS nanite.send-limit) and the Nanite-wide daily mail quota
  //    (sent + received). Count + insert of the allowed row happen under advisory locks (see reserveSend).
  const reserved = await reserveSend(db, {
    agentId: agent.agentId,
    recipientHash,
    agentLimit: policy.limit,
    quota: deps.dailyMailQuota,
    dayStart: utcDayStart(now),
    snapshot: (extra) => snapshotOf(policy, extra),
  });
  if (!reserved.ok) return fail(429, reserved.reason);
  const log = { id: reserved.id };

  // 5. Send. Replies carry In-Reply-To / References taken from the encrypted meta of the mail being answered.
  const date = now.toUTCString();
  const messageId = `<${log.id}@${from.slice(from.lastIndexOf("@") + 1)}>`;
  const headers: Record<string, string> = { "X-Nanite-Agent": agent.ensName, "Message-ID": messageId, "X-Nanite-Date": date };
  if (thread && thread !== "unavailable") {
    headers["In-Reply-To"] = thread.inReplyTo;
    headers["References"] = thread.references.join(" ");
  }
  // Signing (option B): the per-agent signer key is unsealed in memory for this call only. Any failure sends
  // the mail unsigned and says so in the response; nothing about the key or the mail is logged.
  let signature: "signed" | "unavailable" = "unavailable";
  if (ctx.signerKeySealed && ctx.signerAddress && deps.masterKey) {
    try {
      const signed = await signWithSealedSigner(
        deps.masterKey,
        agent.agentId,
        new Uint8Array(ctx.signerKeySealed),
        canonicalSendStringV2({ ensName: agent.ensName, from, to, subject, body, date, messageId }),
      );
      if (signed.address.toLowerCase() === ctx.signerAddress.toLowerCase()) {
        headers["X-Nanite-Signature"] = signed.signature;
        headers["X-Nanite-Sig-Version"] = SIG_VERSION;
        signature = "signed";
      }
    } catch {
      /* unsigned */
    }
  }
  let providerMessageId: string;
  try {
    ({ id: providerMessageId } = await sendWithRetry(deps, { from, to: [to], subject, text: body, headers, idempotencyKey: log.id }));
  } catch (err) {
    // The reserved send_log row must not count toward the per-agent cap or the global quota.
    const mapped = mapSendError(err);
    await markSendFailed(db, log.id, mapped.error).catch(() => undefined);
    if (mapped.config) deps.log?.({ event: "outbound", outcome: "config_error", code: mapped.error, ...(mapped.providerError ? { providerError: mapped.providerError } : {}) });
    return fail(mapped.http, mapped.error);
  }
  await setSendLogProviderId(db, log.id, providerMessageId).catch(() => undefined);

  // 6. Encrypted sent copy on Arkiv (type "sent"), readable by the user and the agent. The recipient is inside the ciphertext.
  const threading = thread === "unavailable" ? ({ threading: "unavailable" } as const) : {};
  let entityKey: string | null = null;
  const ledger = await claimSentLedger(db, log.id);
  if (ledger.status === "confirmed" && ledger.entityKey) {
    entityKey = ledger.entityKey;
  } else {
    try {
      const recipients: Recipient[] = [
        { keyId: ctx.userKeyId, publicKey: new Uint8Array(ctx.userPublicKey) },
        { keyId: ctx.agentKeyId, publicKey: new Uint8Array(ctx.agentPublicKey) },
      ];
      // Thread linkage lives only inside the encrypted copy (so a later reply to this mail can thread too).
      const meta: EmailMeta = {
        to,
        direction: "sent",
        messageId,
        ...(thread && thread !== "unavailable" ? { inReplyTo: thread.inReplyTo, references: thread.references } : {}),
      };
      const enc = await encryptEmail({ subject, body, meta }, recipients);
      const threadKey = createHmac("sha256", deps.senderHashSecret).update(`nanite/sent-thread/v1/${ctx.userId}/${log.id}`).digest("hex").slice(0, 32);
      const res = await deps.arkiv.writeEmail({
        fields: {
          agentId: ctx.ensName,
          ownerId: ctx.userWalletAddress,
          type: "sent",
          receivedAt: Math.floor(now.getTime() / 1000),
          threadId: threadKey,
          senderHash: recipientHash,
          keyIds: enc.keyIds,
          ciphertext: enc.ciphertext,
          wrappedKeys: enc.wrappedKeys,
          nonce: enc.nonce,
        },
        ownerWallet: ctx.userWalletAddress,
        permissionlessExtension: true,
      });
      entityKey = res.entityKey;
      await finishSentLedger(db, ledger.id, { status: "confirmed", entityKey: res.entityKey, txHash: res.txHash });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      await finishSentLedger(db, ledger.id, { status: "failed", lastError: name === "EntityTooLargeError" ? "entity_too_large" : "arkiv_write_failed" }).catch(() => undefined);
    }
  }
  return {
    http: 200,
    body: { status: "sent", providerMessageId, entityKey, signature, ...(entityKey ? {} : { sentCopy: "failed" as const }), ...threading },
  };
}

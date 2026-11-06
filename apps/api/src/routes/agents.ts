/*
 * Dashboard agent management (T3.2 + the T3.5 dashboard controls). Session auth, Origin check on
 * state-changing routes (inside requireSession), everything scoped to the session user.
 *
 * Key custody: the server generates the agent's X25519 keypair and seals the private key under
 * NANITE_MASTER_KEY (custody = nanite), exactly like provisionNaniteAgentKey, because the hosted
 * agent API (/v1/*) decrypts for the agent. The browser contributes only the wallet address it
 * derived from the seed (the seed never leaves the browser). If the client sends its own
 * `encryptionPublicKey` (seed-derived), the agent is custody = self: the server stores only the
 * public key and cannot decrypt for it. A self agent also sends the address of its own mail-signing key
 * (`signerAddress`, generated on the agent's machine by `nanite-mcp keygen`); the create job publishes it as
 * `nanite.signer` and no signer key is ever stored here.
 */
import { generateUserKeypair, keyId as computeKeyId, ready } from "@nanite/crypto";
import { countMailSince, ensureUserMailDomain, getUserDomain, utcDayStart } from "@nanite/db";
import {
  EXTEND_MODES,
  isSendPolicyMode,
  isValidAllowEntry,
  MAX_EXTEND_LIMIT,
  MAX_MAIL_TTL_HOURS,
  MAX_OTP_TTL_MINUTES,
  MAX_SEND_LIMIT,
  MIN_MAIL_TTL_HOURS,
  MIN_OTP_TTL_MINUTES,
} from "@nanite/ens";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { generateSealedSigner, sealAgentPrivateKey } from "../agent-api/keys.js";
import { issueAgentToken } from "../agent-api/tokens.js";
import type { AgentChain } from "../agents/chain.js";
import { createAgentJobRunner, type AgentJob } from "../agents/jobs.js";
import {
  ensureSharedDomain,
  getAgentPublicKeyHex,
  getOwnedAgent,
  insertAgentWithMailbox,
  listUserAgents,
  nextAgentIndex,
  revokeAgentAccess,
  revokeOtherTokens,
  setAgentSelfSigner,
  setAgentSigner,
  type AgentRow,
} from "../agents/queries.js";
import { requireSession, type AuthVars } from "../auth/session.js";
import type { AuthDeps } from "../auth/types.js";

export interface AgentsConfig {
  chain?: AgentChain | undefined;
  /** NANITE_MASTER_KEY for custody = nanite keys. Without it adding a nanite-custody agent answers 503. */
  masterKey?: Uint8Array | undefined;
  /** Shared mail domain for agent mailboxes (`<agent>.<username>@domain`). Default nanite.test. */
  sharedMailDomain?: string | undefined;
  /** DAILY_MAIL_QUOTA shown by GET /usage (default 90). */
  dailyMailQuota?: number | undefined;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const B64_RE = /^[A-Za-z0-9+/]{43}=$/;
const MAX_ALLOW_ENTRIES = 100;

export function checkAgentLabel(name: string): boolean {
  return name.length >= 2 && name.length <= 32 && LABEL_RE.test(name);
}

type AgentStatus = "provisioning" | "active" | "revoked" | "failed";

function agentStatus(a: AgentRow, job: AgentJob | undefined): AgentStatus {
  if (a.revokedAt) return "revoked";
  // The create job also publishes the signer record after the resolver is recorded: stay "provisioning" until it ends.
  if (job && job.kind === "create" && (job.status === "queued" || job.status === "running")) return "provisioning";
  if (a.resolverAddress) return "active";
  return "failed";
}

function dto(a: AgentRow, job: AgentJob | undefined) {
  return {
    id: a.id,
    index: a.index,
    name: a.name,
    ensName: a.ensName,
    email: a.email ?? "",
    walletAddress: a.walletAddress,
    status: agentStatus(a, job),
    createdAt: a.createdAt.toISOString(),
  };
}

function jobBody(a: AgentRow, job: AgentJob | undefined) {
  const agent = agentStatus(a, job);
  return job
    ? { agentStatus: agent, kind: job.kind, status: job.status, steps: job.steps, error: job.error ?? null }
    : { agentStatus: agent, kind: null, status: agent === "failed" ? "error" : "idle", steps: [], error: null };
}

export function agentRoutes(deps: AuthDeps, webOrigin: string, log: (line: string) => void, cfg: AgentsConfig = {}) {
  const app = new Hono<AuthVars>();
  const chain = cfg.chain;
  const runner = chain ? createAgentJobRunner(deps.db, chain, log) : undefined;
  const mailDomain = (cfg.sharedMailDomain?.trim() || "nanite.test").toLowerCase();
  const guard = requireSession(deps, webOrigin);
  app.use("/agents", guard);
  app.use("/agents/*", guard);
  app.use("/usage", guard);

  // Nanite-wide mail used today (UTC): allowed sends + received events, against DAILY_MAIL_QUOTA. Counts only.
  app.get("/usage", async (c) => {
    c.header("Cache-Control", "no-store");
    const day = utcDayStart(new Date());
    const counts = await countMailSince(deps.db, day);
    return c.json({ date: day.toISOString().slice(0, 10), ...counts, quota: cfg.dailyMailQuota ?? 90 });
  });

  const notFound = (c: { json: (b: unknown, s: 404) => Response }) => c.json({ error: "not_found" }, 404);

  app.get("/agents", async (c) => {
    const { user } = c.get("auth");
    c.header("Cache-Control", "no-store");
    const rows = await listUserAgents(deps.db, user.id);
    return c.json({ agents: rows.map((r) => dto(r, runner?.get(r.id))) });
  });

  app.post("/agents", bodyLimit({ maxSize: 2048, onError: (c) => c.json({ error: "payload_too_large" }, 413) }), async (c) => {
    const { user, hasKeys } = c.get("auth");
    if (!chain || !chain.canWrite || !runner) return c.json({ error: "operator_not_configured" }, 503);
    if (!hasKeys || !user.ensName || (user.onboardingState !== "name_claimed" && user.onboardingState !== "done")) {
      return c.json({ error: "onboarding_incomplete" }, 409);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_request" }, 400);

    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    if (!checkAgentLabel(name)) return c.json({ error: "invalid_name" }, 400);
    if (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0 || body.index > 1_000_000) {
      return c.json({ error: "invalid_index" }, 400);
    }
    if (typeof body.walletAddress !== "string" || !WALLET_RE.test(body.walletAddress)) {
      return c.json({ error: "invalid_wallet" }, 400);
    }
    const walletAddress = body.walletAddress.toLowerCase();
    if (walletAddress === user.walletAddress) return c.json({ error: "invalid_wallet" }, 400);

    let selfKey: Buffer | null = null;
    if (body.encryptionPublicKey !== undefined) {
      const v = body.encryptionPublicKey;
      if (typeof v !== "string" || !B64_RE.test(v)) return c.json({ error: "invalid_encryption_key" }, 400);
      selfKey = Buffer.from(v, "base64");
      if (selfKey.length !== 32 || selfKey.toString("base64") !== v) return c.json({ error: "invalid_encryption_key" }, 400);
    }
    let selfSigner: string | null = null;
    if (body.signerAddress !== undefined) {
      if (!selfKey) return c.json({ error: "signer_requires_self_custody" }, 400);
      if (typeof body.signerAddress !== "string" || !isAddress(body.signerAddress, { strict: false })) return c.json({ error: "invalid_signer" }, 400);
      selfSigner = getAddress(body.signerAddress);
    }
    if (!selfKey && !cfg.masterKey) return c.json({ error: "master_key_not_configured" }, 503);

    const expected = await nextAgentIndex(deps.db, user.id);
    if (body.index !== expected) return c.json({ error: "index_mismatch", expected }, 409);

    await ready();
    const id = randomUUID();
    let publicKey: Uint8Array;
    let sealed: Uint8Array | null = null;
    let signer: { address: string; sealed: Uint8Array | null } | null = null;
    if (selfKey) {
      publicKey = new Uint8Array(selfKey);
      if (selfSigner) signer = { address: selfSigner, sealed: null }; // public address only; the key stays on the agent's machine
    }
    else {
      const kp = await generateUserKeypair();
      publicKey = kp.publicKey;
      sealed = await sealAgentPrivateKey(cfg.masterKey!, id, kp.privateKey);
      // Mail-signing key (option B): only for custody = nanite, where the server already holds the agent's keys.
      signer = await generateSealedSigner(cfg.masterKey!, id);
    }
    // The mail domain is optional. Mailbox on the user's own domain only while it is VERIFIED; otherwise (no domain, or
    // still pending) the shared `<agent>.<user>@SHARED_MAIL_DOMAIN` address. Existing agents keep their address when a
    // domain verifies later (no migration of old agents).
    const found = await getUserDomain(deps.db, user.id);
    const userDomain = found?.status === "verified" ? found : null;
    const domain = userDomain
      ? await ensureUserMailDomain(deps.db, user.id, userDomain.name, userDomain.resendDomainId)
      : await ensureSharedDomain(deps.db, mailDomain);
    const email = userDomain ? `${name}@${userDomain.name}` : `${name}.${user.username}@${mailDomain}`;
    const ins = await insertAgentWithMailbox(deps.db, {
      id,
      userId: user.id,
      name,
      index: body.index,
      walletAddress,
      ensName: `${name}.${user.ensName}`,
      publicKey,
      keyId: computeKeyId(publicKey),
      custody: selfKey ? "self" : "nanite",
      encryptedPrivateKey: sealed,
      signer,
      mailboxAddress: email,
      domainId: domain.id,
    });
    if (!ins.ok) {
      if (ins.conflict === "index") return c.json({ error: "index_mismatch", expected: await nextAgentIndex(deps.db, user.id) }, 409);
      return c.json({ error: ins.conflict === "wallet" ? "wallet_taken" : "name_taken" }, 409);
    }

    const { token, tokenId } = await issueAgentToken(deps.db, id, { label: "initial" });
    const job = runner.startCreate(id, {
      username: user.username,
      agentLabel: name,
      agentWallet: walletAddress,
      email,
      encryptionPublicKeyHex: Buffer.from(publicKey).toString("hex"),
      signerAddress: signer?.address,
    });
    const row = (await getOwnedAgent(deps.db, user.id, id))!;
    c.header("Cache-Control", "no-store");
    return c.json({ agent: dto(row, job), token, tokenId, status: jobBody(row, job) }, 202);
  });

  app.get("/agents/:id/status", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    c.header("Cache-Control", "no-store");
    return c.json(jobBody(row, runner?.get(row.id)));
  });

  app.post("/agents/:id/retry", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (!chain || !chain.canWrite || !runner) return c.json({ error: "operator_not_configured" }, 503);
    if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
    if (row.resolverAddress) return c.json({ error: "already_active" }, 409);
    if (runner.busy(row.id)) return c.json({ error: "job_in_progress" }, 409);
    const job = runner.startCreate(row.id, {
      username: user.username,
      agentLabel: row.name,
      agentWallet: row.walletAddress,
      email: row.email ?? "",
      encryptionPublicKeyHex: await getAgentPublicKeyHex(deps.db, row.id),
      signerAddress: row.signerAddress ?? undefined,
    });
    return c.json(jobBody(row, job), 202);
  });

  // Mail signing (option B). The key never leaves the server; these routes expose the address and the ENS record state only.
  app.get("/agents/:id/signer", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    c.header("Cache-Control", "no-store");
    const supported = true; // custody nanite: server key; custody self: the address the agent registered
    const managed = row.custody === "nanite";
    const address = row.signerAddress ? getAddress(row.signerAddress) : null;
    let record: "none" | "pending" | "published" | "mismatch" | "unavailable" = "none";
    let onchain: string | null = null;
    if (supported && address) {
      if (!row.resolverAddress) record = "pending";
      else if (!chain) record = "unavailable";
      else {
        try {
          const v = await chain.readSigner(row.ensName);
          const parsed = v && isAddress(v, { strict: false }) ? getAddress(v) : null;
          onchain = parsed ?? (v ? "invalid" : null);
          record = !v ? "pending" : parsed === address ? "published" : "mismatch";
        } catch {
          record = "unavailable";
        }
      }
    }
    return c.json({ supported, custody: row.custody, managed, address, record, onchain });
  });

  app.post("/agents/:id/signer", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (!chain || !chain.canWrite || !runner) return c.json({ error: "operator_not_configured" }, 503);
    // Self-hosted agent: the new signer address comes from the agent's machine; no key is generated or stored here.
    if (row.custody === "self") {
      const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b || typeof b.address !== "string" || !isAddress(b.address, { strict: false })) return c.json({ error: "invalid_signer" }, 400);
      if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
      if (!row.resolverAddress) return c.json({ error: "agent_not_active" }, 409);
      if (runner.busy(row.id)) return c.json({ error: "job_in_progress" }, 409);
      const address = getAddress(b.address);
      const rotatedSelf = !!row.signerAddress;
      const selfJob = runner.startSigner(row.id, {
        username: user.username,
        agentLabel: row.name,
        address,
        commit: () => setAgentSelfSigner(deps.db, row.id, address),
      });
      c.header("Cache-Control", "no-store");
      return c.json({ ...jobBody(row, selfJob), signerAddress: address, rotated: rotatedSelf }, 202);
    }
    if (!cfg.masterKey) return c.json({ error: "master_key_not_configured" }, 503);
    if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
    if (!row.resolverAddress) return c.json({ error: "agent_not_active" }, 409);
    if (runner.busy(row.id)) return c.json({ error: "job_in_progress" }, 409);
    await ready();
    const fresh = await generateSealedSigner(cfg.masterKey, row.id);
    const rotated = !!row.signerAddress;
    const job = runner.startSigner(row.id, {
      username: user.username,
      agentLabel: row.name,
      address: fresh.address,
      commit: () => setAgentSigner(deps.db, row.id, fresh),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ...jobBody(row, job), signerAddress: fresh.address, rotated }, 202);
  });

  app.get("/agents/:id/send-policy", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (!chain) return c.json({ error: "chain_unavailable" }, 503);
    if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
    if (!row.resolverAddress) return c.json({ error: "agent_not_active" }, 409);
    try {
      const p = await chain.readSendPolicy(row.ensName);
      c.header("Cache-Control", "no-store");
      return c.json({ policy: p.policy, allow: p.allow, limit: p.limit });
    } catch {
      return c.json({ error: "chain_unavailable" }, 502);
    }
  });

  app.put("/agents/:id/send-policy", bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: "payload_too_large" }, 413) }), async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (!chain || !chain.canWrite || !runner) return c.json({ error: "operator_not_configured" }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_request" }, 400);
    if (!isSendPolicyMode(body.policy)) return c.json({ error: "invalid_policy" }, 400);
    let allow: string[] | undefined;
    if (body.allow !== undefined) {
      if (!Array.isArray(body.allow) || body.allow.length > MAX_ALLOW_ENTRIES) return c.json({ error: "invalid_allow" }, 400);
      allow = [];
      for (const e of body.allow) {
        const v = typeof e === "string" ? e.trim().toLowerCase() : "";
        if (!v || v.length > 254 || v.includes(",") || !isValidAllowEntry(v)) return c.json({ error: "invalid_allow", entry: String(e).slice(0, 80) }, 400);
        if (!allow.includes(v)) allow.push(v);
      }
    }
    let limit: number | undefined;
    if (body.limit !== undefined) {
      if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 0 || body.limit > MAX_SEND_LIMIT) {
        return c.json({ error: "invalid_limit" }, 400);
      }
      limit = body.limit;
    }
    if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
    if (!row.resolverAddress) return c.json({ error: "agent_not_active" }, 409);
    if (runner.busy(row.id)) return c.json({ error: "job_in_progress" }, 409);
    const job = runner.startPolicy(row.id, { username: user.username, agentLabel: row.name, policy: body.policy, allow, limit });
    return c.json(jobBody(row, job), 202);
  });

  // Retention (how long mail lives on Arkiv + whether the agent may extend it): ENS records written by the operator
  // on the user's request. The agent wallet has no right to write them.
  app.get("/agents/:id/retention", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (!chain) return c.json({ error: "chain_unavailable" }, 503);
    if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
    if (!row.resolverAddress) return c.json({ error: "agent_not_active" }, 409);
    try {
      const { invalid: _invalid, ...p } = await chain.readRetentionPolicy(row.ensName);
      c.header("Cache-Control", "no-store");
      return c.json(p);
    } catch {
      return c.json({ error: "chain_unavailable" }, 502);
    }
  });

  app.put("/agents/:id/retention", bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }), async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (!chain || !chain.canWrite || !runner) return c.json({ error: "operator_not_configured" }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_request" }, 400);
    const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
    let otpTtlMinutes: number | undefined;
    let mailTtlHours: number | undefined;
    let extend: string | undefined;
    let extendLimit: number | undefined;
    if (body.otpTtlMinutes !== undefined) {
      if (!int(body.otpTtlMinutes, MIN_OTP_TTL_MINUTES, MAX_OTP_TTL_MINUTES)) return c.json({ error: "invalid_otp_ttl" }, 400);
      otpTtlMinutes = body.otpTtlMinutes as number;
    }
    if (body.mailTtlHours !== undefined) {
      if (!int(body.mailTtlHours, MIN_MAIL_TTL_HOURS, MAX_MAIL_TTL_HOURS)) return c.json({ error: "invalid_mail_ttl" }, 400);
      mailTtlHours = body.mailTtlHours as number;
    }
    if (body.extend !== undefined) {
      if (typeof body.extend !== "string" || !(EXTEND_MODES as readonly string[]).includes(body.extend)) return c.json({ error: "invalid_extend" }, 400);
      extend = body.extend;
    }
    if (body.extendLimit !== undefined) {
      if (!int(body.extendLimit, 0, MAX_EXTEND_LIMIT)) return c.json({ error: "invalid_extend_limit" }, 400);
      extendLimit = body.extendLimit as number;
    }
    if (otpTtlMinutes === undefined && mailTtlHours === undefined && extend === undefined && extendLimit === undefined) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
    if (!row.resolverAddress) return c.json({ error: "agent_not_active" }, 409);
    if (runner.busy(row.id)) return c.json({ error: "job_in_progress" }, 409);
    const job = runner.startRetention(row.id, { username: user.username, agentLabel: row.name, otpTtlMinutes, mailTtlHours, extend, extendLimit });
    return c.json(jobBody(row, job), 202);
  });

  app.post("/agents/:id/token", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (row.revokedAt) return c.json({ error: "agent_revoked" }, 409);
    const { token, tokenId } = await issueAgentToken(deps.db, row.id, { label: "rotated" });
    await revokeOtherTokens(deps.db, row.id, tokenId);
    c.header("Cache-Control", "no-store");
    return c.json({ token, tokenId }, 201);
  });

  app.post("/agents/:id/revoke", async (c) => {
    const { user } = c.get("auth");
    const row = await getOwnedAgent(deps.db, user.id, c.req.param("id"));
    if (!row) return notFound(c);
    if (row.revokedAt) return c.json({ agent: dto(row, runner?.get(row.id)), status: jobBody(row, runner?.get(row.id)) });
    // Cut access first (tokens, mailbox, revokedAt); the on-chain role removal follows as a job.
    await revokeAgentAccess(deps.db, row.id);
    const after = (await getOwnedAgent(deps.db, user.id, row.id))!;
    const job =
      chain?.canWrite && runner && row.resolverAddress && !runner.busy(row.id)
        ? runner.startRevoke(row.id, { username: user.username, agentLabel: row.name, agentWallet: row.walletAddress })
        : undefined;
    return c.json({ agent: dto(after, job), status: jobBody(after, job ?? runner?.get(row.id)) }, 202);
  });

  return Object.assign(app, { runner });
}

/*
 * Custom domain onboarding service (T3.6): checks what the user typed, creates the domain in Resend (idempotent),
 * stores it, runs our own public-DNS check per record, triggers Resend's verify and keeps the row in sync.
 * Used by routes/domains.ts, the background verifier and the Resend webhook.
 *
 * Logs only ids and statuses; never keys. All DNS data handled here is public.
 */
import {
  claimVerifySlot,
  deleteUserDomain,
  getUserDomain,
  getUserDomainByResendId,
  insertUserDomain,
  isMailDomainTaken,
  updateUserDomain,
  type Db,
  type UserDomainRow,
} from "@nanite/db";
import { checkRecords, detectProvider, type DnsProvider, type DnsResolver } from "./dns.js";
import { isSameOrSubdomain, normalizeDomain, registrableDomain, zoneRelativeHost } from "./hostname.js";
import {
  classifyDomainError,
  parseRecords,
  type ResendDomain,
  type ResendDomainRecord,
  type ResendDomainsPort,
  type ResendRegion,
} from "./resend-domains.js";
import { VERIFY_MIN_GAP_MS, domainView, readDnsCheck, type StoredDnsCheck } from "./view.js";

/** Re-ask Resend to verify at most this often when every record is in DNS but Resend has not verified. */
const AUTO_RETRIGGER_MS = 10 * 60_000;

export class DomainApiError extends Error {
  constructor(
    readonly http: 400 | 404 | 409 | 429 | 502 | 503,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "DomainApiError";
  }
}

export interface DomainsDeps {
  db: Db;
  resend: ResendDomainsPort;
  dns: DnsResolver;
  defaultRegion: ResendRegion;
  /** Domains users may not add (the platform's own mail domain). Subdomains are refused too. */
  reservedDomains: string[];
  log: (line: string) => void;
  now?: () => Date;
}

export interface DomainCheckResult {
  name: string;
  root: string;
  suggestion?: string;
  rootHasMx: boolean;
  provider: DnsProvider;
  warnings: string[];
}

export type DomainWebhookEvent = {
  type: string;
  domainId: string;
  status?: string | undefined;
  /** Raw `records` of the payload, validated here; absent or unusable means refetch. */
  records?: unknown;
};

export function createDomainService(deps: DomainsDeps) {
  const { db, resend, dns } = deps;
  const now = () => (deps.now ? deps.now() : new Date());
  const log = (fields: Record<string, unknown>) => deps.log(JSON.stringify({ level: "info", component: "domains", ...fields }));
  const reserved = deps.reservedDomains.map((d) => d.toLowerCase());

  function normalizeOrThrow(input: unknown): string {
    const n = normalizeDomain(input);
    if (!n.ok) throw new DomainApiError(400, "invalid_domain");
    if (reserved.some((r) => isSameOrSubdomain(n.name, r))) throw new DomainApiError(400, "domain_reserved");
    return n.name;
  }

  async function lookupProvider(root: string): Promise<DnsProvider> {
    return detectProvider((await dns.query(root, "NS")) ?? []);
  }

  const toRecords = (row: Pick<UserDomainRow, "records">): ResendDomainRecord[] => parseRecords(row.records) ?? [];

  /** Runs our DNS lookup for every record of the row (provider detection is kept from the previous check). */
  async function dnsCheckFor(row: UserDomainRow, records: ResendDomainRecord[]): Promise<StoredDnsCheck> {
    const zone = registrableDomain(row.name);
    const check = await checkRecords(
      records.map((r) => ({ type: r.type, host: zoneRelativeHost(row.name, zone, r.name), value: r.value })),
      zone,
      dns,
      now(),
    );
    const provider = readDnsCheck(row)?.provider ?? (await lookupProvider(zone));
    return { ...check, provider };
  }

  const svc = {
    async check(userId: string, input: unknown): Promise<DomainCheckResult> {
      const name = normalizeOrThrow(input);
      if (await isMailDomainTaken(db, name, userId)) throw new DomainApiError(409, "domain_taken");
      const root = registrableDomain(name);
      const [rootMx, ns, ownMx] = await Promise.all([
        dns.query(root, "MX"),
        dns.query(root, "NS"),
        name === root ? Promise.resolve(null) : dns.query(name, "MX"),
      ]);
      const rootHasMx = (rootMx?.length ?? 0) > 0;
      const warnings: string[] = [];
      let suggestion: string | undefined;
      if (rootMx === null) warnings.push("We could not look up your DNS right now, so we could not check for existing mail records.");
      if (name === root) {
        suggestion = `mail.${root}`;
        warnings.push(
          rootHasMx
            ? `${root} already receives mail (it has MX records). Adding Nanite's MX record there would replace it and break your current mailboxes. Use ${suggestion} instead.`
            : `Best practice: use a subdomain such as ${suggestion}. It keeps agent mail apart from your main mail and lets you add mail to ${root} later.`,
        );
      } else if ((ownMx?.length ?? 0) > 0) {
        warnings.push(`${name} already has MX records. Nanite's receiving MX record would replace them.`);
      }
      return { name, root, ...(suggestion ? { suggestion } : {}), rootHasMx, provider: detectProvider(ns ?? []), warnings };
    },

    /** Creates (or adopts) the user's mail domain in Resend and stores it. Idempotent for the same name. */
    async create(userId: string, input: unknown, regionInput?: ResendRegion): Promise<UserDomainRow> {
      const name = normalizeOrThrow(input);
      const existing = await getUserDomain(db, userId);
      if (existing) {
        if (existing.name === name) return existing;
        throw new DomainApiError(409, "domain_exists", { name: existing.name });
      }
      if (await isMailDomainTaken(db, name, userId)) throw new DomainApiError(409, "domain_taken");

      const region = regionInput ?? deps.defaultRegion;
      let remote: ResendDomain;
      let created = false;
      try {
        const found = (await resend.listDomains()).find((d) => d.name === name);
        if (found) remote = await resend.getDomain(found.id);
        else {
          remote = await resend.createDomain(name, region);
          created = true;
        }
      } catch (e) {
        throw mapResendError(e);
      }
      const row = await insertUserDomain(db, {
        userId,
        name,
        resendDomainId: remote.id,
        region: remote.region || region,
        status: remote.status,
        records: remote.records,
      });
      if (!row) {
        // Lost a race (same user twice, or the name was taken meanwhile): undo what we created.
        if (created) await resend.deleteDomain(remote.id).catch(() => undefined);
        const again = await getUserDomain(db, userId);
        if (again && again.name === name) return again;
        throw new DomainApiError(409, "domain_taken");
      }
      log({ event: "domain_created", resendDomainId: row.resendDomainId, adopted: !created });
      try {
        const check = await dnsCheckFor(row, remote.records);
        return (await updateUserDomain(db, row.id, { dnsCheck: check })) ?? row;
      } catch {
        return row;
      }
    },

    async get(userId: string): Promise<UserDomainRow | null> {
      return getUserDomain(db, userId);
    },

    view(row: UserDomainRow) {
      return domainView(row, now());
    },

    /**
     * One full check: fresh state from Resend, our DNS lookup, and Resend's verify when asked (`force`) or when every
     * record has just become visible in DNS (once, then again every 10 minutes while Resend has not verified).
     * Resend or DNS failures keep the previous data. With `force` a failing Resend verify call is rethrown.
     */
    async runCheck(row: UserDomainRow, opts: { force?: boolean } = {}): Promise<UserDomainRow> {
      let remote: ResendDomain | null = null;
      try {
        remote = await resend.getDomain(row.resendDomainId);
      } catch (e) {
        log({ event: "resend_get_failed", resendDomainId: row.resendDomainId, kind: classifyDomainError(e) });
        if (opts.force) throw mapResendError(e);
      }
      const records = remote?.records.length ? remote.records : toRecords(row);
      const check = await dnsCheckFor(row, records);
      const prev = readDnsCheck(row);
      let status = remote?.status ?? row.status;

      const stale = !row.lastVerifyRequestedAt || now().getTime() - row.lastVerifyRequestedAt.getTime() > AUTO_RETRIGGER_MS;
      const auto =
        check.allFound &&
        status !== "verified" &&
        (!prev?.allFound || (stale && ["not_started", "failed", "temporary_failure"].includes(status)));
      let verifyRequestedAt: Date | undefined;
      let verifyError: unknown;
      if (status !== "verified" && (opts.force || auto)) {
        try {
          await resend.verifyDomain(row.resendDomainId);
          verifyRequestedAt = now();
          log({ event: "verify_requested", resendDomainId: row.resendDomainId, auto: !opts.force });
          const after = await resend.getDomain(row.resendDomainId).catch(() => null);
          if (after) {
            remote = after;
            status = after.status;
          }
        } catch (e) {
          verifyError = e;
          log({ event: "resend_verify_failed", resendDomainId: row.resendDomainId, kind: classifyDomainError(e) });
        }
      }
      const saved = await updateUserDomain(db, row.id, {
        status,
        ...(remote?.records.length ? { records: remote.records } : {}),
        dnsCheck: check,
        ...(verifyRequestedAt && !opts.force ? { lastVerifyRequestedAt: verifyRequestedAt } : {}),
      });
      if (verifyError && opts.force) throw mapResendError(verifyError);
      if (status === "verified" && row.status !== "verified") log({ event: "domain_verified", resendDomainId: row.resendDomainId });
      return saved ?? row;
    },

    /** "Check now": rate limited per domain. Returns the refreshed row. */
    async verifyNow(userId: string): Promise<UserDomainRow> {
      const row = await getUserDomain(db, userId);
      if (!row) throw new DomainApiError(404, "no_domain");
      if (row.status === "verified") return row;
      const claimed = await claimVerifySlot(db, row.id, now(), VERIFY_MIN_GAP_MS);
      if (!claimed) {
        const wait = row.lastVerifyRequestedAt ? Math.max(1, Math.ceil((row.lastVerifyRequestedAt.getTime() + VERIFY_MIN_GAP_MS - now().getTime()) / 1000)) : 1;
        throw new DomainApiError(429, "verify_rate_limited", { retryAfterSeconds: wait });
      }
      return svc.runCheck(claimed, { force: true });
    },

    /** Only while not verified: frees the Resend slot and the local row. */
    async remove(userId: string): Promise<void> {
      const row = await getUserDomain(db, userId);
      if (!row) throw new DomainApiError(404, "no_domain");
      if (row.status === "verified") throw new DomainApiError(409, "domain_verified");
      try {
        await resend.deleteDomain(row.resendDomainId);
      } catch (e) {
        if (classifyDomainError(e) !== "not_found") throw mapResendError(e);
      }
      await deleteUserDomain(db, row.id);
      log({ event: "domain_deleted", resendDomainId: row.resendDomainId });
    },

    /** Resend `domain.*` webhook events (already signature-verified). */
    async applyWebhook(ev: DomainWebhookEvent): Promise<"updated" | "deleted" | "ignored"> {
      const row = await getUserDomainByResendId(db, ev.domainId);
      if (!row) return "ignored";
      if (ev.type === "domain.deleted") {
        if (row.status === "verified") await updateUserDomain(db, row.id, { status: "failed" });
        else await deleteUserDomain(db, row.id);
        return "deleted";
      }
      if (ev.type !== "domain.updated" && ev.type !== "domain.created") return "ignored";
      let status = typeof ev.status === "string" && /^[a-z_]{1,32}$/.test(ev.status) ? ev.status : undefined;
      let records = parseRecords(ev.records);
      if (!status || !records || records.length === 0) {
        try {
          const fresh = await resend.getDomain(ev.domainId);
          status = fresh.status;
          records = fresh.records;
        } catch {
          if (!status) return "ignored";
        }
      }
      await updateUserDomain(db, row.id, { status: status!, ...(records && records.length > 0 ? { records } : {}) });
      log({ event: "domain_webhook", type: ev.type, resendDomainId: ev.domainId, status });
      return "updated";
    },
  };
  return svc;
}

export type DomainService = ReturnType<typeof createDomainService>;

function mapResendError(e: unknown): DomainApiError {
  if (e instanceof DomainApiError) return e;
  switch (classifyDomainError(e)) {
    case "limit":
      return new DomainApiError(409, "domain_limit_reached");
    case "taken":
      return new DomainApiError(409, "domain_taken");
    case "invalid":
      return new DomainApiError(400, "invalid_domain");
    case "key":
      return new DomainApiError(503, "resend_not_configured");
    case "not_found":
      return new DomainApiError(404, "resend_domain_missing");
    default:
      return new DomainApiError(502, "resend_unavailable");
  }
}

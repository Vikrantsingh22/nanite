import { parseMasterKey } from "./agent-api/keys.js";

export interface Env {
  port: number;
  databaseUrl: string;
  webOrigin: string;
  /** Inbound webhook secrets: all three must be set to enable POST /webhooks/resend (else it answers 503). */
  resendApiKey?: string | undefined;
  resendWebhookSecret?: string | undefined;
  senderHashSecret?: string | undefined;
  /** Arkiv operator key (0x + 64 hex). When absent the API uses the in-memory fake writer. Never logged. */
  arkivOperatorPrivateKey?: string | undefined;
  /** Arkiv RPC rate-limit key (not a signing key). */
  arkivAccessKey?: string | undefined;
  /** DEV_ROUTES=1 (ignored when NODE_ENV=production): mounts /internal/dev/*. */
  devRoutes: boolean;
  /** NANITE_MASTER_KEY (32 bytes hex/base64) for custody=nanite agent keys. Never logged. */
  naniteMasterKey?: Uint8Array | undefined;
  /** ENS operator wallet (0x + 64 hex). Without it the username claim answers 503 operator_not_configured. Never logged. */
  operatorPrivateKey?: string | undefined;
  sepoliaRpcUrl?: string | undefined;
  /** Public base URL of this API (written into ENS agent-endpoint records). */
  apiPublicUrl?: string | undefined;
  /** Chain id accepted in SIWE messages (default Sepolia 11155111). */
  authChainId: number;
  /** DAILY_MAIL_QUOTA: Nanite-wide cap on mails sent + received per UTC day (default 90; Resend free tier is 100). */
  dailyMailQuota: number;
}

/**
 * G9: warning text when real Resend is configured but SHARED_MAIL_DOMAIN is still the `nanite.test` placeholder
 * (inbound would never route and outbound From would be rejected). null when fine or when the providers are fake.
 */
export function sharedMailDomainWarning(source: Record<string, string | undefined> = process.env): string | null {
  const real = !!source.RESEND_API_KEY?.trim() && source.FAKE_RESEND_CONTENT !== "1" && source.FAKE_RESEND_SEND !== "1";
  if (!real || (source.SHARED_MAIL_DOMAIN?.trim() || "nanite.test") !== "nanite.test") return null;
  return "RESEND_API_KEY is set but SHARED_MAIL_DOMAIN is still nanite.test: set it to the domain verified in Resend (e.g. mail.example.com), otherwise real mail is not routed and sends are rejected";
}

/** Validate process env. Throws one Error listing every problem (never prints secret values). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const problems: string[] = [];

  const rawPort = source.PORT?.trim() || "4000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
  }

  const databaseUrl = source.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    problems.push("DATABASE_URL is required (e.g. postgres://nanite:nanite@db:5432/nanite)");
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must start with postgres:// or postgresql://");
  }

  const rawOrigin = source.WEB_ORIGIN?.trim() || "http://localhost:3000";
  let webOrigin = rawOrigin;
  try {
    const u = new URL(rawOrigin);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    webOrigin = u.origin; // normalizes: no trailing slash, no path
  } catch {
    problems.push(`WEB_ORIGIN must be an http(s) origin such as http://localhost:3000 (got "${rawOrigin}")`);
  }

  // Optional (the API boots without them); validated only when present. Values are never echoed.
  const resendApiKey = source.RESEND_API_KEY?.trim() || undefined;
  const resendWebhookSecret = source.RESEND_WEBHOOK_SECRET?.trim() || undefined;
  const senderHashSecret = source.SENDER_HASH_SECRET?.trim() || undefined;
  if (resendWebhookSecret && !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(resendWebhookSecret)) {
    problems.push("RESEND_WEBHOOK_SECRET must look like whsec_<base64>");
  }
  if (senderHashSecret && senderHashSecret.length < 16) {
    problems.push("SENDER_HASH_SECRET must be at least 16 characters");
  }

  const arkivOperatorPrivateKey = source.ARKIV_OPERATOR_PRIVATE_KEY?.trim() || undefined;
  const arkivAccessKey = source.ARKIV_ACCESS_KEY?.trim() || undefined;
  if (arkivOperatorPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(arkivOperatorPrivateKey)) {
    problems.push("ARKIV_OPERATOR_PRIVATE_KEY must be 0x followed by 64 hex characters");
  }
  const operatorPrivateKey = source.OPERATOR_PRIVATE_KEY?.trim() || undefined;
  if (operatorPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(operatorPrivateKey)) {
    problems.push("OPERATOR_PRIVATE_KEY must be 0x followed by 64 hex characters");
  }
  const rawChain = source.AUTH_CHAIN_ID?.trim() || "11155111";
  const authChainId = Number(rawChain);
  if (!Number.isInteger(authChainId) || authChainId < 1) problems.push("AUTH_CHAIN_ID must be a positive integer");
  const rawQuota = source.DAILY_MAIL_QUOTA?.trim() || "90";
  const dailyMailQuota = /^\d{1,6}$/.test(rawQuota) ? Number(rawQuota) : NaN;
  if (!Number.isInteger(dailyMailQuota)) problems.push("DAILY_MAIL_QUOTA must be a whole number (default 90)");
  const devRoutes = source.DEV_ROUTES?.trim() === "1" && source.NODE_ENV !== "production";
  let naniteMasterKey: Uint8Array | undefined;
  if (source.NANITE_MASTER_KEY?.trim()) {
    try {
      naniteMasterKey = parseMasterKey(source.NANITE_MASTER_KEY);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment for @nanite/api:\n - ${problems.join("\n - ")}`);
  }
  return {
    port,
    databaseUrl,
    webOrigin,
    resendApiKey,
    resendWebhookSecret,
    senderHashSecret,
    arkivOperatorPrivateKey,
    arkivAccessKey,
    devRoutes,
    naniteMasterKey,
    operatorPrivateKey,
    sepoliaRpcUrl: source.SEPOLIA_RPC_URL?.trim() || undefined,
    apiPublicUrl: source.API_PUBLIC_URL?.trim() || undefined,
    authChainId,
    dailyMailQuota,
  };
}

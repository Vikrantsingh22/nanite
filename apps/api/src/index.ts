import { serve } from "@hono/node-server";
import { createDb } from "@nanite/db";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";
import { createRealAgentChain } from "./agents/chain.js";
import { createRealUserNameChain } from "./auth/ens.js";
import { createRealArkivWriter } from "./arkiv/arkiv-writer.js";
import { InMemoryArkivWriter } from "./arkiv/port.js";
import type { DevInbox, DevOutbox } from "./routes/dev.js";
import { loadEnv, sharedMailDomainWarning } from "./env.js";
import { createEnsServiceFromConfig, loadEnsConfig } from "@nanite/ens";
import { createFakeMailProvider } from "./mail/fake.js";
import { createDohResolver } from "./domains/dns.js";
import { createFakeDns, createFakeResendDomains } from "./domains/fake.js";
import { createResendDomains } from "./domains/resend-domains.js";
import { createDomainService } from "./domains/service.js";
import { createDomainVerifier } from "./domains/verifier.js";
import { createResendProvider } from "./mail/resend.js";
import type { InboundDeps } from "./inbound/pipeline.js";
import { createInboundProcessor } from "./inbound/processor.js";
import { createRetentionSource } from "./retention.js";
import { trustProxyFromEnv } from "./net/client-ip.js";

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : "Invalid environment");
  process.exit(1);
}

const handle = createDb(env.databaseUrl);

// G9: the mailbox domain must be the domain verified in Resend. Warn once if real Resend is configured but the
// domain is still the placeholder (inbound would never match and outbound From would be rejected).
const sharedMailDomain = process.env.SHARED_MAIL_DOMAIN?.trim() || undefined;
const domainWarning = sharedMailDomainWarning();
if (domainWarning) console.warn(domainWarning);
const syncWebhook = process.env.WEBHOOK_SYNC === "1" && process.env.NODE_ENV !== "production";
if (syncWebhook) console.warn("WEBHOOK_SYNC=1: the webhook request waits for the whole pipeline (dev/live scripts only)");

// Dev only: serve canned email content instead of calling Resend (see mail/fake.ts).
const useFake = process.env.FAKE_RESEND_CONTENT === "1" && process.env.NODE_ENV !== "production";
if (useFake) console.warn("FAKE_RESEND_CONTENT=1: inbound mail content is canned, Resend is not called");

// Arkiv: ONE shared real writer per process (single-flight queue), or the in-memory fake without a key.
const realArkiv = env.arkivOperatorPrivateKey
  ? createRealArkivWriter({ privateKey: env.arkivOperatorPrivateKey, accessKey: env.arkivAccessKey })
  : undefined;
if (realArkiv) {
  console.log(`arkiv: real writer enabled (operator ${realArkiv.operatorAddress})`);
} else {
  console.warn("ARKIV_OPERATOR_PRIVATE_KEY is not set: using the in-memory Arkiv writer, nothing is written on chain");
}

// DEV ONLY: metadata listing of the Arkiv inbox. Needs DEV_ROUTES=1, a non-production env and the real writer.
const devInbox: DevInbox | undefined =
  env.devRoutes && realArkiv
    ? {
        async list(agentEns, limit) {
          const page = await realArkiv.reader.listInbox({ agentId: agentEns, limit, includeBytes: false });
          return page.items.map((e) => ({
            key: e.$key,
            type: e.type,
            receivedAt: e.receivedAt,
            $owner: e.$owner,
            $creator: e.$creator,
            $expiresAt: e.$expiresAt.toString(),
          }));
        },
      }
    : undefined;
if (devInbox) console.warn("DEV_ROUTES=1: /internal/dev/inbox/:agentEns is enabled (dev only)");

// Retention (T3.8): per-agent ENS records (OTP / mail lifetime, extend permission), read-only ENS access. Cached <= 60 s
// for writes; an ENS failure falls back to the defaults and never blocks mail.
let retentionEns: ReturnType<typeof createEnsServiceFromConfig> | undefined;
const retention = createRetentionSource({
  read: (name) => {
    retentionEns ??= createEnsServiceFromConfig(
      loadEnsConfig({
        OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`, // read-only: this key is never used to sign
        SEPOLIA_RPC_URL: env.sepoliaRpcUrl ?? "https://ethereum-sepolia-rpc.publicnode.com",
      }),
    );
    return retentionEns.readRetentionPolicy(name);
  },
  log: (f) => console.log(JSON.stringify({ level: "warn", ...f })),
});

// Outbound send (T3.5): needs the creator-pinned reader, the sender-hash secret and a provider.
// FAKE_RESEND_SEND=1 (non-production) records sends in memory instead of calling Resend.
const fakeSend = process.env.FAKE_RESEND_SEND === "1" && process.env.NODE_ENV !== "production";
if (fakeSend) console.warn("FAKE_RESEND_SEND=1: outbound mail is recorded in memory, Resend is not called");
const outbound =
  realArkiv && env.senderHashSecret && (env.resendApiKey || fakeSend)
    ? (() => {
        const ens = createEnsServiceFromConfig(
          loadEnsConfig({
            OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`, // read-only: this key is never used to sign
            SEPOLIA_RPC_URL: env.sepoliaRpcUrl ?? "https://ethereum-sepolia-rpc.publicnode.com",
          }),
        );
        return {
          provider: fakeSend
            ? createFakeMailProvider({ webhookSecret: "whsec_" + Buffer.from("fake-send-only").toString("base64") })
            : createResendProvider({ apiKey: env.resendApiKey!, webhookSecret: env.resendWebhookSecret ?? "whsec_AAAA" }),
          reader: realArkiv.reader,
          arkiv: realArkiv.port,
          ens: {
            readSendPolicy: (name: string) => ens.readSendPolicy(name),
            resolveEmail: async (name: string) => (await ens.resolveAgent(name)).email,
            readSigner: (name: string) => ens.readSigner(name),
          },
          senderHashSecret: env.senderHashSecret,
          sharedMailDomain,
          dailyMailQuota: env.dailyMailQuota,
          retention,
          log: (fields: Record<string, unknown>) => console.error(JSON.stringify({ level: "error", ...fields })),
        };
      })()
    : undefined;

// DEV ONLY: headers of the fake provider's recent sends (to check X-Nanite-Signature). Needs DEV_ROUTES=1 + FAKE_RESEND_SEND=1.
const devOutbox: DevOutbox | undefined =
  env.devRoutes && fakeSend && outbound && "sent" in outbound.provider
    ? {
        recent: (n) =>
          (outbound.provider as unknown as { sent: Array<{ from: string; headers?: Record<string, string> }> }).sent
            .slice(-n)
            .map((m) => ({ from: m.from, headers: { ...(m.headers ?? {}) } })),
      }
    : undefined;
if (devOutbox) console.warn("DEV_ROUTES=1: /internal/dev/outbox is enabled (dev only)");

// Inbound: the webhook answers after recording the event; this processor does the slow part in the background.
const inboundDeps: InboundDeps | undefined =
  (env.resendApiKey || useFake) && env.resendWebhookSecret && env.senderHashSecret
    ? {
        db: handle.db,
        provider: useFake
          ? createFakeMailProvider({ webhookSecret: env.resendWebhookSecret })
          : createResendProvider({ apiKey: env.resendApiKey!, webhookSecret: env.resendWebhookSecret }),
        arkiv: realArkiv ? realArkiv.port : new InMemoryArkivWriter(),
        senderHashSecret: env.senderHashSecret,
        dailyMailQuota: env.dailyMailQuota,
        retention,
        sync: syncWebhook,
      }
    : undefined;
const inboundProcessor =
  inboundDeps && !syncWebhook ? createInboundProcessor(inboundDeps, (f) => console.log(JSON.stringify({ level: f.outcome === "failed" ? "error" : "info", ...f }))) : undefined;
if (inboundDeps && inboundProcessor) inboundDeps.processor = inboundProcessor;
// Crash recovery: re-process events left received / processing / failed (bounded attempts), now and every minute.
const stopSweeper = inboundProcessor?.startSweeper();

// Custom domain onboarding (T3.6): needs the Resend key (or the dev fakes). The verifier is a single in-process loop;
// all its state is in Postgres, so a restart loses nothing.
const fakeDomains = process.env.FAKE_RESEND_DOMAINS === "1" && process.env.NODE_ENV !== "production";
if (fakeDomains) console.warn("FAKE_RESEND_DOMAINS=1: user domains use an in-memory fake Resend and fake DNS (dev only)");
const domainService =
  env.resendApiKey || fakeDomains
    ? createDomainService({
        db: handle.db,
        resend: fakeDomains ? createFakeResendDomains() : createResendDomains({ apiKey: env.resendApiKey! }),
        dns: fakeDomains ? createFakeDns() : createDohResolver(),
        defaultRegion: env.resendDefaultRegion,
        reservedDomains: [...new Set(["nanitecom.itsvikrant.tech", sharedMailDomain?.toLowerCase() ?? ""].filter(Boolean))],
        log: (line) => console.log(line),
      })
    : undefined;
const domainVerifier = domainService ? createDomainVerifier({ db: handle.db, service: domainService, log: (line) => console.log(line) }) : undefined;
const stopDomainVerifier = domainVerifier?.start();

const PING_TIMEOUT_MS = 3000;
const app = createApp({
  db: {
    ping: async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("db ping timeout")), PING_TIMEOUT_MS);
      });
      try {
        await Promise.race([handle.client`select 1`, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  },
  webOrigin: env.webOrigin,
  trustProxy: trustProxyFromEnv(),
  version: pkg.version,
  ...(inboundDeps ? { inbound: inboundDeps } : {}),
  ...(domainService ? { domains: domainService } : {}),
  ...(devInbox ? { devInbox } : {}),
  ...(devOutbox ? { devOutbox } : {}),
  auth: {
    db: handle.db,
    chainIds: [env.authChainId],
    secureCookie: process.env.NODE_ENV === "production",
    chain: createRealUserNameChain({
      operatorPrivateKey: env.operatorPrivateKey,
      sepoliaRpcUrl: env.sepoliaRpcUrl,
      apiPublicUrl: env.apiPublicUrl,
    }),
  },
  agents: {
    chain: createRealAgentChain({
      operatorPrivateKey: env.operatorPrivateKey,
      sepoliaRpcUrl: env.sepoliaRpcUrl,
      apiPublicUrl: env.apiPublicUrl,
    }),
    masterKey: env.naniteMasterKey,
    sharedMailDomain,
    dailyMailQuota: env.dailyMailQuota,
  },
  ...(realArkiv
    ? { mail: { reader: realArkiv.reader, blockNumber: () => realArkiv.reader.client.getBlockNumber(), arkiv: realArkiv.port } }
    : {}),
  // Agent API needs the creator-pinned reader, so it is mounted only with the real Arkiv config.
  ...(realArkiv
    ? {
        v1: {
          db: handle.db,
          reader: realArkiv.reader,
          masterKey: env.naniteMasterKey,
          outbound,
          blockNumber: () => realArkiv.reader.client.getBlockNumber(),
          arkiv: realArkiv.port,
          retention,
        },
      }
    : {}),
});

const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`nanite-api listening on :${info.port} (CORS origin ${env.webOrigin})`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  stopSweeper?.();
  stopDomainVerifier?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Let the event being processed finish (the rest is picked up by the sweep after the next start).
  if (inboundProcessor) await Promise.race([inboundProcessor.idle(), new Promise<void>((r) => setTimeout(r, 7000))]);
  await handle.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

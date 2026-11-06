import { apiBaseUrl } from "@/lib/config"

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

/** JSON call to the Nanite API with the session cookie. Never sends key material (see onboarding-crypto). */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl}${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    })
  } catch {
    throw new ApiError(0, "network_error")
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, typeof json.error === "string" ? json.error : "request_failed", json)
  return json as T
}

export type OnboardingState = "started" | "keys_created" | "name_claimed" | "done"
export interface Me {
  wallet: string
  username: string | null
  ensName: string | null
  onboardingState: OnboardingState
  hasKeys: boolean
  /** The user's mail domain (T3.6). Absent or null until one was added. */
  domain?: { name: string; status: string } | null
}

export type DnsProvider = "cloudflare" | "godaddy" | "namecheap" | "route53" | "google" | "other"

/** POST /onboarding/domain/check */
export interface DomainCheck {
  name: string
  root: string
  suggestion?: string
  rootHasMx: boolean
  provider: DnsProvider
  warnings: string[]
}

export interface DomainRecord {
  purpose: string
  type: string
  /** Relative to the zone root: what DNS panels want. */
  host: string
  fqdn: string
  value: string
  priority?: number
  resendStatus: string
  /** Our own public DNS lookup: null = not checked or lookup failed. */
  dnsFound: boolean | null
}

/** GET /onboarding/domain (and the answer of create / verify). */
export interface DomainView {
  name: string
  zone: string
  status: string
  region: string
  records: DomainRecord[]
  provider: DnsProvider
  providerTips: string[]
  lastCheckedAt: string | null
  nextCheckAt: string | null
  verifyAvailableAt: string | null
  verifiedAt: string | null
}
export interface ClaimStep {
  id: string
  label: string
  status: "pending" | "active" | "done" | "skipped"
  txHash?: string
}
export interface ClaimStatus {
  status: "idle" | "queued" | "running" | "done" | "error"
  username: string | null
  steps: ClaimStep[]
  error: { code: string; message: string } | null
}
export interface OnboardingStatus {
  onboardingState: OnboardingState
  hasKeys: boolean
  username: string | null
  ensName: string | null
  canClaim: boolean
  claim: ClaimStatus
  /** The zero-setup mail domain: agents get <agent>.<user>@<this> until the user's own domain is verified. */
  sharedMailDomain?: string
}
export interface KeyBundle {
  publicKey: string
  keyId: string
  walletSalt: string
  recoverySalt: string
  wrappedPrivateKeyWallet: string
  wrappedPrivateKeyRecovery: string
  wrappedSeedWallet: string
  wrappedSeedRecovery: string
  passphraseMode: boolean
}

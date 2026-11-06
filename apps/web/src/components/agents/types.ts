import type { LogLine } from "@/components/nanite"

/** GET /agents contract (shared with the dashboard). */
export interface AgentSummary {
  id: string
  index: number
  name: string
  ensName: string
  email: string
  walletAddress: string
  status: "provisioning" | "active" | "revoked" | "failed"
  createdAt: string
}

export interface JobStep {
  id: string
  label: string
  status: "pending" | "active" | "done" | "skipped"
  txHash?: string
}

/** GET /agents/:id/status (same step shape as the onboarding claim). */
export interface AgentJobStatus {
  agentStatus: AgentSummary["status"]
  kind: "create" | "policy" | "revoke" | "signer" | null
  status: "idle" | "queued" | "running" | "done" | "error"
  steps: JobStep[]
  error: { code: string; message: string } | null
}

export type SendMode = "off" | "reply-only" | "allowlist" | "any"
export interface SendPolicyValue {
  policy: SendMode
  allow: string[]
  limit: number
}

/** GET /agents/:id/signer. `record` is read fresh from ENS (`nanite.signer`). */
export interface SignerInfo {
  /** Always true now: self-hosted agents sign their own mail with a key on their machine. */
  supported: boolean
  /** "nanite": the server holds the signer key. "self": only the address is registered; the key is on the agent's machine. */
  custody?: "nanite" | "self"
  /** True when Nanite holds the signer key (it can rotate it); false for self-hosted agents. Absent means true. */
  managed?: boolean
  address: string | null
  record: "none" | "pending" | "published" | "mismatch" | "unavailable"
  onchain: string | null
}

export function jobLines(job: Pick<AgentJobStatus, "status" | "steps" | "error">): LogLine[] {
  const total = job.steps.length
  const lines: LogLine[] = []
  job.steps.forEach((s, i) => {
    const time = `${i + 1}/${total}`
    if (s.status === "active") lines.push({ time, level: "info", text: s.label })
    else if (s.status === "done") lines.push({ time, level: "ok", text: s.label })
    else if (s.status === "skipped") lines.push({ time, level: "ok", text: `${s.label} (already on chain)` })
  })
  if (job.status === "error" && job.error) lines.push({ time: "err", level: "error", text: job.error.message })
  if (job.status === "queued") lines.unshift({ time: "0/0", level: "info", text: "queued behind other chain work" })
  return lines
}

export function agentErrorText(code: string): string {
  const map: Record<string, string> = {
    network_error: "Cannot reach the Nanite API. Check your connection and try again.",
    unauthenticated: "Your session ended. Sign in again.",
    operator_not_configured: "Agent creation is not enabled on this server yet (no operator wallet).",
    master_key_not_configured: "This server has no agent key custody configured yet.",
    onboarding_incomplete: "Finish your account setup first.",
    invalid_name: "Use 2 to 32 characters: a-z, 0-9 and inner hyphens.",
    name_taken: "You already have an agent with that name.",
    wallet_taken: "That agent wallet is already registered.",
    index_mismatch: "Your agent list changed. Reload and try again.",
    job_in_progress: "Another change is still being written to ENS. Wait a moment.",
    agent_revoked: "This agent has been revoked.",
    agent_not_active: "The agent is not on chain yet.",
    chain_unavailable: "The Sepolia node did not answer. Try again in a moment.",
    invalid_allow: "One of the allowlist entries is not valid.",
    invalid_limit: "The daily limit must be a whole number from 0 to 10000.",
    invalid_signer: "That is not a valid Ethereum address.",
    invalid_encryption_key: "That encryption public key is not valid. Paste the base64 line from nanite-mcp keygen.",
    signer_requires_self_custody: "A signer address can only be given for a self-hosted agent.",
    not_found: "Agent not found.",
  }
  return map[code] ?? "Something went wrong. Try again."
}

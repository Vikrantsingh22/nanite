"use client"

import * as React from "react"
import Link from "next/link"
import { BanIcon, ExternalLinkIcon, KeyRoundIcon, PlusIcon, SaveIcon, XIcon } from "lucide-react"

import { EnsName, SEND_POLICY_HINT, SendPolicyBadge, StatusLine } from "@/components/nanite"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError } from "@/lib/api"
import { ETHERSCAN_TX } from "@/lib/config"

import { MailSigning } from "./mail-signing"
import { RetentionCard } from "./retention-card"
import { TokenReveal } from "./token-reveal"
import { agentErrorText, jobLines, type AgentJobStatus, type AgentSummary, type SendMode, type SendPolicyValue } from "./types"

const MODES: Array<{ value: SendMode; title: string }> = [
  { value: "off", title: "Off" },
  { value: "reply-only", title: "Reply only" },
  { value: "allowlist", title: "Allowlist" },
  { value: "any", title: "Anyone" },
]
const MODE_TEXT: Record<SendMode, string> = {
  off: "The agent cannot send email.",
  "reply-only": "The agent can only answer people who wrote to it. This is the default.",
  allowlist: "The agent can send to the addresses, domains and ENS names you list.",
  any: "The agent can send to any address. Use with a low daily limit.",
}
const ALLOW_RE = /^([^\s@,]+@[^\s@,]+\.[^\s@,]+|@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|([a-z0-9-]+\.)+eth)$/
const MAX_LIMIT = 10_000

const STATUS_BADGE: Record<AgentSummary["status"], "success" | "warning" | "outline" | "destructive"> = {
  active: "success",
  provisioning: "warning",
  revoked: "outline",
  failed: "destructive",
}

/** Settings for one agent: ENS-enforced send policy, API token rotation and revoke. */
export function AgentSettings({ agentId }: { agentId: string }) {
  const [agent, setAgent] = React.useState<AgentSummary | null>(null)
  const [state, setState] = React.useState<"loading" | "ready" | "anon" | "missing" | "error">("loading")

  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    api<{ agents: AgentSummary[] }>("/agents")
      .then(({ agents }) => {
        if (cancelled) return
        const found = agents.find((a) => a.id === agentId)
        setAgent(found ?? null)
        setState(found ? "ready" : "missing")
      })
      .catch((e) => !cancelled && setState(e instanceof ApiError && e.status === 401 ? "anon" : "error"))
    return () => {
      cancelled = true
    }
  }, [agentId, tick])
  const load = React.useCallback(() => setTick((t) => t + 1), [])

  if (state === "loading") return <Skeleton className="h-64 w-full" />
  if (state === "anon") {
    return (
      <Alert>
        <AlertDescription>
          Sign in to manage this agent. <Link href="/onboarding" className="text-primary underline underline-offset-4">Sign in</Link>
        </AlertDescription>
      </Alert>
    )
  }
  if (state === "missing") {
    return (
      <Alert>
        <AlertDescription>This agent was not found in your account.</AlertDescription>
      </Alert>
    )
  }
  if (state === "error" || !agent) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>Could not load the agent. Reload the page.</AlertDescription>
      </Alert>
    )
  }

  const revoked = agent.status === "revoked"
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="flex flex-wrap items-center gap-2 font-heading text-xl">
            {agent.name}
            <Badge variant={STATUS_BADGE[agent.status]}>{agent.status}</Badge>
          </CardTitle>
          <CardDescription className="font-mono break-all">{agent.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <EnsName name={agent.ensName} resolved={agent.status === "active"} />
        </CardContent>
      </Card>

      {revoked ? (
        <Alert>
          <BanIcon aria-hidden="true" />
          <AlertDescription>This agent is revoked. Its tokens and mailbox are disabled and it can no longer write to ENS.</AlertDescription>
        </Alert>
      ) : agent.status !== "active" ? (
        <Alert>
          <AlertDescription>
            This agent is still being registered on ENS. Send policy and token controls unlock when it is active.{" "}
            <Link href="/agents/new" className="text-primary underline underline-offset-4">Back to add agent</Link>
          </AlertDescription>
        </Alert>
      ) : (
        <SendPolicyEditor agentId={agent.id} />
      )}

      {agent.status === "active" && <RetentionCard agentId={agent.id} />}
      {agent.status === "active" && <MailSigning agentId={agent.id} />}
      {!revoked && <TokenCard agentId={agent.id} />}
      {!revoked && <RevokeCard agent={agent} onRevoked={load} />}
    </div>
  )
}

/* ---------------------------------------------------------------- send policy */

function SendPolicyEditor({ agentId }: { agentId: string }) {
  const [loaded, setLoaded] = React.useState<SendPolicyValue | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<SendMode>("reply-only")
  const [allow, setAllow] = React.useState<string[]>([])
  const [limit, setLimit] = React.useState("50")
  const [entry, setEntry] = React.useState("")
  const [entryError, setEntryError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [job, setJob] = React.useState<AgentJobStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const pending = React.useRef<SendPolicyValue | null>(null)

  React.useEffect(() => {
    let cancelled = false
    api<SendPolicyValue>(`/agents/${agentId}/send-policy`)
      .then((p) => {
        if (cancelled) return
        setLoaded(p)
        setMode(p.policy)
        setAllow(p.allow)
        setLimit(String(p.limit))
      })
      .catch((e) => !cancelled && setLoadError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText("")))
    return () => {
      cancelled = true
    }
  }, [agentId])

  const running = job ? job.status === "queued" || job.status === "running" : false
  React.useEffect(() => {
    if (!running) return
    const t = setInterval(async () => {
      try {
        const next = await api<AgentJobStatus>(`/agents/${agentId}/status`)
        setJob(next)
        if (next.status === "done" || next.status === "error") setSaving(false)
        // After a successful write the saved values become the baseline (the ENS read can lag a few seconds).
        if (next.status === "done" && pending.current) setLoaded(pending.current)
      } catch {
        /* keep polling */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [running, agentId])

  function addEntry() {
    const v = entry.trim().toLowerCase()
    if (!v) return
    if (!ALLOW_RE.test(v) || v.length > 254) {
      setEntryError("Use an email address, an @domain, or an ENS name ending in .eth.")
      return
    }
    setEntryError(null)
    if (!allow.includes(v)) setAllow([...allow, v])
    setEntry("")
  }

  const limitNum = /^\d{1,5}$/.test(limit.trim()) ? Number(limit.trim()) : NaN
  const limitOk = Number.isInteger(limitNum) && limitNum >= 0 && limitNum <= MAX_LIMIT
  const dirty =
    !!loaded && (mode !== loaded.policy || limit.trim() !== String(loaded.limit) || allow.join(",") !== loaded.allow.join(","))

  async function save() {
    if (!limitOk) return
    setError(null)
    setSaving(true)
    try {
      const body = { policy: mode, allow, limit: limitNum }
      setJob(await api<AgentJobStatus>(`/agents/${agentId}/send-policy`, { method: "PUT", body }))
      pending.current = body
    } catch (e) {
      setSaving(false)
      setError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText(""))
    }
  }

  if (loadError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    )
  }
  if (!loaded) return <Skeleton className="h-72 w-full" />

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex flex-wrap items-center gap-2 font-heading text-xl">
          Sending policy
          <SendPolicyBadge policy={loaded.policy} />
        </CardTitle>
        <CardDescription>
          Stored as ENS text records on this agent&apos;s name. The agent&apos;s own wallet cannot change them; every send is checked against ENS first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (dirty && !saving) void save()
          }}
        >
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <fieldset className="flex flex-col gap-3" disabled={saving}>
            <legend className="mb-2 text-sm font-medium">Who can this agent email?</legend>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as SendMode)} aria-label="Send mode">
              {MODES.map((m) => (
                <Field key={m.value} orientation="horizontal">
                  <RadioGroupItem value={m.value} id={`mode-${m.value}`} />
                  <FieldContent>
                    <FieldLabel htmlFor={`mode-${m.value}`}>{m.title}</FieldLabel>
                    <FieldDescription>{MODE_TEXT[m.value]}</FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
          </fieldset>

          {mode === "allowlist" && (
            <fieldset className="flex flex-col gap-3" disabled={saving}>
              <legend className="mb-2 text-sm font-medium">Allowed recipients</legend>
              <Field data-invalid={entryError ? true : undefined}>
                <FieldLabel htmlFor="allow-entry">Add a recipient</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="allow-entry"
                    value={entry}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="friend@example.com, @example.org or name.eth"
                    className="font-mono"
                    aria-invalid={!!entryError}
                    onChange={(e) => setEntry(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        addEntry()
                      }
                    }}
                  />
                  <Button type="button" variant="outline" onClick={addEntry}>
                    <PlusIcon data-icon="inline-start" />
                    Add
                  </Button>
                </div>
                {entryError && <FieldError>{entryError}</FieldError>}
              </Field>
              {allow.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recipients yet. With an empty list the agent cannot send anywhere.</p>
              ) : (
                <ul aria-label="Allowed recipients" className="flex flex-wrap gap-2">
                  {allow.map((a) => (
                    <li key={a} className="inline-flex max-w-full items-center gap-1 rounded-sm border bg-card py-0.5 pr-0.5 pl-2 font-mono text-xs">
                      <span className="truncate">{a}</span>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${a}`} onClick={() => setAllow(allow.filter((x) => x !== a))}>
                        <XIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}

          <Field data-invalid={!limitOk || undefined} className="max-w-48">
            <FieldLabel htmlFor="send-limit">Daily send limit</FieldLabel>
            <Input
              id="send-limit"
              inputMode="numeric"
              value={limit}
              disabled={saving || mode === "off"}
              aria-invalid={!limitOk}
              aria-describedby="send-limit-hint"
              className="font-mono"
              onChange={(e) => setLimit(e.target.value)}
            />
            <FieldDescription id="send-limit-hint" className={limitOk ? undefined : "text-destructive"}>
              {limitOk ? `Whole number, 0 to ${MAX_LIMIT.toLocaleString("en")}.` : `Enter a whole number from 0 to ${MAX_LIMIT.toLocaleString("en")}.`}
            </FieldDescription>
          </Field>

          {job && (
            <div className="flex flex-col gap-3">
              <div className="sr-only" role="status" aria-live="polite">
                {job.status === "done" ? "Policy saved to ENS" : job.status === "error" ? "Saving failed" : "Writing the policy to ENS"}
              </div>
              <StatusLine title="ens://send-policy" lines={jobLines(job)} live={running} />
              {job.steps.some((s) => s.txHash) && (
                <ul className="flex flex-col gap-1 font-mono text-xs">
                  {job.steps
                    .filter((s) => s.txHash)
                    .map((s) => (
                      <li key={s.id}>
                        <a
                          href={`${ETHERSCAN_TX}${s.txHash}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                        >
                          {s.txHash!.slice(0, 10)}…{s.txHash!.slice(-6)}
                          <ExternalLinkIcon className="size-3" aria-hidden="true" />
                          <span className="sr-only">(opens Sepolia Etherscan)</span>
                        </a>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!dirty || !limitOk || saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
              Save to ENS
            </Button>
            <span className="text-xs text-muted-foreground">{SEND_POLICY_HINT[mode]}. Writing takes a few seconds per record.</span>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

/* ---------------------------------------------------------------- token */

function TokenCard({ agentId }: { agentId: string }) {
  const [token, setToken] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [stored, setStored] = React.useState(false)

  async function rotate() {
    setError(null)
    setBusy(true)
    try {
      const r = await api<{ token: string }>(`/agents/${agentId}/token`, { method: "POST" })
      setToken(r.token)
      setStored(false)
    } catch (e) {
      setError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText(""))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">API token</CardTitle>
        <CardDescription>
          The agent uses this token to read its mail through the Nanite API. Rotating issues a new token and revokes the old one immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {token && <TokenReveal token={token} onConfirmChange={setStored} />}
        {token && stored && (
          <Button variant="ghost" className="self-start" onClick={() => setToken(null)}>
            Hide token
          </Button>
        )}
        {!token && (
          <Button variant="outline" className="self-start" disabled={busy} onClick={() => void rotate()}>
            {busy ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
            Rotate token
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/* ---------------------------------------------------------------- revoke */

function RevokeCard({ agent, onRevoked }: { agent: AgentSummary; onRevoked: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function revoke() {
    setError(null)
    setBusy(true)
    try {
      await api(`/agents/${agent.id}/revoke`, { method: "POST" })
      setOpen(false)
      onRevoked()
    } catch (e) {
      setError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText(""))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Revoke agent</CardTitle>
        <CardDescription>
          Disables the agent&apos;s tokens and mailbox now, and removes its write access to its ENS name. Mail already stored stays readable by you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <BanIcon data-icon="inline-start" />
          Revoke {agent.name}
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {agent.name}?</DialogTitle>
            <DialogDescription>
              This cannot be undone. {agent.email} stops receiving mail and the agent&apos;s tokens stop working immediately.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>Cancel</Button>
            </DialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void revoke()}>
              {busy && <Spinner data-icon="inline-start" />}
              Revoke agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

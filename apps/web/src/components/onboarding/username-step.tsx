"use client"

import * as React from "react"
import { CheckIcon, ExternalLinkIcon, XIcon } from "lucide-react"

import { StatusLine, type LogLine } from "@/components/nanite"
import { errorText } from "@/components/onboarding/shell"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError, type ClaimStatus, type OnboardingStatus } from "@/lib/api"
import { ENS_PARENT, ETHERSCAN_TX } from "@/lib/config"

type Availability = { name: string; ok: boolean; text: string }

const REASONS: Record<string, string> = {
  invalid: "Use 3 to 32 characters: a-z, 0-9 and inner hyphens.",
  reserved: "That name is reserved.",
  taken: "That username is taken.",
}
const LOCAL_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/

export function claimLines(claim: ClaimStatus): LogLine[] {
  const total = claim.steps.length
  const lines: LogLine[] = []
  claim.steps.forEach((s, i) => {
    const time = `${i + 1}/${total}`
    if (s.status === "active") lines.push({ time, level: "info", text: `${s.label}` })
    else if (s.status === "done") lines.push({ time, level: "ok", text: s.label })
    else if (s.status === "skipped") lines.push({ time, level: "ok", text: `${s.label} (already on chain)` })
  })
  if (claim.status === "error" && claim.error) lines.push({ time: "err", level: "error", text: claim.error.message })
  if (claim.status === "queued") lines.unshift({ time: "0/0", level: "info", text: "queued behind other registrations" })
  return lines
}

export function UsernameStep({
  status,
  onStatus,
}: {
  status: OnboardingStatus
  onStatus: (s: OnboardingStatus) => void
}) {
  const [name, setName] = React.useState(status.username ?? "")
  const [avail, setAvail] = React.useState<Availability | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const claim = status.claim
  const running = claim.status === "queued" || claim.status === "running"
  const clean = name.trim().toLowerCase()

  // Debounced availability check (state is only set from the timer callback).
  React.useEffect(() => {
    if (running || !LOCAL_RE.test(clean)) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await api<{ available: boolean; reason?: string }>(`/onboarding/username/${encodeURIComponent(clean)}/available`)
        if (!cancelled) setAvail({ name: clean, ok: r.available, text: r.available ? "Available" : REASONS[r.reason ?? ""] ?? "Not available" })
      } catch (e) {
        if (!cancelled) setAvail({ name: clean, ok: false, text: e instanceof ApiError ? errorText(e.code) : errorText("") })
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [clean, running])

  // Poll progress while a claim is running.
  React.useEffect(() => {
    if (!running) return
    const t = setInterval(async () => {
      try {
        onStatus(await api<OnboardingStatus>("/onboarding/status"))
      } catch {
        /* keep polling */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [running, onStatus])

  const checked = avail?.name === clean ? avail : null
  const formatOk = LOCAL_RE.test(clean)

  async function submit() {
    setError(null)
    setSubmitting(true)
    try {
      await api("/onboarding/username", { method: "POST", body: { username: clean } })
      onStatus(await api<OnboardingStatus>("/onboarding/status"))
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code) : errorText(""))
    } finally {
      setSubmitting(false)
    }
  }

  const showProgress = running || claim.status === "error" || claim.steps.length > 0
  const fullName = `${claim.username ?? clean}.${ENS_PARENT}`
  const current = claim.steps.find((s) => s.status === "active")

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Claim your username</CardTitle>
        <CardDescription>
          Your name is registered on ENS (Sepolia) and belongs to your wallet. Registration takes a few transactions, so it can take a minute or two.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!status.canClaim && (
          <Alert role="alert">
            <AlertDescription>Username registration is not enabled on this server yet (no operator wallet is configured).</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!running && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (checked?.ok) void submit()
            }}
          >
            <Field>
              <FieldLabel htmlFor="username">Username</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="username"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-describedby="username-status"
                  className="font-mono"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText className="font-mono">.{ENS_PARENT}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription id="username-status" aria-live="polite" className="flex min-h-5 items-center gap-1.5">
                {!clean ? (
                  "3 to 32 characters: a-z, 0-9 and inner hyphens."
                ) : !formatOk ? (
                  REASONS.invalid
                ) : checked ? (
                  <>
                    {checked.ok ? <CheckIcon className="size-3.5 text-success" aria-hidden="true" /> : <XIcon className="size-3.5 text-destructive" aria-hidden="true" />}
                    <span className={checked.ok ? "text-success" : "text-destructive"}>{checked.text}</span>
                  </>
                ) : (
                  <>
                    <Spinner className="size-3.5" /> Checking
                  </>
                )}
              </FieldDescription>
            </Field>
            <Button type="submit" disabled={!checked?.ok || submitting || !status.canClaim} className="self-start">
              {submitting && <Spinner data-icon="inline-start" />}
              {claim.status === "error" || (status.username && claim.status === "idle") ? "Retry registration" : "Register username"}
            </Button>
          </form>
        )}
        {showProgress && (
          <div className="flex flex-col gap-3">
            <div className="sr-only" role="status" aria-live="polite">
              {running
                ? current
                  ? `Registering ${fullName}: ${current.label}`
                  : `Registering ${fullName}`
                : claim.status === "error"
                  ? "Registration failed. You can retry."
                  : ""}
            </div>
            <StatusLine title={`ens://${fullName}`} lines={claimLines(claim)} live={running} />
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {claim.steps
                .filter((s) => s.txHash)
                .map((s) => (
                  <li key={s.id}>
                    <a
                      href={`${ETHERSCAN_TX}${s.txHash}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      {s.label}: {s.txHash!.slice(0, 10)}…{s.txHash!.slice(-6)}
                      <ExternalLinkIcon className="size-3" aria-hidden="true" />
                      <span className="sr-only">(opens Sepolia Etherscan)</span>
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

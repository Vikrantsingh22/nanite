"use client"

import * as React from "react"
import { CheckCircle2Icon, CheckIcon, ClockIcon, CopyIcon, LightbulbIcon, RefreshCwIcon, SearchCheckIcon, XIcon } from "lucide-react"
import { cn } from "cn"

import { useCopy } from "@/components/nanite/use-copy"
import { useNow } from "@/components/nanite/use-now"
import { errorText } from "@/components/onboarding/shell"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError, type DnsProvider, type DomainCheck, type DomainRecord, type DomainView, type Me } from "@/lib/api"

export const PROVIDER_LABEL: Record<DnsProvider, string> = {
  cloudflare: "Cloudflare",
  godaddy: "GoDaddy",
  namecheap: "Namecheap",
  route53: "Amazon Route 53",
  google: "Google",
  other: "your DNS provider",
}

export type RecordState = "waiting" | "found" | "verified" | "failed"

/** One record's live state, from our own DNS lookup (`dnsFound`) and Resend's verdict (`resendStatus`). */
export function recordState(r: Pick<DomainRecord, "dnsFound" | "resendStatus">): RecordState {
  if (r.resendStatus === "verified") return "verified"
  if (r.dnsFound) return "found"
  if (r.resendStatus === "failed") return "failed"
  return "waiting"
}

const STATE_LABEL: Record<RecordState, string> = { waiting: "waiting", found: "found in DNS", verified: "verified", failed: "failed" }
const STATE_BADGE = { waiting: "outline", found: "info", verified: "success", failed: "destructive" } as const
const STATE_ICON = { waiting: ClockIcon, found: SearchCheckIcon, verified: CheckIcon, failed: XIcon } as const

const recordKey = (r: Pick<DomainRecord, "type" | "host">) => `${r.type}|${r.host}`
const recordName = (r: DomainRecord) => `${r.purpose} ${r.type} record`

function apiMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return typeof e.body.message === "string" ? e.body.message : errorText(e.code)
  }
  return errorText("")
}

export function StateChip({ state }: { state: RecordState }) {
  const Icon = STATE_ICON[state]
  return (
    <Badge variant={STATE_BADGE[state]} data-state={state}>
      <Icon aria-hidden="true" />
      {STATE_LABEL[state]}
    </Badge>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy()
  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={copied ? `${label} copied` : `Copy ${label}`} onClick={() => void copy(text)}>
      {copied ? <CheckIcon className="text-success" aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
    </Button>
  )
}

function Cell({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <td
      data-label={label}
      className={cn(
        "px-3 py-2 align-top max-md:flex max-md:items-start max-md:gap-3 max-md:px-0 max-md:py-1 max-md:before:w-16 max-md:before:shrink-0 max-md:before:pt-0.5 max-md:before:font-mono max-md:before:text-[0.6875rem] max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]",
        className,
      )}
    >
      {children}
    </td>
  )
}

export function RecordsTable({ records, zone }: { records: DomainRecord[]; zone: string }) {
  return (
    <table className="w-full text-left text-sm" data-testid="dns-records">
      <caption className="sr-only">DNS records to add in the zone {zone}</caption>
      <thead className="max-md:sr-only">
        <tr className="border-b font-mono text-xs text-muted-foreground">
          <th scope="col" className="px-3 py-2 font-medium">Type</th>
          <th scope="col" className="px-3 py-2 font-medium">Host</th>
          <th scope="col" className="px-3 py-2 font-medium">Value</th>
          <th scope="col" className="px-3 py-2 font-medium">Priority</th>
          <th scope="col" className="px-3 py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {records.map((r) => {
          const name = recordName(r)
          return (
            <tr
              key={recordKey(r) + r.value}
              data-testid="dns-record"
              data-record={recordKey(r)}
              className="border-b last:border-b-0 max-md:block max-md:px-1 max-md:py-3"
            >
              <Cell label="Type">
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs font-medium">{r.type}</span>
                  <span className="text-xs text-muted-foreground">{r.purpose}</span>
                </div>
              </Cell>
              <Cell label="Host">
                <div className="flex min-w-0 items-start gap-1">
                  <code className="min-w-0 font-mono text-xs break-all">{r.host}</code>
                  <CopyButton text={r.host} label={`host of the ${name}`} />
                </div>
              </Cell>
              <Cell label="Value" className="md:max-w-[22rem]">
                <div className="flex min-w-0 items-start gap-1">
                  <code className="min-w-0 font-mono text-xs break-all">{r.value}</code>
                  <CopyButton text={r.value} label={`value of the ${name}`} />
                </div>
              </Cell>
              <Cell label="Priority">
                {r.priority !== undefined ? (
                  <div className="flex items-center gap-1">
                    <code className="font-mono text-xs">{r.priority}</code>
                    <CopyButton text={String(r.priority)} label={`priority of the ${name}`} />
                  </div>
                ) : (
                  <span className="text-muted-foreground" aria-label="no priority">
                    -
                  </span>
                )}
              </Cell>
              <Cell label="Status">
                <StateChip state={recordState(r)} />
              </Cell>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Polls GET /onboarding/domain: every 5 s, every 15 s after 2 minutes, paused while the tab is hidden. */
function useDomainPolling(enabled: boolean, onView: (v: DomainView) => void) {
  const cb = React.useRef(onView)
  React.useEffect(() => {
    cb.current = onView
  })
  React.useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    let paused = false
    const started = Date.now()
    const schedule = () => {
      timer = setTimeout(() => void tick(), Date.now() - started > 120_000 ? 15_000 : 5_000)
    }
    const tick = async () => {
      if (cancelled) return
      if (document.hidden) {
        paused = true
        return
      }
      try {
        const v = await api<DomainView>("/onboarding/domain")
        if (!cancelled) cb.current(v)
      } catch {
        /* keep polling */
      }
      if (!cancelled) schedule()
    }
    const onVisible = () => {
      if (document.hidden || !paused) return
      paused = false
      if (timer) clearTimeout(timer)
      void tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [enabled])
}

const ago = (seconds: number) => (seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`)

export const DNS_DELAY_NOTE = "DNS changes can take up to 72 hours to reach the internet. You can keep using Nanite meanwhile."

type Variant = "wizard" | "settings"

function DomainRecords({
  initial,
  variant,
  onView,
  onRemoved,
  onContinue,
}: {
  initial: DomainView
  variant: Variant
  onView: (v: DomainView) => void
  onRemoved: () => void
  onContinue: () => void
}) {
  const [view, setView] = React.useState(initial)
  const [announce, setAnnounce] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [cooldownUntil, setCooldownUntil] = React.useState(0)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const prev = React.useRef(new Map(initial.records.map((r) => [recordKey(r), recordState(r)])))
  const now = useNow(1000)
  const verified = view.status === "verified"

  const apply = React.useCallback(
    (next: DomainView) => {
      const msgs: string[] = []
      for (const r of next.records) {
        const s = recordState(r)
        const was = prev.current.get(recordKey(r))
        if (was !== undefined && was !== s) msgs.push(`${recordName(r)}: ${STATE_LABEL[s]}`)
        prev.current.set(recordKey(r), s)
      }
      if (next.status === "verified" && view.status !== "verified") msgs.push("Your domain is verified")
      if (msgs.length > 0) setAnnounce(msgs.join(". "))
      if (next.verifyAvailableAt) setCooldownUntil((c) => Math.max(c, Date.parse(next.verifyAvailableAt!)))
      setView(next)
      onView(next)
    },
    [onView, view.status],
  )

  useDomainPolling(!verified, apply)

  async function checkNow() {
    setError(null)
    setChecking(true)
    setCooldownUntil(Date.now() + 30_000)
    try {
      apply(await api<DomainView>("/onboarding/domain/verify", { method: "POST" }))
    } catch (e) {
      if (e instanceof ApiError && e.code === "verify_rate_limited") {
        const s = typeof e.body.retryAfterSeconds === "number" ? e.body.retryAfterSeconds : 30
        setCooldownUntil(Date.now() + s * 1000)
      } else setError(apiMessage(e))
    } finally {
      setChecking(false)
    }
  }

  async function remove() {
    setRemoving(true)
    setError(null)
    try {
      await api("/onboarding/domain", { method: "DELETE" })
      onRemoved()
    } catch (e) {
      setError(apiMessage(e))
      setRemoving(false)
    }
  }

  const found = view.records.filter((r) => ["found", "verified"].includes(recordState(r))).length
  const total = view.records.length
  const wait = now === null ? 0 : Math.max(0, Math.ceil((cooldownUntil - now) / 1000))
  const lastSeconds = now !== null && view.lastCheckedAt ? Math.max(0, Math.floor((now - Date.parse(view.lastCheckedAt)) / 1000)) : null

  if (verified) {
    return (
      <Card data-testid="domain-verified">
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 font-heading text-xl">
            <CheckCircle2Icon className="size-5 text-success" aria-hidden="true" />
            Domain verified
          </CardTitle>
          <CardDescription>
            <span className="font-mono">{view.name}</span> is ready. New agents get addresses like <span className="font-mono">agent@{view.name}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="sr-only" role="status" aria-live="polite">
            {announce}
          </div>
          <div className="overflow-hidden rounded-lg border">
            <RecordsTable records={view.records} zone={view.zone} />
          </div>
          <Button className="self-start" onClick={onContinue}>
            {variant === "wizard" ? "Continue" : "Done"}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Add these DNS records</CardTitle>
        <CardDescription>
          Add them in the DNS settings of <span className="font-mono">{view.zone}</span>. Nanite checks your DNS every few seconds and verifies the domain as soon as everything is there. You can leave this page and come back.
          <span className="mt-1 block" data-testid="dns-delay-note">{DNS_DELAY_NOTE}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="sr-only" role="status" aria-live="polite" data-testid="domain-announce">
          {announce}
        </div>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2" data-testid="domain-progress">
          <div className="flex items-center justify-between gap-3 font-mono text-xs">
            <span className="tnum">
              {found}/{total} records found
            </span>
            <span className="text-muted-foreground">domain: {view.status.replace(/_/g, " ")}</span>
          </div>
          <Progress value={total ? (found / total) * 100 : 0} aria-label="Records found in DNS" />
        </div>
        <div className="rounded-lg border">
          <RecordsTable records={view.records} zone={view.zone} />
        </div>
        <Alert variant="info" role="note" data-testid="provider-tips">
          <LightbulbIcon aria-hidden="true" />
          <div className="col-start-2 flex flex-col gap-1">
            <p className="font-medium">Tips for {PROVIDER_LABEL[view.provider]}</p>
            <ul className="list-disc space-y-1 pl-4 text-foreground/80">
              {view.providerTips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </Alert>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void checkNow()} disabled={checking || wait > 0}>
            {checking ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {wait > 0 && !checking ? `Check again in ${wait}s` : "Check now"}
          </Button>
          <span className="font-mono text-xs text-muted-foreground" data-testid="last-checked">
            {lastSeconds === null ? (view.lastCheckedAt ? "last checked just now" : "not checked yet") : `last checked ${ago(lastSeconds)}`}
          </span>
          {variant === "wizard" && (
            <Button type="button" variant="outline" onClick={onContinue}>
              Continue for now
            </Button>
          )}
          <span className="flex-1" />
          {!confirmRemove ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              Use a different domain
            </Button>
          ) : (
            <span className="inline-flex items-center gap-2 text-xs">
              Remove {view.name}?
              <Button type="button" variant="destructive" size="sm" disabled={removing} onClick={() => void remove()}>
                {removing && <Spinner data-icon="inline-start" />}
                Remove
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </span>
          )}
        </div>
        {variant === "wizard" && (
          <p className="text-xs text-muted-foreground" data-testid="background-note">
            You do not have to wait. Press Continue for now and finish setup; verification keeps running in the background, and new agents use the shared address until your domain is verified.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function DomainEntry({ onCreated, onBack }: { onCreated: (v: DomainView) => void; onBack?: () => void }) {
  const [input, setInput] = React.useState("")
  const [result, setResult] = React.useState<DomainCheck | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<"check" | "create" | null>(null)

  async function check(value: string) {
    setError(null)
    setBusy("check")
    try {
      setResult(await api<DomainCheck>("/onboarding/domain/check", { method: "POST", body: { name: value.trim() } }))
    } catch (e) {
      setResult(null)
      setError(apiMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function create() {
    if (!result) return
    setError(null)
    setBusy("create")
    try {
      onCreated(await api<DomainView>("/onboarding/domain", { method: "POST", body: { name: result.name } }))
    } catch (e) {
      setError(apiMessage(e))
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Add your mail domain</CardTitle>
        <CardDescription>
          Your agents get their own addresses on a domain you control, like <span className="font-mono">alex@mail.yourcompany.com</span>. A subdomain keeps agent mail apart from your normal mail.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (input.trim() && !busy) void check(input)
          }}
        >
          <Field>
            <FieldLabel htmlFor="domain-name">Domain</FieldLabel>
            <Input
              id="domain-name"
              placeholder="mail.yourcompany.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setResult(null)
              }}
              className="font-mono"
              aria-describedby="domain-hint"
            />
            <FieldDescription id="domain-hint">You must be able to edit this domain&apos;s DNS records.</FieldDescription>
          </Field>
          {!result && (
            <Button type="submit" className="self-start" disabled={!input.trim() || busy !== null}>
              {busy === "check" && <Spinner data-icon="inline-start" />}
              Check domain
            </Button>
          )}
        </form>
        {result && (
          <div className="flex flex-col gap-3" data-testid="domain-check">
            <div className="flex flex-wrap items-center gap-2 text-sm" role="status" aria-live="polite">
              <CheckIcon className="size-4 text-success" aria-hidden="true" />
              <span className="font-mono">{result.name}</span>
              <Badge variant="secondary">DNS: {PROVIDER_LABEL[result.provider]}</Badge>
            </div>
            {result.warnings.map((w) => (
              <Alert key={w} variant="warning" role="note">
                <AlertDescription>{w}</AlertDescription>
              </Alert>
            ))}
            {result.suggestion && result.suggestion !== result.name && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>We suggest</span>
                <code className="font-mono">{result.suggestion}</code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setInput(result.suggestion!)
                    void check(result.suggestion!)
                  }}
                >
                  Use {result.suggestion}
                </Button>
              </div>
            )}
            <Button type="button" className="self-start" disabled={busy !== null} onClick={() => void create()}>
              {busy === "create" && <Spinner data-icon="inline-start" />}
              Add {result.name}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{DNS_DELAY_NOTE}</p>
        {onBack && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}>
            Back to options
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function DomainChoice({ sharedMailDomain, username, onOwn, onShared }: { sharedMailDomain: string; username: string; onOwn: () => void; onShared: () => void }) {
  const example = `alex.${username}@${sharedMailDomain}`
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Choose your agents&apos; mail address</CardTitle>
        <CardDescription>Both options work. You can add your own domain later from the dashboard.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border border-primary/40 p-4" aria-labelledby="opt-own" data-testid="option-own">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="opt-own" className="font-heading text-base font-medium">Use your own domain</h3>
            <Badge variant="success">Recommended</Badge>
          </div>
          <p className="text-sm text-muted-foreground">Your brand, your addresses, like <span className="font-mono text-foreground">alex@mail.yourcompany.com</span>. You add a few DNS records and Nanite checks them for you.</p>
          <p className="text-xs text-muted-foreground">{DNS_DELAY_NOTE}</p>
          <Button type="button" className="mt-auto self-start" onClick={onOwn}>
            Use my own domain
          </Button>
        </section>
        <section className="flex flex-col gap-3 rounded-lg border p-4" aria-labelledby="opt-shared" data-testid="option-shared">
          <h3 id="opt-shared" className="font-heading text-base font-medium">Start now with {sharedMailDomain}</h3>
          <p className="text-sm text-muted-foreground">The faster route: zero setup. Your agents get addresses like <span className="font-mono text-foreground break-all">{example}</span>.</p>
          <Button type="button" variant="outline" className="mt-auto self-start" onClick={onShared}>
            Start now
          </Button>
        </section>
      </CardContent>
    </Card>
  )
}

/**
 * Wizard step 04 (optional): choose between your own domain (recommended) and the shared domain, then, for your own
 * domain, add it, publish the DNS records and watch the status. Resumable from /me. In the dashboard
 * (`variant="settings"`) there is no choice: it adds or shows the domain directly.
 */
export function DomainStep({
  me,
  onChanged,
  onContinue,
  variant = "wizard",
  sharedMailDomain = "nanite.test",
}: {
  me: Me
  onChanged: () => void
  onContinue: () => void
  variant?: Variant
  sharedMailDomain?: string
}) {
  const [view, setView] = React.useState<DomainView | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [removed, setRemoved] = React.useState(false)
  const [own, setOwn] = React.useState(variant === "settings")
  const has = !!me.domain && !removed

  React.useEffect(() => {
    if (!has || view) return
    let cancelled = false
    api<DomainView>("/onboarding/domain")
      .then((v) => !cancelled && setView(v))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [has, view])

  if (view) {
    return (
      <DomainRecords
        initial={view}
        variant={variant}
        onView={() => undefined}
        onRemoved={() => {
          setRemoved(true)
          setView(null)
          setOwn(variant === "settings")
          onChanged()
        }}
        onContinue={onContinue}
      />
    )
  }
  if (has && !failed) return <Skeleton className="h-64 w-full" />
  if (has && failed) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>Could not load your domain. Reload the page to try again.</AlertDescription>
      </Alert>
    )
  }
  if (!own) {
    return <DomainChoice sharedMailDomain={sharedMailDomain} username={me.username ?? "you"} onOwn={() => setOwn(true)} onShared={onContinue} />
  }
  return (
    <DomainEntry
      onBack={variant === "wizard" ? () => setOwn(false) : undefined}
      onCreated={(v) => {
        setRemoved(false)
        setView(v)
        onChanged()
      }}
    />
  )
}

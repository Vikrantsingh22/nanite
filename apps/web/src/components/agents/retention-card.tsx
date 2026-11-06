"use client"

import * as React from "react"
import { ExternalLinkIcon, SaveIcon } from "lucide-react"

import { StatusLine } from "@/components/nanite"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api, ApiError } from "@/lib/api"
import { ETHERSCAN_TX } from "@/lib/config"

import { agentErrorText, jobLines, type AgentJobStatus, type RetentionValue } from "./types"

const MAX_HOURS = 4380 // 182.5 days, the Arkiv maximum lifetime
const MAX_DAYS = 182
const MAX_EXTEND_LIMIT = 1000

type Unit = "hours" | "days"

const wholeNumber = (s: string) => (/^\d{1,6}$/.test(s.trim()) ? Number(s.trim()) : NaN)

/** Retention: how long mail lives on Arkiv, and whether the agent may keep mail longer. Stored as ENS records. */
export function RetentionCard({ agentId }: { agentId: string }) {
  const [loaded, setLoaded] = React.useState<RetentionValue | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [otp, setOtp] = React.useState("5")
  const [mail, setMail] = React.useState("2")
  const [unit, setUnit] = React.useState<Unit>("days")
  const [extend, setExtend] = React.useState(true)
  const [limit, setLimit] = React.useState("20")
  const [saving, setSaving] = React.useState(false)
  const [job, setJob] = React.useState<AgentJobStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const pending = React.useRef<RetentionValue | null>(null)

  const apply = React.useCallback((p: RetentionValue) => {
    setLoaded(p)
    setOtp(String(p.otpTtlMinutes))
    const days = p.mailTtlHours % 24 === 0
    setUnit(days ? "days" : "hours")
    setMail(String(days ? p.mailTtlHours / 24 : p.mailTtlHours))
    setExtend(p.extend === "on")
    setLimit(String(p.extendLimit))
  }, [])

  React.useEffect(() => {
    let cancelled = false
    api<RetentionValue>(`/agents/${agentId}/retention`)
      .then((p) => !cancelled && apply(p))
      .catch((e) => !cancelled && setLoadError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText("")))
    return () => {
      cancelled = true
    }
  }, [agentId, apply])

  const running = job ? job.status === "queued" || job.status === "running" : false
  React.useEffect(() => {
    if (!running) return
    const t = setInterval(async () => {
      try {
        const next = await api<AgentJobStatus>(`/agents/${agentId}/status`)
        setJob(next)
        if (next.status === "done" || next.status === "error") setSaving(false)
        if (next.status === "done" && pending.current) setLoaded(pending.current)
      } catch {
        /* keep polling */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [running, agentId])

  const otpNum = wholeNumber(otp)
  const otpOk = Number.isInteger(otpNum) && otpNum >= 1 && otpNum <= 60
  const mailNum = wholeNumber(mail)
  const mailHours = unit === "days" ? mailNum * 24 : mailNum
  const mailOk = Number.isInteger(mailNum) && mailNum >= 1 && (unit === "days" ? mailNum <= MAX_DAYS : mailNum <= MAX_HOURS)
  const limitNum = wholeNumber(limit)
  const limitOk = Number.isInteger(limitNum) && limitNum >= 0 && limitNum <= MAX_EXTEND_LIMIT
  const valid = otpOk && mailOk && limitOk

  const next: RetentionValue | null = valid
    ? { otpTtlMinutes: otpNum, mailTtlHours: mailHours, extend: extend ? "on" : "off", extendLimit: limitNum }
    : null
  const dirty =
    !!loaded &&
    !!next &&
    (next.otpTtlMinutes !== loaded.otpTtlMinutes ||
      next.mailTtlHours !== loaded.mailTtlHours ||
      next.extend !== loaded.extend ||
      next.extendLimit !== loaded.extendLimit)

  async function save() {
    if (!next || !loaded) return
    setError(null)
    setSaving(true)
    try {
      // Only the changed records are written (each one is an ENS transaction).
      const body: Partial<RetentionValue> = {}
      if (next.otpTtlMinutes !== loaded.otpTtlMinutes) body.otpTtlMinutes = next.otpTtlMinutes
      if (next.mailTtlHours !== loaded.mailTtlHours) body.mailTtlHours = next.mailTtlHours
      if (next.extend !== loaded.extend) body.extend = next.extend
      if (next.extendLimit !== loaded.extendLimit) body.extendLimit = next.extendLimit
      pending.current = next
      setJob(await api<AgentJobStatus>(`/agents/${agentId}/retention`, { method: "PUT", body }))
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
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">
          Retention
        </CardTitle>
        <CardDescription>
          Mail disappears from Arkiv after this time unless you or the agent keep it. Stored as ENS text records; the agent&apos;s own wallet cannot change them.
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

          <Field data-invalid={!otpOk || undefined} className="max-w-48">
            <FieldLabel htmlFor="otp-ttl">One-time code lifetime (minutes)</FieldLabel>
            <Input
              id="otp-ttl"
              inputMode="numeric"
              value={otp}
              disabled={saving}
              aria-invalid={!otpOk}
              aria-describedby="otp-ttl-hint"
              className="font-mono"
              onChange={(e) => setOtp(e.target.value)}
            />
            <FieldDescription id="otp-ttl-hint" className={otpOk ? undefined : "text-destructive"}>
              {otpOk ? "1 to 60. Codes can never be extended." : "Enter a whole number from 1 to 60."}
            </FieldDescription>
          </Field>

          <fieldset className="flex flex-col gap-3" disabled={saving}>
            <legend className="mb-2 text-sm font-medium">Mail lifetime</legend>
            <div className="flex flex-wrap items-start gap-4">
              <Field data-invalid={!mailOk || undefined} className="w-32">
                <FieldLabel htmlFor="mail-ttl" className="sr-only">
                  Mail lifetime ({unit})
                </FieldLabel>
                <Input
                  id="mail-ttl"
                  inputMode="numeric"
                  value={mail}
                  aria-invalid={!mailOk}
                  aria-describedby="mail-ttl-hint"
                  className="font-mono"
                  onChange={(e) => setMail(e.target.value)}
                />
              </Field>
              <RadioGroup
                value={unit}
                onValueChange={(v) => setUnit(v as Unit)}
                aria-label="Mail lifetime unit"
                className="flex gap-4 pt-1.5"
              >
                {(["hours", "days"] as const).map((u) => (
                  <Field key={u} orientation="horizontal" className="w-auto">
                    <RadioGroupItem value={u} id={`mail-unit-${u}`} />
                    <FieldLabel htmlFor={`mail-unit-${u}`}>{u}</FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </div>
            <p id="mail-ttl-hint" className={`text-sm ${mailOk ? "text-muted-foreground" : "text-destructive"}`}>
              {mailOk
                ? "How long new conversation and sent mail stays on Arkiv. Default 2 days, at most 182 days."
                : unit === "days"
                  ? "Enter a whole number from 1 to 182 days."
                  : "Enter a whole number from 1 to 4380 hours."}
            </p>
          </fieldset>

          <Field orientation="horizontal">
            <Switch
              id="agent-extend"
              checked={extend}
              disabled={saving}
              onCheckedChange={setExtend}
              aria-describedby="agent-extend-hint"
            />
            <FieldContent>
              <FieldLabel htmlFor="agent-extend">The agent can keep mail longer</FieldLabel>
              <FieldDescription id="agent-extend-hint">
                When on, the agent may extend conversation and sent mail for up to 182 days. You pay the small network fee for each extension.
              </FieldDescription>
            </FieldContent>
          </Field>

          <Field data-invalid={!limitOk || undefined} className="max-w-48">
            <FieldLabel htmlFor="extend-limit">Extensions per day</FieldLabel>
            <Input
              id="extend-limit"
              inputMode="numeric"
              value={limit}
              disabled={saving || !extend}
              aria-invalid={!limitOk}
              aria-describedby="extend-limit-hint"
              className="font-mono"
              onChange={(e) => setLimit(e.target.value)}
            />
            <FieldDescription id="extend-limit-hint" className={limitOk ? undefined : "text-destructive"}>
              {limitOk ? `Whole number, 0 to ${MAX_EXTEND_LIMIT.toLocaleString("en")} (UTC day).` : `Enter a whole number from 0 to ${MAX_EXTEND_LIMIT.toLocaleString("en")}.`}
            </FieldDescription>
          </Field>

          {job && (
            <div className="flex flex-col gap-3">
              <div className="sr-only" role="status" aria-live="polite">
                {job.status === "done" ? "Retention saved to ENS" : job.status === "error" ? "Saving failed" : "Writing the retention settings to ENS"}
              </div>
              <StatusLine title="ens://retention" lines={jobLines(job)} live={running} />
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
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
              Save retention to ENS
            </Button>
            <span className="text-xs text-muted-foreground">Applies to new mail. Writing takes a few seconds per changed record.</span>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

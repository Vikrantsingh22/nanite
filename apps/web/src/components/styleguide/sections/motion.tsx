"use client"

import * as React from "react"
import { RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { OtpCountdown } from "@/components/nanite"

import { Code, Section, Subsection } from "../primitives"

const DURATIONS = [
  { token: "instant", ms: "0-100", use: "hover, press, focus ring" },
  { token: "quick", ms: "150-250", use: "menus, tooltips, copy confirmation" },
  { token: "reveal", ms: "700", use: "load-in of new content (clip, left to right)" },
  { token: "loop", ms: "1100-2600", use: "caret, scan, live pulse only" },
]

function Demo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <Code>{label}</Code>
      <div className="flex min-h-24 flex-1 items-center">{children}</div>
    </div>
  )
}

export function MotionSection() {
  const [run, setRun] = React.useState(0)
  const [expiresAt, setExpiresAt] = React.useState(() => Date.now() + 25_000)

  return (
    <Section
      id="motion"
      index="05"
      title="Motion"
      lead="Four motions, each with a meaning. All of them stop under prefers-reduced-motion; the caret stays solid and the countdown still counts."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Demo label="caret · input is live">
          <p className="font-mono text-sm">
            <span className="text-primary">$</span> resolve alex.vikrant.nanitecom.eth<span className="caret" />
          </p>
        </Demo>
        <Demo label="scan · decrypting">
          <div className="relative h-14 w-full overflow-hidden rounded-md border bg-muted">
            <div className="absolute inset-x-3 top-3 flex flex-col gap-2" aria-hidden="true">
              <span className="h-2 w-3/4 rounded-xs bg-muted-foreground/25" />
              <span className="h-2 w-1/2 rounded-xs bg-muted-foreground/25" />
            </div>
            <div className="absolute inset-x-0 h-full animate-scan bg-gradient-to-b from-transparent via-signal-glow to-transparent" aria-hidden="true" />
          </div>
        </Demo>
        <Demo label="pulse-ring · live signal">
          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="size-2.5 animate-pulse-ring rounded-full bg-primary" aria-hidden="true" />
            listening on alex@nanite.email
          </div>
        </Demo>
        <Demo label="reveal · new content arrives">
          <div className="flex w-full items-center justify-between gap-3">
            <div key={run} className="animate-reveal rounded-md border bg-muted px-3 py-2 font-mono text-xs">
              0x9f3a…c21e · Your login code
            </div>
            <Button variant="outline" size="sm" onClick={() => setRun((n) => n + 1)}>
              <RotateCwIcon data-icon="inline-start" />
              Replay
            </Button>
          </div>
        </Demo>
      </div>

      <Subsection title="Countdown" note="Time is shown as both a number and a depleting bar; the bar turns amber under 10 seconds and red at zero.">
        <div className="max-w-md">
          <OtpCountdown
            code="482913"
            from="auth@example.com"
            expiresAt={expiresAt}
            totalMs={25_000}
            onRequestNew={() => setExpiresAt(Date.now() + 25_000)}
          />
        </div>
      </Subsection>

      <Subsection title="Durations">
        <div className="overflow-hidden rounded-lg border">
          {DURATIONS.map((d) => (
            <div key={d.token} className="grid grid-cols-[5rem_6rem_1fr] gap-3 border-b bg-card/50 px-4 py-2.5 text-sm last:border-b-0">
              <Code>{d.token}</Code>
              <span className="font-mono text-xs text-muted-foreground tnum">{d.ms} ms</span>
              <span className="text-muted-foreground">{d.use}</span>
            </div>
          ))}
        </div>
      </Subsection>
    </Section>
  )
}

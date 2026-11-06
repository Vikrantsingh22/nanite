"use client"

import * as React from "react"
import { CheckIcon, CopyIcon, RotateCwIcon } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

import { useCopy } from "./use-copy"
import { useNow } from "./use-now"

type OtpCountdownProps = {
  code: string
  /** Epoch ms at which the code stops being valid. */
  expiresAt: number
  /** Total validity window, for the progress bar. */
  totalMs?: number
  from?: string
  onRequestNew?: () => void
  className?: string
}

function formatRemaining(ms: number) {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** One-time code with live countdown, progress and expired state. */
export function OtpCountdown({
  code,
  expiresAt,
  totalMs = 60_000,
  from,
  onRequestNew,
  className,
}: OtpCountdownProps) {
  const now = useNow(250)
  const { copied, copy } = useCopy()
  const remaining = now === null ? null : Math.max(0, expiresAt - now)
  const expired = remaining === 0
  const pct = remaining === null ? 100 : Math.min(100, (remaining / totalMs) * 100)
  const urgent = remaining !== null && remaining <= 10_000 && !expired
  const half = Math.ceil(code.length / 2)

  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {from ? `one-time code from ${from}` : "one-time code"}
        </span>
        {expired ? (
          <Badge variant="destructive">expired</Badge>
        ) : urgent ? (
          <Badge variant="warning">expiring</Badge>
        ) : (
          <Badge variant="success">valid</Badge>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            "font-mono text-3xl font-medium tracking-[0.18em] tnum sm:text-4xl",
            expired && "text-muted-foreground line-through decoration-destructive",
          )}
          aria-label={`Code ${code.split("").join(" ")}`}
        >
          {code.slice(0, half)}
          <span className="px-[0.15em]" />
          {code.slice(half)}
        </span>
        <Button
          variant="outline"
          size="icon"
          disabled={expired}
          aria-label={copied ? "Code copied" : "Copy code"}
          onClick={() => copy(code)}
        >
          {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
        </Button>
      </div>
      <Progress
        value={pct}
        aria-label="Time until the code expires"
        indicatorClassName={cn(
          "transition-[transform] duration-300 ease-linear",
          expired ? "bg-destructive" : urgent ? "bg-warning" : "bg-primary",
        )}
      />
      <div className="flex items-center justify-between gap-2 font-mono text-xs">
        <span className="text-muted-foreground tnum" aria-live="off">
          {remaining === null
            ? "expires in --:--"
            : expired
              ? "expired"
              : `expires in ${formatRemaining(remaining)}`}
        </span>
        {expired && (
          <Button variant="ghost" size="xs" onClick={onRequestNew}>
            <RotateCwIcon data-icon="inline-start" />
            Request new code
          </Button>
        )}
      </div>
    </div>
  )
}

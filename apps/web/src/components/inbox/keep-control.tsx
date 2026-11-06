"use client"

import * as React from "react"
import { BookmarkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError } from "@/lib/api"

import { KEEP_DAYS, type MailEntity } from "./mail"

interface ExtendResult {
  status: "extended" | "unchanged"
  expiresAtBlock: string
  expiresAt: string | null
}

const KEEP_ERRORS: Record<string, string> = {
  rate_limited: "Too many requests. Try again in a minute.",
  otp_not_extendable: "One-time codes cannot be kept.",
  not_found: "This message is no longer on Arkiv.",
  network_error: "Cannot reach the Nanite API.",
}

/** "Keep" action: pick how long to keep a conversation/sent message; the operator extends it on Arkiv. */
export function KeepControl({
  agentId,
  entity,
  onKept,
}: {
  agentId: string
  entity: MailEntity
  onKept: (patch: Pick<MailEntity, "expiresAtBlock" | "expiresAt">) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState<number | null>(null)
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null)

  async function keep(days: number) {
    setBusy(days)
    setMessage(null)
    try {
      const r = await api<ExtendResult>(`/mail/${encodeURIComponent(agentId)}/emails/${entity.key}/extend`, {
        method: "POST",
        body: { days },
      })
      onKept({ expiresAtBlock: r.expiresAtBlock, expiresAt: r.expiresAt })
      setMessage({
        ok: true,
        text: r.status === "extended" ? `Kept for ${days} more days.` : "Already kept at least that long.",
      })
      setOpen(false)
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? (KEEP_ERRORS[e.code] ?? "Could not keep this message. Try again.") : "Could not keep this message. Try again." })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={(v) => busy === null && setOpen(v)}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="xs" data-testid="keep-button">
            <BookmarkIcon data-icon="inline-start" />
            Keep
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          <PopoverHeader>
            <PopoverTitle>Keep this message</PopoverTitle>
            <PopoverDescription>Stays on Arkiv this many days from now. Nanite pays the network fee.</PopoverDescription>
          </PopoverHeader>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Keep for">
            {KEEP_DAYS.map((d) => (
              <Button key={d} variant="outline" size="sm" disabled={busy !== null} onClick={() => void keep(d)} data-testid={`keep-${d}`}>
                {busy === d && <Spinner data-icon="inline-start" />}
                {d} days
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {message && (
        <span role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-muted-foreground" : "text-destructive"}`} data-testid="keep-message">
          {message.text}
        </span>
      )}
    </div>
  )
}

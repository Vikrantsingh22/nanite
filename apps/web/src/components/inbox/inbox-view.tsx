"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeftIcon, CheckIcon, CopyIcon, LockIcon, SettingsIcon } from "lucide-react"

import { AgentStatusBadge, useAgents } from "@/components/dashboard/dashboard-view"
import { MailShell, SessionGate } from "@/components/dashboard/mail-shell"
import { ArkivEntityChip, EnsName, InboxRow, OtpCountdown } from "@/components/nanite"
import { useCopy } from "@/components/nanite/use-copy"
import { useNow } from "@/components/nanite/use-now"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useKeys } from "@/lib/key-context"

import { SandboxedHtml } from "./html-frame"
import { KeepControl } from "./keep-control"
import { formatExpiry, formatTime, looksLikeHtml, otpExpiry, shortSender, type MailEntity, type MailType } from "./mail"
import { useMailbox, type MailRow, type MailboxError } from "./use-mailbox"

const ERRORS: Record<MailboxError, string> = {
  not_found: "This agent was not found in your account.",
  upstream: "Arkiv did not answer. Mail is safe on chain; retrying automatically.",
  network: "Cannot reach the Nanite API. Retrying automatically.",
  failed: "Could not load mail. Retrying automatically.",
}

type Tab = "all" | "otp"

export function InboxView({ agentId }: { agentId: string }) {
  return (
    <MailShell>
      <SessionGate needsKeys>
        <InboxBody agentId={agentId} />
      </SessionGate>
    </MailShell>
  )
}

function InboxBody({ agentId }: { agentId: string }) {
  const { keys } = useKeys()
  const { agents } = useAgents()
  const agent = agents?.find((a) => a.id === agentId)
  const [tab, setTab] = React.useState<Tab>("all")

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link href="/dashboard" className="inline-flex w-fit items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-3" aria-hidden="true" />
          all agents
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="animate-reveal font-heading text-3xl font-semibold tracking-tighter sm:text-4xl">Inbox</h1>
            <div className="flex flex-wrap items-center gap-2">
              {agent ? (
                <>
                  <EnsName name={agent.ensName} showStatus={false} />
                  <span className="font-mono text-xs text-muted-foreground">{agent.email}</span>
                  <AgentStatusBadge status={agent.status} />
                </>
              ) : (
                <Skeleton className="h-6 w-56" />
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/agents/${agentId}/settings`}>
              <SettingsIcon data-icon="inline-start" />
              Settings
            </Link>
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
        <TabsList aria-label="Message filter">
          <TabsTrigger value="all">All mail</TabsTrigger>
          <TabsTrigger value="otp">One-time codes</TabsTrigger>
        </TabsList>
        <TabsContent value="all">{keys && <MailPanel agentId={agentId} keys={keys} />}</TabsContent>
        <TabsContent value="otp">{keys && <OtpPanel agentId={agentId} keys={keys} />}</TabsContent>
      </Tabs>
    </>
  )
}

type Keys = NonNullable<ReturnType<typeof useKeys>["keys"]>

function Loading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading mail">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  )
}

function MailPanel({ agentId, keys }: { agentId: string; keys: Keys }) {
  const { rows, error, hasMore, loadingMore, loadMore, patchEntity } = useMailbox(agentId, keys, undefined)
  const [selected, setSelected] = React.useState<string | null>(null)
  const now = useNow(30_000)
  const current = rows?.find((r) => r.entity.key === selected) ?? null

  if (error && !rows) return <ErrorAlert kind={error} />
  if (!rows) return <Loading />
  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LockIcon />
          </EmptyMedia>
          <EmptyTitle>No mail yet</EmptyTitle>
          <EmptyDescription>Messages sent to this agent appear here, decrypted in your browser.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorAlert kind={error} />}
      <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <nav aria-label="Messages" className={`${current ? "hidden md:block" : "block"} h-fit overflow-hidden rounded-lg border bg-card`}>
          {rows.map((r) => (
            <InboxRow
              key={r.entity.key}
              senderHash={r.dec?.ok && r.dec.mail.from ? r.dec.mail.from : shortSender(r.entity.senderHash)}
              {...(r.dec ? { subject: r.dec.ok ? r.dec.mail.subject || "(no subject)" : `Cannot decrypt: ${r.dec.reason}` } : {})}
              type={r.entity.type}
              time={now === null ? "" : formatTime(r.entity.receivedAt, now)}
              expiry={now === null ? null : formatExpiry(r.entity, now)}
              selected={r.entity.key === selected}
              onSelect={() => setSelected(r.entity.key)}
            />
          ))}
          {hasMore && (
            <div className="border-t p-2">
              <Button variant="ghost" size="sm" className="w-full" disabled={loadingMore} onClick={() => void loadMore()}>
                Load older
              </Button>
            </div>
          )}
        </nav>
        <section aria-label="Message" className={`${current ? "block" : "hidden md:block"} min-w-0`}>
          {current ? (
            <MessageDetail
              row={current}
              agentId={agentId}
              now={now}
              onBack={() => setSelected(null)}
              onKept={(patch) => patchEntity(current.entity.key, patch)}
            />
          ) : (
            <div className="hidden rounded-lg border border-dashed p-8 text-center font-mono text-xs text-muted-foreground md:block">
              select a message
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ErrorAlert({ kind }: { kind: MailboxError }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{ERRORS[kind]}</AlertDescription>
    </Alert>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy()
  return (
    <Button variant="ghost" size="icon-xs" aria-label={copied ? "Copied" : label} onClick={() => copy(text)}>
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
    </Button>
  )
}

const TYPE_LABEL: Record<MailType, string> = { otp: "otp", conversation: "thread", sent: "sent" }

function MessageDetail({
  row,
  agentId,
  now,
  onBack,
  onKept,
}: {
  row: MailRow
  agentId: string
  now: number | null
  onBack: () => void
  onKept: (patch: Pick<MailEntity, "expiresAtBlock" | "expiresAt">) => void
}) {
  const { entity, dec } = row
  const expiry = now === null ? null : formatExpiry(entity, now)
  const extendable = entity.extendable ?? entity.type !== "otp"
  const [asText, setAsText] = React.useState(false)
  const when = new Date(entity.receivedAt * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
  const mail = dec?.ok ? dec.mail : null
  const html = mail ? looksLikeHtml(mail.body) : false
  const exp = entity.type === "otp" ? otpExpiry(entity) : null

  return (
    <article className="flex flex-col gap-4 rounded-lg border bg-card p-4" aria-label="Message detail">
      <Button variant="ghost" size="sm" className="w-fit md:hidden" onClick={onBack}>
        <ArrowLeftIcon data-icon="inline-start" />
        Back to inbox
      </Button>
      <header className="flex flex-col gap-2">
        <h2 className="font-heading text-xl font-semibold tracking-tight break-words">
          {mail ? mail.subject || "(no subject)" : "Encrypted message"}
        </h2>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>{mail?.from ?? shortSender(entity.senderHash)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(entity.receivedAt * 1000).toISOString()}>{when}</time>
          <Badge variant="outline">{TYPE_LABEL[entity.type]}</Badge>
        </div>
      </header>

      {dec && !dec.ok && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>This message could not be decrypted ({dec.reason}). The encrypted entity is still on Arkiv.</AlertDescription>
        </Alert>
      )}

      {mail?.otp && exp && <OtpCountdown code={mail.otp} expiresAt={exp.expiresAt} totalMs={exp.totalMs} />}

      {mail && (
        <div className="flex flex-col gap-2">
          {html && (
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">html message</span>
              <Button variant="outline" size="xs" onClick={() => setAsText((v) => !v)}>
                {asText ? "Show rendered" : "Show as text"}
              </Button>
            </div>
          )}
          {html && !asText ? (
            <SandboxedHtml html={mail.body} />
          ) : (
            <pre data-testid="mail-text" className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-sm break-words whitespace-pre-wrap">
              {mail.body}
            </pre>
          )}
        </div>
      )}

      {mail && mail.links.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="font-mono text-xs text-muted-foreground">links in this message (shown as text, not clickable)</h3>
          <ul className="flex flex-col gap-1">
            {mail.links.map((l) => (
              <li key={l} className="flex items-center gap-1 font-mono text-xs">
                <span className="min-w-0 break-all">{l}</span>
                <CopyButton text={l} label={`Copy link ${l}`} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3">
        {expiry && (
          <p
            data-testid="detail-expiry"
            className={`font-mono text-xs tnum ${expiry.urgent ? "font-medium text-destructive" : "text-muted-foreground"}`}
          >
            {expiry.text === "expired" ? "expired" : `expires in ${expiry.text}`}
          </p>
        )}
        {extendable && <KeepControl agentId={agentId} entity={entity} onKept={onKept} />}
      </div>

      <footer className="flex flex-col gap-2 border-t pt-3">
        <ArkivEntityChip entityKey={entity.key} ownedByYou creator={entity.creator} />
        <p className="text-xs text-muted-foreground">
          The explorer shows only ciphertext. The subject and body above were decrypted in this tab with your key. Mail disappears from Arkiv after its lifetime unless you or the agent keep it.
        </p>
      </footer>
    </article>
  )
}

function OtpPanel({ agentId, keys }: { agentId: string; keys: Keys }) {
  const { rows, error, reload } = useMailbox(agentId, keys, "otp", 4000)
  if (error && !rows) return <ErrorAlert kind={error} />
  if (!rows) return <Loading />
  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No active codes</EmptyTitle>
          <EmptyDescription>One-time codes expire within minutes and disappear from Arkiv. New ones show up here automatically.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorAlert kind={error} />}
      <ul className="flex flex-col gap-4" aria-label="One-time codes">
        {rows.map((r) => (
          <li key={r.entity.key} className="flex flex-col gap-2" data-testid="otp-item">
            {r.dec?.ok && r.dec.mail.otp ? (
              <OtpCountdown
                code={r.dec.mail.otp}
                {...otpExpiry(r.entity)}
                from={r.dec.mail.from ?? r.dec.mail.subject}
                onRequestNew={() => void reload()}
              />
            ) : (
              <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                {r.dec?.ok ? "No code found in this message." : r.dec ? `Cannot decrypt: ${r.dec.reason}` : "Decrypting..."}
              </div>
            )}
            <ArkivEntityChip entityKey={r.entity.key} ownedByYou creator={r.entity.creator} />
          </li>
        ))}
      </ul>
    </div>
  )
}

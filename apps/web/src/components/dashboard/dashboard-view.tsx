"use client"

import * as React from "react"
import Link from "next/link"
import { InboxIcon, PlusIcon, SettingsIcon } from "lucide-react"

import { MailDomainCard } from "@/components/dashboard/mail-domain-card"
import { MailShell, SessionGate } from "@/components/dashboard/mail-shell"
import { AgentMascot, EnsName } from "@/components/nanite"
import { UnlockLink } from "@/components/unlock-link"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { useKeys } from "@/lib/key-context"

/** Contract of GET /agents. */
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

export function useAgents() {
  const [agents, setAgents] = React.useState<AgentSummary[] | null>(null)
  const [error, setError] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    api<{ agents: AgentSummary[] }>("/agents")
      .then((r) => !cancelled && setAgents(r.agents))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [])
  return { agents, error }
}

const STATUS_VARIANT = { active: "success", provisioning: "warning", revoked: "destructive", failed: "destructive" } as const

export function AgentStatusBadge({ status }: { status: AgentSummary["status"] }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
}

function AgentTile({ agent }: { agent: AgentSummary }) {
  return (
    <Card data-testid="agent-tile" data-mascot-host>
      <CardHeader className="grid-cols-[auto_1fr_auto] items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-md bg-muted">
          <AgentMascot seed={agent.ensName} label={agent.ensName} status={agent.status} className="h-12 w-[45px]" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase leading-none tracking-wider text-primary">AI agent</span>
          <EnsName name={agent.ensName} showStatus={false} />
          <span className="truncate font-mono text-xs text-muted-foreground">{agent.email}</span>
        </div>
        <AgentStatusBadge status={agent.status} />
      </CardHeader>
      <CardContent />
      <CardFooter className="justify-end gap-2 border-t bg-muted/40 py-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/agents/${agent.id}/settings`}>
            <SettingsIcon data-icon="inline-start" />
            Settings
          </Link>
        </Button>
        {agent.status === "failed" ? (
          <Button size="sm" disabled>
            <InboxIcon data-icon="inline-start" />
            Open inbox
          </Button>
        ) : (
          <Button size="sm" asChild>
            <Link href={`/agents/${agent.id}`}>
              <InboxIcon data-icon="inline-start" />
              Open inbox
            </Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

function AgentsList() {
  const { agents, error } = useAgents()
  if (error) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>Could not load your agents. Reload the page.</AlertDescription>
      </Alert>
    )
  }
  if (!agents) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    )
  }
  if (agents.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>Create an agent to give it its own email address and ENS name.</EmptyDescription>
        </EmptyHeader>
        <Button asChild>
          <Link href="/agents/new">
            <PlusIcon data-icon="inline-start" />
            Create your first agent
          </Link>
        </Button>
      </Empty>
    )
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2" aria-label="Your agents">
      {agents.map((a) => (
        <li key={a.id} className="contents">
          <AgentTile agent={a} />
        </li>
      ))}
    </ul>
  )
}

/** Contract of GET /usage: Nanite-wide mail today (UTC), sent + received, against the daily quota. */
function MailUsage() {
  const [usage, setUsage] = React.useState<{ sent: number; received: number; quota: number } | null>(null)
  React.useEffect(() => {
    let cancelled = false
    api<{ sent: number; received: number; quota: number }>("/usage")
      .then((u) => !cancelled && setUsage(u))
      .catch(() => undefined) // a missing counter must never break the dashboard
    return () => {
      cancelled = true
    }
  }, [])
  if (!usage) return null
  return (
    <p className="font-mono text-xs text-muted-foreground" data-testid="mail-usage">
      mail today: {usage.sent + usage.received} / {usage.quota}
    </p>
  )
}

export function DashboardView() {
  const { status } = useKeys()
  return (
    <MailShell>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="animate-reveal font-heading text-3xl font-semibold tracking-tighter sm:text-4xl">Your agents</h1>
          <p className="text-sm text-muted-foreground">Each agent has its own address. Mail is encrypted; only your key opens it.</p>
        </div>
        <Button asChild>
          <Link href="/agents/new">
            <PlusIcon data-icon="inline-start" />
            New agent
          </Link>
        </Button>
      </div>
      <SessionGate>
        {status === "locked" && (
          <Alert>
            <AlertDescription>
              Your mailbox is locked.{" "}
              <UnlockLink className="text-primary underline underline-offset-4">
                Unlock it
              </UnlockLink>{" "}
              to read mail.
            </AlertDescription>
          </Alert>
        )}
        <AgentsList />
        <MailDomainCard />
        <MailUsage />
      </SessionGate>
    </MailShell>
  )
}

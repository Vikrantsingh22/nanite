import { MailIcon, ShieldOffIcon } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"

import { AgentMascot, type AgentMascotStatus } from "./agent-mascot"
import { EmailText } from "./email-text"
import { EnsName } from "./ens-name"
import { SendPolicyBadge, type SendPolicy } from "./send-policy-badge"

type AgentCardProps = {
  ensName: string
  email: string
  unread: number
  policy: SendPolicy
  revoked?: boolean
  /** Mascot state; defaults to active (or revoked when `revoked`). */
  status?: AgentMascotStatus
  onRevoke?: () => void
  className?: string
}

/** One agent: glyph, ENS identity, mailbox address, unread count, send policy, revoke. */
export function AgentCard({
  ensName,
  email,
  unread,
  policy,
  revoked = false,
  status,
  onRevoke,
  className,
}: AgentCardProps) {
  return (
    <Card data-mascot-host className={cn(revoked && "bg-muted/40", className)}>
      <CardHeader className="grid-cols-[auto_1fr] items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-md bg-muted">
          <AgentMascot seed={ensName} label={ensName} status={status ?? (revoked ? "revoked" : "active")} className="h-12 w-[45px]" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase leading-none tracking-wider text-primary">AI agent</span>
            {revoked ? (
              <Badge variant="destructive">revoked</Badge>
            ) : (
              <Badge variant={unread > 0 ? "default" : "outline"} aria-label={`${unread} unread`} className="tnum">
                <MailIcon data-icon="inline-start" />
                {unread}
              </Badge>
            )}
          </div>
          <EnsName name={ensName} showStatus={false} />
          <span
            className={cn(
              "break-words font-mono text-xs text-muted-foreground",
              revoked && "line-through decoration-destructive",
            )}
          >
            <EmailText value={email} />
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <SendPolicyBadge policy={revoked ? "off" : policy} />
      </CardContent>
      <CardFooter className="justify-end border-t bg-muted/40 py-2">
        <Button variant="destructive" size="sm" disabled={revoked} onClick={onRevoke}>
          <ShieldOffIcon data-icon="inline-start" />
          Revoke access
        </Button>
      </CardFooter>
    </Card>
  )
}

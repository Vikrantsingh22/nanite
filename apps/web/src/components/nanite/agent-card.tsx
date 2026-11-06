import { MailIcon, ShieldOffIcon } from "lucide-react"
import { cn } from "cn"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"

import { AgentGlyph } from "./agent-glyph"
import { EnsName } from "./ens-name"
import { SendPolicyBadge, type SendPolicy } from "./send-policy-badge"

type AgentCardProps = {
  ensName: string
  email: string
  unread: number
  policy: SendPolicy
  revoked?: boolean
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
  onRevoke,
  className,
}: AgentCardProps) {
  return (
    <Card className={cn(revoked && "bg-muted/40", className)}>
      <CardHeader className="grid-cols-[auto_1fr_auto] items-center gap-3">
        <Avatar size="lg" className="rounded-md after:rounded-md">
          <AvatarFallback className="rounded-md bg-muted p-1.5">
            <AgentGlyph seed={ensName} className={cn(revoked && "fill-muted-foreground")} />
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <EnsName name={ensName} showStatus={false} />
          <span
            className={cn(
              "truncate font-mono text-xs text-muted-foreground",
              revoked && "line-through decoration-destructive",
            )}
          >
            {email}
          </span>
        </div>
        {revoked ? (
          <Badge variant="destructive">revoked</Badge>
        ) : (
          <Badge
            variant={unread > 0 ? "default" : "outline"}
            aria-label={`${unread} unread`}
            className="tnum"
          >
            <MailIcon data-icon="inline-start" />
            {unread}
          </Badge>
        )}
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

"use client"

import * as React from "react"

import { DNS_DELAY_NOTE, DomainStep } from "@/components/onboarding/domain-step"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useSession } from "@/lib/session-context"

/**
 * "Mail domain" card on the dashboard. A user who skipped the optional domain in onboarding can add one here (same
 * component as wizard step 04), and see the status of a pending one. New agents use the domain only once it is
 * verified; existing agents keep their address.
 */
export function MailDomainCard() {
  const { session, refresh } = useSession()
  const [open, setOpen] = React.useState(false)
  if (session.status !== "authed") return null
  const me = session.me
  const domain = me.domain
  const verified = domain?.status === "verified"

  return (
    <Card data-testid="mail-domain-card">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex flex-wrap items-center gap-2 font-heading text-base">
          Mail domain
          {domain && <Badge variant={verified ? "success" : "warning"}>{verified ? "verified" : domain.status.replace(/_/g, " ")}</Badge>}
        </CardTitle>
        <CardDescription>
          {!domain && "You are using Nanite's shared domain. Add your own domain for addresses on your brand, like alex@mail.yourcompany.com."}
          {domain && verified && (
            <>
              <span className="font-mono">{domain.name}</span> is verified. New agents get <span className="font-mono">agent@{domain.name}</span>; existing agents keep their addresses.
            </>
          )}
          {domain && !verified && (
            <>
              <span className="font-mono">{domain.name}</span> is not verified yet. Until it is, new agents use the shared address. {DNS_DELAY_NOTE}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {open ? (
          <DomainStep
            variant="settings"
            me={me}
            onChanged={() => void refresh()}
            onContinue={() => setOpen(false)}
          />
        ) : (
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
            {!domain ? "Add your own domain" : verified ? "View DNS records" : "View status and DNS records"}
          </Button>
        )}
        {open && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setOpen(false)}>
            Hide
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

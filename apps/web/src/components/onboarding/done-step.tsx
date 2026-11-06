"use client"

import * as React from "react"
import Link from "next/link"
import { CheckCircle2Icon } from "lucide-react"

import { EnsName } from "@/components/nanite"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { api, type Me } from "@/lib/api"

export function DoneStep({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const complete = me.onboardingState !== "done"
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 font-heading text-xl">
          <CheckCircle2Icon className="size-5 text-success" aria-hidden="true" />
          You are set
        </CardTitle>
        <CardDescription>Your name is registered on ENS and owned by your wallet.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {me.ensName && <EnsName name={me.ensName} />}
        {me.domain && me.domain.status !== "verified" && (
          <p className="text-sm text-muted-foreground" data-testid="done-domain-pending">
            Your domain <span className="font-mono">{me.domain.name}</span> is still being verified, and that keeps running in the background. Until it is verified, new agents use the shared address. Follow it on your dashboard.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Next time, open the unlock page and sign once to read your mail. Keep your recovery code safe.
        </p>
        <div className="flex flex-wrap gap-3">
          {complete && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await api("/onboarding/complete", { method: "POST" })
                  onChanged()
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy && <Spinner data-icon="inline-start" />}
              Finish setup
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link href="/unlock?next=%2Fdashboard">Unlock mailbox</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

"use client"

import * as React from "react"

import { DomainStep } from "@/components/onboarding/domain-step"
import { DoneStep } from "@/components/onboarding/done-step"
import { KeysStep } from "@/components/onboarding/keys-step"
import { AccountShell, StepList } from "@/components/onboarding/shell"
import { UsernameStep } from "@/components/onboarding/username-step"
import { WalletStep } from "@/components/onboarding/wallet-step"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type OnboardingStatus } from "@/lib/api"
import { useSession } from "@/lib/session-context"

const STEPS = ["connect", "keys", "username", "domain", "done"]

/** Resumable from the server state in /me: each step is derived from onboardingState. */
export function OnboardingWizard() {
  const { session, refresh } = useSession()
  const [status, setStatus] = React.useState<OnboardingStatus | null>(null)

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const state = session.status === "authed" ? session.me.onboardingState : null
  React.useEffect(() => {
    if (state !== "keys_created" && state !== "name_claimed") return
    let cancelled = false
    api<OnboardingStatus>("/onboarding/status")
      .then((s) => !cancelled && setStatus(s))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [state])

  // When the background claim finishes, pull the new onboarding state.
  const claimDone = status?.claim.status === "done"
  React.useEffect(() => {
    if (claimDone && state === "keys_created") void refresh()
  }, [claimDone, state, refresh])

  // Step 04 (domain) shows for name_claimed users until they continue; users who already finished (including those
  // from before custom domains existed) go straight to the last step.
  const [domainDone, setDomainDone] = React.useState(false)
  const atDomain = state === "name_claimed" && !domainDone
  const current = state === null ? 0 : state === "started" ? 1 : state === "keys_created" ? 2 : atDomain ? 3 : 4

  return (
    <AccountShell>
      <div className="flex animate-reveal flex-col gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tighter sm:text-4xl">Set up your Nanite account</h1>
        <StepList steps={STEPS} current={current} />
      </div>
      {session.status === "loading" && <Skeleton className="h-48 w-full" />}
      {session.status === "anon" && <WalletStep onSignedIn={() => void refresh()} />}
      {session.status === "authed" && state === "started" && <KeysStep onDone={() => void refresh()} />}
      {session.status === "authed" && state === "keys_created" &&
        (status ? <UsernameStep status={status} onStatus={setStatus} /> : <Skeleton className="h-48 w-full" />)}
      {session.status === "authed" && atDomain && (
        status ? (
          <DomainStep
            me={session.me}
            sharedMailDomain={status.sharedMailDomain}
            onChanged={() => void refresh()}
            onContinue={() => setDomainDone(true)}
          />
        ) : (
          <Skeleton className="h-48 w-full" />
        )
      )}
      {session.status === "authed" && (state === "done" || (state === "name_claimed" && domainDone)) && (
        <DoneStep me={session.me} onChanged={() => void refresh()} />
      )}
    </AccountShell>
  )
}

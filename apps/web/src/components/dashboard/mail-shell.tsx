"use client"

import * as React from "react"
import Link from "next/link"
import { LockIcon, LockOpenIcon, LogOutIcon } from "lucide-react"
import { cn } from "cn"

import { shortAddress } from "@/components/onboarding/shell"
import { ThemeToggle } from "@/components/theme-toggle"
import { UnlockLink } from "@/components/unlock-link"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useKeys } from "@/lib/key-context"
import { useSession } from "@/lib/session-context"

/** Wide page frame for the signed-in app (dashboard, inbox). Same header as the onboarding shell. */
export function MailShell({ children, className }: { children: React.ReactNode; className?: string }) {
  const { session, signOut } = useSession()
  const { status, lock } = useKeys()
  return (
    <div className="bg-grid relative flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/dashboard" className="font-mono text-sm text-primary">
          nanite
        </Link>
        <div className="flex items-center gap-2">
          {session.status === "authed" && (
            <>
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{shortAddress(session.me.wallet)}</span>
              {status === "unlocked" ? (
                <Button variant="outline" size="sm" onClick={lock}>
                  <LockOpenIcon data-icon="inline-start" />
                  Lock
                </Button>
              ) : (
                <Button variant="outline" size="sm" asChild>
                  <UnlockLink>
                    <LockIcon data-icon="inline-start" />
                    Unlock
                  </UnlockLink>
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                <LogOutIcon data-icon="inline-start" />
                Sign out
              </Button>
            </>
          )}
          <ThemeToggle />
        </div>
      </header>
      <main className={cn("mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 pb-16 sm:px-6", className)}>{children}</main>
    </div>
  )
}

/**
 * Resolves the session once on mount and renders the right gate. Children render only for a finished account.
 * `needsKeys` additionally requires the in-memory key (the inbox does, the dashboard does not).
 */
export function SessionGate({ needsKeys = false, children }: { needsKeys?: boolean; children: React.ReactNode }) {
  const { session, refresh } = useSession()
  const { status } = useKeys()
  React.useEffect(() => {
    void refresh()
  }, [refresh])

  if (session.status === "loading") return <Skeleton className="h-40 w-full" />
  if (session.status === "anon") {
    return (
      <Alert>
        <AlertDescription>
          You are signed out.{" "}
          <UnlockLink className="text-primary underline underline-offset-4">
            Sign in
          </UnlockLink>
        </AlertDescription>
      </Alert>
    )
  }
  if (!session.me.hasKeys || session.me.onboardingState !== "done") {
    return (
      <Alert>
        <AlertDescription>
          Finish your account setup first.{" "}
          <Link href="/onboarding" className="text-primary underline underline-offset-4">
            Continue setup
          </Link>
        </AlertDescription>
      </Alert>
    )
  }
  if (needsKeys && status !== "unlocked") {
    return (
      <Alert>
        <AlertDescription>
          Your mailbox is locked. Mail is decrypted in this tab with your key, so it needs to be unlocked first.{" "}
          <UnlockLink className="text-primary underline underline-offset-4">
            Unlock your mailbox
          </UnlockLink>
        </AlertDescription>
      </Alert>
    )
  }
  return <>{children}</>
}

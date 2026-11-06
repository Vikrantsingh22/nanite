"use client"

import * as React from "react"
import Link from "next/link"
import { LockIcon, LockOpenIcon, LogOutIcon } from "lucide-react"
import { cn } from "cn"

import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { useKeys } from "@/lib/key-context"
import { useSession } from "@/lib/session-context"

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Page frame for account pages: session-aware header (wallet, lock state, sign out). */
export function AccountShell({ children, className }: { children: React.ReactNode; className?: string }) {
  const { session, signOut } = useSession()
  const { status, lock } = useKeys()
  return (
    <div className="bg-grid relative flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="font-mono text-sm text-primary">
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
                <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <LockIcon className="size-3.5" aria-hidden="true" />
                  locked
                </span>
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
      <main className={cn("mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pb-16 sm:px-6", className)}>{children}</main>
    </div>
  )
}

export function StepList({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs" aria-label="Onboarding steps">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className={cn(i === current ? "text-primary" : i < current ? "text-foreground" : "text-muted-foreground")}
        >
          {String(i + 1).padStart(2, "0")} {s}
          {i < current && <span className="sr-only"> (done)</span>}
        </li>
      ))}
    </ol>
  )
}

export function errorText(code: string): string {
  const map: Record<string, string> = {
    network_error: "Cannot reach the Nanite API. Check your connection and try again.",
    unauthenticated: "Your session ended. Sign in again.",
    invalid_siwe: "The sign-in message was rejected. Reload the page and try again.",
    keys_exist: "Keys already exist for this account.",
    keys_required: "Create your keys first.",
    operator_not_configured: "Username registration is not enabled on this server yet.",
    username_taken: "That username is taken.",
    username_locked: "Your username is already registered and cannot be changed.",
    claim_in_progress: "A registration is already running.",
    chain_unavailable: "The Sepolia node did not answer. Try again in a moment.",
    invalid_domain: "That does not look like a valid domain name.",
    domain_reserved: "That domain belongs to Nanite. Use your own domain.",
    domain_taken: "That domain is already used by another account.",
    domain_limit_reached: "Nanite has no free domain slot left. Please contact support.",
    resend_not_configured: "Custom domains are not enabled on this server yet.",
    resend_unavailable: "The email provider did not answer. Try again in a moment.",
    domain_not_verified: "Your domain is not verified yet.",
  }
  return map[code] ?? "Something went wrong. Try again."
}

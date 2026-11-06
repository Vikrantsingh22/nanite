"use client"

import * as React from "react"
import { PlugIcon, SignatureIcon } from "lucide-react"
import { useAccount, useConnect } from "wagmi"

import { shortAddress } from "@/components/onboarding/shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { useSession } from "@/lib/session-context"

const hasInjected = () => typeof window !== "undefined" && "ethereum" in window

/** Connect an injected wallet, then sign the SIWE message (login only; it cannot unlock mail). */
export function WalletStep({ onSignedIn }: { onSignedIn?: () => void }) {
  const { address, isConnected } = useAccount()
  const { connectors, connectAsync, isPending: connecting } = useConnect()
  const { signIn } = useSession()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const injected = React.useSyncExternalStore(
    () => () => {},
    hasInjected,
    () => true,
  )

  async function connect() {
    setError(null)
    try {
      await connectAsync({ connector: connectors[0]! })
    } catch {
      setError("The wallet did not connect. Unlock it and approve the request.")
    }
  }
  async function sign() {
    setError(null)
    setBusy(true)
    try {
      await signIn()
      onSignedIn?.()
    } catch {
      setError("Signing was cancelled or failed. Your wallet must approve the sign-in request.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Connect your wallet</CardTitle>
        <CardDescription>
          Your wallet is your account. Signing in proves you own it; it costs no gas and cannot unlock your mail.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!injected && (
          <Alert>
            <AlertTitle>No browser wallet found</AlertTitle>
            <AlertDescription>Install MetaMask (or another injected wallet), then reload this page.</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {isConnected && address ? (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-sm">
              <span className="text-muted-foreground">wallet </span>
              {shortAddress(address)}
            </p>
            <Button onClick={() => void sign()} disabled={busy} className="self-start">
              {busy ? <Spinner data-icon="inline-start" /> : <SignatureIcon data-icon="inline-start" />}
              {busy ? "Waiting for your wallet" : "Sign in with Ethereum"}
            </Button>
          </div>
        ) : (
          <Button onClick={() => void connect()} disabled={connecting || !injected || connectors.length === 0} className="self-start">
            {connecting ? <Spinner data-icon="inline-start" /> : <PlugIcon data-icon="inline-start" />}
            Connect MetaMask
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

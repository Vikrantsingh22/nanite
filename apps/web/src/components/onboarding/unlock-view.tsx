"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { KEY_DERIVATION_MESSAGE } from "@nanite/crypto"
import { useAccount, useConnect, useSignMessage } from "wagmi"

import { UnlockKeyPanel, type UnlockState } from "@/components/nanite"
import { AccountShell, shortAddress } from "@/components/onboarding/shell"
import { WalletStep } from "@/components/onboarding/wallet-step"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type KeyBundle } from "@/lib/api"
import { useKeys } from "@/lib/key-context"
import { unlockWithBundle, type UnlockSecret } from "@/lib/onboarding-crypto"
import { safeNextPath } from "@/lib/safe-next"
import { useSession } from "@/lib/session-context"

type Stored = KeyBundle & { keyVersion?: number }

/** Sign again (or passphrase / recovery code) and unwrap the key into memory only. */
export function UnlockView({ next }: { next?: string | null }) {
  const { session, refresh } = useSession()
  const { status, setKeys } = useKeys()
  const router = useRouter()
  const target = safeNextPath(next)

  // Client-side navigation keeps the in-memory key. `replace` so Back does not return to the unlock page.
  React.useEffect(() => {
    if (status === "unlocked" && target) router.replace(target)
  }, [status, target, router])
  const [stored, setStored] = React.useState<Stored | null>(null)
  const [loadError, setLoadError] = React.useState(false)

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const hasKeys = session.status === "authed" && session.me.hasKeys
  React.useEffect(() => {
    if (!hasKeys) return
    let cancelled = false
    api<Stored>("/onboarding/keys")
      .then((k) => !cancelled && setStored(k))
      .catch(() => !cancelled && setLoadError(true))
    return () => {
      cancelled = true
    }
  }, [hasKeys])

  return (
    <AccountShell>
      <h1 className="animate-reveal font-heading text-3xl font-semibold tracking-tighter sm:text-4xl">Unlock your mailbox</h1>
      {session.status === "loading" && <Skeleton className="h-40 w-full" />}
      {session.status === "anon" && <WalletStep onSignedIn={() => void refresh()} />}
      {session.status === "authed" && !session.me.hasKeys && (
        <Alert>
          <AlertDescription>
            You have not created your keys yet. <Link href="/onboarding" className="text-primary underline underline-offset-4">Continue setup</Link>
          </AlertDescription>
        </Alert>
      )}
      {loadError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Could not load your key data. Reload the page.</AlertDescription>
        </Alert>
      )}
      {session.status === "authed" && stored && status === "locked" && (
        <UnlockForms stored={stored} wallet={session.me.wallet} onUnlocked={setKeys} />
      )}
      {status === "unlocked" && (
        <UnlockKeyPanel state="unlocked" />
      )}
    </AccountShell>
  )
}

function UnlockForms({
  stored,
  wallet,
  onUnlocked,
}: {
  stored: Stored
  wallet: string
  onUnlocked: (k: Awaited<ReturnType<typeof unlockWithBundle>>) => void
}) {
  const { address, isConnected } = useAccount()
  const { connectors, connectAsync } = useConnect()
  const { signMessageAsync } = useSignMessage()
  const [state, setState] = React.useState<UnlockState>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [secret, setSecret] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  async function run(get: () => Promise<UnlockSecret>) {
    setError(null)
    try {
      const s = await get()
      onUnlocked(await unlockWithBundle(stored, s))
      setState("unlocked")
    } catch (e) {
      setState("error")
      const code = (e as { code?: string }).code
      setError(
        code === "WRONG_KEY" || code === "BAD_INPUT"
          ? "That did not unlock your key. Check the wallet, passphrase or recovery code and try again."
          : "The request was not completed. Try again.",
      )
    }
  }

  async function walletUnlock() {
    setState("signing")
    await run(async () => {
      if (!isConnected) await connectAsync({ connector: connectors[0]! })
      if (address && address.toLowerCase() !== wallet) throw new Error("wrong wallet")
      return { kind: "signature", signature: await signMessageAsync({ message: KEY_DERIVATION_MESSAGE }) }
    })
  }

  const primaryLabel = stored.passphraseMode ? "Passphrase" : "Wallet"
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Choose how to unlock</CardTitle>
        <CardDescription>
          Everything happens in this tab. The key is kept in memory and disappears when you lock or close the tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {address && address.toLowerCase() !== wallet && (
          <Alert>
            <AlertDescription>Switch your wallet to {shortAddress(wallet)} to unlock with a signature.</AlertDescription>
          </Alert>
        )}
        <Tabs defaultValue="primary">
          <TabsList>
            <TabsTrigger value="primary">{primaryLabel}</TabsTrigger>
            <TabsTrigger value="recovery">Recovery code</TabsTrigger>
          </TabsList>
          <TabsContent value="primary" className="pt-4">
            {stored.passphraseMode ? (
              <SecretForm
                id="unlock-passphrase"
                label="Passphrase"
                type="password"
                value={secret}
                onChange={setSecret}
                busy={busy}
                action="Unlock"
                onSubmit={async () => {
                  setBusy(true)
                  await run(async () => ({ kind: "passphrase", passphrase: secret }))
                  setBusy(false)
                }}
              />
            ) : (
              <UnlockKeyPanel state={state === "unlocked" ? "idle" : state} onUnlock={() => void walletUnlock()} />
            )}
          </TabsContent>
          <TabsContent value="recovery" className="pt-4">
            <SecretForm
              id="unlock-recovery"
              label="Recovery code"
              hint="The 25-character code you saved during setup, e.g. ABCDE-FGHJK-…"
              type="text"
              value={secret}
              onChange={setSecret}
              busy={busy}
              action="Unlock with recovery code"
              onSubmit={async () => {
                setBusy(true)
                await run(async () => ({ kind: "recovery", code: secret }))
                setBusy(false)
              }}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function SecretForm(p: {
  id: string
  label: string
  hint?: string
  type: "text" | "password"
  value: string
  onChange: (v: string) => void
  busy: boolean
  action: string
  onSubmit: () => Promise<void>
}) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (p.value) void p.onSubmit()
      }}
    >
      <Field>
        <FieldLabel htmlFor={p.id}>{p.label}</FieldLabel>
        <Input
          id={p.id}
          type={p.type}
          autoComplete={p.type === "password" ? "current-password" : "off"}
          spellCheck={false}
          value={p.value}
          onChange={(e) => p.onChange(e.target.value)}
          className={p.type === "text" ? "font-mono uppercase" : undefined}
        />
        {p.hint && <FieldDescription>{p.hint}</FieldDescription>}
      </Field>
      <Button type="submit" disabled={!p.value || p.busy} className="self-start">
        {p.busy && <Spinner data-icon="inline-start" />}
        {p.action}
      </Button>
    </form>
  )
}

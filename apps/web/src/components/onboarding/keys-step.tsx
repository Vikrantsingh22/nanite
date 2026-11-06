"use client"

import * as React from "react"
import { KeyRoundIcon } from "lucide-react"
import { useSignMessage } from "wagmi"
import { cn } from "cn"

import { errorText } from "@/components/onboarding/shell"
import { RecoveryCode } from "@/components/nanite"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError } from "@/lib/api"
import { useKeys } from "@/lib/key-context"
import {
  passphraseStrength,
  prepareKeys,
  probeDeterministicSignature,
  type PreparedKeys,
} from "@/lib/onboarding-crypto"

type Stage = "intro" | "working" | "passphrase" | "recovery"

/**
 * Browser-side key setup. The private key, seed, signatures, passphrase and recovery code never
 * leave this component's memory; POST /onboarding/keys receives public data and wrapped blobs only.
 */
export function KeysStep({ onDone }: { onDone: () => void }) {
  const { signMessageAsync } = useSignMessage()
  const { setKeys } = useKeys()
  const [stage, setStage] = React.useState<Stage>("intro")
  const [error, setError] = React.useState<string | null>(null)
  const [prepared, setPrepared] = React.useState<PreparedKeys | null>(null)

  const sign = React.useCallback((message: string) => signMessageAsync({ message }), [signMessageAsync])

  async function start() {
    setError(null)
    setStage("working")
    try {
      const probe = await probeDeterministicSignature(sign)
      if (probe.deterministic) {
        setPrepared(await prepareKeys({ kind: "signature", signature: probe.signature }))
        setStage("recovery")
      } else {
        setStage("passphrase")
      }
    } catch {
      setError("Signing was cancelled or failed. Both signature requests must be approved.")
      setStage("intro")
    }
  }

  async function withPassphrase(passphrase: string) {
    setError(null)
    setStage("working")
    try {
      setPrepared(await prepareKeys({ kind: "passphrase", passphrase }))
      setStage("recovery")
    } catch {
      setError("Could not create keys in this browser. Try again.")
      setStage("passphrase")
    }
  }

  async function upload() {
    if (!prepared) return
    setError(null)
    try {
      await api("/onboarding/keys", { method: "POST", body: prepared.bundle })
      setKeys(prepared.unlocked)
      setPrepared(null)
      onDone()
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code) : errorText(""))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Create your mailbox key</CardTitle>
        <CardDescription>
          Generated in this browser. Nanite stores only the public key and encrypted copies it cannot open.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {stage === "intro" && (
          <>
            <p className="text-sm text-muted-foreground">
              You will sign one message twice (no gas). If your wallet signs identically both times, that signature protects your key.
              Otherwise you will choose a passphrase instead. Then you get a one-time recovery code.
            </p>
            <Button onClick={() => void start()} className="self-start">
              <KeyRoundIcon data-icon="inline-start" />
              Create keys
            </Button>
          </>
        )}
        {stage === "working" && (
          <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Working. Approve the requests in your wallet if asked.
          </p>
        )}
        {stage === "passphrase" && <PassphraseForm onSubmit={(p) => void withPassphrase(p)} />}
        {stage === "recovery" && prepared && <RecoveryStage code={prepared.recoveryCode} onConfirmed={upload} />}
      </CardContent>
    </Card>
  )
}

function PassphraseForm({ onSubmit }: { onSubmit: (passphrase: string) => void }) {
  const [pass, setPass] = React.useState("")
  const [again, setAgain] = React.useState("")
  const strength = passphraseStrength(pass)
  const mismatch = again.length > 0 && again !== pass
  const ok = strength.score >= 1 && pass === again
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) onSubmit(pass)
      }}
    >
      <Alert>
        <AlertTitle>Your wallet signs differently each time</AlertTitle>
        <AlertDescription>
          That is normal for some wallets (smart-contract or MPC). Choose a passphrase to protect your key. It is never sent anywhere
          and cannot be reset; the recovery code is your backup.
        </AlertDescription>
      </Alert>
      <Field>
        <FieldLabel htmlFor="passphrase">Passphrase</FieldLabel>
        <Input id="passphrase" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} aria-describedby="passphrase-hint" />
        <FieldDescription id="passphrase-hint" aria-live="polite" className={cn(strength.score === 0 && pass.length > 0 && "text-warning")}>
          {pass.length === 0 ? "At least 12 characters. A few random words works well." : strength.label}
        </FieldDescription>
      </Field>
      <Field data-invalid={mismatch || undefined}>
        <FieldLabel htmlFor="passphrase-again">Repeat passphrase</FieldLabel>
        <Input id="passphrase-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch} />
        {mismatch && <FieldError>The passphrases do not match.</FieldError>}
      </Field>
      <Button type="submit" disabled={!ok} className="self-start">
        Use this passphrase
      </Button>
    </form>
  )
}

function RecoveryStage({ code, onConfirmed }: { code: string; onConfirmed: () => Promise<void> }) {
  const groups = React.useMemo(() => code.split("-"), [code])
  const [stored, setStored] = React.useState(false)
  // Which group the user must re-type (chosen once per code).
  const [probe] = React.useState(() => Math.floor(Math.random() * 5))
  const [typed, setTyped] = React.useState("")
  const typedOk = typed.trim().toUpperCase() === groups[probe]
  const [busy, setBusy] = React.useState(false)
  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertTitle>Save your recovery code now</AlertTitle>
        <AlertDescription>
          If you lose access to your wallet this code is the only way back into your mail. It is shown once and Nanite cannot restore it.
        </AlertDescription>
      </Alert>
      <RecoveryCode groups={groups} onConfirmChange={setStored} />
      <Field data-invalid={typed.length >= 5 && !typedOk ? true : undefined}>
        <FieldLabel htmlFor="recovery-check">{`Type group ${probe + 1} of your code to confirm`}</FieldLabel>
        <Input
          id="recovery-check"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={5}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="max-w-40 font-mono tracking-[0.16em] uppercase"
          aria-invalid={typed.length >= 5 && !typedOk}
        />
        {typed.length >= 5 && !typedOk && <FieldError>That does not match group {probe + 1}.</FieldError>}
      </Field>
      <Button
        disabled={!stored || !typedOk || busy}
        className="self-start"
        onClick={() => {
          setBusy(true)
          void onConfirmed().finally(() => setBusy(false))
        }}
      >
        {busy && <Spinner data-icon="inline-start" />}
        Finish key setup
      </Button>
    </div>
  )
}

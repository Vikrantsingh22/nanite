"use client"

import * as React from "react"
import { ExternalLinkIcon, PenLineIcon, RefreshCwIcon } from "lucide-react"

import { StatusLine } from "@/components/nanite"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError } from "@/lib/api"
import { ETHERSCAN_TX } from "@/lib/config"

import { agentErrorText, jobLines, type AgentJobStatus, type SignerInfo } from "./types"

const RECORD_BADGE: Record<SignerInfo["record"], { variant: "success" | "warning" | "destructive" | "outline"; label: string; text: string }> = {
  published: { variant: "success", label: "published", text: "The signer address is on this agent's ENS name, so anyone can verify its mail." },
  pending: { variant: "warning", label: "pending", text: "The address is not on ENS yet. Mail is signed, but cannot be verified until the record is written." },
  mismatch: {
    variant: "destructive",
    label: "mismatch",
    text: "ENS holds a different address than the signing key. Mail will not verify. Rotate the key to publish a matching one.",
  },
  unavailable: { variant: "outline", label: "unavailable", text: "The Sepolia node did not answer, so the ENS record could not be read. Check again in a moment." },
  none: { variant: "outline", label: "not set up", text: "" },
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Mail signing. Nanite-held agents (option B): the server signs with a key kept only on the server and publishes its
 * address as the ENS text record `nanite.signer`. Self-hosted agents: the key is on the agent's machine; here you only
 * register (rotate) its ADDRESS. Either way the key is never shown; only the address is.
 */
export function MailSigning({ agentId }: { agentId: string }) {
  const [info, setInfo] = React.useState<SignerInfo | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [job, setJob] = React.useState<AgentJobStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [newAddress, setNewAddress] = React.useState("")

  React.useEffect(() => {
    let cancelled = false
    api<SignerInfo>(`/agents/${agentId}/signer`)
      .then((r) => !cancelled && (setInfo(r), setLoadError(null)))
      .catch((e) => !cancelled && setLoadError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText("")))
    return () => {
      cancelled = true
    }
  }, [agentId, tick])

  const running = job ? job.status === "queued" || job.status === "running" : false
  React.useEffect(() => {
    if (!running) return
    const t = setInterval(async () => {
      try {
        const next = await api<AgentJobStatus>(`/agents/${agentId}/status`)
        if (next.kind !== "signer") return
        setJob(next)
        if (next.status === "done" || next.status === "error") {
          setBusy(false)
          setTick((n) => n + 1)
        }
      } catch {
        /* keep polling */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [running, agentId])

  async function start() {
    setError(null)
    setBusy(true)
    try {
      setJob(
        await api<AgentJobStatus>(`/agents/${agentId}/signer`, {
          method: "POST",
          ...(info && info.managed === false ? { body: { address: newAddress.trim() } } : {}),
        }),
      )
      setConfirm(false)
      setNewAddress("")
    } catch (e) {
      setBusy(false)
      setConfirm(false)
      setError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText(""))
    }
  }

  if (loadError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    )
  }
  if (!info) return <Skeleton className="h-48 w-full" />

  const rec = RECORD_BADGE[info.record]
  const hasSigner = !!info.address
  const selfHosted = info.managed === false
  const addrOk = ADDRESS_RE.test(newAddress.trim())
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex flex-wrap items-center gap-2 font-heading text-xl">
          Mail signing
          {info.supported && hasSigner && <Badge variant={rec.variant}>{rec.label}</Badge>}
        </CardTitle>
        <CardDescription>
          Each message this agent sends carries a signature. Anyone can check it against the <code className="font-mono">nanite.signer</code> record on the
          agent&apos;s ENS name.
          {selfHosted && " This agent signs with a key on its own machine; Nanite only knows the address."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!info.supported ? (
          <p className="text-sm text-muted-foreground">This agent does not sign its mail.</p>
        ) : hasSigner ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Signer address</span>
              <code className="font-mono text-sm break-all" data-testid="signer-address">
                {info.address}
              </code>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="signer-record-text">
              {rec.text}
            </p>
            {info.record === "mismatch" && info.onchain && (
              <p className="text-xs text-muted-foreground">
                ENS currently says <code className="font-mono break-all">{info.onchain}</code>
              </p>
            )}
          </>
        ) : selfHosted ? (
          <p className="text-sm text-muted-foreground">
            No signer address is registered, so this agent&apos;s mail goes out unsigned. Run <code className="font-mono">nanite-mcp rotate-signer</code> on its
            machine and paste the address below.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            This agent has no signing key yet, so its mail goes out unsigned. Set one up to make its mail verifiable.
          </p>
        )}

        {selfHosted && info.supported && (
          <Field data-invalid={newAddress.trim() !== "" && !addrOk ? true : undefined}>
            <FieldLabel htmlFor="new-signer-address">{hasSigner ? "New signer address" : "Signer address"}</FieldLabel>
            <Input
              id="new-signer-address"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              disabled={busy || running}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="0x…"
              className="font-mono"
              aria-invalid={newAddress.trim() !== "" && !addrOk}
              aria-describedby="new-signer-address-hint"
            />
            <FieldDescription id="new-signer-address-hint">
              Run <code className="font-mono">nanite-mcp rotate-signer</code> on the agent&apos;s machine. It replaces only the signer key and prints the new address.
            </FieldDescription>
            {newAddress.trim() !== "" && !addrOk && <FieldError>That is not an Ethereum address (0x and 40 hex characters).</FieldError>}
          </Field>
        )}

        {job && (
          <div className="flex flex-col gap-3">
            <div className="sr-only" role="status" aria-live="polite">
              {job.status === "done" ? "Signing key published to ENS" : job.status === "error" ? "Publishing failed" : "Publishing the signing key to ENS"}
            </div>
            <StatusLine title="ens://nanite.signer" lines={jobLines(job)} live={running} />
            {job.steps.some((s) => s.txHash) && (
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {job.steps
                  .filter((s) => s.txHash)
                  .map((s) => (
                    <li key={s.id}>
                      <a
                        href={`${ETHERSCAN_TX}${s.txHash}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                      >
                        {s.txHash!.slice(0, 10)}…{s.txHash!.slice(-6)}
                        <ExternalLinkIcon className="size-3" aria-hidden="true" />
                        <span className="sr-only">(opens Sepolia Etherscan)</span>
                      </a>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}

        {info.supported && (
          <div className="flex flex-wrap items-center gap-3">
            {selfHosted ? (
              <Button variant="outline" disabled={busy || running || !addrOk} onClick={() => setConfirm(true)}>
                {busy || running ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                {hasSigner ? "Rotate signer address" : "Publish signer address"}
              </Button>
            ) : hasSigner ? (
              <Button variant="outline" disabled={busy || running} onClick={() => setConfirm(true)}>
                {busy || running ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                Rotate signing key
              </Button>
            ) : (
              <Button variant="outline" disabled={busy || running} onClick={() => void start()}>
                {busy || running ? <Spinner data-icon="inline-start" /> : <PenLineIcon data-icon="inline-start" />}
                Set up signing
              </Button>
            )}
            <Button variant="ghost" disabled={busy || running} onClick={() => setTick((n) => n + 1)}>
              Check ENS again
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={confirm} onOpenChange={(v) => !busy && setConfirm(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selfHosted ? "Rotate the signer address?" : "Rotate the signing key?"}</DialogTitle>
            <DialogDescription>
              {selfHosted
                ? "The new address is written to ENS (one transaction). The agent must already use the new key (nanite-mcp rotate-signer), and mail signed with the old key is rejected from now on. Mail already sent will no longer verify against the new record."
                : "A new key replaces the old one and its address is written to ENS (one transaction). Mail already sent was signed with the old key and will no longer verify against the new record. Do this if the old key may have leaked."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>Cancel</Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void start()}>
              {busy && <Spinner data-icon="inline-start" />}
              {selfHosted ? "Publish address" : "Rotate key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

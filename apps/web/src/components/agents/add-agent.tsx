"use client"

import * as React from "react"
import Link from "next/link"
import { deriveAgentWallet } from "@nanite/crypto"
import { BotIcon, MailIcon, PlusIcon, RotateCcwIcon, SettingsIcon, ShieldCheckIcon } from "lucide-react"

import { EnsName, StatusLine } from "@/components/nanite"
import { useCopy } from "@/components/nanite/use-copy"
import { AccountShell } from "@/components/onboarding/shell"
import { UnlockLink } from "@/components/unlock-link"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError } from "@/lib/api"
import { apiBaseUrl, ENS_PARENT } from "@/lib/config"
import { useKeys } from "@/lib/key-context"
import { useSession } from "@/lib/session-context"

import { CodeBlock } from "./code-block"
import { TokenReveal } from "./token-reveal"
import { agentErrorText, jobLines, type AgentJobStatus, type AgentSummary } from "./types"

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

type Custody = "nanite" | "self"

/** Base64 of exactly 32 bytes (the X25519 public key that `nanite-mcp keygen` prints). */
export function isEncryptionPublicKey(v: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(v)) return false
  try {
    return atob(v).length === 32 && btoa(atob(v)) === v
  } catch {
    return false
  }
}

/** MCP client config for a self-hosted agent (local mode): the key file never leaves the agent's machine. */
export function localMcpConfig(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        nanite: {
          command: "npx",
          args: ["-y", "nanite-mcp"],
          env: {
            NANITE_API_URL: apiBaseUrl,
            NANITE_AGENT_TOKEN: token,
            NANITE_AGENT_KEY_FILE: "/home/you/.nanite/agent-key.json",
          },
        },
      },
    },
    null,
    2,
  )
}

interface Created {
  agent: AgentSummary
  token: string
  status: AgentJobStatus
}

/** One-click add-agent flow: derive the wallet in the browser, POST, watch ENS progress, show the token once. */
export function AddAgent() {
  const { session, refresh } = useSession()
  const { status: keyStatus, keys } = useKeys()
  const [existing, setExisting] = React.useState<AgentSummary[] | null>(null)
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [created, setCreated] = React.useState<Created | null>(null)
  const [job, setJob] = React.useState<AgentJobStatus | null>(null)
  const [stored, setStored] = React.useState(false)
  const [custody, setCustody] = React.useState<Custody>("nanite")
  const [encKey, setEncKey] = React.useState("")
  const [signerAddr, setSignerAddr] = React.useState("")
  const [createdCustody, setCreatedCustody] = React.useState<Custody>("nanite")

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const authed = session.status === "authed"
  const ready = authed && (session.me.onboardingState === "name_claimed" || session.me.onboardingState === "done") && keyStatus === "unlocked"

  const [listTick, setListTick] = React.useState(0)
  const loadList = React.useCallback(() => setListTick((t) => t + 1), [])
  React.useEffect(() => {
    if (!ready) return
    let cancelled = false
    api<{ agents: AgentSummary[] }>("/agents")
      .then((r) => !cancelled && setExisting(r.agents))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText("")))
    return () => {
      cancelled = true
    }
  }, [ready, listTick])

  const nextIndex = existing ? existing.reduce((m, a) => Math.max(m, a.index + 1), 0) : null
  const label = name.trim().toLowerCase()
  const nameOk = NAME_RE.test(label)
  const encOk = isEncryptionPublicKey(encKey.trim())
  const signerOk = ADDRESS_RE.test(signerAddr.trim())
  const keysOk = custody === "nanite" || (encOk && signerOk)
  const createdId = created?.agent.id
  const jobRunning = job ? job.status === "queued" || job.status === "running" : !!created

  // Poll ENS progress until the job settles.
  React.useEffect(() => {
    if (!createdId || !jobRunning) return
    const t = setInterval(async () => {
      try {
        setJob(await api<AgentJobStatus>(`/agents/${createdId}/status`))
      } catch {
        /* keep polling */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [createdId, jobRunning])

  async function submit() {
    if (!keys || nextIndex === null || !nameOk || !keysOk) return
    setError(null)
    setBusy(true)
    try {
      // The seed never leaves the browser: only the derived public wallet address is sent.
      const wallet = await deriveAgentWallet(keys.seed, nextIndex)
      const res = await api<Created>("/agents", {
        method: "POST",
        body: {
          name: label,
          index: nextIndex,
          walletAddress: wallet.address,
          // Self-hosted: only PUBLIC values leave the agent's machine (the keys were made by `nanite-mcp keygen`).
          ...(custody === "self" ? { encryptionPublicKey: encKey.trim(), signerAddress: signerAddr.trim() } : {}),
        },
      })
      setCreatedCustody(custody)
      setCreated(res)
      setJob(res.status)
    } catch (e) {
      if (e instanceof ApiError && e.code === "index_mismatch") loadList()
      setError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText(""))
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    if (!created) return
    setError(null)
    try {
      setJob(await api<AgentJobStatus>(`/agents/${created.agent.id}/retry`, { method: "POST" }))
    } catch (e) {
      setError(e instanceof ApiError ? agentErrorText(e.code) : agentErrorText(""))
    }
  }

  function reset() {
    setCreated(null)
    setJob(null)
    setName("")
    setStored(false)
    setCustody("nanite")
    setEncKey("")
    setSignerAddr("")
    setError(null)
    loadList()
  }

  return (
    <AccountShell>
      <div className="flex animate-reveal flex-col gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tighter sm:text-4xl">Add an agent</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Each agent gets its own email address, an ENS name you own, and an API token. Its wallet is derived from your seed in this browser.
        </p>
      </div>

      {session.status === "loading" && <Skeleton className="h-48 w-full" />}
      {session.status === "anon" && (
        <Alert>
          <AlertDescription>
            Sign in to add an agent. <Link href="/onboarding" className="text-primary underline underline-offset-4">Sign in</Link>
          </AlertDescription>
        </Alert>
      )}
      {authed && session.me.onboardingState !== "name_claimed" && session.me.onboardingState !== "done" && (
        <Alert>
          <AlertDescription>
            Finish your account setup first. <Link href="/onboarding" className="text-primary underline underline-offset-4">Continue setup</Link>
          </AlertDescription>
        </Alert>
      )}
      {authed && (session.me.onboardingState === "name_claimed" || session.me.onboardingState === "done") && keyStatus !== "unlocked" && (
        <Alert>
          <AlertDescription>
            Your keys are locked. Agent wallets are derived from your seed, so unlock first.{" "}
            <UnlockLink className="text-primary underline underline-offset-4">Unlock your mailbox</UnlockLink>
          </AlertDescription>
        </Alert>
      )}

      {ready && !created && (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Name your agent</CardTitle>
            <CardDescription>
              {nextIndex === null ? "Loading your agents" : `This will be agent #${nextIndex} (wallet index ${nextIndex}).`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">Who holds the agent&apos;s key?</legend>
                <RadioGroup value={custody} onValueChange={(v) => setCustody(v as Custody)} aria-label="Key custody">
                  <Field orientation="horizontal">
                    <RadioGroupItem value="nanite" id="custody-nanite" />
                    <FieldContent>
                      <FieldLabel htmlFor="custody-nanite">Nanite holds the agent key (simplest)</FieldLabel>
                      <FieldDescription>
                        Nanite decrypts this agent&apos;s mail for it, so a plain API token is all the agent needs. Works with the hosted MCP endpoint.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="self" id="custody-self" />
                    <FieldContent>
                      <FieldLabel htmlFor="custody-self">Hold the key yourself (self-hosted)</FieldLabel>
                      <FieldDescription>
                        You generate the keys on the agent&apos;s machine. Nanite stores only public values and can never read this agent&apos;s inbox.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                </RadioGroup>
              </fieldset>

              {custody === "self" && (
                <div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4" data-testid="self-hosted-keys">
                  <p className="flex items-start gap-2 text-sm text-muted-foreground">
                    <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span>
                      Run this on the machine where the agent runs. It writes the private keys to a file there (mode 600) and prints only the two public values to paste below.
                    </span>
                  </p>
                  <CodeBlock title="terminal" text="npx nanite-mcp keygen" testId="keygen-command" />
                  <Field data-invalid={encKey.trim() !== "" && !encOk ? true : undefined}>
                    <FieldLabel htmlFor="enc-key">Encryption public key</FieldLabel>
                    <Input
                      id="enc-key"
                      value={encKey}
                      onChange={(e) => setEncKey(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="44 characters, ends with ="
                      className="font-mono"
                      aria-invalid={encKey.trim() !== "" && !encOk}
                      aria-describedby="enc-key-hint"
                    />
                    <FieldDescription id="enc-key-hint">Base64, as printed by keygen. Mail for this agent is sealed to it.</FieldDescription>
                    {encKey.trim() !== "" && !encOk && <FieldError>That is not a 32-byte base64 key. Paste the line from keygen.</FieldError>}
                  </Field>
                  <Field data-invalid={signerAddr.trim() !== "" && !signerOk ? true : undefined}>
                    <FieldLabel htmlFor="signer-address">Signer address</FieldLabel>
                    <Input
                      id="signer-address"
                      value={signerAddr}
                      onChange={(e) => setSignerAddr(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="0x…"
                      className="font-mono"
                      aria-invalid={signerAddr.trim() !== "" && !signerOk}
                      aria-describedby="signer-address-hint"
                    />
                    <FieldDescription id="signer-address-hint">
                      Published on the agent&apos;s ENS name as <code className="font-mono">nanite.signer</code>, so anyone can verify mail the agent signs.
                    </FieldDescription>
                    {signerAddr.trim() !== "" && !signerOk && <FieldError>That is not an Ethereum address (0x and 40 hex characters).</FieldError>}
                  </Field>
                </div>
              )}

              <Field>
                <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="agent-name"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-describedby="agent-name-hint"
                    className="font-mono"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="max-w-[40vw] truncate font-mono">.{session.status === "authed" ? (session.me.username ?? "") : ""}.{ENS_PARENT}</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription id="agent-name-hint" aria-live="polite">
                  {!label || nameOk ? "2 to 32 characters: a-z, 0-9 and inner hyphens." : "Use 2 to 32 characters: a-z, 0-9 and inner hyphens."}
                </FieldDescription>
              </Field>
              <Button type="submit" disabled={!nameOk || !keysOk || busy || nextIndex === null} className="self-start">
                {busy ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
                Add agent
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {created && job && (
        <>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 font-heading text-xl">
                <BotIcon className="size-5 text-primary" aria-hidden="true" />
                {job.status === "done" ? "Agent ready" : job.status === "error" ? "Registration failed" : "Registering on ENS"}
              </CardTitle>
              <CardDescription>
                {job.status === "done"
                  ? "Its mailbox is live and its name resolves on Sepolia."
                  : "Each step is a Sepolia transaction. This takes a minute or two."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="sr-only" role="status" aria-live="polite">
                {job.status === "done" ? "Agent ready" : job.status === "error" ? "Registration failed. You can retry." : "Registering the agent name"}
              </div>
              <StatusLine title={`ens://${created.agent.ensName}`} lines={jobLines(job)} live={job.status === "queued" || job.status === "running"} />
              {job.status === "error" && (
                <Button variant="outline" className="self-start" onClick={() => void retry()}>
                  <RotateCcwIcon data-icon="inline-start" />
                  Retry registration
                </Button>
              )}
              <dl className="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
                <dt className="font-mono text-xs text-muted-foreground">email</dt>
                <dd className="flex min-w-0 items-center gap-2">
                  <MailIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <EmailAddress value={created.agent.email} />
                </dd>
                <dt className="font-mono text-xs text-muted-foreground">ens name</dt>
                <dd className="min-w-0">
                  <EnsName name={created.agent.ensName} resolved={job.status === "done"} />
                </dd>
              </dl>
            </CardContent>
          </Card>

          <TokenReveal token={created.token} onConfirmChange={setStored} />

          {createdCustody === "self" && (
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2} className="font-heading text-xl">Connect your MCP client</CardTitle>
                <CardDescription>
                  Local mode: the MCP server runs on your machine, reads your key file and decrypts mail there. Add this to Claude Desktop or Claude Code, and use the absolute path of the key file that keygen printed.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <CodeBlock title="mcp config (local mode)" text={localMcpConfig(created.token)} testId="mcp-config" />
                <p className="text-sm text-muted-foreground" data-testid="self-hosted-trust">
                  Mail you receive stays encrypted to your key: Nanite cannot read it. Mail you send passes through Nanite and Resend in plain text, and Nanite writes the encrypted sent copy.
                </p>
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap gap-3">
            {stored ? (
              <>
                <Button asChild>
                  <Link href={`/agents/${created.agent.id}`}>Open inbox</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link href={`/agents/${created.agent.id}/settings`}>
                    <SettingsIcon data-icon="inline-start" />
                    Agent settings
                  </Link>
                </Button>
                <Button variant="ghost" onClick={reset}>
                  Add another agent
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Confirm that you stored the token to continue.</p>
            )}
          </div>
        </>
      )}
    </AccountShell>
  )
}

function EmailAddress({ value }: { value: string }) {
  const { copied, copy } = useCopy()
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-sm" data-testid="agent-email">{value}</span>
      <Button variant="ghost" size="xs" onClick={() => void copy(value)} aria-label={copied ? "Copied" : `Copy ${value}`}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  )
}

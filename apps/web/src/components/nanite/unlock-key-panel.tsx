import { AlertTriangleIcon, LockIcon, LockOpenIcon, SignatureIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export type UnlockState = "idle" | "signing" | "unlocked" | "error"

type UnlockKeyPanelProps = {
  state: UnlockState
  onUnlock?: () => void
  className?: string
}

const COPY: Record<UnlockState, { title: string; body: string }> = {
  idle: {
    title: "Mail is locked",
    body: "Sign a message with your wallet to derive your decryption key. Nothing is sent to a server and no gas is spent.",
  },
  signing: {
    title: "Waiting for your wallet",
    body: "Confirm the signature request in your wallet. The key exists only in this tab.",
  },
  unlocked: {
    title: "Mail is unlocked",
    body: "Decryption key is held in memory for this session. Close the tab to lock again.",
  },
  error: {
    title: "Signature was not completed",
    body: "The request was rejected or timed out. Your mail stays encrypted. Try signing again.",
  },
}

/** Sign-to-unlock prompt for deriving the mailbox decryption key. */
export function UnlockKeyPanel({ state, onUnlock, className }: UnlockKeyPanelProps) {
  const { title, body } = COPY[state]
  const Icon =
    state === "unlocked" ? LockOpenIcon : state === "error" ? AlertTriangleIcon : LockIcon
  return (
    <div
      data-state={state}
      className={cn(
        "flex flex-col gap-4 rounded-lg border bg-card p-4 data-[state=error]:border-destructive/50 data-[state=unlocked]:border-success/40",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted",
            state === "unlocked" && "border-success/40 text-success",
            state === "error" && "border-destructive/40 text-destructive",
            state === "signing" && "text-warning",
          )}
        >
          {state === "signing" ? <Spinner /> : <Icon className="size-4" aria-hidden="true" />}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium" role={state === "error" ? "alert" : "status"}>
            {title}
          </p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
      </div>
      {state !== "unlocked" && (
        <Button disabled={state === "signing"} onClick={onUnlock} className="self-start">
          {state === "signing" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <SignatureIcon data-icon="inline-start" />
          )}
          {state === "error" ? "Try again" : state === "signing" ? "Signing" : "Sign to unlock"}
        </Button>
      )}
    </div>
  )
}

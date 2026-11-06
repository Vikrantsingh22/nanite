import { ArrowUpRightIcon, KeyRoundIcon, LockIcon, MessagesSquareIcon } from "lucide-react"
import { cn } from "cn"

export type MailType = "otp" | "conversation" | "sent"

const TYPE = {
  otp: { icon: KeyRoundIcon, label: "otp" },
  conversation: { icon: MessagesSquareIcon, label: "thread" },
  sent: { icon: ArrowUpRightIcon, label: "sent" },
} as const

type InboxRowProps = {
  senderHash: string
  /** Decrypted subject; omit while the message is still encrypted. */
  subject?: string
  type: MailType
  time: string
  unread?: boolean
  selected?: boolean
  /** Remaining life ("1 d 23 h"); warning colour only when `urgent` (under 6 h). */
  expiry?: { text: string; urgent: boolean } | null
  /** Recipient of a sent copy, when known. */
  to?: string
  onSelect?: () => void
}

/** Single letter for the avatar: first letter or digit of the sender, ignoring "sender " and "0x" prefixes. */
export function senderInitial(sender: string): string {
  const cleaned = sender.replace(/^sender\s+/i, "").replace(/^0x/i, "")
  const m = /[\p{L}\p{N}]/u.exec(cleaned)
  return (m?.[0] ?? "?").toUpperCase()
}

export function SenderAvatar({ sender, className }: { sender: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-sm font-medium text-muted-foreground",
        className,
      )}
    >
      {senderInitial(sender)}
    </span>
  )
}

/** One mailbox line. Without `subject` the message is shown as encrypted (locked). */
export function InboxRow({
  senderHash,
  subject,
  type,
  time,
  unread = false,
  selected = false,
  expiry,
  to,
  onSelect,
}: InboxRowProps) {
  const { icon: Icon, label } = TYPE[type]
  const encrypted = subject === undefined
  const who = type === "sent" && to ? `To: ${to}` : senderHash
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cn(
        "group/row relative flex w-full items-start gap-3 border-b border-l-2 border-l-transparent px-3 py-3 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "border-l-primary bg-accent",
      )}
    >
      <SenderAvatar sender={type === "sent" && to ? to : senderHash} className={cn(selected && "border-primary/40 text-foreground")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>{who}</span>
          <time className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground tnum">{time}</time>
        </span>
        {encrypted ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <LockIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="sr-only">Encrypted message</span>
            <span aria-hidden="true" className="h-2 w-40 max-w-full rounded-xs bg-muted-foreground/25" />
            <span className="font-mono text-xs">encrypted</span>
          </span>
        ) : (
          <span className={cn("truncate text-sm", unread ? "text-foreground" : "text-foreground/90")}>{subject}</span>
        )}
        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted-foreground">
          <Icon className="size-3 shrink-0" aria-hidden="true" />
          <span>{label}</span>
          {expiry && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="row-expiry" className={cn("truncate tnum", expiry.urgent && "text-destructive")}>
                {expiry.text === "expired" ? "expired" : `expires in ${expiry.text}`}
              </span>
            </>
          )}
        </span>
      </span>
      {unread && <span aria-hidden="true" className="absolute top-3.5 right-1.5 size-1.5 rounded-full bg-primary" />}
    </button>
  )
}

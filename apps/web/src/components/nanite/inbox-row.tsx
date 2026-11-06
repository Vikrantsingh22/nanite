import { ArrowUpRightIcon, KeyRoundIcon, LockIcon, MessagesSquareIcon } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"

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
  onSelect?: () => void
}

/** One mailbox line. Without `subject` the message is shown as encrypted (locked). */
export function InboxRow({
  senderHash,
  subject,
  type,
  time,
  unread = false,
  selected = false,
  onSelect,
}: InboxRowProps) {
  const { icon: Icon, label } = TYPE[type]
  const encrypted = subject === undefined
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cn(
        "group/row grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 border-b px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-accent",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", unread ? "bg-primary" : "bg-transparent")}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className={cn(unread && "text-foreground")}>{senderHash}</span>
          <Badge variant="outline">
            <Icon data-icon="inline-start" />
            {label}
          </Badge>
        </span>
        {encrypted ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <LockIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="sr-only">Encrypted message</span>
            <span aria-hidden="true" className="h-2 w-40 max-w-full rounded-xs bg-muted-foreground/25" />
            <span className="font-mono text-xs">encrypted</span>
          </span>
        ) : (
          <span className={cn("truncate text-sm", unread ? "font-medium" : "text-muted-foreground")}>
            {subject}
          </span>
        )}
      </span>
      <time className="font-mono text-xs text-muted-foreground tnum">{time}</time>
    </button>
  )
}

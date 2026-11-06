import { BanIcon, GlobeIcon, ListChecksIcon, ReplyIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"

export type SendPolicy = "off" | "reply-only" | "allowlist" | "any"

const POLICY = {
  off: { icon: BanIcon, variant: "outline", hint: "Cannot send mail" },
  "reply-only": { icon: ReplyIcon, variant: "info", hint: "Can answer senders only" },
  allowlist: { icon: ListChecksIcon, variant: "success", hint: "Can send to listed recipients" },
  any: { icon: GlobeIcon, variant: "warning", hint: "Can send to anyone" },
} as const

export const SEND_POLICY_HINT: Record<SendPolicy, string> = {
  off: POLICY.off.hint,
  "reply-only": POLICY["reply-only"].hint,
  allowlist: POLICY.allowlist.hint,
  any: POLICY.any.hint,
}

/** The ENS-enforced outbound policy of an agent (nanite.send record). */
export function SendPolicyBadge({ policy }: { policy: SendPolicy }) {
  const { icon: Icon, variant, hint } = POLICY[policy]
  return (
    <Badge variant={variant} title={hint}>
      <Icon data-icon="inline-start" />
      send: {policy}
    </Badge>
  )
}

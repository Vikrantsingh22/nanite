import {
  BadgeCheckIcon, BanIcon, CheckIcon, CopyIcon, ExternalLinkIcon, FeatherIcon, GlobeIcon,
  KeyRoundIcon, ListChecksIcon, LockIcon, LockOpenIcon, MailIcon, ReplyIcon, ShieldOffIcon,
  SignatureIcon, TriangleAlertIcon, WalletIcon, type LucideIcon,
} from "lucide-react"

import { Section, Subsection } from "../primitives"

const ICONS: [string, LucideIcon][] = [
  ["mail", MailIcon], ["lock", LockIcon], ["lock-open", LockOpenIcon], ["key-round", KeyRoundIcon],
  ["signature", SignatureIcon], ["wallet", WalletIcon], ["feather", FeatherIcon], ["badge-check", BadgeCheckIcon],
  ["copy", CopyIcon], ["check", CheckIcon], ["external-link", ExternalLinkIcon], ["reply", ReplyIcon],
  ["list-checks", ListChecksIcon], ["globe", GlobeIcon], ["ban", BanIcon], ["shield-off", ShieldOffIcon],
  ["triangle-alert", TriangleAlertIcon],
]

export function IconographySection() {
  return (
    <Section
      id="iconography"
      index="06"
      title="Iconography"
      lead="Lucide, 1.5px stroke, square caps. Icons inside buttons and badges use data-icon and size themselves; never add size classes there."
    >
      <Subsection title="Set in use">
        <ul className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4 lg:grid-cols-6">
          {ICONS.map(([name, Icon]) => (
            <li key={name} className="flex flex-col items-center gap-2 bg-card px-2 py-4">
              <Icon className="size-5" aria-hidden="true" />
              <span className="font-mono text-[0.6875rem] text-muted-foreground">{name}</span>
            </li>
          ))}
        </ul>
      </Subsection>
      <Subsection title="Sizes and tones">
        <div className="flex flex-wrap items-center gap-6 rounded-lg border bg-card/50 p-4">
          {[3, 3.5, 4, 5, 6].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <LockIcon style={{ width: n * 4, height: n * 4 }} aria-hidden="true" />
              <LockIcon style={{ width: n * 4, height: n * 4 }} className="text-muted-foreground" aria-hidden="true" />
              <span className="font-mono text-xs text-muted-foreground tnum">{n * 4}px</span>
            </div>
          ))}
        </div>
      </Subsection>
    </Section>
  )
}

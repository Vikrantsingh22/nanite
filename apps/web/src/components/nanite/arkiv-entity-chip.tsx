import { ExternalLinkIcon, FeatherIcon, WalletIcon } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"

/** Arkiv testnet explorer base. Single place to change. */
export const ARKIV_EXPLORER_BASE = "https://rabdi.explorer.arkiv.network"

export function arkivEntityUrl(key: string) {
  return `${ARKIV_EXPLORER_BASE}/entity/${key}`
}

type ArkivEntityChipProps = {
  /** Full entity key (0x...). Shown shortened. */
  entityKey: string
  explorerUrl?: string
  ownedByYou?: boolean
  /** Creator address, shortened for display. */
  creator?: string
  className?: string
}

export function shortKey(key: string, head = 6, tail = 4) {
  return key.length <= head + tail + 1 ? key : `${key.slice(0, head)}…${key.slice(-tail)}`
}

/** Reference to an encrypted mail entity stored on Arkiv. */
export function ArkivEntityChip({
  entityKey,
  explorerUrl = arkivEntityUrl(entityKey),
  ownedByYou = false,
  creator,
  className,
}: ArkivEntityChipProps) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <a
        href={explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-6 items-center gap-1.5 rounded-sm border bg-card px-2 font-mono text-xs outline-none transition-colors hover:border-ring hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <FeatherIcon className="size-3 text-muted-foreground" aria-hidden="true" />
        {shortKey(entityKey)}
        <ExternalLinkIcon className="size-3 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Open in Arkiv explorer</span>
      </a>
      {ownedByYou && (
        <Badge variant="success">
          <WalletIcon data-icon="inline-start" />
          owned by your wallet
        </Badge>
      )}
      {creator && (
        <span className="font-mono text-xs text-muted-foreground">
          creator {shortKey(creator)}
        </span>
      )}
    </span>
  )
}

"use client"

import { BadgeCheckIcon, CheckIcon, CopyIcon, HourglassIcon } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { useCopy } from "./use-copy"

type EnsNameProps = {
  name: string
  /** Whether the name currently resolves on-chain. */
  resolved?: boolean
  showStatus?: boolean
  copyable?: boolean
  className?: string
}

/** ENS name pill: leading label in ink, parent domain muted, optional copy + resolved badge. */
export function EnsName({
  name,
  resolved = true,
  showStatus = true,
  copyable = true,
  className,
}: EnsNameProps) {
  const { copied, copy } = useCopy()
  const dot = name.indexOf(".")
  const label = dot === -1 ? name : name.slice(0, dot)
  const rest = dot === -1 ? "" : name.slice(dot)

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5", className)}>
      <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-sm border bg-card pl-2 pr-0.5 font-mono text-xs">
        <span className="truncate">
          <span className="text-foreground">{label}</span>
          <span className="text-muted-foreground">{rest}</span>
        </span>
        {copyable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={copied ? "Copied" : `Copy ${name}`}
                onClick={() => copy(name)}
              >
                {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "Copied" : "Copy name"}</TooltipContent>
          </Tooltip>
        )}
      </span>
      {showStatus &&
        (resolved ? (
          <Badge variant="success">
            <BadgeCheckIcon data-icon="inline-start" />
            resolved
          </Badge>
        ) : (
          <Badge variant="warning">
            <HourglassIcon data-icon="inline-start" />
            pending
          </Badge>
        ))}
    </span>
  )
}

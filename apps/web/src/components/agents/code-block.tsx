"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "cn"

import { useCopy } from "@/components/nanite/use-copy"
import { Button } from "@/components/ui/button"

/** Terminal-style block for a command or config snippet, with a copy button. Scrolls sideways, never the page. */
export function CodeBlock({
  title,
  text,
  testId,
  className,
}: {
  title: string
  text: string
  testId?: string
  className?: string
}) {
  const { copied, copy } = useCopy()
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{title}</span>
        <Button variant="ghost" size="xs" onClick={() => void copy(text)} aria-label={copied ? `Copied ${title}` : `Copy ${title}`}>
          {copied ? <CheckIcon data-icon="inline-start" className="text-success" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre tabIndex={0} className="overflow-x-auto p-3 font-mono text-xs leading-relaxed" data-testid={testId}>
        <code>{text}</code>
      </pre>
    </div>
  )
}

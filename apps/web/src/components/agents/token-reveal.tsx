"use client"

import * as React from "react"
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "cn"

import { useCopy } from "@/components/nanite/use-copy"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"

/**
 * Agent API token, shown once. The parent keeps the token only in React state; it is never written
 * to any browser storage. `onConfirmChange` reports the "I stored it" checkbox.
 */
export function TokenReveal({
  token,
  onConfirmChange,
  className,
}: {
  token: string
  onConfirmChange?: (confirmed: boolean) => void
  className?: string
}) {
  const { copied, copy } = useCopy()
  const id = React.useId()
  return (
    <div className={cn("flex flex-col gap-4 rounded-lg border bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">agent api token</span>
        <Button variant="outline" size="sm" onClick={() => void copy(token)}>
          {copied ? <CheckIcon data-icon="inline-start" className="text-success" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? "Copied" : "Copy token"}
        </Button>
      </div>
      <code
        data-testid="agent-token"
        className="block rounded-md border bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed break-all select-all"
      >
        {token}
      </code>
      <Alert>
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>Shown once</AlertTitle>
        <AlertDescription>
          Nanite stores only a hash of this token and cannot show it again. Treat it like a password: anyone holding it can read this
          agent&apos;s mail. You can rotate it later from the agent settings.
        </AlertDescription>
      </Alert>
      <Field orientation="horizontal">
        <Checkbox id={id} onCheckedChange={(v) => onConfirmChange?.(v === true)} />
        <FieldContent>
          <FieldLabel htmlFor={id}>I stored this token somewhere safe</FieldLabel>
          <FieldDescription>You will not see it again after you leave this page.</FieldDescription>
        </FieldContent>
      </Field>
    </div>
  )
}

"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"

import { useCopy } from "./use-copy"

type RecoveryCodeProps = {
  /** Groups of the code, e.g. ["K7QX","92MD",...]. */
  groups: string[]
  onConfirmChange?: (confirmed: boolean) => void
  className?: string
}

/** Recovery code shown once: grouped mono code, copy, and a "saved it" confirmation. */
export function RecoveryCode({ groups, onConfirmChange, className }: RecoveryCodeProps) {
  const { copied, copy } = useCopy()
  const [confirmed, setConfirmed] = React.useState(false)
  const id = React.useId()

  return (
    <div className={cn("flex flex-col gap-4 rounded-lg border bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">recovery code</span>
        <Button variant="outline" size="sm" onClick={() => copy(groups.join("-"))}>
          {copied ? (
            <CheckIcon data-icon="inline-start" className="text-success" />
          ) : (
            <CopyIcon data-icon="inline-start" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <ul
        aria-label="Recovery code groups"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-5"
      >
        {groups.map((g, i) => (
          <li
            key={`${g}-${i}`}
            // 2 columns on phones: an odd last group spans both so no cell is left empty; one row of 5 from sm up.
            className="bg-muted px-3 py-2.5 text-center font-mono text-base font-medium tracking-[0.16em] tnum max-sm:odd:last:col-span-2"
          >
            {g}
          </li>
        ))}
      </ul>
      <Field orientation="horizontal">
        <Checkbox
          id={id}
          checked={confirmed}
          onCheckedChange={(v) => {
            setConfirmed(v === true)
            onConfirmChange?.(v === true)
          }}
        />
        <FieldContent>
          <FieldLabel htmlFor={id}>I stored this code somewhere safe</FieldLabel>
          <FieldDescription>It is shown once and cannot be recovered later.</FieldDescription>
        </FieldContent>
      </Field>
    </div>
  )
}

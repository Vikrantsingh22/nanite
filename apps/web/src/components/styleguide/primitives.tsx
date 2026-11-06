import * as React from "react"
import { cn } from "cn"

/** A page section with an anchor id, a mono path label, a title and optional lead. */
export function Section({
  id,
  index,
  title,
  lead,
  children,
}: {
  id: string
  index: string
  title: string
  lead?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section id={id} className="flex scroll-mt-28 flex-col gap-8 border-t pt-10 pb-6 lg:scroll-mt-16">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-xs text-muted-foreground">
          <span className="text-primary">{index}</span> / {id}
        </p>
        <h2 className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {title}
        </h2>
        {lead && <p className="max-w-[62ch] text-base text-muted-foreground">{lead}</p>}
      </header>
      {children}
    </section>
  )
}

export function Subsection({
  title,
  note,
  children,
  className,
}: {
  title: string
  note?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-lg font-medium">{title}</h3>
        {note && <p className="max-w-[70ch] text-sm text-muted-foreground">{note}</p>}
      </div>
      {children}
    </div>
  )
}

/** Bordered specimen frame on a faint grid. */
export function Specimen({
  children,
  className,
  grid = false,
}: {
  children: React.ReactNode
  className?: string
  grid?: boolean
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card/50 p-4 sm:p-6",
        grid && "bg-grid",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A small mono label for a pinned state or variant. */
export function StateLabel({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-muted-foreground">{children}</span>
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-sm border bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground">
      {children}
    </code>
  )
}

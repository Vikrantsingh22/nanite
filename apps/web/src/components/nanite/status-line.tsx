import { cn } from "cn"

export type LogLevel = "ok" | "info" | "warn" | "error"
export type LogLine = { time: string; level: LogLevel; text: string }

const GLYPH: Record<LogLevel, { sym: string; cls: string; label: string }> = {
  ok: { sym: "✓", cls: "text-success", label: "ok" },
  info: { sym: "›", cls: "text-info", label: "info" },
  warn: { sym: "!", cls: "text-warning", label: "warning" },
  error: { sym: "✕", cls: "text-destructive", label: "error" },
}

/** Terminal-style activity feed. `live` appends a blinking caret. */
export function StatusLine({
  lines,
  title = "nanite://activity",
  live = true,
  className,
}: {
  lines: LogLine[]
  title?: string
  live?: boolean
  className?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <div className="flex items-center justify-between border-b px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span>{title}</span>
        {live && (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 animate-pulse-ring rounded-full bg-primary" aria-hidden="true" />
            live
          </span>
        )}
      </div>
      <ol className="flex flex-col gap-1 p-3 font-mono text-xs leading-relaxed">
        {lines.map((l, i) => {
          const g = GLYPH[l.level]
          return (
            <li key={i} className="grid grid-cols-[auto_auto_1fr] gap-x-2">
              <time className="text-muted-foreground tnum">{l.time}</time>
              <span className={cn("w-3 text-center", g.cls)} aria-label={g.label}>
                {g.sym}
              </span>
              <span className="min-w-0 break-words">{l.text}</span>
            </li>
          )
        })}
        {live && (
          <li className="grid grid-cols-[auto_auto_1fr] gap-x-2" aria-hidden="true">
            <span className="text-muted-foreground">&nbsp;</span>
            <span className="w-3 text-center text-primary">$</span>
            <span className="caret" />
          </li>
        )}
      </ol>
    </div>
  )
}

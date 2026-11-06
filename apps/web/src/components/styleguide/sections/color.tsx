"use client"

import { Badge } from "@/components/ui/badge"

import { useTokenMeasure } from "../color"
import { Code, Section, Subsection } from "../primitives"

const PAIRS: { bg: string; fg: string; use: string }[] = [
  { bg: "background", fg: "foreground", use: "Page canvas and ink" },
  { bg: "card", fg: "card-foreground", use: "Raised panels" },
  { bg: "popover", fg: "popover-foreground", use: "Menus, tooltips, dialogs" },
  { bg: "primary", fg: "primary-foreground", use: "Signal green: the one action" },
  { bg: "secondary", fg: "secondary-foreground", use: "Quiet filled controls" },
  { bg: "muted", fg: "muted-foreground", use: "Wells, secondary text" },
  { bg: "accent", fg: "accent-foreground", use: "Hover and selected rows" },
  { bg: "success", fg: "success-foreground", use: "Verified, decrypted, unlocked" },
  { bg: "warning", fg: "warning-foreground", use: "Pending, expiring, wide open" },
  { bg: "info", fg: "info-foreground", use: "Neutral information, chain links" },
]

const TEXT_ON_BG: { fg: string; use: string }[] = [
  { fg: "muted-foreground", use: "Secondary text on background" },
  { fg: "primary", use: "Signal text on background" },
  { fg: "destructive", use: "Destructive text on background" },
  { fg: "warning", use: "Warning text on background" },
  { fg: "info", use: "Info text on background" },
  { fg: "success", use: "Success text on background" },
]

const SWATCHES = [
  "border", "input", "ring", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
  "destructive", "signal-glow", "grid-line", "sidebar", "sidebar-primary", "sidebar-accent", "sidebar-border", "sidebar-ring",
]

function Ratio({ ratio }: { ratio: number | null }) {
  if (ratio === null) return <Badge variant="outline">measuring</Badge>
  return (
    <Badge variant={ratio >= 4.5 ? "success" : "destructive"} className="tnum">
      {ratio.toFixed(2)}:1 {ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : "fails AA"}
    </Badge>
  )
}

function ColorPair({ bg, fg, use }: { bg: string; fg: string; use: string }) {
  const { hex, ratio } = useTokenMeasure(fg, bg)
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border">
      <div
        className="flex h-28 flex-col justify-between p-3"
        style={{ background: `var(--${bg})`, color: `var(--${fg})` }}
      >
        <span className="font-heading text-3xl font-semibold leading-none">Aa</span>
        <span className="truncate font-mono text-xs">{fg}</span>
      </div>
      <div className="flex flex-col gap-2 border-t bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Code>{bg}</Code>
          <Ratio ratio={ratio} />
        </div>
        <p className="text-xs text-muted-foreground">{use}</p>
        <p className="font-mono text-xs text-muted-foreground tnum">text {hex}</p>
      </div>
    </div>
  )
}

function TextOnBg({ fg, use }: { fg: string; use: string }) {
  const { hex, ratio } = useTokenMeasure(fg, "background")
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-sm" style={{ color: `var(--${fg})` }}>
          {fg}
        </span>
        <span className="text-xs text-muted-foreground">{use}</span>
        <span className="font-mono text-xs text-muted-foreground tnum">{hex}</span>
      </div>
      <Ratio ratio={ratio} />
    </div>
  )
}

function Swatch({ token }: { token: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-2">
      <span
        className="size-9 shrink-0 rounded-sm border"
        style={{ background: `var(--${token})` }}
        aria-hidden="true"
      />
      <Code>{token}</Code>
    </div>
  )
}

export function ColorSection() {
  return (
    <Section
      id="color"
      index="02"
      title="Color"
      lead="Roles, not a palette. Each surface is paired with its foreground and measured live in the active theme; switch theme and the numbers update. Body text must reach 4.5:1."
    >
      <Subsection title="Role pairs" note="Surface with its foreground. Ratio is text on surface.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {PAIRS.map((p) => (
            <ColorPair key={p.bg} {...p} />
          ))}
        </div>
      </Subsection>
      <Subsection title="Text on background" note="Colored text used inline, measured against the page canvas.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TEXT_ON_BG.map((t) => (
            <TextOnBg key={t.fg} {...t} />
          ))}
        </div>
      </Subsection>
      <Subsection title="Lines, series, glow and sidebar" note="signal-glow and grid-line are translucent and only ever used as effects.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SWATCHES.map((t) => (
            <Swatch key={t} token={t} />
          ))}
        </div>
      </Subsection>
    </Section>
  )
}

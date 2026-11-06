import { Code, Section, Subsection } from "../primitives"

const SPACING = [1, 2, 3, 4, 6, 8, 12, 16]
const RADII = [
  { token: "rounded-xs", px: "2px", use: "progress bars, redaction" },
  { token: "rounded-sm", px: "3px", use: "badges, chips, kbd" },
  { token: "rounded-md", px: "4.5px", use: "buttons, inputs" },
  { token: "rounded-lg", px: "6px", use: "cards, menus, panels" },
  { token: "rounded-xl", px: "9px", use: "dialogs, sheets" },
]
const ELEVATION = [
  { name: "flat", cls: "", use: "canvas, bands" },
  { name: "hairline", cls: "border bg-card", use: "cards, panels" },
  { name: "raised", cls: "border bg-popover shadow-md", use: "menus, popovers" },
  { name: "overlay", cls: "border bg-popover shadow-2xl", use: "dialogs, sheets" },
]

export function SpacingSection() {
  return (
    <Section
      id="spacing"
      index="04"
      title="Spacing, radius and hairlines"
      lead="A 4px base unit, a 6px base radius and 1px borders. Structure is drawn with lines on a faint blueprint grid."
    >
      <Subsection title="Spacing scale" note="Inside a component 2-3, between related items 4, between groups 6-8, between sections 12-16.">
        <div className="flex flex-col gap-2 rounded-lg border bg-card/50 p-4">
          {SPACING.map((n) => (
            <div key={n} className="grid grid-cols-[6rem_1fr] items-center gap-3">
              <span className="font-mono text-xs text-muted-foreground tnum">gap-{n} · {n * 4}px</span>
              <span className="h-3 rounded-xs bg-primary" style={{ width: n * 4 * 2 }} />
            </div>
          ))}
        </div>
      </Subsection>

      <Subsection title="Radius">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {RADII.map((r) => (
            <div key={r.token} className="flex flex-col gap-2">
              <div className={`${r.token} h-20 border border-primary/60 bg-primary/10`} />
              <Code>{r.token}</Code>
              <span className="font-mono text-xs text-muted-foreground">{r.px}</span>
              <span className="text-xs text-muted-foreground">{r.use}</span>
            </div>
          ))}
        </div>
      </Subsection>

      <Subsection title="Hairlines and grid" note="The backdrop grid is 32px at 5% ink. Borders are solid 1px tokens, never alpha-stacked.">
        <div className="bg-grid relative flex h-40 items-center justify-center overflow-hidden rounded-lg border">
          <div className="flex flex-col divide-y rounded-lg border bg-card font-mono text-xs">
            <span className="px-4 py-2">border · 1px</span>
            <span className="px-4 py-2 text-muted-foreground">grid-line · 32px</span>
          </div>
        </div>
      </Subsection>

      <Subsection title="Elevation">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {ELEVATION.map((e) => (
            <div key={e.name} className="flex flex-col gap-2">
              <div className={`${e.cls} flex h-20 items-center justify-center rounded-lg font-mono text-xs`}>{e.name}</div>
              <span className="text-xs text-muted-foreground">{e.use}</span>
            </div>
          ))}
        </div>
      </Subsection>
    </Section>
  )
}

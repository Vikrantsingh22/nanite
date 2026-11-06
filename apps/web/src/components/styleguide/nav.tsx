"use client"

import * as React from "react"
import { cn } from "cn"

export const SECTIONS = [
  { id: "principles", label: "Principles" },
  { id: "color", label: "Color" },
  { id: "typography", label: "Typography" },
  { id: "spacing", label: "Spacing and radius" },
  { id: "motion", label: "Motion" },
  { id: "iconography", label: "Iconography" },
  { id: "components", label: "Components" },
  { id: "patterns", label: "Product patterns" },
  { id: "theming", label: "Theming" },
] as const

export function SectionNav() {
  const [active, setActive] = React.useState<string>(SECTIONS[0].id)

  React.useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (e): e is HTMLElement => e !== null,
    )
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length) {
          const top = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
          setActive(top.target.id)
        }
      },
      { rootMargin: "-80px 0px -65% 0px" },
    )
    els.forEach((e) => obs.observe(e))
    return () => obs.disconnect()
  }, [])

  return (
    <nav aria-label="Sections">
      <ol className="flex gap-1 lg:flex-col">
        {SECTIONS.map((s, i) => (
          <li key={s.id} className="shrink-0">
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "location" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                active === s.id && "bg-accent text-accent-foreground",
              )}
            >
              <span className={cn("tnum", active === s.id ? "text-primary" : "text-muted-foreground")}>
                {String(i + 1).padStart(2, "0")}
              </span>
              {s.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}

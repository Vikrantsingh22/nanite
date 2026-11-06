"use client"

import { useTheme } from "next-themes"
import { MoonIcon, SunIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

import { Code, Section, Subsection } from "../primitives"

export function ThemingSection() {
  const { setTheme } = useTheme()
  return (
    <Section
      id="theming"
      index="09"
      title="Theming"
      lead="Dark is the default and the reference. Light keeps the same geometry and accents on paper and ink. Both live in CSS variables; components never branch on theme."
    >
      <Subsection title="Switch theme">
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => setTheme("dark")}>
            <MoonIcon data-icon="inline-start" />
            Dark
          </Button>
          <Button variant="outline" onClick={() => setTheme("light")}>
            <SunIcon data-icon="inline-start" />
            Light
          </Button>
        </div>
      </Subsection>
      <Subsection title="Rules">
        <ul className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">
          {[
            ["Use semantic tokens", "bg-primary, text-muted-foreground. Never bg-green-500."],
            ["Edit variables, not components", "Change values in globals.css; both themes follow."],
            ["No dark: overrides in new code", "Light and dark differ only by variable values."],
            ["Status needs text", "Every colored state also carries a word or an icon."],
          ].map(([t, d]) => (
            <li key={t} className="flex flex-col gap-1 bg-card p-4">
              <span className="font-heading font-medium">{t}</span>
              <span className="text-sm text-muted-foreground">{d}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Tokens live in <Code>apps/web/src/app/globals.css</Code>; each is documented beside its definition.
        </p>
      </Subsection>
    </Section>
  )
}

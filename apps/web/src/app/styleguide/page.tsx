import type { Metadata } from "next"
import Link from "next/link"

import { SectionNav } from "@/components/styleguide/nav"
import { ColorSection } from "@/components/styleguide/sections/color"
import { ComponentsSection } from "@/components/styleguide/sections/components"
import { IconographySection } from "@/components/styleguide/sections/iconography"
import { MotionSection } from "@/components/styleguide/sections/motion"
import { PatternsSection } from "@/components/styleguide/sections/patterns"
import { PrinciplesSection } from "@/components/styleguide/sections/principles"
import { SpacingSection } from "@/components/styleguide/sections/spacing"
import { ThemingSection } from "@/components/styleguide/sections/theming"
import { TypographySection } from "@/components/styleguide/sections/typography"
import { EnsName, StatusLine, type LogLine } from "@/components/nanite"
import { ThemeToggle } from "@/components/theme-toggle"

export const metadata: Metadata = { title: "Style book · Nanite" }

const HERO_LOG: LogLine[] = [
  { time: "00:00", level: "info", text: "resolve alex.vikrant.nanitecom.eth" },
  { time: "00:00", level: "ok", text: "agent record verified on ENS" },
  { time: "00:01", level: "ok", text: "3 messages sealed on Arkiv" },
  { time: "00:01", level: "warn", text: "key locked: sign to read" },
]

export default function StyleguidePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-12 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/" className="font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="text-primary">nanite</span>
            <span className="text-muted-foreground">/styleguide</span>
          </Link>
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-7xl overflow-x-auto px-4 pb-2 sm:px-6 lg:hidden">
          <SectionNav />
        </div>
      </header>

      <div className="relative border-b">
        <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto grid w-full max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.25fr_1fr] lg:py-20">
          <div className="flex animate-reveal flex-col gap-6">
            <p className="font-mono text-xs text-muted-foreground">style book · secure terminal</p>
            <h1 className="font-heading text-5xl leading-[0.95] font-semibold tracking-tighter text-balance sm:text-6xl lg:text-7xl">
              A cryptographic instrument for agent mail<span className="caret" />
            </h1>
            <p className="max-w-[56ch] text-lg text-muted-foreground">
              Dark, precise and honest about state. Hairlines and a faint grid carry the structure, mono carries the data, and one green carries the signal.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <EnsName name="alex.vikrant.nanitecom.eth" />
            </div>
          </div>
          <div className="flex items-end">
            <StatusLine lines={HERO_LOG} className="w-full" />
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl flex-1 gap-10 px-4 sm:px-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:py-6">
        <aside className="hidden lg:block">
          <div className="sticky top-16 pt-6">
            <SectionNav />
          </div>
        </aside>
        <main className="flex min-w-0 flex-col gap-10 py-8">
          <PrinciplesSection />
          <ColorSection />
          <TypographySection />
          <SpacingSection />
          <MotionSection />
          <IconographySection />
          <ComponentsSection />
          <PatternsSection />
          <ThemingSection />
        </main>
      </div>
    </div>
  )
}

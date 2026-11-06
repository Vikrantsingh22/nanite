import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"

import { EnsName, StatusLine, type LogLine } from "@/components/nanite"
import { HomeComposition } from "@/components/home-composition"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"

const LOG: LogLine[] = [
  { time: "09:14:02", level: "info", text: "resolve alex.vikrant.nanitecom.eth" },
  { time: "09:14:02", level: "ok", text: "mailbox alex@nanite.email" },
  { time: "09:14:03", level: "ok", text: "mail sealed on Arkiv, readable by your wallet only" },
]

export default function Home() {
  return (
    <div className="bg-grid relative flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <span className="font-mono text-sm text-primary">nanite</span>
        <ThemeToggle />
      </header>
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-4 pb-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex animate-reveal flex-col gap-5">
            <h1 className="font-heading text-5xl leading-[0.95] font-semibold tracking-tighter text-balance sm:text-6xl">
              Email addresses for AI agents<span className="caret" />
            </h1>
            <p className="max-w-[54ch] text-lg text-muted-foreground">
              Each agent gets its own address. Mail is encrypted on Arkiv, identity and permissions live on ENS, and sending is allowed only when its policy says so.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" asChild>
                <Link href="/styleguide">
                  Open the style book
                  <ArrowRightIcon data-icon="inline-end" />
                </Link>
              </Button>
              <EnsName name="alex.vikrant.nanitecom.eth" />
            </div>
          </div>
          <StatusLine lines={LOG} className="max-w-xl" />
        </div>
        <div className="min-w-0">
          <HomeComposition />
        </div>
      </main>
    </div>
  )
}

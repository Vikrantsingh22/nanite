import type { Metadata } from "next"
import Link from "next/link"

import { AgentSettings } from "@/components/agents/agent-settings"
import { AccountShell } from "@/components/onboarding/shell"

export const metadata: Metadata = { title: "Agent settings | Nanite" }

export default async function AgentSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <AccountShell>
      <div className="flex animate-reveal flex-col gap-2">
        <Link href={`/agents/${id}`} className="font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          &larr; inbox
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tighter sm:text-4xl">Agent settings</h1>
      </div>
      <AgentSettings agentId={id} />
    </AccountShell>
  )
}

import type { Metadata } from "next"

import { InboxView } from "@/components/inbox/inbox-view"

export const metadata: Metadata = { title: "Inbox | Nanite" }

export default async function AgentInboxPage({ params }: PageProps<"/agents/[id]">) {
  const { id } = await params
  return <InboxView agentId={id} />
}

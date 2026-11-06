import type { Metadata } from "next"

import { AddAgent } from "@/components/agents/add-agent"

export const metadata: Metadata = { title: "Add an agent | Nanite" }

export default function NewAgentPage() {
  return <AddAgent />
}

"use client"

import * as React from "react"

import { AgentCard, ArkivEntityChip, OtpCountdown } from "@/components/nanite"

const KEY = "0x4e1a9c53d07be2f18a64c9d0e5b3f7a21c8d6e90b7c2f4a1d83e5c6b9a07b7c2"
const CREATOR = "0x71C0e9d3a5B8f2c41d6A07e9b3C5d8F1a2E49aB3"

function Step({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative pl-6">
      <span
        aria-hidden="true"
        className="absolute top-5 left-0 size-2 -translate-x-1/2 rounded-full border bg-background ring-4 ring-background"
      />
      {children}
    </li>
  )
}

/** Product patterns stacked on a hairline spine: identity, mail, storage. */
export function HomeComposition() {
  const [expiresAt, setExpiresAt] = React.useState(() => Date.now() + 45_000)
  return (
    <ol className="ml-1 flex flex-col gap-4 border-l">
      <Step>
        <AgentCard
          ensName="alex.vikrant.nanitecom.eth"
          email="alex@nanite.email"
          unread={3}
          policy="reply-only"
        />
      </Step>
      <Step>
        <OtpCountdown
          code="482913"
          from="auth@example.com"
          totalMs={45_000}
          expiresAt={expiresAt}
          onRequestNew={() => setExpiresAt(Date.now() + 45_000)}
        />
      </Step>
      <Step>
        <div className="rounded-lg border bg-card p-3">
          <ArkivEntityChip entityKey={KEY} ownedByYou creator={CREATOR} />
        </div>
      </Step>
    </ol>
  )
}

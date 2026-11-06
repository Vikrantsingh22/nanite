"use client"

import * as React from "react"

import {
  AgentCard, AgentGlyph, AgentMascot, ArkivEntityChip, EnsName, InboxRow, OtpCountdown, PermissionMatrix,
  RecoveryCode, SendPolicyBadge, StatusLine, UnlockKeyPanel,
  type LogLine, type UnlockState,
} from "@/components/nanite"
import { Button } from "@/components/ui/button"

import { Section, StateLabel, Subsection } from "../primitives"

const LOG: LogLine[] = [
  { time: "14:02:11", level: "info", text: "resolve alex.vikrant.nanitecom.eth" },
  { time: "14:02:11", level: "ok", text: "nanite.send = reply-only" },
  { time: "14:02:12", level: "ok", text: "stored entity 0x4e1a9c…b7c2 on Arkiv" },
  { time: "14:02:19", level: "warn", text: "send to unknown@example.com blocked by policy" },
  { time: "14:02:30", level: "error", text: "decrypt failed: key locked" },
]

const UNLOCK_STATES: UnlockState[] = ["idle", "signing", "unlocked", "error"]
const KEY = "0x4e1a9c53d07be2f18a64c9d0e5b3f7a21c8d6e90b7c2f4a1d83e5c6b9a07b7c2"
const CREATOR = "0x71C0e9d3a5B8f2c41d6A07e9b3C5d8F1a2E49aB3"

function Block({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <Subsection title={title} note={note}>{children}</Subsection>
}

export function PatternsSection() {
  const [unlock, setUnlock] = React.useState<UnlockState>("idle")
  const [revoked, setRevoked] = React.useState(false)
  const [selected, setSelected] = React.useState(0)
  const [expiresAt, setExpiresAt] = React.useState(() => Date.now() + 40_000)

  return (
    <Section
      id="patterns"
      index="08"
      title="Product patterns"
      lead="Nanite's own vocabulary built from the primitives above. Pure UI with mock data; none of these call the chain."
    >
      <Block title="ENS name" note="Leading label in ink, parent in muted. Copy is one click; resolved state is a badge, not a color alone.">
        <div className="flex flex-col gap-3 rounded-lg border bg-card/50 p-4">
          <EnsName name="vikrant.nanitecom.eth" />
          <EnsName name="alex.vikrant.nanitecom.eth" />
          <EnsName name="scout.vikrant.nanitecom.eth" resolved={false} />
        </div>
      </Block>

      <Block title="Send policy" note="Enforced by the nanite.send record. Open policies are amber on purpose: wide-open deserves caution.">
        <div className="flex flex-wrap gap-2 rounded-lg border bg-card/50 p-4">
          <SendPolicyBadge policy="off" />
          <SendPolicyBadge policy="reply-only" />
          <SendPolicyBadge policy="allowlist" />
          <SendPolicyBadge policy="any" />
        </div>
      </Block>

      <Block title="Agent mascot" note="Pixel bot, deterministic per ENS name; the 5x5 identity glyph sits on its chest. Animations stop under reduced motion.">
        <div className="flex flex-wrap items-end gap-6 rounded-lg border bg-card/50 p-4">
          {(["active", "provisioning", "revoked", "failed"] as const).map((st) => (
            <div key={st} className="flex flex-col items-center gap-2">
              <AgentMascot seed="alex.vikrant.nanitecom.eth" status={st} className="h-24 w-[90px]" />
              <StateLabel>{st}</StateLabel>
            </div>
          ))}
          {["scout.vikrant.nanitecom.eth", "mira.vikrant.nanitecom.eth", "otto.vikrant.nanitecom.eth", "juno.vikrant.nanitecom.eth", "bex.vikrant.nanitecom.eth"].map((n) => (
            <div key={n} className="flex flex-col items-center gap-2">
              <AgentMascot seed={n} className="h-24 w-[90px]" />
              <StateLabel>{n.split(".")[0]}</StateLabel>
            </div>
          ))}
          <div className="flex flex-col items-center gap-2">
            <div className="size-12 p-1"><AgentGlyph seed="alex.vikrant.nanitecom.eth" /></div>
            <StateLabel>glyph</StateLabel>
          </div>
        </div>
      </Block>

      <Block title="Agent card" note="Active and revoked. Revoking is previewed by the button.">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <StateLabel>active</StateLabel>
            <AgentCard
              ensName="alex.vikrant.nanitecom.eth"
              email="alex@nanite.email"
              unread={3}
              policy="reply-only"
              revoked={revoked}
              onRevoke={() => setRevoked(true)}
            />
            {revoked && (
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setRevoked(false)}>
                Undo (demo)
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <StateLabel>revoked</StateLabel>
            <AgentCard ensName="scout.vikrant.nanitecom.eth" email="scout@nanite.email" unread={0} policy="any" revoked />
          </div>
        </div>
      </Block>

      <Block title="Inbox rows" note="Encrypted rows show a lock and a redaction bar; decrypted rows show the subject.">
        <div className="overflow-hidden rounded-lg border bg-card">
          <InboxRow senderHash="0x9f3a…c21e" subject="Your login code for Example" type="otp" time="14:02" unread selected={selected === 0} onSelect={() => setSelected(0)} />
          <InboxRow senderHash="0x31bd…07a4" type="conversation" time="13:40" unread selected={selected === 1} onSelect={() => setSelected(1)} />
          <InboxRow senderHash="0xc7e2…91f0" subject="Re: Invoice 2041" type="conversation" time="Mon" selected={selected === 2} onSelect={() => setSelected(2)} />
          <InboxRow senderHash="alex@nanite.email" subject="Booking confirmed" type="sent" time="Sun" selected={selected === 3} onSelect={() => setSelected(3)} />
        </div>
      </Block>

      <div className="grid gap-8 lg:grid-cols-2">
        <Block title="One-time code" note="Live countdown from expiresAt. Wait for it to expire.">
          <OtpCountdown
            code="482913"
            from="auth@example.com"
            expiresAt={expiresAt}
            totalMs={40_000}
            onRequestNew={() => setExpiresAt(Date.now() + 40_000)}
          />
        </Block>
        <Block title="Arkiv entity" note="Short key with explorer link, ownership and creator.">
          <div className="flex flex-col gap-3 rounded-lg border bg-card/50 p-4">
            <ArkivEntityChip entityKey={KEY} ownedByYou creator={CREATOR} />
            <ArkivEntityChip entityKey={KEY} />
          </div>
        </Block>
      </div>

      <Block title="Permission matrix" note="Who may edit each ENS record of alex.vikrant.nanitecom.eth. The agent can edit only its own context.">
        <div className="overflow-hidden rounded-lg border bg-card">
          <PermissionMatrix />
        </div>
      </Block>

      <div className="grid gap-8 lg:grid-cols-2">
        <Block title="Unlock key" note="Click through the four states.">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Unlock state">
              {UNLOCK_STATES.map((s) => (
                <Button key={s} size="xs" variant={unlock === s ? "default" : "outline"} onClick={() => setUnlock(s)}>
                  {s}
                </Button>
              ))}
            </div>
            <UnlockKeyPanel
              state={unlock}
              onUnlock={() => {
                setUnlock("signing")
                setTimeout(() => setUnlock("unlocked"), 1500)
              }}
            />
          </div>
        </Block>
        <Block title="Recovery code" note="Shown once. Confirm before continuing.">
          <RecoveryCode groups={["K7QX", "92MD", "TW4P", "8HZN", "E5VC", "J3RA"]} />
        </Block>
      </div>

      <Block title="Activity log" note="Terminal-style feed for resolves, storage and policy decisions.">
        <StatusLine lines={LOG} />
      </Block>
    </Section>
  )
}

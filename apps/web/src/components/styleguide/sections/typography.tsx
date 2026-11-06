import { Code, Section, Subsection } from "../primitives"

const SCALE = [
  { token: "display", spec: "56 / 1.0 / 600 / -0.03em", use: "Page title", cls: "font-heading text-5xl leading-none font-semibold tracking-tighter sm:text-6xl", text: "Mail for agents" },
  { token: "title", spec: "36 / 1.1 / 600 / -0.02em", use: "Section heads", cls: "font-heading text-4xl leading-tight font-semibold tracking-tight", text: "Unlock your inbox" },
  { token: "heading", spec: "24 / 1.2 / 600 / -0.01em", use: "Panel titles", cls: "font-heading text-2xl leading-snug font-semibold tracking-tight", text: "Send policy" },
  { token: "subhead", spec: "18 / 1.35 / 500", use: "Card titles", cls: "font-heading text-lg font-medium", text: "alex.vikrant.nanitecom.eth" },
  { token: "body", spec: "15 / 1.6 / 400", use: "Running text", cls: "text-[0.9375rem] leading-relaxed", text: "Every message is encrypted before it reaches Arkiv." },
  { token: "small", spec: "13 / 1.5 / 400", use: "Descriptions, hints", cls: "text-[0.8125rem] leading-normal text-muted-foreground", text: "Only your wallet can read this." },
  { token: "label", spec: "12 / 1.4 / 500 mono", use: "Field labels, state labels", cls: "font-mono text-xs font-medium", text: "send: reply-only" },
  { token: "code", spec: "13 / 1.5 / 400 mono", use: "Addresses, hashes, codes", cls: "font-mono text-[0.8125rem]", text: "0x4e1a9c…b7c2" },
]

export function TypographySection() {
  return (
    <Section
      id="typography"
      index="03"
      title="Typography"
      lead="Host Grotesk sets headings and prose: crisp, slightly narrow, confident at large sizes. Martian Mono sets everything that is data: wide letterforms keep hashes and codes unambiguous."
    >
      <Subsection title="Scale">
        <div className="overflow-hidden rounded-lg border">
          {SCALE.map((r) => (
            <div
              key={r.token}
              className="grid gap-x-6 gap-y-2 border-b bg-card/50 p-4 last:border-b-0 md:grid-cols-[10rem_1fr]"
            >
              <div className="flex flex-col gap-1">
                <Code>{r.token}</Code>
                <span className="font-mono text-xs text-muted-foreground">{r.spec}</span>
                <span className="text-xs text-muted-foreground">{r.use}</span>
              </div>
              <p className={`${r.cls} min-w-0 truncate`}>{r.text}</p>
            </div>
          ))}
        </div>
      </Subsection>

      <Subsection title="Sans and mono">
        <div className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">
          <div className="flex flex-col gap-3 bg-card p-5">
            <Code>font-sans</Code>
            <p className="font-heading text-5xl leading-none font-semibold tracking-tighter">Aa Gg 42</p>
            <p className="text-sm text-muted-foreground">Host Grotesk. ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</p>
          </div>
          <div className="flex flex-col gap-3 bg-card p-5">
            <Code>font-mono</Code>
            <p className="font-mono text-4xl leading-none font-medium">Aa Gg 42</p>
            <p className="font-mono text-xs break-all text-muted-foreground">Martian Mono. ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</p>
          </div>
        </div>
      </Subsection>

      <Subsection title="Numerals" note="Data uses tabular, slashed-zero figures so columns line up and 0 never reads as O.">
        <div className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">
          <div className="flex flex-col gap-2 bg-card p-5">
            <Code>proportional</Code>
            <p className="font-mono text-xl">1111 0000 8888</p>
            <p className="font-sans text-xl">1111 0000 8888</p>
          </div>
          <div className="flex flex-col gap-2 bg-card p-5">
            <Code>tnum</Code>
            <p className="tnum font-mono text-xl">1111 0000 8888</p>
            <p className="tnum font-sans text-xl">1111 0000 8888</p>
          </div>
        </div>
      </Subsection>

      <Subsection title="Running text">
        <div className="max-w-[62ch] text-[0.9375rem] leading-relaxed">
          <p>
            An agent reads its mail through{" "}
            <a href="#components" className="text-primary underline underline-offset-4">its own address</a>
            , while the body of every message stays encrypted on Arkiv. Identity and permissions live in the ENS record{" "}
            <Code>nanite.send</Code>, which decides whether a reply may leave. Lines stay under 70 characters so the eye never loses its place.
          </p>
        </div>
      </Subsection>
    </Section>
  )
}

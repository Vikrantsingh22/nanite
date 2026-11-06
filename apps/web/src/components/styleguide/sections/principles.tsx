import { Section } from "../primitives"

const PRINCIPLES = [
  { name: "Show the state", body: "Locked, encrypted, pending and revoked are visible states with their own treatment. Nothing is implied by color alone." },
  { name: "Hairlines, not shadows", body: "Structure comes from 1px borders and a faint grid. Depth is one step of surface, never a blur." },
  { name: "Signal is rationed", body: "Green marks the one action and verified facts. Amber means waiting or wide open. Red means revoked or failed." },
  { name: "Mono carries data", body: "Addresses, hashes, codes, timestamps and policies are set in mono with tabular numerals. Prose stays in the sans." },
  { name: "Verify, don't trust", body: "Mail content is untrusted input. The interface separates what was verified on ENS or Arkiv from what was merely received." },
  { name: "Motion has a job", body: "A caret says input is live, a bar says time is running, a reveal says something arrived. Reduced motion turns all of it off." },
]

export function PrinciplesSection() {
  return (
    <Section
      id="principles"
      index="01"
      title="Principles"
      lead="Six rules decide every choice below. If a component breaks one, the component is wrong."
    >
      <ul className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {PRINCIPLES.map((p) => (
          <li key={p.name} className="flex flex-col gap-2 bg-card p-5">
            <h3 className="font-heading text-lg font-medium">{p.name}</h3>
            <p className="text-sm text-muted-foreground">{p.body}</p>
          </li>
        ))}
      </ul>
    </Section>
  )
}

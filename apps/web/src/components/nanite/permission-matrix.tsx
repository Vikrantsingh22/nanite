import { CheckIcon, MinusIcon } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export type Actor = "user" | "operator" | "agent"
export type PermissionRow = {
  record: string
  description: string
  editableBy: Actor[]
}

const ACTORS: Actor[] = ["user", "operator", "agent"]

export const DEFAULT_PERMISSIONS: PermissionRow[] = [
  { record: "email", description: "Mailbox address", editableBy: ["user"] },
  { record: "nanite.send", description: "Outbound send policy", editableBy: ["user"] },
  { record: "nanite.pubkey", description: "Encryption public key", editableBy: ["user", "operator"] },
  { record: "nanite.agent-context", description: "Notes the agent keeps for itself", editableBy: ["user", "operator", "agent"] },
]

/** Which actor may edit which ENS text record. Read-only cells are explicit, not blank. */
export function PermissionMatrix({
  rows = DEFAULT_PERMISSIONS,
  name = "alex.vikrant.nanitecom.eth",
}: {
  rows?: PermissionRow[]
  name?: string
}) {
  return (
    <Table>
      <caption className="sr-only">Who can edit each ENS record of {name}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>record</TableHead>
          {ACTORS.map((a) => (
            <TableHead key={a} className="w-20 text-center font-mono">
              {a}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.record}>
            <TableCell className="whitespace-normal">
              <span className="block font-mono text-xs">{row.record}</span>
              <span className="block text-xs text-muted-foreground">{row.description}</span>
            </TableCell>
            {ACTORS.map((a) => {
              const can = row.editableBy.includes(a)
              return (
                <TableCell key={a} className="text-center">
                  {can ? (
                    <CheckIcon className="mx-auto size-4 text-success" aria-hidden="true" />
                  ) : (
                    <MinusIcon className="mx-auto size-4 text-muted-foreground/60" aria-hidden="true" />
                  )}
                  <span className="sr-only">{can ? "can edit" : "read-only"}</span>
                </TableCell>
              )
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

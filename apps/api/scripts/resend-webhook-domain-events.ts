/*
 * Adds the domain events (`domain.created`, `domain.updated`, `domain.deleted`) to an existing Resend webhook
 * (T3.6). Reference: PATCH https://api.resend.com/webhooks/{id} with { events: [...] } (endpoint and status are
 * optional); the `events` array REPLACES the list, so the current events are read first and kept.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/resend-webhook-domain-events.ts            # list webhooks
 *   docker compose run --rm tools npx tsx apps/api/scripts/resend-webhook-domain-events.ts --id=<webhook id> [--apply]
 *
 * Without --apply it only prints what would change. Needs RESEND_API_KEY (never printed).
 */
export {};
const key = process.env.RESEND_API_KEY?.trim();
if (!key) {
  console.error("RESEND_API_KEY is missing: set it in the local .env (the value is never printed)");
  process.exit(1);
}
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const WANTED = ["domain.created", "domain.updated", "domain.deleted"];

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Resend ${method} ${path} answered ${res.status}${json?.name ? ` ${json.name}` : ""}`);
  return json;
}

const id = arg("id");
if (!id) {
  const list = await call("GET", "/webhooks");
  for (const w of list.data ?? []) console.log(`${w.id}  ${w.status}  ${w.endpoint}  events: ${(w.events ?? []).join(", ")}`);
} else {
  const current = await call("GET", `/webhooks/${encodeURIComponent(id)}`);
  const events: string[] = [...new Set([...(current.events ?? []), ...WANTED])];
  console.log(`webhook ${id}: ${(current.events ?? []).join(", ")}\n  -> ${events.join(", ")}`);
  if (!apply) console.log("dry run: add --apply to send the PATCH");
  else {
    await call("PATCH", `/webhooks/${encodeURIComponent(id)}`, { events });
    console.log("updated");
  }
}

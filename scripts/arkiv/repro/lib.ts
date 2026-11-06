// Shared helpers for the Arkiv friction repro scripts. Read-only: raw JSON-RPC against the public
// Rabdi endpoint, no wallet, no key. Run via `docker compose run --rm tools npx tsx scripts/arkiv/repro/<file>.ts`.
export const RPC = process.env.RPC ?? "https://rpc.rabdi.db-chain.testnet.arkiv.network";
// Arkiv-side operator that created the live Nanite entities (docs/wallets.md, Arkiv index 3).
export const OPERATOR = process.env.OPERATOR ?? "0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F";
export const P = `arkiv.schema = str('nanite.email.v1') AND $creator = addr(${OPERATOR})`;

export interface RpcOut {
  ms: number;
  http: number;
  body: any;
}

export async function rpc(method: string, params: unknown[], url = RPC): Promise<RpcOut> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 200) };
  }
  return { ms: Date.now() - t0, http: res.status, body };
}

const hex = (v: unknown) => (typeof v === "string" && v.startsWith("0x") ? parseInt(v, 16) : v);

/** arkiv_query with only small attributes selected (never the bytes columns). */
export async function query(q: string, opts: Record<string, unknown> = {}) {
  const options = {
    select: { key: true, count: true, attributes: { agentId: true, type: true, receivedAt: true } },
    limit: "0x3",
    ...opts,
  };
  const r = await rpc("arkiv_query", [q, options]);
  return { request: { method: "arkiv_query", params: [q, options] }, ...r };
}

/** One-line verdict for a query result. */
export function summarize(r: { http: number; ms: number; body: any }): string {
  if (r.body?.error) return `ERROR http=${r.http} ${r.ms}ms code=${r.body.error.code} message=${JSON.stringify(r.body.error.message)}`;
  const res = r.body?.result;
  if (!res) return `http=${r.http} ${r.ms}ms body=${JSON.stringify(r.body).slice(0, 200)}`;
  return `OK http=${r.http} ${r.ms}ms rows=${res.data?.length} count=${hex(res.count)} block=${hex(res.blockNumber)} keys=${Object.keys(res).join(",")}`;
}

export async function runCases(title: string, cases: { label: string; q: string; opts?: Record<string, unknown> }[]) {
  console.log(`# ${title}  (${new Date().toISOString()})  RPC=${RPC}`);
  for (const c of cases) {
    const r = await query(c.q, c.opts);
    console.log(`\n## ${c.label}\nquery:   ${c.q}${c.opts ? `\noptions: ${JSON.stringify(c.opts)}` : ""}\nresult:  ${summarize(r)}`);
  }
}

// U4: availability and latency of the Arkiv hosts (status code + time, N samples each). Read-only.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/u4-hosts.ts [samples]
export {};
const N = Number(process.argv[2] ?? 5);
const hosts: { name: string; url: string; init?: RequestInit }[] = [
  { name: "docs", url: "https://docs.arkiv.network/" },
  { name: "hub", url: "https://hub.arkiv.network/" },
  { name: "explorer", url: "https://rabdi.explorer.arkiv.network/" },
  { name: "rpc (GET)", url: "https://rpc.rabdi.db-chain.testnet.arkiv.network" },
  {
    name: "rpc (eth_chainId)",
    url: "https://rpc.rabdi.db-chain.testnet.arkiv.network",
    init: { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' },
  },
  {
    name: "rpc (arkiv_getBlockTiming)",
    url: "https://rpc.rabdi.db-chain.testnet.arkiv.network",
    init: { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"arkiv_getBlockTiming","params":[]}' },
  },
  { name: "indexer", url: "https://indexer.rabdi.db-chain.testnet.arkiv.network/" },
];
console.log(`# U4 host probe ${new Date().toISOString()} samples=${N}`);
for (const h of hosts) {
  const rows: string[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(h.url, { ...(h.init ?? {}), signal: AbortSignal.timeout(30_000), redirect: "manual" });
      await res.arrayBuffer();
      rows.push(`${res.status}/${Date.now() - t0}ms`);
    } catch (e) {
      rows.push(`ERR(${(e as Error).name}:${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message})/${Date.now() - t0}ms`);
    }
  }
  console.log(`${h.name.padEnd(28)} ${h.url}\n    ${rows.join("  ")}`);
}

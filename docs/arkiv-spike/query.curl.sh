#!/usr/bin/env bash
# Raw arkiv_query against Rabdi. Run inside Docker:
#   docker compose run --rm tools bash docs/arkiv-spike/query.curl.sh ['<query>'] [limit-hex]
# Public RPC is rate limited; with ARKIV_ACCESS_KEY set the key is the last path segment.
RPC="https://rpc.rabdi.db-chain.testnet.arkiv.network${ARKIV_ACCESS_KEY:+/$ARKIV_ACCESS_KEY}"
QUERY="${1:-\$expiresAt > u64(0)}"   # PLACEHOLDER. Literals are typed: name = str('x'), n >= u64(5), $owner = addr(0x..) (addr/key literals are UNQUOTED; addr('0x..') is rejected)
LIMIT="${2:-0x3}"                       # hex quantity, node max 0x64 (100)
# select: key defaults to true; everything else defaults off. attributes: true | {name:true}
curl -sS -m 30 -X POST "$RPC" -H 'content-type: application/json' -d "$(cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
  "$QUERY",
  {"select":{"key":true,"owner":true,"creator":true,"expiresAt":true,"attributes":true},"limit":"$LIMIT"}]}
JSON
)"
echo
# Other read methods (no params): arkiv_getBlockTiming ; arkiv_getEntity ["0x<32-byte key>"]
# curl ... -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_getBlockTiming","params":[]}'

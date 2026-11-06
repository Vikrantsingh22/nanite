#!/usr/bin/env bash
# Judge-runnable: list the seeded Nanite inbox for one agent straight from Arkiv (Rabdi testnet).
# No access key, no wallet, no SDK needed: one curl against the public JSON-RPC endpoint.
#   bash docs/arkiv-spike/readme-query.sh
#   docker compose run --rm tools bash docs/arkiv-spike/readme-query.sh    # if you have no local curl
# Optional: AGENT=alex.vikrant.nanitecom.eth LIMIT=0x5 bash docs/arkiv-spike/readme-query.sh
# Updated to schema nanite.email.v1 and the live-test operator (long-lived entities). The maintained judge script is arkiv/query.curl.sh.
RPC="${RPC:-https://rpc.rabdi.db-chain.testnet.arkiv.network}"
WRITER="${WRITER:-0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F}"   # the Nanite writer: ALWAYS pin $creator (anyone can write look-alikes)
AGENT="${AGENT:-alex.vikrant.nanitecom.eth}"
LIMIT="${LIMIT:-0x5}"
# Note: addr(...) and key(...) literals are unquoted, str('...') and u64(...) are typed.
QUERY="arkiv.schema = str('nanite.email.v1') AND \$creator = addr($WRITER) AND agentId = str('$AGENT') ORDER BY receivedAt:u64 DESC"
echo "query: $QUERY"
RESP=$(curl -sS -m 30 -X POST "$RPC" -H 'content-type: application/json' -d "$(cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
  "$QUERY",
  {"select":{"key":true,"creator":true,"expiresAt":true,"attributes":true,"count":true},"limit":"$LIMIT"}]}
JSON
)")
if command -v jq >/dev/null 2>&1; then
  echo "$RESP" | jq -r '
    def h: ltrimstr("0x") | explode | map(if . >= 97 then . - 87 else . - 48 end) | reduce .[] as $d (0; . * 16 + $d);
    def a($n): ([.attributes[]? | select(.name == $n) | .value][0]) // "?";
    (if .error then "error: \(.error.message)" else empty end),
    "matches: \((.result.count // "0x0") | h) (block \(.result.blockNumber | h))",
    (.result.data[]? | "\(.key[0:12])..  received=\(a("receivedAt") | if . == "?" then . else h | todate end)  type=\(a("type"))  thread=\(a("threadId"))  senderHash=\(a("senderHash")[0:12])..  ciphertext=<\(a("ciphertext") | (length - 2) / 2) bytes encrypted>")'
else
  echo "(jq not found; raw response follows)"; echo "$RESP"
fi

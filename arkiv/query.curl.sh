#!/bin/sh
# Judge-runnable: list Nanite email entities written by the Nanite operator, straight from Arkiv (Rabdi testnet).
# One curl against the public JSON-RPC endpoint; no wallet, SDK or access key. Needs curl and jq.
#   sh arkiv/query.curl.sh                       (POSIX sh; no bash needed)
#   AGENT=alex.vikrant.nanitecom.eth LIMIT=0x5 sh arkiv/query.curl.sh
# Env: RPC, OPERATOR ($creator pin), AGENT (optional agentId filter), LIMIT (hex quantity, node max 0x64),
#      ARKIV_ACCESS_KEY (optional; it is a rate-limit key and is the last path segment of the RPC URL).
#
# Query language facts (confirmed on Rabdi, see arkiv/friction.md):
#   - str('x') and u64(5) are typed literals; addr(0x...) and key(0x...) are UNQUOTED (addr('0x..') is rejected).
#   - Raw-string ORDER BY needs the column type: ORDER BY receivedAt:u64 DESC.
#   - ALWAYS pin $creator: anyone can write look-alike entities with our schema, so $owner alone is not enough.
#   - select.attributes can name columns; we leave out the bytes columns (ciphertext, wrappedKeys, nonce) here.
RPC="${RPC:-https://rpc.rabdi.db-chain.testnet.arkiv.network}${ARKIV_ACCESS_KEY:+/$ARKIV_ACCESS_KEY}"
OPERATOR="${OPERATOR:-0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F}"
LIMIT="${LIMIT:-0x5}"
FILTER=""
[ -n "${AGENT:-}" ] && FILTER=" AND agentId = str('$AGENT')"
QUERY="arkiv.schema = str('nanite.email.v1') AND \$creator = addr($OPERATOR)$FILTER ORDER BY receivedAt:u64 DESC"
curl -sS -m 30 -X POST "$RPC" -H 'content-type: application/json' -d "$(cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
  "$QUERY",
  {"select":{"key":true,"owner":true,"creator":true,"expiresAt":true,"count":true,
             "attributes":{"agentId":true,"type":true,"receivedAt":true,"threadId":true,"senderHash":true,"keyIds":true,"ownerId":true}},
   "limit":"$LIMIT"}]}
JSON
)" | jq '
  def h: ltrimstr("0x") | explode | map(if . >= 97 then . - 87 else . - 48 end) | reduce .[] as $d (0; . * 16 + $d);
  def a($n): ([.attributes[]? | select(.name == $n) | .value][0]);
  if .error then .error else
  { matches: (.result.count | h), atBlock: (.result.blockNumber | h),
    entities: [.result.data[] | {key, owner, creator, expiresAtBlock: (.expiresAt | h),
      agentId: a("agentId"), type: a("type"), receivedAt: (a("receivedAt") | h | todate), threadId: a("threadId"),
      senderHash: (a("senderHash")[0:12] + "..."), keyIds: a("keyIds")}] } end'

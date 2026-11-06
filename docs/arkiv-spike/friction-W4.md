# Friction W4
- sdk-notes.md and query.curl.sh say `addr('0x..')`; the node rejects quoted addresses ("addr takes a 0x-prefixed address"). Correct literal is unquoted `addr(0x...)`, `key(0x...)`. Cost: failed run plus 5 pointless retries (my retry loop retried a deterministic QueryError; fixed).
- `skipped` on `QueryResult` is a number, not an array (docs/types suggested list). Cost: one crashed poison run after the attacker tx was already sent.
- Raw RPC returns u64/count/blockNumber as hex strings and attributes as `[{name,type,value}]`; no doc. jq needs a hand-written hex parser.
- `client.query` with a raw string needs `ORDER BY name:type`; builder `orderBy` option on raw strings needs the type argument (`desc("receivedAt","u64")`).
- Public RPC: no rate-limit errors hit at ~1 call/0.6 s, but each query costs ~1-1.7 s.
- watchEntityEvents has no server-side filter; the event can arrive before the SDK's receipt wait returns.
- Funding took ~20 min of waiting (polling).

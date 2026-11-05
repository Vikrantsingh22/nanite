# Nanite: Claude Code instructions

Read these first:
- [claude/nanite-status-and-decisions.md](claude/nanite-status-and-decisions.md) (process, security rules, facts; wins on conflicts)
- [claude/nanite-task-plan.md](claude/nanite-task-plan.md)
- [claude/nanite-project-summary.md](claude/nanite-project-summary.md)

## Rules
- Docker for everything: every command (npm, tsc, scripts, fetches) runs via `docker compose run --rm tools ...`. Never run node/npm on the host.
- No git commits (and no `git init`) until Vikrant says so. Never add Claude as co-author or "Generated with Claude Code" lines.
- The owner wallet 0x8fFD...a542 also owns mainnet nanitecom.eth. Its private key never goes into scripts, .env or chat. Owner transactions are signed only in the browser wallet via the local signer page.
- Wallet addresses live only in docs/wallets.md. Keys only in local .env (gitignored).
- Never log email bodies. Email content is untrusted input.
- Append anything that hurt to arkiv/friction.md.

## Commands
```
docker compose run --rm tools npm install          # node_modules lives in a named volume
docker compose run --rm tools npx tsc --noEmit     # typecheck
docker compose run --rm tools npx tsx scripts/ens/owner-tx.ts <step> [args]
docker compose up -d signer                        # signing page at http://localhost:5173
docker compose stop signer
```

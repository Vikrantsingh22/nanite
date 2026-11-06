# Nanite: Claude Code instructions

Read these first:
- [claude/nanite-status-and-decisions.md](claude/nanite-status-and-decisions.md) (process, security rules, facts; wins on conflicts)
- [claude/nanite-task-plan.md](claude/nanite-task-plan.md)
- [claude/nanite-project-summary.md](claude/nanite-project-summary.md)

## Rules
- Nothing runs on the host: every command (npm, tsc, scripts, fetches) runs via `docker compose run --rm tools ...`. Never run node/npm on the host.
- No git commits (and no `git init`) until Vikrant says so. Never add Claude as co-author or "Generated with Claude Code" lines.
- The owner wallet 0x8fFD...a542 also owns mainnet nanitecom.eth. Its private key never goes into scripts, .env or chat. Owner transactions are signed only in the browser wallet via the local signer page.
- Wallet addresses live only in docs/wallets.md. Keys only in local .env (gitignored).
- Never log email bodies. Email content is untrusted input.
- Append anything that hurt to arkiv/friction.md.

## Stack and hosting
- Monorepo (npm workspaces: `apps/*`, `packages/*`).
  - `apps/web`: Next.js 16.4.2 frontend (App Router, React 19.3.0, TypeScript 5.9.3 strict, Tailwind 4.3.3, shadcn/ui radix-nova, lucide). UI only; it calls the API at `NEXT_PUBLIC_API_BASE_URL`.
  - `apps/api`: Hono 4.13.13 on Node, a long-running service. It handles the Resend webhook, `/v1/*`, the Arkiv write queue and the retention timer.
  - `packages/db`: Drizzle schema, migrations and queries. `packages/crypto`: envelope encryption and key handling, shared by browser and server.
- Hosting (decided 2026-11-06; live since 2026-11-07, T4.3 done): the frontend on Vercel; the API and Postgres 17.6 in Docker on an AWS Lightsail $12 instance behind Caddy; images from GHCR. Locally everything runs in Docker Compose. License MIT.
- Layout: `apps/web` (app; `src/app/globals.css`, `components.json`, `src/components/ui`), `packages/` (shared; T1.2 adds `packages/crypto`), `scripts/`, `config/`, `contracts/`, `signer/`, `arkiv/`, `docs/`, `.design-refs/` (gitignored design guidance for the UI work).
- All dependency versions are pinned exactly (no `^` or `~`); prefer releases at least 2 weeks old.

## Commands
```
docker compose run --rm tools npm install          # node_modules lives in named volumes
docker compose run --rm tools npm run lint         # all workspaces
docker compose run --rm tools npm run typecheck    # scripts (tsc) + apps/web (next typegen + tsc)
docker compose run --rm tools npm run build        # next build
docker compose up -d db api web                    # web http://localhost:3000, api http://localhost:4000, Postgres 127.0.0.1:5432
docker compose run --rm tools curl -s http://api:4000/health
docker compose run --rm tools npm run test -w apps/api   # api tests (need db up)
docker compose logs -f api                         # api runs migrations then `tsx watch`
docker compose run --rm -w /app/apps/web tools npx shadcn@4.22.1 add <component>   # add shadcn components
docker compose stop web
docker compose run --rm tools npx tsc --noEmit     # typecheck
docker compose run --rm tools npx tsx scripts/ens/owner-tx.ts <step> [args]
docker compose up -d signer                        # signing page at http://localhost:5173
docker compose stop signer
```

## Visual checks
Playwright lives in the standalone `e2e/` package (own lockfile, not a workspace; image `mcr.microsoft.com/playwright:v1.64.1-noble`, compose profile `e2e`). Needs `docker compose up -d db api web`. Details: [e2e/README.md](e2e/README.md).
```
docker compose --profile e2e run --rm e2e npm install                                       # first time
docker compose --profile e2e run --rm e2e npx playwright test                               # smoke + a11y (axe) + visual
docker compose --profile e2e run --rm e2e npx playwright test --project=baseline --update-snapshots   # pixel baselines (opt-in)
docker compose --profile e2e run --rm e2e npx playwright screenshot --full-page --viewport-size=390,844 http://web:3000/styleguide artifacts/shot.png
docker compose --profile e2e run --rm --service-ports e2e npx playwright show-report artifacts/report --host 0.0.0.0   # http://127.0.0.1:9323
```
- Screenshots (always saved, review them after UI changes): `e2e/artifacts/screenshots/<route>-<width>.png` at 1440, 1024, 768, 390 (`/` is `home`). A11y summary: `e2e/artifacts/a11y.json`.
- Interactive agent CLI (`playwright-cli open/snapshot/click/screenshot`): see e2e/README.md.

Watch it live (headed Chromium on a virtual display in Docker, viewed through noVNC; needs `docker compose up -d db api web`):
```
docker compose --profile headed up -d browser      # then open http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
docker compose --profile headed exec browser npx playwright test -c playwright.headed.config.ts   # watch the flows (slowMo 200 ms)
docker compose --profile headed exec -d browser npx tsx bin/headed-browse.ts                      # click around yourself (mock wallet injected)
docker compose --profile headed stop browser
```
noVNC has no password; it is published on 127.0.0.1 only. Details: e2e/README.md.

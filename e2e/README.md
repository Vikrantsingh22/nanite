# e2e: Playwright visual and frontend checks

Standalone package (own package.json and lockfile, NOT an npm workspace). Everything runs in Docker.
Pinned: `@playwright/test` 1.64.1, `@axe-core/playwright` 4.14.0, `@playwright/cli` 0.1.22, image `mcr.microsoft.com/playwright:v1.64.1-noble`.
The app must be up: `docker compose up -d db web`.

## Run
```
docker compose --profile e2e run --rm e2e npm install                      # first time / after dep change
docker compose --profile e2e run --rm e2e npx playwright test              # smoke + a11y + visual (default project)
docker compose --profile e2e run --rm e2e npx playwright test --project=baseline --update-snapshots   # create pixel baselines
docker compose --profile e2e run --rm e2e npx playwright test --project=baseline                      # compare to baselines
docker compose --profile e2e run --rm e2e npx playwright test tests/a11y.spec.ts
```
Outputs (gitignored): `artifacts/screenshots/<route>-<width>.png` (always saved, for human review; `/` is `home`), `artifacts/a11y.json`, `artifacts/report/`, `test-results/` (traces on first retry). Baselines live in `tests/__snapshots__/` (committed).
If `/styleguide` returns 404 its tests are marked fixme (skipped with a message), not failed.

## View the HTML report
```
docker compose --profile e2e run --rm --service-ports e2e npx playwright show-report artifacts/report --host 0.0.0.0
```
Open http://127.0.0.1:9323. Or just open `e2e/artifacts/report/index.html` / screenshots from Finder.

## Watch the flows in a headed browser (noVNC)
Compose service `browser` (profile `headed`, `e2e/headed.Dockerfile`: the pinned Playwright image + Xvfb 1440x900, fluxbox, x11vnc, noVNC). The app must be up (`docker compose up -d db api web`). noVNC is published on 127.0.0.1:6080 only and has no password (localhost-bound).
```
docker compose --profile headed up -d browser
# open http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
docker compose --profile headed exec browser npx playwright test -c playwright.headed.config.ts   # watch the flows
docker compose --profile headed exec -d browser npx tsx bin/headed-browse.ts                      # click around yourself
docker compose --profile headed stop browser
```
- `playwright.headed.config.ts`: headed, slowMo 200 ms (`SLOWMO=1000` env to change), 1440x900, 1 worker, no retries/video. Demo order: onboarding (wizard, then the domain choice), domain (own-domain records flow, start-now route, dashboard mail-domain card), agents (add agent, settings), inbox (decrypt, HTML sandbox, OTP). Uses the same mocked wallet and API as the headless suite, which is unchanged.
- The tests connect to a shared headed Chromium started by the container (`bin/headed-server.mjs`, ws://127.0.0.1:9222/pw) so slowMo applies even to specs that set their own `launchOptions`. `nanite.test` is mapped to the web container by Chromium (`--host-resolver-rules`).
- `bin/headed-browse.ts`: maximised headed Chromium on `http://nanite.test:3000` with the mock wallet from `bin/mock-wallet.ts` injected (connect step works without MetaMask); `localhost` is mapped to the api container so the baked-in API URL reaches the real API (not the mocked one). Stays open until the container stops. `BROWSE_URL=... ` overrides the start page.

## Ad-hoc checks
Standard CLI:
```
docker compose --profile e2e run --rm e2e npx playwright screenshot --full-page --viewport-size=390,844 http://web:3000/styleguide artifacts/shot.png
```
Agent CLI (`@playwright/cli`, binary `playwright-cli`): see the "Agent CLI" notes below.

## Agent CLI (`@playwright/cli` 0.1.22, usable)
Always call it through `sh bin/pw-cli.sh <args>` (alias `npm run cli --`). The CLI bundles a Playwright alpha whose browser revision differs from the image, so the wrapper finds the image's Chromium at runtime (`/ms-playwright/chromium-*/chrome-linux*/chrome`, so arm64 and x86 both work) and writes a gitignored `.playwright/cli.config.json`. The browser session lives only inside one container, so chain commands in a single `sh -c`:
```
docker compose --profile e2e run --rm e2e sh -c '
  sh bin/pw-cli.sh open http://web:3000/styleguide &&
  sh bin/pw-cli.sh snapshot &&            # accessibility tree with refs (e1, e2, ...), also saved in .playwright-cli/
  sh bin/pw-cli.sh click e5 &&
  sh bin/pw-cli.sh resize 390 844 &&
  sh bin/pw-cli.sh screenshot --filename=artifacts/adhoc.png &&
  sh bin/pw-cli.sh close'
```
Other commands: `goto`, `fill`, `type`, `hover`, `find <text>`, `eval <js>`, `console`, `network` (see `npx playwright-cli --help`). `snapshot` output is text, so it is cheap to read; use screenshots for visual review.

# Demo 1: the Reddit sign-up agent

Claude Code, as the agent runtime, signs up for Reddit with a Nanite mailbox, reads the verification code from its own inbox over the Nanite MCP, signs in, and brings back the top post of a subreddit. You watch the browser live and solve a CAPTCHA yourself if Reddit shows one.

```
Claude Code (your machine) --HTTP MCP--> Nanite API  http://localhost:4000/mcp   (inbox: wait_for_email, get_latest_otp)
                           --HTTP MCP--> Playwright MCP  http://localhost:8931/mcp --CDP--> headed Chromium in Docker
                                                                                        \--> noVNC http://127.0.0.1:6080
```

Everything except Claude Code itself runs in Docker. Both MCP ports are bound to 127.0.0.1 and have no auth of their own (the Playwright server can drive the browser, so never publish 8931 beyond localhost).

## 1. Prerequisites

- Docker Desktop running, `claude` (Claude Code CLI) installed on your machine.
- The stack up with the dev API that holds user `vikrantsingh` (database `nanite`) and real mail configured in the root `.env` (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SHARED_MAIL_DOMAIN=nanitecom.itsvikrant.tech`, operator and Arkiv keys). Real inbound mail only reaches the agent if the webhook tunnel is live (step 3).

```
docker compose up -d db api web
docker compose run --rm tools curl -s http://api:4000/health        # {"ok":true,"db":"up",...}
```

## 2. Create a dedicated agent (`scout`)

1. Open http://localhost:3000, sign in with your wallet as `vikrantsingh`.
2. Add agent, name `scout`, keep "Nanite holds the key" (hosted MCP only works for that custody). Wait until the status is ready (ENS record and mailbox are created; takes a minute or two).
3. The mailbox is shown on the agent card, `scout.vikrantsingh@nanitecom.itsvikrant.tech`. If you want the agent to also be able to answer mail later, leave the send policy as it is; this demo does not send.
4. Agent settings, Settings (API token): create/rotate the token and copy it. Do not paste it in chat.

Put the token in a local, gitignored file that contains ONLY demo variables (do not source the repo-root `.env`: it holds the operator key, and everything in Claude Code's environment is visible to the agent's shell tool):

```
cd demo
printf 'NANITE_AGENT_TOKEN=' > .env && chmod 600 .env    # then open .env in an editor and paste the token after the =
```

`demo/.env` is gitignored (root rule `.env` plus `demo/**/.env`). `.mcp.json` only contains the placeholder `${NANITE_AGENT_TOKEN}`, which Claude Code expands from its environment (syntax `${VAR}` or `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers`; an unset variable shows a warning in `claude mcp list` and stays literal).

## 3. Make sure the inbound webhook tunnel is live

Resend delivers inbound mail to ONE webhook endpoint, currently a Cloudflare quick tunnel to the `api` service. Quick tunnel URLs change on every restart.

```
docker compose ps tunnel                                    # should be running (container nanite-tunnel)
docker logs nanite-tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare.com' | tail -1     # the current URL
docker compose run --rm tools curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<that-url>/webhooks/resend   # 400/401 = reachable (unsigned), 530/1033 = tunnel dead
```

If it is down or you are unsure which URL Resend has, restart it and point Resend at the new URL:

```
docker compose --profile tunnel up -d --force-recreate tunnel
docker logs nanite-tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare.com' | tail -1
docker compose run --rm tools npx tsx apps/api/scripts/live-resend.ts --webhook-endpoint=https://<new-url>/webhooks/resend
```

Note `docker-compose.yml` forwards the tunnel to `api:4000`, the dev API on host port 4000, which is the one Claude Code talks to. Stop the tunnel after the demo (`docker compose --profile tunnel stop tunnel`): it exposes all API routes.

## 4. Start the headed browser and Playwright MCP

```
docker compose --profile headed up -d --build browser    # first time builds the image (adds @playwright/mcp 0.0.83)
```

The `browser` container runs Xvfb 1440x900, noVNC, one persistent headed Chromium (CDP on 127.0.0.1:9223 inside the container) and `playwright-mcp --cdp-endpoint ... --port 8931`. Check it from Docker:

```
docker compose run --rm tools npx tsx demo/scripts/check-mcp.ts --browse
# [playwright] http://browser:8931/mcp: 25 tools, ...   then navigates to http://web:3000 and prints the snapshot size
```

Open the live view: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale (no password, localhost only). Keep it next to the terminal.

## 5. Run Claude Code

```
cd demo
set -a; . ./.env; set +a          # exports NANITE_AGENT_TOKEN into this shell only
cd reddit
claude mcp list                    # expect: nanite ... Connected, playwright ... Connected
claude
```

On the very first `claude` start in this folder approve the two project servers from `.mcp.json` (until then `claude mcp list` shows "Pending approval (run `claude` to approve)"; `claude mcp reset-project-choices` resets this). Inside the session `/mcp` lists both servers and their tools.

Then type the prompt from [prompt.md](prompt.md) (change the subreddit if you like):

> Sign up for Reddit with your Nanite email address, verify it with the code you receive, sign in, and bring me the top post from r/MachineLearning.

Claude Code reads `demo/reddit/CLAUDE.md` automatically (workflow, CAPTCHA rule, untrusted mail, report format). You approve each tool call, or allow the two servers for the session when you are comfortable.

## 6. What you will see

- In noVNC: the Chromium window opening reddit.com/register, the email typed in, username and password chosen.
- In the terminal: `wait_for_email` calls ("waiting", then a hit), `get_latest_otp` returning the 6-digit code, the code typed into the page.
- In the app (http://localhost:3000): the verification mail arrives in `scout`'s inbox as an `otp` mail (lifetime 5 minutes).
- At the end: the report (account name, top post title/author/score/summary).
- If a CAPTCHA appears the agent stops and asks you; click it in the noVNC window, tell Claude "done".

## 7. Fallbacks

- Reddit rejects the mail domain ("email not allowed", or no mail ever arrives): do not try other addresses. Use the same flow against a site that accepts it, or demonstrate the inbox half alone: sign up on any site that accepts the address, or send a test mail from Gmail to the `scout` mailbox and ask Claude "wait for the next mail and tell me the OTP in it".
- Reddit changed its form: the agent works from snapshots, so small changes are fine; if it loops, interrupt and tell it the next step by hand.
- No code arrives within 2 minutes: check the webhook tunnel (step 3), the Resend dashboard (inbound events) and `docker compose logs api | tail`. Daily quota is 90 mails (sent + received).
- Playwright MCP session is stuck: `docker compose --profile headed restart browser` (Chromium profile is in `/tmp` inside the container, so this also signs out of everything).
- Offline rehearsal of the tools without Reddit: `claude` then ask it to "open http://web:3000 in the browser and describe it, then list your inbox".

## 8. Reset

```
docker compose --profile headed restart browser     # fresh Chromium profile: Reddit session gone
docker compose --profile headed stop browser
docker compose --profile tunnel stop tunnel
rm demo/.env                                         # forget the token; rotate it in the app (agent settings) to revoke it
```

Delete the Reddit account yourself at reddit.com (Settings, Account) if you do not want to keep it. Rotate or delete the `scout` token/agent in the app afterwards.

## Notes

- This demo makes ONE real sign-up on Reddit. Reddit's terms and rate limits apply; the agent is told not to bypass anything and not to retry with other identities.
- The prompt and `CLAUDE.md` forbid CAPTCHA solving; the human in noVNC is the only one who may.

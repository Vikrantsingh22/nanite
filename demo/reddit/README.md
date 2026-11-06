# Demo 1: the Reddit sign-up agent

Claude Code, as the agent runtime, signs up for Reddit with a Nanite mailbox, reads the verification code from its own inbox over the Nanite MCP, signs in, and brings back the top post of a subreddit. You watch the browser live and solve a CAPTCHA yourself if Reddit shows one.

```
Claude Code (your machine) --HTTP MCP--> Nanite API  https://api.nanite.itsvikrant.tech/mcp   (inbox: wait_for_email, get_latest_otp)
                           --HTTP MCP--> Playwright MCP  http://localhost:8931/mcp --CDP--> headed Chromium in Docker
                                                                                        \--> noVNC http://127.0.0.1:6080
```

The Nanite side is the live production deployment (web app https://nanite.itsvikrant.tech, API https://api.nanite.itsvikrant.tech). The Resend webhook already points at production, so no tunnel is needed. Only the browser runs locally in Docker. The Playwright MCP port is bound to 127.0.0.1 and has no auth of its own (it can drive the browser), so never publish 8931 beyond localhost.

## 1. Prerequisites

- Docker Desktop running, `claude` (Claude Code CLI) installed on your machine.
- No local API, database or tunnel is needed.

## 2. Create a dedicated agent (`scout`)

1. Open https://nanite.itsvikrant.tech and sign in with your wallet.
2. Add agent, name `scout`, keep "Nanite holds the key" (hosted MCP only works for that custody). Wait until the status is ready (ENS record and mailbox are created; takes a minute or two).
3. The mailbox is shown on the agent card, `scout.<username>@<shared mail domain>`. This demo does not send mail.
4. Agent settings, Settings (API token): create/rotate the token and copy it. Do not paste it in chat.

Write the token into a local, gitignored file that contains ONLY demo variables (do not source the repo-root `.env`: it holds the operator key, and everything in Claude Code's environment is visible to the agent's shell tool). The `read -rs` keeps the token out of your shell history and off the screen (zsh syntax; in bash use `read -rsp "scout token: " T`):

```
cd demo
read -rs "T?scout token: "; echo
sed -i '' '/^NANITE_AGENT_TOKEN=/d' .env 2>/dev/null; printf 'NANITE_AGENT_TOKEN=%s\n' "$T" >> .env && chmod 600 .env; unset T   # appends; keeps vault's NANITE_SELF_AGENT_TOKEN line
```

`demo/.env` is gitignored (root rule `.env` plus `demo/**/.env`). Paste the token into the prompt; never copy it from chat.

## 3. Register the Nanite MCP server in Claude Code

Why not rely on `.mcp.json` alone: it holds the placeholder `${NANITE_AGENT_TOKEN}` (Claude Code expands `${VAR}` in `url` and `headers` from its environment), but the project-scoped server stays "Pending approval" until you approve it in an interactive `claude` session, and it only works if the variable is exported in the shell that starts `claude`. In the 2026-11-07 run `claude mcp list` did not show it. Use an explicit add instead.

```
cd demo
set -a; . ./.env; set +a          # exports NANITE_AGENT_TOKEN into this shell only
cd reddit
claude mcp add --transport http --scope local nanite https://api.nanite.itsvikrant.tech/mcp \
  --header "Authorization: Bearer ${NANITE_AGENT_TOKEN}"
claude mcp add --transport http --scope local playwright http://localhost:8931/mcp
```

Plainly: your shell expands `${NANITE_AGENT_TOKEN}` before Claude Code runs (the docs do not describe any expansion at add time), so the literal token is stored in `~/.claude.json` under this project's path (`--scope local`, the default). That file is in your home directory, not in the repo, so nothing committed contains the token. It is the only robust variant; the committed `.mcp.json` keeps the placeholder only. A local-scope server takes precedence over a same-named project one. Remove it after the demo: `claude mcp remove nanite` (and rotate the token in the app).

## 4. Start the headed browser and Playwright MCP

```
docker compose --profile headed up -d --build browser    # first time builds the image (adds @playwright/mcp 0.0.83)
```

The `browser` container runs Xvfb 1440x900, noVNC, one persistent headed Chromium (CDP on 127.0.0.1:9223 inside the container) and `playwright-mcp --cdp-endpoint ... --port 8931`. Check it from Docker:

```
docker compose run --rm tools npx tsx demo/scripts/check-mcp.ts --browse
```

Open the live view: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale (no password, localhost only). Keep it next to the terminal.

## 5. Run Claude Code

```
cd demo/reddit
claude mcp list                    # expect: nanite ... Connected, playwright ... Connected
claude
```

Both servers must show Connected before you continue (a 401 on `nanite` means a wrong or rotated token: re-run the `claude mcp add` from step 3). Inside the session `/mcp` lists both servers and their tools. If you rely on the project `.mcp.json` instead of the explicit add, approve the servers on the first `claude` start (`claude mcp reset-project-choices` resets this) and export the token first.

Then type the prompt from [prompt.md](prompt.md) (change the subreddit if you like):

> Sign up for Reddit with your Nanite email address, verify it with the code you receive, sign in, and bring me the top post from r/MachineLearning.

Claude Code reads `demo/reddit/CLAUDE.md` automatically (workflow, CAPTCHA rule, untrusted mail, report format). You approve each tool call, or allow the two servers for the session when you are comfortable.

## 6. What you will see

- In noVNC: the Chromium window opening reddit.com/register, the email typed in, username and password chosen.
- In the terminal: `wait_for_email` calls ("waiting", then a hit), `get_latest_otp` returning the 6-digit code, the code typed into the page.
- In the app (https://nanite.itsvikrant.tech): the verification mail arrives in `scout`'s inbox as an `otp` mail (lifetime 5 minutes).
- At the end: the report (account name, top post title/author/score/summary).
- If a CAPTCHA appears the agent stops and asks you; click it in the noVNC window, tell Claude "done".

## 7. Fallbacks

- Reddit rejects the mail domain ("email not allowed", or no mail ever arrives): do not try other addresses. Use the same flow against a site that accepts it, or demonstrate the inbox half alone: sign up on any site that accepts the address, or send a test mail from Gmail to the `scout` mailbox and ask Claude "wait for the next mail and tell me the OTP in it".
- Reddit changed its form: the agent works from snapshots, so small changes are fine; if it loops, interrupt and tell it the next step by hand.
- No code arrives within 2 minutes: check the Resend dashboard (inbound events) and `curl -s https://api.nanite.itsvikrant.tech/health`. Daily quota is 90 mails (sent + received).
- Playwright MCP session is stuck: `docker compose --profile headed restart browser` (Chromium profile is in `/tmp` inside the container, so this also signs out of everything).
- Rehearsal of the tools without Reddit: `claude` then ask it to "open https://nanite.itsvikrant.tech in the browser and describe it, then list your inbox".

## 8. Reset

```
docker compose --profile headed restart browser     # fresh Chromium profile: Reddit session gone
docker compose --profile headed stop browser
rm demo/.env                                         # forget the token; rotate it in the app (agent settings) to revoke it
claude mcp remove nanite                             # drops the token stored in ~/.claude.json
```

Delete the Reddit account yourself at reddit.com (Settings, Account) if you do not want to keep it. Rotate or delete the `scout` token/agent in the app afterwards.

## Notes

- This demo makes ONE real sign-up on Reddit. Reddit's terms and rate limits apply; the agent is told not to bypass anything and not to retry with other identities.
- The prompt and `CLAUDE.md` forbid CAPTCHA solving; the human in noVNC is the only one who may.

## Recording tips

- Record the screen with noVNC (http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale) beside the terminal; 1440x900 fits a 16:10 capture.
- Rehearse once first: Reddit may show a CAPTCHA at random, and you only get one clean sign-up per address.
- Hide the token: do not run `claude mcp get nanite` or `cat ~/.claude.json` on camera.
- Say the CAPTCHA rule aloud before you start: the agent stops and the human clicks.

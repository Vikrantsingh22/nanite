# Demo kits (Claude Code as the agent runtime)

Everything runs in Docker except Claude Code itself. Tokens and keys live only in the gitignored `demo/.env` (and the Docker volume `kit_keys`); the committed `.mcp.json` files use `${VAR}` placeholders.

| Demo | Summary |
| --- | --- |
| [reddit/](reddit/README.md) | An autonomous agent signs up for Reddit with its Nanite mailbox, reads the verification code over the hosted Nanite MCP, signs in and reports the top post of a subreddit.<br>Browser: the headed Chromium from the `browser` compose service (watch and solve a CAPTCHA in noVNC), driven by Playwright MCP over HTTP on 127.0.0.1:8931.<br>Hard rules in `CLAUDE.md`: one account, read only, Nanite MCP is the only email path, never solve a CAPTCHA. |
| [self-hosted/](self-hosted/README.md) | A self-hosted agent: keys generated in a container into a Docker volume stand in for the user's machine, mounted read-only into the stdio Nanite kit that Claude Code launches via `docker compose run -i -T kit`.<br>Claude reads the latest mail (decrypted locally), summarises it and replies in the thread; the kit signs the reply locally.<br>You prove it: API answers 409 self_custody, Arkiv holds ciphertext only, the Gmail reply verifies against ENS and a tampered copy fails. |

Helpers: `scripts/check-mcp.ts` (is Playwright MCP / the Nanite hosted MCP reachable, run in the tools container), `scripts/prove-self-custody.ts` (proof steps 1 and 2 of demo 2), `scripts/issue-token.ts` (validation only: issues a 15-minute agent token from the database; do not paste its output anywhere).

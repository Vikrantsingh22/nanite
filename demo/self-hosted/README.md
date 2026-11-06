# Demo 2: self-hosted agent, decrypt and sign on your own machine

Claude Code drives an agent whose private keys exist only in a key file on "the user's machine" (here: a Docker volume mounted read-only into the local stdio Nanite MCP kit). Nanite stores and serves ciphertext for this agent and cannot read its mail; the kit decrypts locally and signs replies locally. You then prove it three ways.

```
Gmail --> Resend --> Nanite API --> Arkiv (ciphertext only)
                         ^ ?raw=1 (ciphertext)           ^ signed send (v3 signature, checked against ENS nanite.signer)
Claude Code --stdio--> docker compose run -i -T kit  [ /keys/agent-key.json (ro) : decrypt + sign here ]
```

## 1. Prerequisites

- A user and mail domain on production (https://nanite.itsvikrant.tech; the Resend webhook already points at https://api.nanite.itsvikrant.tech, so no tunnel), `claude` installed. For a local dev stack instead, run `docker compose up -d db api web` and use the Cloudflare tunnel steps in [docs/resend-integration.md](../../docs/resend-integration.md).
- `docker compose config -q` passes (it declares the `kit` and `kit-keygen` services, profile `kit`, and the volume `kit_keys`).

## 2. Generate the keys on "your machine"

```
docker compose --profile kit run --rm kit-keygen
```

This runs `nanite-mcp keygen --out /keys` in a container and writes `agent-key.json` (mode 600) into the Docker volume `nanite-email_kit_keys`. It prints only two PUBLIC values: the encryption public key and the signer address. Copy both. The private keys are never printed and are not in the repo tree.

(Alternative: a gitignored folder instead of the volume. Generate with `docker compose run --rm -v "$PWD/demo/self-hosted/keys:/keys" tools npx tsx packages/mcp/src/bin.ts keygen --out /keys` and export `KIT_KEYS_DIR=$PWD/demo/self-hosted/keys` before starting Claude Code. `demo/**/keys/` is gitignored.)

## 3. Register the agent in the app

1. https://nanite.itsvikrant.tech, signed in with your wallet. Add agent, name e.g. `vault`.
2. Choose "Hold the key yourself (self-hosted)" and paste the encryption public key and the signer address. Create.
3. Wait until the agent is ready; the create job publishes the signer address as ENS record `nanite.signer`. Note the mailbox (`vault.vikrantsingh@nanitecom.itsvikrant.tech`) and the ENS name.
4. Send policy: the agent can only reply to allowed recipients (default is reply-only, which is what this demo needs: it answers someone who wrote to it). Mail lifetime is 2 days by default.
5. Copy the agent token (agent settings). Put it in the demo-only env file `demo/.env` (never in chat, never the repo-root `.env`). Type the token into a hidden prompt instead of copying a command from chat (that can overwrite the clipboard):

```
cd demo
read -rs "T?vault token: "; echo
printf 'NANITE_SELF_AGENT_TOKEN=%s\nKIT_API_URL=https://api.nanite.itsvikrant.tech\n' "$T" > .env && chmod 600 .env; unset T
```

`KIT_API_URL` is where the agent lives. Production `https://api.nanite.itsvikrant.tech` is the example above; for the local dev stack use `KIT_API_URL=http://api:4000` instead.

## 4. Send it a mail from Gmail

From your Gmail address to `vault.vikrantsingh@nanitecom.itsvikrant.tech`, any short subject and body. Pick a distinctive phrase you will search for later in step 6, for example "pomegranate-7421". It shows up in the app as a mail that the server cannot decrypt (self-hosted agents are not readable in the web inbox either).

## 5. Run Claude Code

```
cd demo/self-hosted
claude mcp list          # nanite: docker compose --env-file ../.env ... Connected
claude
```

Approve the project server from `.mcp.json` on first start. If Claude Code does not list it, register it yourself:

```
claude mcp add nanite --scope local -- docker compose --env-file ../.env -f ../../docker-compose.yml run --rm -i -T kit
```

Note: `--scope local` servers are stored per repository, so only one `nanite` server can exist at a time. To switch demos, run `claude mcp remove nanite -s local` and then add the other one:

```
# reddit demo (hosted)
claude mcp add --transport http --scope local nanite https://api.nanite.itsvikrant.tech/mcp \
  --header "Authorization: Bearer ${NANITE_AGENT_TOKEN}"

# self-hosted demo (local kit)
claude mcp add nanite --scope local -- docker compose --env-file ../.env -f ../../docker-compose.yml run --rm -i -T kit
```

The `.mcp.json` launches the kit like this (`--env-file ../.env` loads `demo/.env`, so no `set -a` is needed):

```
docker compose --env-file ../.env -f ../../docker-compose.yml run --rm -i -T kit
  kit = node:22, repo mounted, key volume mounted READ-ONLY at /keys, NANITE_AGENT_KEY_FILE=/keys/agent-key.json,
        NANITE_API_URL=${KIT_API_URL:-http://api:4000}, NANITE_AGENT_TOKEN=${NANITE_SELF_AGENT_TOKEN}
```

`-i -T` keeps stdin open and disables the pseudo-TTY, which MCP stdio needs (only JSON-RPC may reach stdout; compose's progress lines go to stderr). Type the prompt from [prompt.md](prompt.md):

> Read my latest email, summarise it in three sentences, then reply in the same thread with a short, polite answer.

Claude calls `list_inbox`, `get_email` (decrypted inside the container; the sender is `untrusted.from`), then `send_email` with `inReplyTo`; the kit signs the mail and the API verifies the signature against ENS before sending. Gmail shows the reply threaded under your mail. Write down the `entityKey` Claude reports for the mail it read (or take it from `list_inbox`).

## 6. Prove it

Run these from the repo root. `NEEDLE` is your distinctive phrase from step 4.

**(1) and (2): the API refuses plaintext and Arkiv holds ciphertext only**

```
set -a; . demo/.env; set +a
docker compose run --rm -e NANITE_AGENT_TOKEN="$NANITE_SELF_AGENT_TOKEN" -e API_URL=https://api.nanite.itsvikrant.tech tools \
  npx tsx demo/scripts/prove-self-custody.ts <entityKey> --needle="pomegranate-7421"
```

Expected: `GET /v1/emails/<key>` answers `409 self_custody`; `?raw=1` returns only `entityKey, type, receivedAt, threadId, expiresAtBlock, agentKeyId, keyIds, ciphertext, wrappedKeys, nonce, content_trust`; the needle is found nowhere in the API responses nor in the raw Arkiv entity (a direct `arkiv_query` selecting every stored attribute); the explorer link shows the same encrypted attributes. A mail the kit reads, by contrast, contains the needle: ask Claude to `get_email` it and search.

By hand, the 409 alone: `docker compose run --rm tools curl -s -H "Authorization: Bearer $NANITE_SELF_AGENT_TOKEN" https://api.nanite.itsvikrant.tech/v1/emails/<entityKey>` (local stack: `http://api:4000`) (after `set -a; . demo/.env; set +a`).

Also: `curl` to the hosted MCP with this token answers `403 self_custody` (no decryption on the server, by design).

**(3): the reply in Gmail verifies against ENS, a tampered copy fails**

1. In Gmail open Claude's reply, three dots, "Show original". Copy these headers: `X-Nanite-Agent`, `X-Nanite-Date`, `X-Nanite-Signature`, `X-Nanite-Sig-Version` (3) and `X-Nanite-Message-Id`.
2. Create `demo/self-hosted/mail.json` (gitignored, it contains the mail text):

```json
{
  "headers": {
    "X-Nanite-Agent": "vault.vikrantsingh.nanitecom.eth",
    "X-Nanite-Date": "<Date header value>",
    "X-Nanite-Signature": "0x...",
    "X-Nanite-Sig-Version": "3",
    "X-Nanite-Message-Id": "<uuid@nanitecom.itsvikrant.tech>"
  },
  "from": "vault.vikrantsingh@nanitecom.itsvikrant.tech",
  "to": "<your gmail>",
  "subject": "<exact subject>",
  "body": "<exact body text as sent>"
}
```

3. Verify (reads LIVE ENS on Sepolia):

```
docker compose run --rm tools npx tsx apps/api/scripts/verify-mail-signature.ts demo/self-hosted/mail.json
# {"valid":true,"agent":"vault.vikrantsingh.nanitecom.eth","signer":"0x<the signer you pasted in step 3>","reason":"ok"}   exit 0
```

4. Tamper with one word of `subject` or `body` in a copy (`mail-tampered.json`) and run it again: `{"valid":false,...,"reason":"signer_mismatch"}`, exit 1.
5. Compare the `signer` printed with the signer address from keygen: they match, and ENS (text record `nanite.signer` of the agent name) is the only place that address comes from.

## What this shows, honestly

- Inbound mail is encrypted to a key only the key file holds; Nanite, Arkiv and Resend's stored copy of the encrypted entity cannot read it. (Resend and the sender's mail provider see the inbound mail in transit, as for any email.)
- Outbound plain text passes through Nanite and Resend to be delivered, and the encrypted sent copy is written from it. What is local and verifiable is the signature: only the key file can produce it.
- Anyone with the key volume can read the agent's mail and send as it; treat it like an SSH key. The compose volume stands in for the user's machine; in real use it is `~/.nanite/agent-key.json` and `npx nanite-mcp`.

## Scripted rehearsals and reuse

- [apps/api/scripts/live-selfhosted-part1.ts](../../apps/api/scripts/live-selfhosted-part1.ts) creates a self-hosted agent from a key file without the UI (test wallet, database `nanite_live`); [part2.ts](../../apps/api/scripts/live-selfhosted-part2.ts) reads, replies and verifies as one script (both hardcode the agent `kit` and API `http://nanite-api-live:4000`; see apps/api/LIVE-E2E.md).
- The existing `kit` agent lives on `nanite-api-live` (database `nanite_live`, user `nanitedemo`, not published on the host). Its key file is in the gitignored `apps/api/.live-selfhosted/`. To rehearse the stdio launch without registering anything: `export KIT_KEYS_DIR=$PWD/apps/api/.live-selfhosted KIT_API_URL=http://nanite-api-live:4000 NANITE_SELF_AGENT_TOKEN=$(cat apps/api/.live-selfhosted/token)` then `claude mcp list` in this folder. Do not use it for the live demo: its mail has expired and the agent's send policy is an allowlist.
- Quick protocol check without Claude Code: pipe `initialize` and `tools/list` into `docker compose run --rm -i -T kit` (see the validation note in the task log).

## Reset

```
rm demo/.env demo/self-hosted/mail*.json
docker volume rm nanite-email_kit_keys            # destroys the key: the agent's mail can never be read again
```

Revoke the `vault` agent in the app afterwards.

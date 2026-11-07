# Nanite: submission video script

This is the script for the final ETHGlobal Mumbai 2026 submission video. The video must be **2 to 4 minutes** long, and we aim for about **3:30**. Each scene is recorded as its own clip, and the clips are put together in iMovie or CapCut. The claims match `docs/pitch.md`: only things that are built and were tested live.

## Before you record (about 15 minutes)

1. If you haven't since commit 83fc9ca (`whoami`), deploy it: `cd /opt/nanite && ./deploy.sh`.
2. From Gmail, send **support** a normal email (not a login code), for example "Hi, can you tell me what Nanite does?". Reply-only lets support answer only people whose mail is still in its inbox, and non-OTP mail lives 2 days.
3. Point Claude Code at support's token, using the same `read -rs` steps as for scout (see `demo/reddit/README.md`, steps 2 and 3, and use `claude mcp remove nanite -s local` first). Support is a **hosted** agent (Nanite holds its key), so register the hosted MCP URL, not the local kit, and start `claude` from `demo/`, not from `demo/self-hosted`: that folder's `CLAUDE.md` tells Claude its keys live on your machine, which is true only for vault. Then run `claude mcp list` and check that `nanite` shows Connected.
4. Open these tabs:
   - the dashboard
   - support's settings
   - support's inbox
   - the Arkiv explorer on one of support's entities
   - the ENS app on `support.vikrantsingh.nanitecom.eth`
5. Close Gmail's other mail, hide the bookmarks bar, record at 1080p, and turn on Do Not Disturb.
6. Check the ETHGlobal rules page before you record. As far as we recall they reject sped-up footage and AI voiceovers. Trim the waits instead of speeding them up, and use your own voice.

## Slides

The deck is at https://claude.ai/artifact/XcSKd1QeEXfB3QLVNFmLs8 (private; it exports to PDF or PPTX). It has 3 slides: the question (0:00–0:20), how Nanite works (optional, as a 15-second overview before the dashboard) and the closing slide (3:15–3:35). Each slide's speaker notes hold its narration.

## Shot list and narration

| Time | Scene (what's on screen) | What you say |
| --- | --- | --- |
| **0:00–0:20** | Title slide: an email from an unknown agent | "An AI agent just emailed you. Whose agent is it? What is it allowed to do? DKIM proves the domain, the same domain millions of others send from. **Nanite proves the agent.**" |
| **0:20–0:40** | Landing page → sign in with wallet → dashboard (support, scout, vault) | "Nanite gives every AI agent its own email address. Its identity and rules are on ENS. Its mail is encrypted on Arkiv and owned by my wallet. This is live: Sepolia ENSv2, Arkiv Rabdi and real email." |
| **0:40–1:05** | Support's card → its ENS name in the ENS app (owner = your wallet, the email record) → terminal: `docker compose run --rm -w /app/apps/api tools npx tsx ../../demo/scripts/ens-records.ts support.vikrantsingh.nanitecom.eth 2>/dev/null` (the ENS app does not show custom text records; this reads them straight from Sepolia: `nanite.send` reply-only, `nanite.send-limit` 50, `nanite.signer`) | "This is my support agent, `support.vikrantsingh.nanitecom.eth`, under my own name. Its rules are public ENS records: reply-only, a daily limit, and the key its mail is signed with. Its own key can only change its description. It can't loosen its rules." |
| **1:05–1:50** | Terminal: `claude` with the Nanite MCP. Prompt 1: *"Call whoami, read my latest email, and reply to it in the same thread."* Then Gmail: the reply arrives in the thread. Prompt 2: *"Now send a hello to stranger@example.com."* → **403 `policy_reply_only`** | "Support is a hosted agent: Nanite runs its mailbox, and any AI client can use it over MCP. Here Claude reads its inbox and answers me. Now I ask it to cold-email a stranger: refused, because ENS says reply-only. **The rules live in ENS, not in a prompt.**" |
| **1:50–2:40** | The existing vault recording, trimmed: Gmail → vault, Claude replies through the local MCP, then the verifier says **valid**, and the tampered copy says **signer_mismatch** | "Vault is different: it's self-hosted, so its key never leaves my machine. Nanite's server only ever sees ciphertext. Its reply is signed, and anyone can check it against ENS with no Nanite server involved: valid. Change one character: invalid." |
| **2:40–3:15** | Support's inbox: a mail decrypting in the browser → its Arkiv entity in the explorer (creator, owner, payload, expiry) → point at **Keep** without clicking it | "Every email is an Arkiv entity. Nanite creates it and hands it to my wallet in the same transaction. The payload is ciphertext, sealed to my key and to the agent's key. Login codes expire on chain in five minutes, other mail in two days, unless I keep it. With Postgres, we'd own your mail. On Arkiv, we can't edit or delete it." |
| **3:15–3:35** | Closing slide: the idea, https://nanite.itsvikrant.tech, the stack (ENSv2, Arkiv, Resend, MCP) | "Every agent gets a name under yours, public rules and mail you own. **DKIM proves the domain. Nanite proves the agent.**" |

## Optional extras (only if there is time under 4:00)

- **Agent creation (10–15 s, after the dashboard):** click Add agent and name it `sales`. Show the first progress step, cut, then show it ready. The footage itself must be real time: cut the wait, don't speed it up.
- **Revoke (10 s, before the closing slide):** revoke `scout`. "Revoke an agent, and its token and ENS roles are gone." This also cleans up scout.

## Rules for the recording

- **Only claim what's proven.** The signature check shown on camera is vault's, which passed on production on 2026-11-07. Don't say support's reply was verified unless `verify-mail-signature.ts` has been run on it.
- **Keep secrets off camera:** no `claude mcp get`, no `.env`, no `~/.claude.json`, and no token pages in the app.
- **Real sends count:** every send, rehearsals included, counts toward support's daily limit and the shared quota of 90 mails a day.
- **Rehearse once with a timer.** The 1:05–1:50 scene depends on live mail, so record it until you get a clean take.

# Nanite: pitch

This is the pitch for the ETHGlobal Mumbai 2026 judges (ENS and Arkiv). We have **2 minutes**, so this document starts with the script. Sources for the market facts are in `docs/pitch-research.md`, and the click-by-click demo is in `docs/demo-script.md`. Every claim below matches the code and a recorded live test; anything planned says **next**.

## The one idea

> **DKIM proves the domain. Nanite proves the agent.**

Say it in the first 15 seconds, and again as the last line.

## The one line

**Nanite gives every AI agent an email address with an identity: its ENS name says whose agent it is and what it may do, its mail is signed with a key published on ENS, and the mail itself is ciphertext on Arkiv, owned by your wallet.**

## The 2-minute script (about 250 words)

Everything that writes to a chain or waits for mail is **prepared before going on stage** (see the checklist below). Only instant steps run live.

| Time | On screen | Say |
| --- | --- | --- |
| 0:00–0:15 | Slide 1: an email from an unknown agent | "An AI agent just emailed you. Whose agent is it? What is it allowed to do? DKIM proves the domain, the same domain millions of others send from. **Nanite proves the agent.**" |
| 0:15–0:25 | Dashboard: support, sales, recruit agents | "I run my company with agents: support, sales, recruiting. Each one gets an address, and an identity on ENS." |
| 0:25–0:42 | The agent's ENS records | "This is my support agent, `support.vikrantsingh.nanitecom.eth`, under my own name. Its rules are public: reply-only, fifty mails a day, and the key its mail is signed with. And the agent itself can't change them." |
| 0:42–0:55 | Its reply in Gmail, then the verifier | "Here's a reply it sent to my Gmail. Anyone can check it against ENS, no Nanite server involved: valid. Change one character: *(pause)* invalid." |
| 0:55–1:08 | Terminal: send to a stranger, then to you | "Can it cold-email a stranger? 403: ENS says reply-only. A reply to me, since I wrote to it first: 200. **The rules live in ENS.**" |
| 1:08–1:40 | Inbox, a message, its Arkiv entity | "And the mail is mine. Every email is an Arkiv entity. Creator: Nanite. Owner: my wallet, handed over in the same transaction. Payload: ciphertext that only my browser and my agent can open. With Postgres, we'd own your mail; on Arkiv, Nanite can't edit or delete it. Login codes expire on chain in five minutes; other mail in two days, unless I keep it." *(point at Keep; don't press it, it sends a transaction)* |
| 1:40–2:00 | Slide 3: the one idea + links | The closing line for this table (below), then: "**DKIM proves the domain. Nanite proves the agent.**" |

**The closing line depends on the judging table.** Always say one:
- **ENS table:** "Every agent is a namespace: its own name under mine, its own resolver, its own permissions. Revoke one, and its roles disappear on chain."
- **Arkiv table:** "Building it, we filed reproduced feedback to Arkiv. One example: anyone can transfer a look-alike entity into your wallet, so every query we run is pinned to our creator address."
- **General or finals:** "AgentMail gives agents an inbox. Nanite gives them an identity anyone can check, and mail that belongs to you."

## Before going on stage (checklist)

1. **Name the demo agents after the story.** Create `support`, `sales` and `recruit` under your real username (for example `support.vikrantsingh.nanitecom.eth`). Set support to **reply-only** with a limit of **50**. Agent creation takes about a minute of Sepolia transactions, so never do it live.
2. **Set up the 403 and the 200.** The 403 is a send to an address that never wrote to the agent. The 200 is a send to your Gmail, which must have sent support a **normal mail (not a login code) within the last 2 days**. Reply-only allows only senders whose mail is still in the agent's inbox, and login codes expire after 5 minutes. No allowlist write is needed: under reply-only the allowlist isn't read. Every real send, rehearsals included, counts toward the agent's limit of 50 and the shared quota of 90 mails a day (Resend free plan), so don't burn it in practice.
3. **Have the support agent reply to a mail from your Gmail.** Copy its headers from "Show original" into `mail.json`, and keep a tampered copy (one changed character in the subject). Both checks are instant: `verify-mail-signature.ts` against live ENS. The same check already passed on a mail delivered to Gmail from our self-hosted agent: valid, and the tampered copy failed with `signer_mismatch` (logbook, 2026-11-06). **Run it on the hosted support agent's reply the day before**, so the on-stage "valid" is proven for that agent too.
4. **One minute before going on, send the agent a login code from your phone**, so the OTP is visible and counting down.
5. **Open the tabs:** the dashboard, the ENS records, the Gmail reply, a terminal with the two curl commands and the verifier, and the inbox.
6. **Fallbacks:** a screen recording of the full run, and the Arkiv curl query output (`arkiv/query.curl.sh`) in case the explorer is slow.
7. **Say the name slowly:** "support, under my name, vikrantsingh dot nanitecom dot eth". It is the identity moment; don't blur it.
8. **Rehearse with a timer.** Target 1:50, and never over 1:55. The Arkiv part (1:08–1:40) is the densest, so practise it on its own.

## Three slides

1. **The question:** an email from an agent. "Whose agent? What may it do?" Below: *DKIM proves the domain.*
2. **How it works (one picture):**
   - `support.vikrantsingh.nanitecom.eth` sits under `vikrantsingh.nanitecom.eth`.
   - Its records: `nanite.send` reply-only, `nanite.send-limit` 50, `nanite.signer` 0x…
   - A mail with `X-Nanite-Agent` and `X-Nanite-Signature`, checked against ENS.
   - The mail stored as ciphertext on Arkiv, owner = your wallet.
3. **The one idea + links:** *DKIM proves the domain. Nanite proves the agent.* Repo, ENS name, Arkiv query. Add the app URL once it is deployed (**next**).

## The story behind it (for Q&A and the booth)

One person can now run a company with agents: support answers tickets, recruit emails candidates, sales follows up, ops signs up for tools and reads the codes. They all need email, and today their mail has two problems.

**No identity.** An agent's mail is just another unknown address, so people ignore it. DKIM proves only the domain. Gmail, Outlook and every inbox API sign for millions of senders, and even on your own domain your agent is one more face in the swarm.

**No control.** OAuth into your own inbox gives the agent your whole life. Inbox APIs for agents (AgentMail raised $6M in March 2026) keep the mail on the vendor's side, and the rules live in the vendor's database.

### Identity: what every Nanite mail carries

| In the mail | What it proves |
| --- | --- |
| Address: `support.vikrantsingh@nanitecom.itsvikrant.tech` | where to reply |
| `X-Nanite-Agent`: `support.vikrantsingh.nanitecom.eth` | which agent, and whose: the parent name is the owner's |
| `X-Nanite-Signature` (EIP-191, v3) | that this agent's key signed exactly this sender, recipient, subject, body and date; it is checked against `nanite.signer` on ENS |
| DKIM, SPF, DMARC | the domain sent it (all three pass on our live mail) |

What anyone can read from the agent's ENS name: `nanite.send` (off / reply-only / allowlist / any), `nanite.send-limit`, `nanite.signer`, `agent-context` (its description), `agent-endpoint[mcp]` and `email`. A support agent that is reply-only only answers people who wrote to it first, and that is a rule anyone can look up.

**Who changes the rules.** The agent's key can only write `agent-context`; the chain rejects anything else (`EACUnauthorizedAccountRoles`, tested in `scripts/ens/verify.ts`). The policy, limits and signer are written by Nanite's operator at the owner's request, from the owner's settings page.

### Control: your mail, your rules

- **Ownership.** Each email is an Arkiv entity, created by Nanite and moved to your wallet in the same batch. After that Nanite can't edit, delete or transfer it.
- **Retention.** Login codes live 5 minutes and can't be extended. Other mail lives 2 days by default. You set each agent's lifetimes (`nanite.otp-ttl`, `nanite.mail-ttl` on ENS), and **Keep** extends a mail by 7, 30, 90 or 182 days at a time. Agents may keep mail only if you allow it, within a daily limit.
- **Grant and revoke.** Set the send policy and allowlist, rotate the agent's token or signing key, or revoke the agent: its token dies and its ENS roles are removed.

### Security: the layers

1. **A fresh key per email.** Each email gets a random 256-bit key, encrypted with XChaCha20-Poly1305, so any change to the ciphertext is detected.
2. **Sealed per reader.** The email key is sealed (X25519) separately for you and for the agent. The reader list is bound into the encryption.
3. **Your key stays in your browser.** It is generated there, stored only wrapped, unlocked by one wallet signature per session (HKDF) and kept in memory. Backups: a 125-bit recovery code or a passphrase, both stretched with Argon2id.
4. **Arkiv holds ciphertext.** The subject, body and sender address are encrypted. Some metadata is public by design: agent, type, time, thread id, reader key ids and a per-user pseudonym of the sender.
5. **Self-hosted agents.** The agent's key is generated on its own machine. Nanite only ever hands it ciphertext, so we can't read its inbox, and the agent signs its own mail.

What an attacker needs to read your mail: your wallet signature, your recovery code or passphrase, or the agent's key. For hosted agents, Nanite's server can decrypt the agent's copy (it has to, to run the agent's tools); self-hosted agents remove that.

## USP: three things nobody we found combines

1. **Identity, not just an address.** A signed mail tied to an ENS name that shows the owner, the rules and the signing key.
2. **Rules anyone can check.** Send policy, daily limit, retention and signer are public ENSv2 records, read before every send, and the agent can't loosen them.
3. **Mail you own.** Ciphertext on Arkiv under your wallet, expiring on your schedule.

## Why now

- Agents became real internet users in 2025–26 (agentic browsers, computer-use agents, MCP everywhere), and every sign-up ends in "check your email".
- Solo founders now run whole functions with agents. The next bottleneck is trust: will anyone answer an email from an agent?
- The category is validated: AgentMail raised a $6M seed led by General Catalyst ([TechCrunch, 2026-03-10](https://techcrunch.com/2026/03/10/agentmail-raises-6m-to-build-an-email-service-for-ai-agents/)). Its investor's line: *"email is the heart of identity on the Internet."* We put the identity in.

## Competitors

| | Per-agent address | Agent identity (owner, rules) | Signature checked against a public record | User owns data | Client-side decrypt | Retention you set | MCP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Nanite** | ✓ | ✓ ENS name + records | ✓ `nanite.signer` on ENS | ✓ wallet, on Arkiv | ✓ | ✓ per agent + Keep | ✓ hosted + local |
| AgentMail | ✓ | no | DKIM (domain only) | vendor | not stated | no | ✓ |
| Gmail / Graph via OAuth | your inbox | no | DKIM (domain only) | Google / Microsoft | no | no | community |
| Resend / Mailgun inbound | build it yourself | no | DKIM (domain only) | vendor | no | no | no |
| Temp-mail APIs | ✓ | no | no | vendor | no | whole inbox | some |
| XMTP / Push | wallet messaging | wallet | ✓ wallet | network | ✓ | no | n/a, **no normal email or OTPs** |

AgentMail is more mature: SOC 2 on paid plans, a funded team, an onboarding API. Our difference is not more features; it is **identity and ownership**.

## Honest answers to likely questions

| Question | Answer |
| --- | --- |
| "How does a normal recipient check the signature?" | Today with our open-source verifier (`verifyNaniteSignature` in `@nanite/ens`, or one CLI command): paste the headers, it resolves the ENS name and checks. Anyone can also read the records in any ENS tool. **Next:** a public "verify this mail" page and a Gmail badge. |
| "Is every mail signed?" | Every mail from an agent with a signer is signed. Hosted agents get a signing key when they are created; self-hosted agents register their own signer address (`nanite-mcp keygen`). If signing ever fails, the send response says `signature: unavailable` rather than hiding it. |
| "Who writes the description?" | `agent-context` is set at creation ("Nanite agent mailbox &lt;name&gt;"), and the agent may update it. **Next:** choose a role (support, sales, recruiting) with a matching default policy. |
| "Is it end-to-end encrypted?" | Encrypted at rest and user-controlled. Inbound mail reaches the mail provider in plaintext (that's SMTP) and is encrypted before storage. Outbound mail leaves in plaintext (that's email). Hosted agents are decrypted by our server for their tools; self-hosted agents are not. |
| "Who pays gas?" | Nanite's operator pays for writes and extensions; the user only signs. |
| "What if I lose my keys?" | A recovery code is shown once at onboarding and must be confirmed; a passphrase is the fallback. |
| "What if a signing key leaks?" | Rotate it in the agent's settings; mail signed with the old key stops verifying. |
| "Deliverability?" | Real mail through Resend on our domain: DKIM, SPF and DMARC pass, and replies land in the Gmail inbox in the same thread (live, 2026-11-06). |
| "Is it live?" | It runs end to end against Sepolia ENSv2, Arkiv Rabdi and real email today. The public URL comes with deployment (**next**). |
| "Why not Postgres?" | Postgres would make us the owner and reader of every agent's mail. See `arkiv/why-arkiv.md`. |
| "Testnet only?" | Sepolia and Rabdi today; the code is chain-config driven. |

## Longer formats

**30 seconds.** "An AI agent emails you: whose agent is it, and what is it allowed to do? Today you can't tell, because DKIM proves only the domain. Nanite gives every agent an ENS name under its owner's, with public rules and a signing key, so anyone can check its mail. And the mail is ciphertext on Arkiv, owned by your wallet, gone when its lifetime ends unless you keep it. DKIM proves the domain. Nanite proves the agent."

**4 minutes.** The 2-minute script, plus: both swap lines, a self-hosted agent (the server only sees ciphertext), revoking an agent, and custom-domain onboarding.

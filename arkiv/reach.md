# Reach

**Nanite is for everyone whose AI agents need their own email address. We built it and ran it end to end with real mail, but we have not measured demand.**

You can try every part today: one curl, the local Docker stack, or the MCP server. Every claim below points to something in the repo.

## Who is it for, and what do they get?

| Who | Their problem | What Nanite gives them | Evidence |
| --- | --- | --- | --- |
| Developers building AI agents (LangChain, CrewAI, Claude and OpenAI agent SDKs, browser agents) | An agent that signs up for services needs its own inbox and must read one-time codes. Sharing a personal Gmail gives it far too much access. | One address per agent. An API and an MCP server let the agent read, wait for, send and keep mail. The MCP tool `get_latest_otp` returns the newest one-time code. Mail that expires on its own. A send policy in ENS that the agent cannot change. | Market research in [docs/pitch-research.md](../docs/pitch-research.md) (section 5 says the evidence is indirect). Live runs with real mail in [apps/api/LIVE-E2E.md](../apps/api/LIVE-E2E.md). [docs/mcp.md](../docs/mcp.md). |
| People who run a personal agent and care who reads its mail | A hosted agent-mail provider holds the plain text. | Mail is encrypted before it is stored. A web inbox decrypts it in the browser, with a countdown to expiry and a Keep button. A self-hosted agent decrypts on its own machine, so our server never sees the plain text after it arrives. | Self-hosted kit in `packages/mcp`; its live run in LIVE-E2E.md (no server response contained the subject or the sender). [how-you-use-arkiv.md](how-you-use-arkiv.md). |
| ENS and onchain-agent builders | They want an agent identity that is also a working email address. | `alex.user.nanitecom.eth` holds the agent's address, send policy, retention and signing key as ENS records. Every sent mail is stored as an encrypted `type = sent` entity owned by the user. | [docs/ens.md](../docs/ens.md) |
| Other apps, and anyone who wants to check the data | They are asked to trust "our database". | The mail lives on Arkiv with the user's wallet as owner. The schema (`nanite.email.v1`) is public. Any app can query it and keep only mail our operator wrote (`$creator`). | [schema.md](schema.md), the curl query below |

## Would they use it?

We have no user numbers yet. What we do have:

- We built the whole product and ran it with real mail: Gmail to a Nanite address, a signed agent reply through Resend, and both the user and the agent decrypting it ([LIVE-E2E.md](../apps/api/LIVE-E2E.md)).
- Others are paying for this category. AgentMail (YC S25) raised a $6M seed led by General Catalyst on 2026-03-10 (TechCrunch, source S1 in [docs/pitch-research.md](../docs/pitch-research.md)). Nylas has a beta "Agent Accounts" product, and smaller entrants include Nuntly and the self-hosted AgenticMail (source S7).
- As far as we found, none of them stores mail as encrypted, wallet-owned records that expire on chain. AgentMail, for example, holds mail on its own servers (research doc, section 4).

Whether users prefer wallet-owned, encrypted mail over a hosted inbox is what a public beta would test.

## Try it today

The live URL is not deployed yet. The planned address is `https://nanite.itsvikrant.tech`; deployment is task T4.3 ([docs/deployment.md](../docs/deployment.md)). Until then:

1. **One curl, nothing to install.** [query.curl.sh](query.curl.sh) lists real Nanite entities from the public Arkiv RPC. No wallet, SDK or key. It is plain POSIX `sh` and needs `curl` and `jq`:
   ```
   sh arkiv/query.curl.sh
   ```
   On 2026-11-06 it returned 16 entities at block 285,197. [schema.md](schema.md) explains every field.
2. **The full product, locally in Docker.** Follow the root [README](../README.md), then run `docker compose up -d db api web`. The web app opens at http://localhost:3000. A seed script creates a demo user with two agents and invented mail ([LIVE-E2E.md](../apps/api/LIVE-E2E.md), "Demo seed").
3. **Connect an agent through MCP.** `packages/mcp` has six tools: `list_inbox`, `get_email`, `get_latest_otp`, `wait_for_email`, `send_email`, `extend_email`. It runs hosted (`/mcp` on the API) or locally over stdio. On 2026-11-06 we tested both modes against our local stack. A few paths have only unit tests ([docs/mcp.md](../docs/mcp.md), section 10). `nanite-mcp` is not on npm yet, so run it from a checkout.
4. **Run a full agent demo.** [demo/](../demo/README.md) has two Claude Code kits: an agent that signs up for Reddit and reads its own verification code, and a self-hosted agent that decrypts and signs on its own machine.
5. **Read how it all works.** [docs/how-it-works.md](../docs/how-it-works.md); section 12 covers Arkiv.

## Limits that affect adoption

125 KiB per mail, 182.5 days of life at most, and testnet only. Details in [friction.md](friction.md) and [why-arkiv.md](why-arkiv.md#honest-limits).

## Reach inside the Arkiv ecosystem

`nanite.email.v1` is a plain Arkiv schema for expiring, wallet-owned messages. Any Arkiv app can read it with one query filtered on `$creator` ([schema.md](schema.md)). Our friction repro scripts run with one command each ([friction.md](friction.md)).

## After the hackathon

Nanite is MIT-licensed and the whole stack runs from the repo with Docker, so anyone can host it. The repo and the research doc list what is not done: DKIM checks on incoming mail, key rotation, a key management service for the master key, large attachments, and mainnet.

Whether the team keeps building after ETHGlobal Mumbai is Vikrant's call. He will fill in this line before submission:

> TODO(Vikrant): our commitment after Mumbai

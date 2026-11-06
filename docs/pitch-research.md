# Nanite pitch research (Y3)

Research date: 2026-11-06. All URLs accessed on that date unless noted. "Unverified" marks anything I could not confirm from a primary source. Nanite's own design claims come from the project brief, not from outside sources. Competitor cells marked "n/s" mean "not stated in sources I read", which is not the same as "no".

## 1. Problem (with evidence)

**Why agents need email.** Email is still the identity and notification layer of most web services: sign-up confirmation, OTP/2FA codes, invoices, receipts, password resets, and humans or services that only speak email. AgentMail's CEO puts it this way: "You give an agent an email address, [and] it can now use essentially any software service that already exists" (TechCrunch, 2026-03-10) [S1]. He also says agents should use email without clicking through screens, and that Gmail-style APIs impose rate and volume limits [S1]. This is a vendor's view, but it matches how sign-up automation is documented (dedicated inbox, regex the 4-8 digit code) [S2].

**Evidence of the trend (2025-2026).**
- AgentMail (YC S25) reports "hundreds of thousands of agent users", 500+ B2B customers, and says its user count tripled the week OpenClaw (then Clawdbot) launched in late January 2026 and quadrupled in February. All figures are company-stated, not independently audited [S1].
- Notion is shutting down Notion Mail on 2026-09-22; its stated reason is that users have shifted to AI agents for inbox management (secondary report, unverified against Notion's own announcement) [S3].
- Gartner predicts 40% of enterprise apps will feature task-specific AI agents by end of 2026, up from under 5% in 2025 (press release 2025-08-26). This is a forecast, and it is about agents in apps, not about email [S4].
- Agentic browsers (Perplexity Comet, OpenAI Atlas) shipped in 2025 [S5].

**Risks of agents using the owner's inbox or shared credentials.**
- Over-permission: Gmail's OAuth scopes are coarse. `mail.google.com` is "Read, compose, send, and permanently delete all your email"; `gmail.readonly` reads the whole mailbox. Google's docs say only "choose the most narrowly focused scope possible" and do not describe per-label or per-agent scoping [S6]. A community guide warns that OAuth into a personal Gmail exposes the entire history and recommends one inbox per agent [S2].
- Prompt injection via email: Brave's research found indirect prompt injection is "a systemic challenge facing the entire category of AI-powered browsers" (Comet case, Oct 2025) [S5]. For email specifically, I found only vendor/community guidance that a single crafted email can hijack an agent and that email must be treated as untrusted input [S2]. No independent measured incident rate found: unverified.
- Leaked OTPs and no audit: an OTP left sitting in a long-lived inbox is a standing secret. I found no study quantifying this; the point is reasoned, not sourced.
- Revocation: with a shared mailbox login or broad OAuth grant, cutting one agent means rotating a credential the owner also uses. This is an architectural observation, not a sourced statistic.
- ToS/consent: one agent-email guide notes it does not authorize automating sign-in or verification on third-party accounts the agent does not operate for its owner [S2]. Worth a line in a Q&A.

## 2. Market and trend

- Signal for the category: a YC-backed company raised a $6M seed led by General Catalyst (with YC, Phosphor Capital, and angels including Paul Graham, Dharmesh Shah, Paul Copplestone, Karim Atiyeh) specifically for "email for agents" on 2026-03-10 [S1]. Nylas has a beta "Agent Accounts" product, and several smaller entrants exist (Nuntly, self-hosted AgenticMail) [S7]. Competitors entering confirms demand and also means the space is contested.
- Gartner projects agentic AI could drive about 30% of enterprise application software revenue by 2035, above $450B (via secondary summary of Gartner's research; unverified against the primary) [S4]. This is not an email-market size. I found no credible sizing for "agent email" specifically: unverified, do not quote one.
- Web3 side: ERC-8004 (Trustless Agents) is a Draft ERC created 2025-08-13 with identity, reputation and validation registries [S8]. ENSIP-25 (Draft, created 2025-10-02) links an ENS name to an agent registry entry via `agent-registration[<registry>][<agentId>]` [S9]. ENSIP-26 (Draft, created 2025-05-17) defines `agent-context` and `agent-endpoint[mcp|a2a|web]` text records [S10]. A secondary source says the ERC-8004 registries launched on 2026-01-29 across about 30 networks: unverified [S11]. All of these are drafts and may change.

## 3. Competitors

### Comparison table

Legend: Y = supported per sources/brief; N = not offered per sources; ? = not stated or unverified; P = partial.
Nanite column reflects the design as specified in the brief (not yet independently shipped or audited).

| Capability | Nanite | AgentMail | Resend / Postmark / Mailgun inbound | Cloudflare Email Routing + Workers | MailSlurp / Mailinator / temp mail | Gmail API / MS Graph OAuth | Proton Mail (+Bridge) | Dmail / EtherMail | XMTP / Push | ERC-8004 + ENSIP-25/26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Per-agent address | Y | Y | P (domain/inbox, shared infra) | P (you build routing) | Y (disposable) | N (the user's own address) | P (aliases) | P (wallet-based address) | N (wallet/inbox ID, not email) | P (names/endpoints; email only as example endpoint) |
| Data owned by user wallet | Y | N (vendor account) | N | N | N | N (Google/MS) | N (Proton account) | P (wallet-keyed; storage details ?) | P (wallet identity) | n/a |
| E2E encrypted at rest | Y | ? (not on pricing page) | N | N | ? | N | Y (Proton-to-Proton; mailbox encrypted) | Y (claimed) | Y (MLS) [S12] | n/a |
| Server cannot read (self-host decrypt) | Y | N | N | N | N | N | P | ? | P | n/a |
| On-chain verifiable identity | Y (ENS) | N | N | N | N | N | N | P | P | Y |
| User-set send policy enforced per send | Y (ENS policy) | P (allowlists/permissions set by human; rate caps) [S1] | N | N | N | N | N | N | N | N |
| Verifiable outbound signature | Y (X-Nanite-Signature via ENS) | ? | P (DKIM only, domain-level) | P (DKIM/DMARC) | N | P (DKIM) | P (DKIM/PGP) | ? | Y (signed messages) | P |
| Expiring OTP storage | Y (5 min) | ? | N | N | P (temp inboxes expire) | N | N | N | N | N |
| Instant revoke | Y (on-chain) | P (revoke API key/inbox; not on-chain) | P (API key) | P | P | P (revoke OAuth grant) | P | ? | ? | ? |
| MCP-native | Y | Y (MCP on all tiers) [S13] | N | N | ? (some MCP wrappers) [S14] | N | N | N | N | P (MCP endpoint listing) |
| Open source | Y (MIT) | ? | N | P (Workers runtime not OSS) | N | N | P (Proton clients OSS; unverified) | ? | P (protocol/SDK OSS; unverified) | Y (spec) |

### Short notes

- **AgentMail** (agentmail.to). API-first inboxes for agents; two-way threaded mail, parsing, labels, search, webhooks, onboarding API so an agent can create its own inbox, humans manage permissions, allowlists, API keys [S1]. Pricing (official page): Free $0 (3 inboxes, 3,000 emails/mo, 100/day), Developer $20/mo (10 inboxes), Startup $200/mo (150 inboxes, SOC 2), Enterprise custom with EU region and BYO cloud; MCP server on all tiers; encryption not specified on the pricing page [S13]. Unauthenticated agent inboxes limited to 10 emails/day, bounce monitoring and keyword sampling for abuse [S1]. Data is held by the vendor. This is the closest competitor.
- **Nylas Agent Accounts / Nuntly / AgenticMail.** Nylas offers beta hosted mailboxes for agents; Nuntly gives agents inboxes with JSON delivery; AgenticMail is self-hosted with email plus phone/SMS [S7]. Details from a secondary comparison; unverified in depth.
- **Resend / Postmark / Mailgun / SendGrid.** Transactional send plus inbound parsing, shared domains, no per-agent inbox model [S7]. Resend Free: 3,000 emails/mo, 100/day, 3 domains, 3 inboxes, 1 webhook endpoint, 30-day retention; inbound counts toward quota; Pro from $20/mo for 50,000 emails [S15]. Nanite uses Resend, so these limits are Nanite's own ceiling too.
- **Cloudflare Email Routing and Email Workers.** Code on inbound mail: parse, forward, reject, or reply. Replies must match the original sender, one reply per incoming email, sender domain must match; docs do not describe arbitrary new outbound mail or AI use [S16]. Good building block, not a product.
- **MailSlurp / Mailinator / Mail.tm / Guerrilla.** Disposable or QA inboxes. MailSlurp has SMS/OTP and an "agent inboxes" offering; its pricing is inconsistent across sources (about $19.99 or $79/mo) so treat as unverified. Mailinator is described by one dev guide as enterprise QA, a poor fit for agent workflows; no price list found [S14]. I did not research Mail.tm or Guerrilla Mail in depth: unverified.
- **Gmail API / Microsoft Graph.** Delegated OAuth to a human's mailbox; scopes are coarse (full, readonly, send) with no documented per-label restriction [S6]. Microsoft Graph not fetched: unverified.
- **Proton Mail / Bridge.** Strong E2E between Proton users. To non-Proton recipients mail is not E2E unless password-protected or external PGP is used; Bridge exposes mail over IMAP/SMTP to desktop clients [S17]. Not designed for agent fleets or per-agent policy.
- **Skiff.** E2E encrypted email and docs, acquired by Notion in Feb 2024 and shut down after a sunset period (sources disagree on 6 vs 12 months) [S3]. Lesson: centralised private email can disappear; a user-owned, open-source design is a counterpoint.
- **Dmail / EtherMail.** Wallet-based web3 email and messaging; Dmail has a developer messaging-push SDK. Evidence is directory and newsletter level only; encryption, storage and pricing details unverified [S18].
- **XMTP / Push Protocol.** XMTP is wallet-identity messaging with MLS-based security and an Agents SDK [S12]. Push focuses on notifications [S18]. Neither speaks SMTP, so they cannot receive a sign-up OTP from a normal website. This is my inference from their being non-email protocols; I did not find a doc stating it.
- **ERC-8004, ENSIP-25/26, A2A, MCP.** Identity and discovery standards. ERC-8004's sample registration file includes an "email" endpoint entry as an example only; no email behaviour is defined [S8]. ENSIP-25 notes records can go stale when a name changes hands [S9]. They give identity, not a mailbox.

## 4. Where Nanite is different

Only claims the comparison supports (Nanite properties are from the brief; competitor gaps are from the sources above):

1. **Policy lives in ENS and is checked on every send.** In the sources, the closest control is AgentMail's human-set permissions/allowlists and rate caps held in the vendor's database [S1]. None of the other products read a user-controlled on-chain policy per send. Note: "N" cells for other vendors mean not documented in what I read.
2. **Verifiable outbound identity via ENS.** Standard mail offers domain-level DKIM [S7, S16]; ENSIP-25/26 define agent identity records [S9, S10] but not mail signing. Nanite ties an agent-level signature to an ENS-published key. I found no competitor doing this: unverified absence.
3. **User-owned, client-decrypted storage.** AgentMail, Resend and Cloudflare hold plaintext mail on their infrastructure; Proton encrypts but is its own silo and not E2E to external recipients [S13, S15, S16, S17]. Nanite stores ciphertext as wallet-owned Arkiv entities and decrypts in the browser or on the agent's machine (per brief).
4. **Short-lived OTP storage and instant on-chain revoke** as default behaviours (per brief). Competitors offer API-key revocation and temp-inbox expiry (MailSlurp-style) but not wallet-level revoke [S13, S14].
5. Open source (MIT) plus MCP-native. MCP alone is not unique (AgentMail has it [S13]); the combination with the above is.

## 5. Target users

Evidence is mostly indirect; none of these are measured Nanite demand.
- **Developers building agents** with LangChain, CrewAI, OpenAI Agents SDK, Claude Agent SDK, browser-use: they need sign-up and OTP handling. Evidence: AgentMail's agent-skill directories and the OpenClaw-driven surge [S1, S2]. Framework adoption numbers: unverified, not researched.
- **Companies deploying agent fleets:** AgentMail reports 500+ B2B customers and sells SOC 2 and enterprise tiers [S1, S13]. Per-agent policy and audit are the pitch angle.
- **Privacy-conscious individuals with personal agents:** the Skiff shutdown and Proton's popularity suggest demand for private email [S3]; no sizing found.
- **Web3 agent ecosystems:** ERC-8004 and ENSIP-25/26 give a standards-based audience of ENS and onchain-agent builders [S8, S9, S10]. Small and early; all drafts.

## 6. Risks and honest answers to likely judge questions

| Question | Honest answer |
|---|---|
| Outbound mail is plaintext through a provider, so what is "E2E"? | E2E covers stored inbound mail (ciphertext at rest, decrypted client-side). Inbound mail arrives as plaintext over SMTP at the receiving server before encryption, and outbound goes via Resend to the recipient's server. Proton has the same limit for non-Proton recipients [S17]. Say "encrypted at rest and user-controlled", not "E2E over SMTP". |
| Does the server see inbound plaintext? | Yes, transiently, at ingest before encrypting (inherent to SMTP). Confirm against the actual architecture before claiming otherwise. |
| Testnets? | Current ENSv2 and Arkiv work is on testnets (per brief); ERC-8004, ENSIP-25/26 are drafts [S8, S9, S10]. Position as a prototype aligned to emerging standards. |
| Who pays gas / operator cost? | Operator-funded write queue today (per project design); no sustainable pricing model validated. Unverified; needs an answer from the team. |
| Deliverability on a new domain? | Real risk: new domains lack reputation and need SPF/DKIM/DMARC warm-up. AgentMail mitigates with rate caps, bounce monitoring and abuse sampling; enterprise tiers offer dedicated IPs [S1, S13]. Resend dedicated IPs are $30/mo on Scale [S15]. |
| Resend free-tier limits? | 100 emails/day, 3,000/mo, 3 inboxes, 1 webhook endpoint, 30-day retention, and inbound counts toward quota [S15]. Fine for a demo, not a fleet; AgentMail's free tier has the same 100/day and 3 inboxes [S13]. |
| Key loss? | Wallet-held keys mean losing the key loses mail; no vendor reset. Mitigations (recovery, key rotation via ENS) need to be stated by the team. Proton and Skiff-style products offer account recovery trade-offs; not researched. |
| Prompt injection via email? | Not solved by encryption. Mitigations: send policy caps blast radius, expiring OTPs, revocation, email treated as untrusted input. Brave calls indirect prompt injection systemic [S5]. |
| Why not AgentMail? | It is more mature, funded, has SOC 2 and 500+ customers [S1, S13]. Nanite's gap to close is trust model (user-owned, on-chain policy) not features. |
| Why not just XMTP? | XMTP is not SMTP, so cannot receive normal web sign-up mail (inference, see notes) [S12]. |
| Legal/ToS of automated sign-ups? | Some services forbid automated accounts; see [S2] caveat. Flag as a responsibility of the user. |
| Is ENS read on every send slow or a single point of failure? | Not researched. Unverified; team should state caching and failure mode (fail closed). |

## 7. Sources

- [S1] TechCrunch, "AgentMail raises $6M to build an email service for AI agents", 2026-03-10. https://techcrunch.com/2026/03/10/agentmail-raises-6m-to-build-an-email-service-for-ai-agents/
- [S2] AgentMail skills (community directory mirrors), "email for ai agents" / "agent email patterns". https://claudeskills.info/skills/agentmail-to/agentmail-skills/email-for-ai-agents/ and https://claudeskills.info/skills/agentmail-to/agentmail-skills/agent-email-patterns/ (vendor-authored, not independent)
- [S3] Skiff/Notion: https://emailexpert.com/notion-acquires-skiff-and-shuts-it-all-down/ ; https://techradar.com/computing/cyber-security/skiff-gets-bought-by-notion-raising-privacy-concerns ; Notion Mail shutdown: https://cryptobriefing.com/notion-mail-shutdown-ai-agents/ (secondary)
- [S4] Gartner press release, 2025-08-26. https://gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025 (the 2035 revenue figure came from secondary summaries, e.g. https://www.uctoday.com/unified-communications/gartner-predicts-40-of-enterprise-apps-will-feature-ai-agents-by-2026/)
- [S5] Brave agentic-browser research coverage: https://www.digit.in/features/general/chatgpt-atlas-to-comet-agentic-ai-browsers-pose-security-risks-says-brave-report.html ; https://www.varonis.com/blog/architectural-vulnerabilities-in-agentic-llm-browsers (primary Brave post not fetched)
- [S6] Gmail API scopes. https://developers.google.com/workspace/gmail/api/auth/scopes
- [S7] AgentMail knowledge base and eesel comparisons (vendor-adjacent). https://docs.agentmail.to/knowledge-base/what-is-agentmail ; https://www.eesel.ai/blog/agentmail-review
- [S8] EIP-8004. https://eips.ethereum.org/EIPS/eip-8004
- [S9] ENSIP-25. https://docs.ens.domains/ensip/25/
- [S10] ENSIP-26. https://docs.ens.domains/ensip/26/
- [S11] ERC-8004 explainer (Spanish, secondary). https://www.datawallet.com/es/crypto/erc-8004-explained
- [S12] XMTP docs (navigation only read; MLS and Agents SDK listed, details not verified). https://xmtp.org/agents/quickstart/
- [S13] AgentMail pricing. https://www.agentmail.to/pricing
- [S14] MailSlurp / temp-mail comparisons (mixed reliability). https://www.xpay.sh/agent-ready-index/mailslurp/ ; https://dev.to/dishantsinghdev/the-best-temp-mail-api-in-2026-a-practical-guide-for-developers-4p5h
- [S15] Resend pricing. https://resend.com/pricing
- [S16] Cloudflare Email Workers docs. https://developers.cloudflare.com/email-routing/email-workers/
- [S17] Proton support on Bridge/external PGP. https://proton.me/hi/support/sending-pgp-emails-bridge (found via search; the page itself not fetched directly)
- [S18] Web3 messaging overviews (secondary). https://alchemy.com/best/web3-messaging-tools ; https://dmailnetwork.gitbook.io/dmail-network/overview/dmail-network

Not researched or not verified: Microsoft Graph, Mail.tm, Guerrilla Mail, SendGrid/Mailgun specifics, A2A spec, EtherMail details, framework adoption numbers, Arkiv and ENSv2 status, any market-size figure for agent email.

# Resend DNS records for nanitecom.itsvikrant.tech

Domain created through the Resend API on 2026-11-06. Domain id `610a155e-009e-4433-b0bb-d62b8d4691ec`, region `ap-northeast-1`, sending and receiving enabled, open/click tracking off.

Add these in the DNS zone of `itsvikrant.tech`. "Host" is relative to that zone; most DNS panels append `.itsvikrant.tech` automatically.

| # | Purpose | Type | Host (in zone itsvikrant.tech) | Full name | Value | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | DKIM | TXT | `resend._domainkey.nanitecom` | resend._domainkey.nanitecom.itsvikrant.tech | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCyLXusGIambISQtEIPxOvVFzSm183Z752bTzIe+Hv4IcpbjKbdQPDXUgLaVwHGxZbcO6bKXL4K1clfaCVMBY8seHVM7Ne/rkJ1rkhiThKS/xFxeYkJTovhl+rZn4r9H/nERBmZ4JGPPvt0weOU1RgJmCYqe2aY17J8XaRdloYIQwIDAQAB` | |
| 2 | SPF (bounce MX) | MX | `send.nanitecom` | send.nanitecom.itsvikrant.tech | `feedback-smtp.ap-northeast-1.amazonses.com` | 10 |
| 3 | SPF | TXT | `send.nanitecom` | send.nanitecom.itsvikrant.tech | `v=spf1 include:amazonses.com ~all` | |
| 4 | SPF | CNAME | `rsend.nanitecom` | rsend.nanitecom.itsvikrant.tech | `send.forge.rmta.net` | |
| 5 | Receiving | MX | `nanitecom` | nanitecom.itsvikrant.tech | `receive-apne1.forge.rmta.net` | 10 |
| 6 | DMARC (optional, recommended) | TXT | `_dmarc.nanitecom` | _dmarc.nanitecom.itsvikrant.tech | `v=DMARC1; p=none;` | |

Notes: if the CNAME (row 4) is proxied in your DNS panel (e.g. Cloudflare orange cloud), set it to DNS-only. TTL: Auto/default. After adding, run the verify step; propagation can take minutes to hours.

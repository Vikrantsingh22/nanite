# Headed browser for watching the e2e flows: the pinned Playwright image plus a virtual display and noVNC.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox x11-utils imagemagick \
 && rm -rf /var/lib/apt/lists/*
# Playwright MCP (HTTP) for the Claude Code demos (demo/reddit). 0.0.83 (2026-09-28) depends on playwright 1.64.0-alpha; it
# attaches to our Chromium over CDP, so it never needs its own browser download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g @playwright/mcp@0.0.83

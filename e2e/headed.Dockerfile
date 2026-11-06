# Headed browser for watching the e2e flows: the pinned Playwright image plus a virtual display and noVNC.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox x11-utils imagemagick \
 && rm -rf /var/lib/apt/lists/*

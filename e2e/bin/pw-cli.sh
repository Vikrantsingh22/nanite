#!/bin/sh
# Wrapper for @playwright/cli inside the e2e container. The CLI bundles a Playwright
# build whose browser revision differs from the image, so point it at the image's
# Chromium, resolved at runtime (works on arm64 and x86).
set -e
exe=$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)
[ -n "$exe" ] || { echo "pw-cli: no Chromium found under /ms-playwright" >&2; exit 1; }
mkdir -p .playwright
cat > .playwright/cli.config.json <<EOF
{ "browser": { "browserName": "chromium", "launchOptions": { "executablePath": "$exe", "args": ["--no-sandbox"] } } }
EOF
exec npx playwright-cli "$@"

# Nanite API image. Build from the repo root:
#   docker build -f apps/api/Dockerfile -t nanite-api:local .
# The API runs TypeScript source through tsx (same as `npm run start -w apps/api`), so there is no compile step.
# node 22.23.3 (tag published 2026-10-21), multi-arch index digest (linux/amd64 for the VM, linux/arm64 for local tests).
ARG NODE_IMAGE=node:22.23.3-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9

# ---- stage 1: production dependencies only (api + the workspace packages it imports)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# apps/web is listed so the lockfile stays consistent; with -w apps/api none of its dependencies are installed.
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/crypto/package.json packages/crypto/
COPY packages/arkiv/package.json packages/arkiv/
COPY packages/ens/package.json packages/ens/
COPY packages/mcp/package.json packages/mcp/
# --ignore-scripts: no native compilers in the image; bufferutil/utf-8-validate (optional ws accelerators) are skipped
# and ws uses its pure-JS fallback. esbuild (tsx) ships prebuilt binaries as optional packages.
RUN npm ci --omit=dev --ignore-scripts --workspace=apps/api --include-workspace-root --no-audit --no-fund \
 && npm cache clean --force

# ---- stage 2: runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY --chown=node:node apps/api/src ./apps/api/src
COPY --chown=node:node packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY --chown=node:node packages/db/src ./packages/db/src
COPY --chown=node:node packages/db/migrations ./packages/db/migrations
COPY --chown=node:node packages/crypto/package.json packages/crypto/tsconfig.json ./packages/crypto/
COPY --chown=node:node packages/crypto/src ./packages/crypto/src
COPY --chown=node:node packages/arkiv/package.json packages/arkiv/tsconfig.json ./packages/arkiv/
COPY --chown=node:node packages/arkiv/src ./packages/arkiv/src
COPY --chown=node:node packages/ens/package.json packages/ens/tsconfig.json ./packages/ens/
COPY --chown=node:node packages/ens/src ./packages/ens/src
COPY --chown=node:node packages/mcp/package.json packages/mcp/tsconfig.json ./packages/mcp/
COPY --chown=node:node packages/mcp/src ./packages/mcp/src
# @nanite/ens imports these JSON files with relative paths.
COPY --chown=node:node config/roles.json config/sepolia.json ./config/
COPY --chown=node:node contracts/abi/ETHRegistry.json contracts/abi/PermissionedResolverImpl.json contracts/abi/UniversalResolverV2.json contracts/abi/UserRegistryImpl.json contracts/abi/VerifiableFactory.json ./contracts/abi/

USER node
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Apply database migrations, then start the API (exec so SIGTERM reaches node for the graceful shutdown).
CMD ["sh", "-c", "node --import tsx ../../packages/db/src/bin/migrate.ts && exec node --import tsx src/index.ts"]

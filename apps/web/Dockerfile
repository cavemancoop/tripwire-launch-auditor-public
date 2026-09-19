# M9 — built with the REPO ROOT as build context (Railway service setting:
# Root Directory blank, Dockerfile Path "apps/web/Dockerfile"). apps/web has
# no dependencies of its own (server.mjs is plain node:http, no framework),
# but pnpm still needs the whole workspace present to validate the lockfile.
FROM node:22-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/chain/package.json packages/chain/package.json
COPY packages/scoring/package.json packages/scoring/package.json
COPY packages/rpc-budget/package.json packages/rpc-budget/package.json
# packages/db's postinstall (`prisma generate`) fires during the install below
# even for this dependency-free app — the workspace install runs every
# package's postinstall, so the schema needs to be present.
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web

ENV NODE_ENV=production
EXPOSE 3002
# See apps/api/Dockerfile: not `pnpm --filter ... start` — its own dependency
# check aborts with no TTY on every container start, not just at build time.
# apps/web has no dependencies of its own, so plain node is enough (no tsx).
CMD ["node", "apps/web/server.mjs"]

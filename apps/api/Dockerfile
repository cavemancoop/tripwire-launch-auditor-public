# M9 — built with the REPO ROOT as build context (Railway service setting:
# Root Directory blank, Dockerfile Path "apps/api/Dockerfile"), because this
# is a pnpm workspace: apps/api depends on packages/db etc. via the
# workspace protocol and needs the whole monorepo to install correctly.
#
# No separate compile stage: every app here runs via `tsx` directly (no
# tsc/esbuild build step), so devDependencies (tsx, typescript) are needed at
# runtime too — this image is not pruned to --prod.
FROM node:22-alpine

# Prisma's query engine on alpine needs these; without them `pnpm install`'s
# `prisma generate` postinstall still succeeds but the engine fails at runtime.
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

# Install first from just the manifests, so an unrelated source change doesn't
# invalidate this (slow) layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/chain/package.json packages/chain/package.json
COPY packages/scoring/package.json packages/scoring/package.json
COPY packages/rpc-budget/package.json packages/rpc-budget/package.json
# packages/db's postinstall (`prisma generate`) fires during the install below
# for every image, whichever app it's building — it needs the schema present.
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile

# The client generated during install above already matches this schema (the
# same packages/db/prisma was copied in before that install ran) — no need to
# regenerate now. (A second `pnpm exec prisma generate` here triggers pnpm's
# dependency-status check, which aborts with no TTY in a Docker build.)
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
# Not `pnpm --filter ... start`: pnpm's own dependency-status check runs
# before every invocation (even after a successful build) and aborts wanting
# to prompt with no TTY. tsx resolves the entry file's own relative imports
# regardless of cwd, and this app's own env/path helpers walk up from cwd
# looking for pnpm-workspace.yaml / .env — both already sit at /app.
CMD ["node_modules/.bin/tsx", "apps/api/src/index.ts"]

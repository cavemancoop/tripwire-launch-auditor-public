# M9 — built with the REPO ROOT as build context (Railway service setting:
# Root Directory blank, Dockerfile Path "apps/worker/Dockerfile"). See
# apps/api/Dockerfile for the full rationale (shared across all three apps).
FROM node:22-alpine

RUN apk add --no-cache openssl libc6-compat

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
# for every image, whichever app it's building — it needs the schema present.
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile

# The client generated during install above already matches this schema (the
# same packages/db/prisma was copied in before that install ran) — no need to
# regenerate now. (A second `pnpm exec prisma generate` here triggers pnpm's
# dependency-status check, which aborts with no TTY in a Docker build.)
COPY . .

ENV NODE_ENV=production
# Health/metrics HTTP surface (M9) — the long-running loops (watcher, commit,
# metabolism, deep-dive, scorer, telegram poster, alerts) don't need a public
# port themselves; this is just so Railway (or any prober) has something to
# check the process is alive and to scrape.
EXPOSE 3010
# See apps/api/Dockerfile: not `pnpm --filter ... start` — its own dependency
# check aborts with no TTY on every container start, not just at build time.
#
# Also applies pending migrations before starting: the worker is the one
# process that's actually inside Railway's private network, so it's the
# right place to run `prisma migrate deploy` — reaching Postgres from a
# laptop needs a public endpoint this project doesn't expose. `migrate
# deploy` only applies pending migrations and is a no-op otherwise, so this
# is safe on every restart, not just the first one. `exec` before the final
# command so it replaces the shell (PID 1) and still receives SIGTERM
# directly for a clean shutdown.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma && exec node_modules/.bin/tsx apps/worker/src/index.ts"]

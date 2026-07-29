# syntax=docker/dockerfile:1
# ^ parser directive — BuildKit only reads it while it is still the FIRST line of the file: once a
# comment, blank line or instruction has been seen it stops looking, and the pin becomes an inert
# comment. Keep it above the usage notes below.

# RFP Hub API — container image.
#
# Multi-stage, pnpm-workspace-aware build for @the-rfp-hub/api. Build from the REPO ROOT (this
# Dockerfile needs the workspace manifest, lockfile, and its workspace dependency
# @the-rfp-hub/standard — packages/api alone is not a buildable context):
#
#   docker build -t rfp-hub-api .
#
# No domain exists yet — everything the running container needs is env-driven (see
# packages/api/README.md and packages/api/.env-example). In production, DATABASE_URL is required;
# the process fails fast at startup if it's unset (see src/config.ts).
#
# The image defaults to starting the server. To run pending Drizzle migrations instead (e.g. as a
# one-off job before rolling out a new revision), override the command:
#
#   docker run --rm -e DATABASE_URL=... rfp-hub-api node dist/migrate.js
#   docker run --rm -e DATABASE_URL=... rfp-hub-api                    # starts the server (default)

FROM node:20-alpine AS base
RUN corepack enable

# ---------------------------------------------------------------------------------------------
# build: install the full workspace (dev deps included) and compile every package this image needs
# ---------------------------------------------------------------------------------------------
FROM base AS build
WORKDIR /repo

# Manifests only, first, so `pnpm install` is cached independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/standard/package.json packages/standard/package.json
COPY packages/validate/package.json packages/validate/package.json
COPY packages/api/package.json packages/api/package.json

RUN pnpm install --frozen-lockfile

# Now the source of every workspace package @the-rfp-hub/api depends on.
COPY packages/standard packages/standard
COPY packages/validate packages/validate
COPY packages/api packages/api

# @the-rfp-hub/standard and rfphub-validate are workspace deps the api package imports at build
# and (for the standard's types/schema) runtime — build them first so the api build resolves their
# dist. The api build itself compiles TWO entries with tsup: dist/server.js (the API process) and
# dist/migrate.js (drizzle-orm's migrator + the same DATABASE_URL-driven config, for the migration
# job above) — tsup.config.ts only declares the server entry for `pnpm build`, so this passes both
# explicitly rather than editing that shared config for an image-only concern.
RUN pnpm --filter @the-rfp-hub/standard build \
  && pnpm --filter rfphub-validate build \
  && pnpm --filter @the-rfp-hub/api exec tsup --entry.server=src/server.ts --entry.migrate=scripts/migrate.ts

# Self-contained production install of just @the-rfp-hub/api + its workspace deps, materialized as
# real files (not symlinks back into /repo) — the runtime stage below copies ONLY this directory,
# so nothing from the rest of the monorepo (dev deps, other packages' source, test fixtures) ships.
# `--legacy`: pnpm 10 otherwise requires `inject-workspace-packages=true` in .npmrc for `deploy`;
# this workspace has no .npmrc, and legacy deploy already produces a correct, real-files output.
RUN pnpm --filter @the-rfp-hub/api deploy --prod --legacy /prod/api

# ---------------------------------------------------------------------------------------------
# runtime: slim, production-only, non-root
# ---------------------------------------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S rfphub && adduser -S rfphub -G rfphub
COPY --from=build --chown=rfphub:rfphub /prod/api ./

USER rfphub
EXPOSE 3001

CMD ["node", "dist/server.js"]

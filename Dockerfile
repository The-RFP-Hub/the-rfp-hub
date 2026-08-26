# Multi-stage Dockerfile for the RFP Hub /v1/ API (packages/api).
#
# Stage 1: install the full workspace and build every package —
#   `@the-rfp-hub/standard` and `rfphub-validate` are workspace deps of the
#   API and stay external to its tsup bundle, so their dist output must
#   exist at runtime.
#
# Stage 2: lean runtime image. Re-installs prod-only deps from the lockfile
#   (which recreates the workspace symlinks), then copies the built dist
#   folders and the standard package's runtime assets (schemas, registries,
#   conformance, meta) that its package.json exports point at.
#
# The image serves the API *and* runs its three one-off admin tasks —
# `migrate`, `seed` and `export` — as separate entry points under
# `packages/api/dist`, so a task runner can launch any of them against the
# same image the service runs (see "One-off tasks" in packages/api/README.md).
# Each needs data the server does not: the Drizzle migrations, the seed
# corpus, and a writable directory to export into. Those are copied below.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm -r --if-present build
RUN pnpm -r --if-present typecheck

# ----- runtime -----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# curl is required by the ECS container health check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/standard/package.json packages/standard/package.json
COPY packages/validate/package.json packages/validate/package.json
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/api/dist packages/api/dist
COPY --from=builder /app/packages/standard/dist packages/standard/dist
COPY --from=builder /app/packages/standard/schemas packages/standard/schemas
COPY --from=builder /app/packages/standard/registries packages/standard/registries
COPY --from=builder /app/packages/standard/conformance packages/standard/conformance
COPY --from=builder /app/packages/standard/meta packages/standard/meta
COPY --from=builder /app/packages/standard/ns packages/standard/ns
COPY --from=builder /app/packages/standard/spec.config.json packages/standard/spec.config.json
COPY --from=builder /app/packages/validate/dist packages/validate/dist

# Inputs the one-off tasks read, which the server never touches.
#
# The migrations are SQL files, not code, so nothing bundles them: the
# `migrate` entry point resolves them relative to its own module URL, which
# puts them here whether it runs as `dist/migrate.js` or as `scripts/migrate.ts`
# under tsx. The `meta/` journal inside is part of the folder drizzle reads.
#
# The corpus is the seed's one and only input — a repo artifact, reviewed and
# versioned like source — and it is passed to the task as an argument, so a
# seed run in this image is the same offline, reproducible run CI makes.
COPY --from=builder /app/packages/api/src/db/migrations packages/api/src/db/migrations
COPY --from=builder /app/packages/api/data/seed-corpus.json packages/api/data/seed-corpus.json

# The export writes six files to ./exports relative to the working directory,
# and /app is root-owned while the container runs as `node` — so the directory
# is created and handed over here rather than left to fail at write time. An
# export task that needs its output to outlive the task mounts a volume over
# this path; the ordinary run leaves it in the container's own layer.
RUN mkdir -p /app/exports && chown node:node /app/exports

# NO SECRETS ARE BAKED INTO THIS IMAGE. There is deliberately no `COPY .env*`
# here and `.env`/`.env.*` are excluded from the build context by
# `.dockerignore`, which `scripts/check-deploy.mjs` enforces in CI.
#
# An image is not a secret store: anyone who can pull it — and, when the build
# uses a `mode=max` layer cache in a public repository, anyone who can read
# that cache — can read every value inside it. Every runtime variable is
# therefore injected by the ECS task definition, which the DEPLOY job assembles
# from Secrets Manager on its way past: interim in the container definition's
# `environment` array, and eventually in its `secrets:` array, each entry
# resolving a Secrets Manager JSON key at task start. See packages/api/docs/deploy.md
# for the variable→secret table, what the interim step exposes and to whom, the
# split migration/runtime credentials, and the rotation runbook for values that
# were baked into earlier images.
#
# `src/config.ts` still calls dotenv, so a developer's local `packages/api/.env`
# keeps working; in the image there is no such file and the real environment is
# the only source.

# PORT is fixed here rather than in the secret so it always matches the
# container_port/back_end_port wired into the ECS task and ALB target group.
ENV PORT=3004
EXPOSE 3004
USER node

CMD ["node", "packages/api/dist/server.js"]

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
COPY --from=builder /app/packages/standard/spec.config.json packages/standard/spec.config.json
COPY --from=builder /app/packages/validate/dist packages/validate/dist

# Bake `.env` into the image. The CI workflow pulls the file from AWS
# Secrets Manager (staging/rfp-hub or production/rfp-hub) before the
# Docker build so this COPY picks it up. Glob form (`.env*`) means the
# build doesn't fail when no .env is present (e.g. local `docker build`
# during dev). The app reads process.env directly (no dotenv), so the
# CMD loads the file via Node's --env-file; real environment variables
# still win over .env values.
COPY .env* ./

# PORT is fixed here rather than in the secret so it always matches the
# container_port/back_end_port wired into the ECS task and ALB target group.
ENV PORT=3004
EXPOSE 3004
USER node

CMD ["node", "--env-file-if-exists=.env", "packages/api/dist/server.js"]

# @the-rfp-hub/api

The public **`/v1/` read API** for the RFP Hub — an unauthenticated Fastify + Postgres service that
serves [RFP Hub Standard v1.0.0](../standard) objects, backed by a 100+ entry seed dataset ingested
from a configurable upstream funding-map source and nightly open-data exports (CC0). This is
milestone **M2**.

## Endpoints (`/v1`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Service info: name, `version`, the `standard` version served, and a link map to the endpoints below. |
| `GET` | `/v1/opportunities` | List (thin projection). Filters: `fundingType`, `status`, `ecosystem`, `category`, `organization`, `minAward`, `maxAward`, `deadlineAfter`, `deadlineBefore`, `q`; `sort` (`nextDeadlineAt\|opensAt\|postedAt\|updatedAt\|createdAt`), `order`, `page`, `limit`. |
| `GET` | `/v1/opportunities/:id` | One full Standard object (e.g. `fundingmap:1459`); `404` if not found. |
| `GET` | `/v1/opportunities/schema` | The canonical v1.0.0 JSON Schema, served as `application/schema+json` — semantically identical to the published file (re-serialized, so key order may differ from the raw bytes). |
| `GET` | `/v1/stats` | Totals + breakdowns by funding type/status/ecosystem. |
| `GET` | `/v1/health` | Liveness + DB readiness. |
| `GET` | `/v1/docs` | Swagger UI (OpenAPI 3.1). |
| `GET` | `/v1/docs/json` | The OpenAPI 3.1 document itself, as JSON — what Swagger UI renders, and what `test/integration/openapi.test.ts` validates live responses against. |

Public reads return only `review_status = 'approved' AND is_listed` rows. List responses omit
`fundingDetails` — the type-specific details slot, a tagged union whose own required `fundingType`
tag names its shape — as a delivery optimization (see the Standard's FIELDS.md); the detail
endpoint serves it in full. Storage keeps the payload **tag-free** in the `type_data` jsonb column
(the tag is derivable from `funding_type`) and reattaches the tag on read, so the served tag can
never disagree with the top-level discriminator.

### Response envelopes

`GET /v1/opportunities` wraps its results rather than returning a bare array, so pagination
metadata travels with the page:

```jsonc
{ "items": [ /* OpportunitySummary */ ], "page": 1, "limit": 20, "total": 123, "totalPages": 7 }
```

`GET /v1/opportunities/:id` and `GET /v1/opportunities/schema` return the object itself (no
envelope). `GET /v1/stats` and `GET /v1/health` return their own flat shapes — see the `Stats` and
`Health` components in the OpenAPI document (`/v1/docs/json`) for the exact fields.

Every error (400/404/500) returns `{ "error": "<code>", "message": "<string>" }` with a stable
`error` code (`bad_request`, `not_found`, `client_error`, `internal_error`) — never a stack trace or
other internal detail; see `src/app.ts`'s error handler.

CORS is wide open (`Access-Control-Allow-Origin: *`, `GET`/`HEAD`/`OPTIONS` only) — this is a fully
public, unauthenticated read API, so there is no origin to allowlist and nothing to protect with
credentials.

### Deadlines, sorting and the rolling-only exclusion

The Standard has no deadline scalar — `deadlines[]` holds `{deadlineType: 'fixed' | 'rolling',
date?, label?}` entries and consumers must select by label, never by array position. The API therefore
derives **`nextDeadlineAt`**: the earliest `fixed` deadline still in the future, stored in an
indexed column and recomputed on every write.

It is **null** for a record that is rolling-only, whose fixed deadlines have all passed, or that
has no deadlines at all. Those records **sort last** (in both `asc` and `desc`) and are
**excluded** from the `deadlineAfter`/`deadlineBefore` window filters, since there is no date to
compare — the OpenAPI description of each of those parameters says so. `docs/data-model.md`
covers the derivation and the matching auto-close rule (a rolling program never auto-closes).

### Query-param renames (v1.0.0 re-cut)

The API is pre-adoption, so the re-cut renames are applied without a back-compat shim:

| Before | After |
|---|---|
| `?type=` | `?fundingType=` |
| `?sort=closesAt` | `?sort=nextDeadlineAt` (also the new default) |
| — | `?deadlineAfter=` / `?deadlineBefore=` (RFC 3339) |
| `?organization=` (issuer FK) | `?organization=` — now matches **any** entry in `operatingOrganizations` OR `sponsoringOrganizations`, not only the primary `operatingOrganizations[0]` |
| `?network=` / `?tag=` | removed — the Standard dropped `networks`/`tags` (`?ecosystem=` and `?category=` remain) |
| `/v1/stats` → `byType` | `/v1/stats` → `byFundingType` |

## Local development

```bash
docker compose up -d                     # Postgres 15 (see docker-compose.yml)
export DATABASE_URL=postgres://rfphub:rfphub@localhost:5432/rfphub
pnpm --filter @the-rfp-hub/api migrate       # apply Drizzle migrations (see the note below)
export SOURCE_API_URL=https://…          # upstream funding-map registry API (see .env-example)
pnpm --filter @the-rfp-hub/api seed          # ingest 100+ entries from SOURCE_API_URL
pnpm --filter @the-rfp-hub/api seed -- --strict   # ...and fail the run on ANY non-conforming record
pnpm --filter @the-rfp-hub/api dev           # start the server (http://localhost:3001)
pnpm --filter @the-rfp-hub/api export        # write JSON + CSV to ./exports
```

### Configuration

Config is read from the environment (see `.env-example`) — everything is optional in development
(sane localhost defaults), and there is no domain yet, so nothing below defaults to one:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://rfphub:rfphub@localhost:5432/rfphub` | Postgres connection string. **Required in production** — with `NODE_ENV=production` the process exits non-zero at startup if unset rather than silently using the localhost default (see `src/config.ts`). |
| `PORT` | `3001` | HTTP port. A set-but-unusable value — empty, whitespace-only, non-numeric, or outside `1..65535` — falls back to the default rather than binding to `NaN` or to an ephemeral port (`Number("")` is `0`). |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `NODE_ENV` | unset | Set to `production` to enable the `DATABASE_URL` fail-fast above. |
| `PUBLIC_BASE_URL` | `/` | The OpenAPI document's `servers[0].url` (see `src/plugins/swagger.ts`). Relative by default — correct wherever the server happens to be hosted. Set to the API's public URL (e.g. `https://api.example.org`) once one exists. |
| `SOURCE_API_URL` | — | Upstream funding-map registry API the seed loader ingests from. |
| `SOURCE_SYSTEM` | `fundingmap` | Provenance namespace stamped on seeded entries. |
| `SOURCE_PROGRAM_URL_BASE` | — | Last-resort `applicationUrl` base for a program with no submission/website URL. |

This table is the whole config surface — every key `src/config.ts` and `scripts/*.ts` read, and no
others. The export writes to a local `./exports` directory today; it has no cloud sink and no
minimum-record floor, so there is nothing to configure for either. Both arrive with the open-data
export work, which will add its keys here in the same change that adds the code that reads them.

> **Migrations were regenerated for the v1.0.0 re-cut.** `src/db/migrations` starts from the
> drizzle-kit-generated `0000_recut_v1_0_0` baseline; `0001_schema_vnext_org_flip` applies the
> schema v-next changes (org-array flip, `networks`/`tags`/`extensions` removal, eligibility →
> text, the renames) forward-only on top of it. `0001` rewrites DDL but NOT pre-existing jsonb
> payloads — **after migrating a database that already has data, re-run the seed**; every row is
> re-derivable from the upstream source. Regenerate after a schema change with
> `pnpm --filter @the-rfp-hub/api db:generate`.

## Architecture

Layered, module-per-folder — full pattern in [`docs/architecture.md`](./docs/architecture.md):
`routes/<module>/<entity>.controller.ts` (HTTP handlers) → `services/<module>/<name>.service.ts`
(logic + data over Drizzle) → `mappers/<entity>.mapper.ts` (pure row ↔ Standard). Route
registration lives in `routes/<module>/index.ts`.

- **DB**: Drizzle ORM over node-postgres; schema in `src/db/schema.ts`, migrations in
  `src/db/migrations`. The schema is the **M2 subset** of the full design in
  [`docs/data-model.md`](./docs/data-model.md) (which tags what's deferred to M3/M4).
- **Search**: `ILIKE` over title/summary/description (the generated `tsvector` column is deferred).
- **Validation/types**: reuses [`@the-rfp-hub/standard`](../standard) (schema + types) and
  [`rfphub-validate`](../validate). **The seed loader validates every mapped record against the
  schema before anything reaches the database** (`gateForSeed` in `scripts/seed.ts`), printing each
  rejection with its id and the rules it broke — a rejected record is never silently subtracted
  from a count. `--strict` (or `SEED_STRICT=1`) turns any rejection into a failed run; it is off by
  default because the upstream is a third-party feed, so one malformed program should not block a
  120-record seed.

## Tests

- **unit** (`test/unit`, no DB): mappers round-tripped against the committed Standard examples,
  the `deadlines.ts` derivations (`nextDeadlineAt` / auto-close), the ingest normalization
  (`fundingDetails` tag stripping/reattachment, self-identification stripping), `map-program`
  old-upstream→re-cut-Standard, query-param parsing, CSV serialization.
- **integration** (`test/integration`, gated on `DATABASE_URL`): each endpoint via `app.inject()`
  against Postgres, with isolated self-cleaning fixtures — including `openapi.test.ts`, which fetches
  the live `/v1/docs/json` document and validates ACTUAL responses against whatever schema each
  operation declares there (not a hand-kept copy of the contract).

```bash
pnpm --filter @the-rfp-hub/api typecheck
DATABASE_URL=… pnpm test     # integration tests run when DATABASE_URL is set; otherwise skipped
```

### Integration tests

Run the DB-gated suites against the **throwaway** test database in
[`docker-compose.test.yml`](./docker-compose.test.yml) (tmpfs-backed, port `5439`, container
`rfphub-test-pg`) — **not** against the persistent dev DB in `docker-compose.yml`, whose data a
`down -v` would destroy. From `packages/api`:

```bash
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgres://rfphub:rfphub@localhost:5439/rfphub pnpm run migrate
DATABASE_URL=postgres://rfphub:rfphub@localhost:5439/rfphub npx vitest run test/integration
docker compose -f docker-compose.test.yml down
```

## Deployment

Everything above is env-driven with local-friendly defaults (see **Configuration** above), so
pointing this at a real host is a matter of setting the environment, not changing code.

- **Container image**: [`/Dockerfile`](../../Dockerfile) (repo root — a pnpm-workspace-aware,
  multi-stage build; it needs the workspace lockfile and `@the-rfp-hub/standard`'s source, so it
  must be built from the **repo root**, not from `packages/api/`):

  ```bash
  docker build -t rfp-hub-api .          # from the repo root
  docker run --rm -p 3001:3001 -e DATABASE_URL=… rfp-hub-api
  ```

  The final stage is a slim `node:20-alpine` runtime, running as a non-root user, with only
  `@the-rfp-hub/api`'s production dependencies (`pnpm deploy --prod`) — no dev tooling, no other
  workspace package's source. `curl` is installed in that stage on purpose: the container health
  check is an HTTP request to `/v1/health` issued from inside the container.

### One image, four entrypoints

The image ships four compiled entrypoints and is started by overriding the command. There is no
second image, no second build, and no separate migration image:

| Command | Used by | Notes |
|---|---|---|
| `node dist/server.js` | the long-running service (default `CMD`) | listens on `PORT` (3001), health at `/v1/health` |
| `node dist/migrate.js` | the one-off migration job, before every rollout | drizzle-orm's migrator over `src/db/migrations` |
| `node dist/seed.js --strict` | the scheduled refresh job | `--strict` fails the run on any non-conforming upstream record |
| `node dist/export.js` | the scheduled refresh job, right after the seed | writes the CC0 open-data export (JSON + CSV + `LICENSE`) to `./exports` **inside the container**, and records a `dataset_snapshots` row per file |

The scheduled refresh runs them in order as a single command —
`node dist/migrate.js && node dist/seed.js --strict && node dist/export.js` — so a failed migration
or a rejected record stops the run before anything is published.

> **`dist/export.js` writes to the container's own filesystem, which is discarded when the task
> stops.** It has no cloud sink yet (see **Deferred** below), so scheduling it today refreshes the
> database and then throws the export artifacts away, exiting `0`. That is a green job that
> publishes nothing — do not stand the scheduled refresh up as evidence that the export pipeline
> works until the upload sink lands.

Locally the same three:

```bash
docker run --rm -e DATABASE_URL=… rfp-hub-api node dist/migrate.js   # apply pending migrations
docker run --rm -e DATABASE_URL=… rfp-hub-api node dist/seed.js --strict
docker run --rm -e DATABASE_URL=… rfp-hub-api node dist/export.js
docker run --rm -p 3001:3001 -e DATABASE_URL=… rfp-hub-api           # then start the server
```

**Env contract for all four.** Nothing is baked into the image and nothing is read from a `.env`
file in production — `src/config.ts` reads `process.env` directly and never loads dotenv. Every
value in the **Configuration** table above is supplied by the task definition the container is
started from: the secret values (`DATABASE_URL`, `SOURCE_API_URL`) come from the deployment
platform's secrets store; the non-secret values (`PUBLIC_BASE_URL`, `SOURCE_SYSTEM`,
`SOURCE_PROGRAM_URL_BASE`) are plain environment entries on the same task definition. The table is
exhaustive — a key that is not in it is not read by anything in this package, so putting it on a
task definition has no effect. Two consequences worth knowing: an image is not environment-specific
and the same digest can be promoted between environments, and **changing a secret's value does not
restart anything** — those references resolve at task start, so a rotation needs a forced new
deployment.

> **Migrations must be backward-compatible with the revision already running.** The migration job
> runs *before* the new service revision rolls out, and the rollout drains the old tasks gradually,
> so for the length of every deploy the **previous** code is talking to the **new** schema. A
> migration that drops or renames a column, tightens a constraint, or changes a column's type in
> place will break the running service before the new code that expects it is live. Split those
> into two deploys: first an additive migration the old code tolerates (add the column, backfill,
> write to both), then — once the new code is fully rolled out — a second migration that removes
> what is no longer read. A failed migration fails the deploy before the service is touched, which
> is the safe direction; an *applied but incompatible* migration does not.

- **Graceful shutdown**: `SIGTERM`/`SIGINT` stop the server, drain in-flight requests, close the
  Postgres pool (a Fastify `onClose` hook on the server's own instance — see `src/server.ts`), then
  exit `0`. A forced-exit timeout (`process.exit(1)`) guards against a hung close.
- **CORS**: `Access-Control-Allow-Origin: *`, `GET`/`HEAD`/`OPTIONS` only — an explicit product
  decision for a fully public, unauthenticated read API (see `src/app.ts`).
- **Pipelines**: [`.github/workflows/staging.yml`](../../.github/workflows/staging.yml) (push to
  `main`, or a manual run — with a `build_only` option that stops after the image is pushed) and
  [`.github/workflows/production.yml`](../../.github/workflows/production.yml) (a `production-*`
  tag, or a manual run). Both do the same four things: build and push the image, run the migration
  job and gate on its exit code, roll the service onto the new revision and assert it actually
  moved, then notify. Deploys serialize rather than cancel each other. Every environment-specific
  value — registry repository, cluster, credentials, task families — comes from the matching GitHub
  Environment, so neither file names a host, an account or a resource.

## Deferred (later in M2 / beyond)

The public URL itself (the pipelines above deploy the image, but the hostname is still being
decided, so `PUBLIC_BASE_URL` has no live value yet); **the export's cloud sink** — `scripts/export.ts`
writes JSON + CSV + `LICENSE` to a local `./exports` directory and nothing uploads them anywhere, so
there are no stable public URLs and no minimum-record floor guarding what gets published; DAOIP-5
`grantPools` export adapter. The write API, auth, verification, dedup, and analytics are M3+ (see
`docs/data-model.md`).

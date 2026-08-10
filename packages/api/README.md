# @the-rfp-hub/api

The public **`/v1/` read API** for the RFP Hub — an unauthenticated Fastify + Postgres service that
serves [RFP Hub Standard v1.0.0](../standard) objects, backed by a 100+ entry seed dataset ingested
from a configurable upstream funding-map source and repeatable open-data exports (CC0). This is
milestone **M2**.

## Endpoints (`/v1`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/opportunities` | List (thin projection). Filters: `fundingType`, `status`, `ecosystem`, `category`, `organization`, `minAward`, `maxAward`, `deadlineAfter`, `deadlineBefore`, `q`; `sort` (`nextDeadlineAt\|opensAt\|postedAt\|updatedAt\|createdAt`), `order`, `page`, `limit`. |
| `GET` | `/v1/opportunities/:id` | One full Standard object (e.g. `fundingmap:1459`); `404` if not found. |
| `GET` | `/v1/opportunities/schema` | The canonical v1.0.0 JSON Schema, served as `application/schema+json` — semantically identical to the published file (re-serialized, so key order may differ from the raw bytes). |
| `GET` | `/v1/stats` | Totals + breakdowns by funding type/status/ecosystem. |
| `GET` | `/v1/health` | Liveness + DB readiness. |
| `GET` | `/v1/docs` | Swagger UI (OpenAPI 3.1). |

Public reads return only `review_status = 'approved' AND is_listed` rows. List responses omit
`fundingDetails` — the type-specific details slot, a tagged union whose own required `fundingType`
tag names its shape — as a delivery optimization (see the Standard's FIELDS.md); the detail
endpoint serves it in full. Storage keeps the payload **tag-free** in the `type_data` jsonb column
(the tag is derivable from `funding_type`) and reattaches the tag on read, so the served tag can
never disagree with the top-level discriminator.

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
pnpm --filter @the-rfp-hub/api export        # publish the dataset (to ./exports by default)
```

Config is read from the environment (see `.env-example`): `DATABASE_URL`, `PORT`, `HOST`, the
seed source (`SOURCE_API_URL`, `SOURCE_SYSTEM`, `SOURCE_PROGRAM_URL_BASE`), and the open-data
export (`EXPORT_MIN_COUNT`, `S3_*`, `AWS_*` — see below).

## Open-data export

`pnpm export` publishes the public dataset (`review_status = 'approved' AND is_listed`, ordered
by public id) under **CC0-1.0**. Every run publishes **five** objects, in this order:

| # | Object | Cache-Control | Purpose |
|---|---|---|---|
| 1 | `LICENSE` | `max-age=300` | CC0 rights sidecar (SPDX), so a bare file set is machine-detectable as CC0 without reading the JSON envelope. |
| 2 | `opportunities-<YYYY-MM-DD>-<digest>.json` | `max-age=31536000, immutable` | This run's archive. |
| 3 | `opportunities-<YYYY-MM-DD>-<digest>.csv` | `max-age=31536000, immutable` | Same data, flat. |
| 4 | `latest.json` | `max-age=300` | Stable key a consumer can hard-code. |
| 5 | `latest.csv` | `max-age=300` | Ditto. |

The order is deliberate. The **sidecar goes first**, so no data object is ever readable without its
rights notice beside it (its content is constant, so re-publishing it each run is idempotent). The
**aliases go last**, so a run that dies part-way leaves `latest.*` naming the last *complete*
dataset rather than a half-written one. Nothing makes five objects land atomically, so when a put
does fail the error names which objects were published and which one was not, and no
`dataset_snapshots` row is recorded for that run.

`<digest>` is the first 12 hex of the sha256 of the object's own bytes. That is what makes the
archive genuinely immutable, and it is the only reason the `immutable` header above is honest: one
key can never designate two different datasets, so a second run on the same UTC day — a re-run
after a partial failure, say — writes its own archive instead of overwriting the first, and a
digest recorded in `dataset_snapshots` stays true for the URL it was recorded against. A re-run
over *unchanged* data rewrites byte-identical content under the same key, so re-runs do not pile
up. The two cache policies differ on purpose: without an explicit header a CDN in front of the
bucket applies its own origin default to the moving aliases and serves the previous dataset for
that TTL, since there is no invalidation step.

Ordering by public id makes the **CSV** byte-identical across runs over unchanged data. The
**JSON** is not: its envelope stamps `generatedAt` from the clock, so an unchanged dataset yields
JSON that differs in that one field — and therefore in its digest and its archive key.

**Where** the objects land is a sink (`scripts/upload.ts`), chosen purely by whether `S3_BUCKET`
is set:

- **unset (the default)** — a local directory (`./exports`). No credentials, no network:
  `pnpm export` works offline out of the box.
- **set** — an S3 bucket, or any S3-compatible store via `S3_ENDPOINT` (which also forces
  path-style addressing). Credentials and region come from the SDK's standard `AWS_*` variables,
  and an instance role satisfies them just as well.

`dataset_snapshots` records one row per **data** format (not the sidecar), each pointing at the
**archive** — the per-run record — with its `sha256` and entry count, never at an alias, which
moves. The URL recorded is whatever the sink reports: the `S3_PUBLIC_BASE_URL` object URL, an
`s3://` URI when no public base is configured, or the local path.

`EXPORT_MIN_COUNT` (default `100`) is a floor asserted **before** anything is serialized or
published: a run below it publishes nothing and exits non-zero, rather than quietly replacing
`latest.*` with a header-only CSV after a broken seed. The same validation covers a floor passed
programmatically, so no caller gets a weaker guard than the environment variable does.

| Variable | Default | Purpose |
|---|---|---|
| `EXPORT_MIN_COUNT` | `100` | Floor below which the export publishes nothing and exits non-zero. |
| `S3_BUCKET` | — | Unset ⇒ write to `./exports`. Set ⇒ publish to this bucket. |
| `S3_PREFIX` | — | Optional key prefix inside the bucket (slashes normalized). |
| `S3_ENDPOINT` | — | Optional endpoint for an S3-compatible store; implies path-style addressing. Leave unset for AWS S3 itself. |
| `S3_PUBLIC_BASE_URL` | — | Optional public/CDN base the objects are served from; recorded in `dataset_snapshots.url`. |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | Standard AWS SDK credentials (an instance role works too). |

No bucket is provisioned, so the S3 path is exercised only against a stubbed client and
`S3_PUBLIC_BASE_URL` has no live value. Scheduling a recurring run belongs with the deployment;
the export is a plain, repeatable command.

`@aws-sdk/client-s3` is pinned to `~3.967.0` deliberately: `3.968.0` raised its own engine
requirement to Node `>=20`, and this workspace declares `>=18`. The sink issues `PutObject` and
nothing else, so the older line costs nothing. Lift the pin when the workspace's Node floor is
raised on its own merits — not silently, as a side effect of a dependency bump.

### CSV columns

The JSON export carries the full Standard object. The CSV is a **flat projection derived from the
Standard**, so the v1.0.0 re-cut is what fixes its column set:

```
id,fundingType,status,title,organization,organizationSlug,ecosystems,categories,
currency,minAward,maxAward,budget,allocated,opensAt,nextDeadlineAt,rollingDeadline,applicationUrl
```

- `organization`/`organizationSlug` are `operatingOrganizations[0]` — the org that actually runs
  the intake, and the one to display. Sponsors are a separate role and are **not** flattened into
  the display columns; read `sponsoringOrganizations` in the JSON export for those.
- `categories` survived the closed core; `networks` and `tags` did not, so there are no `networks`
  or `tags` columns.
- **One `currency` column** denominates every amount column in the row (`minAward`, `maxAward`,
  `budget`, `allocated`) — the Standard permits exactly one currency per document, so a
  per-amount currency column would be unrepresentable noise.
- `nextDeadlineAt` + `rollingDeadline` flatten `deadlines[]`: the earliest upcoming *fixed*
  deadline, plus a boolean so a rolling program is distinguishable from one that simply has no
  upcoming date. The full array is in the JSON export.
- Multi-valued columns (`ecosystems`, `categories`) are `|`-joined. Any cell opening with
  `= + - @` or a tab/CR is prefixed with `'` to neutralize spreadsheet formula injection from
  untrusted upstream text.

The export test asserts this header **verbatim**, not as a prefix, so a later change to the core
cannot reshape the published dataset without a failing test.

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
  old-upstream→re-cut-Standard, query-param parsing, CSV serialization, and the export sinks
  (`upload.test.ts` — env parsing, key layout, header emission and recorded URLs against a stubbed
  S3 client, so no test needs a network or credentials).
- **integration** (`test/integration`, gated on `DATABASE_URL`): each endpoint via `app.inject()`
  against Postgres, with isolated self-cleaning fixtures.

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

## Deferred (later in M2 / beyond)

Cloud deploy; provisioning the public export bucket and running the export on a schedule (the
exporter publishes to a bucket when `S3_BUCKET` is set, but none is deployed, so `S3_PUBLIC_BASE_URL`
has no live value and scheduling lives with the deployment); full OpenAPI live-spec test suite;
TS/Python/curl client examples; DAOIP-5 `grantPools` export adapter. The write API, auth,
verification, dedup, and analytics are M3+ (see `docs/data-model.md`).

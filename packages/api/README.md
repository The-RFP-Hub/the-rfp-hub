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
pnpm --filter @the-rfp-hub/api export        # write the open-data export to ./exports
```

Config is read from the environment (see `.env-example`): `DATABASE_URL`, `PORT`, `HOST`, the
seed source (`SOURCE_API_URL`, `SOURCE_SYSTEM`, `SOURCE_PROGRAM_URL_BASE`), and the export floor
(`EXPORT_MIN_COUNT`, see below).

## Open-data export

`pnpm export` writes the public dataset (`review_status = 'approved' AND is_listed`, ordered by
public id) to `./exports` under **CC0-1.0**. Every run writes **five** files, in this order:

| # | File | Purpose |
|---|---|---|
| 1 | `LICENSE` | CC0 rights sidecar (SPDX), so a bare file set is machine-detectable as CC0 without reading the JSON envelope. |
| 2 | `opportunities-<YYYY-MM-DD>-<digest>.json` | This run's archive. |
| 3 | `opportunities-<YYYY-MM-DD>-<digest>.csv` | Same data, flat. |
| 4 | `latest.json` | Stable name a consumer can hard-code. |
| 5 | `latest.csv` | Ditto. |

The order is deliberate. The **sidecar goes first**, so no data file is ever readable without its
rights notice beside it (its content is constant, so re-writing it each run is idempotent). The
**aliases go last**, so a run that dies part-way leaves `latest.*` naming the last *complete*
dataset rather than a half-written one. Nothing makes five files land atomically, so when a write
does fail the error names which files were written and which one was not, and no
`dataset_snapshots` row is recorded for that run.

`<digest>` is the first 12 hex of the sha256 of the file's own bytes. That is what makes the
archive genuinely immutable: one name can never designate two different datasets, so a second run
on the same UTC day — a re-run after a partial failure, say — writes its own archive instead of
overwriting the first, and a digest recorded in `dataset_snapshots` stays true for the name it was
recorded against. A re-run over *unchanged* data rewrites byte-identical content under the same
name, so re-runs do not pile up.

Ordering by public id makes the **CSV** byte-identical across runs over unchanged data. The
**JSON** is not: its envelope stamps `generatedAt` from the clock, so an unchanged dataset yields
JSON that differs in that one field — and therefore in its digest and its archive name.

`dataset_snapshots` records one row per **data** format (not the sidecar), each pointing at the
**archive** — the per-run record — with its `sha256` and entry count, never at an alias, which
moves.

`EXPORT_MIN_COUNT` (default `100`) is a floor asserted **before** anything is serialized or
written: a run below it writes nothing and exits non-zero, rather than quietly replacing `latest.*`
with a header-only CSV after a broken seed. The same validation covers a floor passed
programmatically, so no caller gets a weaker guard than the environment variable does.

| Variable | Default | Purpose |
|---|---|---|
| `EXPORT_MIN_COUNT` | `100` | Floor below which the export writes nothing and exits non-zero. |

Where the files go from `./exports` is not this repo's business yet: no public bucket is deployed,
and scheduling a recurring run belongs with the deployment. The export is a plain, repeatable
command.

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
  old-upstream→re-cut-Standard, query-param parsing, CSV serialization.
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

Cloud deploy; publishing the export to a public bucket and running it on a schedule (both belong
with the deployment — no bucket is provisioned, so the export writes locally and `pnpm export` is
the whole of it here); full OpenAPI live-spec test suite; TS/Python/curl client examples; DAOIP-5
`grantPools` export adapter. The write API, auth, verification, dedup, and analytics are M3+ (see
`docs/data-model.md`).

# @the-rfp-hub/api

The public **`/v1/` read API** for the RFP Hub — an unauthenticated Fastify + Postgres service that
serves [RFP Hub Standard v1.0.0](../standard) objects, backed by a 100+ entry seed dataset loaded
from a committed corpus file, and nightly open-data exports (CC0). This is milestone **M2**.

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
pnpm --filter @the-rfp-hub/api seed test/fixtures/seed-corpus.json --strict   # 143 entries, offline
pnpm --filter @the-rfp-hub/api dev           # start the server (http://localhost:3001)
pnpm --filter @the-rfp-hub/api export        # write JSON + CSV to ./exports
```

### Configuration

Config is read from the environment (see `.env-example`) — everything is optional in development
(localhost defaults), and this table is the whole surface of the **running server**: every key
`src/config.ts` reads, and no others.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://rfphub:rfphub@localhost:5432/rfphub` | Postgres connection string. **Required in production** — with `NODE_ENV=production` the process exits non-zero at startup if unset, rather than silently using the localhost default. |
| `PORT` | `3001` | HTTP port. A set-but-unusable value — empty, whitespace-only, non-numeric, or outside `1..65535` — falls back to the default rather than binding an ephemeral port (`Number("")` is `0`, not `NaN`). |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `DB_POOL_MAX` | `10` | Max size of the pg pool. Bound this on a shared database instance, where connection budget is split across services. Defaults to pg's own default. A set-but-unusable value falls back to the default. |
| `NODE_ENV` | unset | Set to `production` to enable the `DATABASE_URL` fail-fast above. |
| `PUBLIC_BASE_URL` | `/` | The OpenAPI document's `servers[0].url`. Relative by default — correct wherever the server is reachable. Set it to the API's **own** origin (never the apex, which is the specification's origin); a trailing slash is stripped. The scheme must be `https://` for **any host that is not loopback** (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) — this value is what the published document tells every client to use, so a plaintext remote origin downgrades all of them at once. Unlike the two above, a malformed value is an error, not a fallback: `servers[0].url` is a published contract with no safe default to guess at. |

The seed is deliberately absent from that table: it is not configured through the environment at
all — it takes a corpus file as its argument. The one variable that points at an upstream is read
by the separate corpus-refresh program, and is documented with it under
[Seeding](#seeding-fetch--file--seed-file) rather than as a deployment variable.

### Process behaviour

- **CORS**: every response carries `Access-Control-Allow-Origin: *`, for `GET`/`HEAD`/`OPTIONS`
  only. This is a fully public, unauthenticated read API that never mutates, so there are no
  credentials to protect and no origin allowlist to maintain — and without the headers no browser
  client can call it at all.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` stop new connections, let in-flight requests finish and
  close the pg pool (a Fastify `onClose` hook) before exiting 0. A 10s forced-exit timeout means a
  hung close can never leave an un-killable process.

> **Migrations were regenerated for the v1.0.0 re-cut.** `src/db/migrations` starts from the
> drizzle-kit-generated `0000_recut_v1_0_0` baseline; `0001_schema_vnext_org_flip` applies the
> schema v-next changes (org-array flip, `networks`/`tags`/`extensions` removal, eligibility →
> text, the renames) forward-only on top of it. `0001` rewrites DDL but NOT pre-existing jsonb
> payloads — **after migrating a database that already has data, re-run the seed**; every row is
> re-derivable from the corpus file. Regenerate after a schema change with
> `pnpm --filter @the-rfp-hub/api db:generate`.

## Seeding: fetch → file → seed file

Acquiring data and loading data are **two programs**, because they have two different failure
modes:

| | `scripts/fetch-corpus.ts` (`pnpm corpus`) | `scripts/seed.ts` (`pnpm seed <path>`) |
|---|---|---|
| Job | page an upstream registry, neutralize, write a corpus file | read a corpus file, map, validate, upsert |
| Network | yes — the only file that fetches | **none**, by construction |
| Config | `SOURCE_API_URL` (+ optional `SOURCE_BRAND`, `CORPUS_SIZE`), env-only | one argument: the corpus path |
| Runs | by hand, when the corpus needs refreshing | CI, deploys, local dev — anywhere |
| Output | `test/fixtures/seed-corpus.json` | rows in Postgres |

```bash
# step 1 — refresh the corpus (rare, by hand; needs an upstream you can reach)
SOURCE_API_URL=https://… SOURCE_BRAND="acme,acme-labs" pnpm --filter @the-rfp-hub/api corpus

# step 2 — load a corpus file (deterministic, offline, no secrets; this is what CI runs)
pnpm --filter @the-rfp-hub/api seed test/fixtures/seed-corpus.json --strict
```

The loader is deliberately the boring half: same file in, same rows out, on any machine with a
database and no credentials. That is what lets CI prove on every PR that a clean checkout seeds
143 valid entries with nothing rejected. `SOURCE_API_URL` is read by step 1 only, straight from
the environment, and no value for it is ever committed.

The provenance namespace (`fundingmap` in `fundingmap:1459`, and the `source_system` column) is
**not** a variable: it is the `SOURCE_SYSTEM` constant in `scripts/map-program.ts`. It forms every
public id and pairs with `original_id` in a uniqueness constraint, so a missing or mistyped value
would silently rewrite every id AND break idempotency — re-seeding would insert duplicates instead
of updating. In M3 a publisher's namespace becomes a property of the publisher record rather than
one global.

A program that publishes no URL of its own gets **no `applicationUrl`**. The mapper reads
`submissionUrl`, then the program's own grants site, then its website — and then stops. It does not
fall back to the program's listing page on the platform the record was ingested from: that page is
not the program's application URL, and putting it in the field consumers read as "apply here" is a
fabrication of the same kind as inventing an organisation from a program title. In the committed
corpus, 13 of 143 records (9%) have no `applicationUrl` as a result; `applicationUrl` is optional
in the Standard, so all 143 still validate.

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
  default because a corpus is a recording of a third-party feed, so one malformed program should
  not block a 143-record seed. CI runs it on, against the committed corpus.

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

Cloud deploy + public export bucket + nightly cron; full OpenAPI live-spec test suite; DAOIP-5
`grantPools` export adapter. The write API, auth, verification, dedup, and analytics are M3+ (see
`docs/data-model.md`).

Runnable curl/TypeScript/Python client examples now live in [`examples/`](../../examples).

# @the-rfp-hub/api

The public **`/v1/` read API** for the RFP Hub — an unauthenticated Fastify + Postgres service that
serves [RFP Hub Standard v1.0.0](../standard) objects, backed by a 100+ entry seed dataset ingested
from a configurable upstream funding-map source and nightly open-data exports (CC0). This is
milestone **M2**.

## Endpoints (`/v1`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/opportunities` | List (thin projection). Filters: `fundingType`, `status`, `ecosystem`, `category`, `organization`, `minAward`, `maxAward`, `deadlineAfter`, `deadlineBefore`, `q`; `sort` (`nextDeadlineAt\|opensAt\|postedAt\|updatedAt\|createdAt`), `order`, `page`, `limit`. |
| `GET` | `/v1/opportunities/:id` | One full Standard object (e.g. `fundingmap:1459`); `404` if not found. |
| `GET` | `/v1/opportunities/schema` | The canonical v1.0.0 JSON Schema, served as `application/schema+json` — semantically identical to the published file (re-serialized, so key order may differ from the raw bytes). |
| `GET` | `/v1/feeds/opportunities.atom` | Atom 1.0 feed of the most recently published opportunities (`application/atom+xml`). `limit` (1..100, default 50), `status`. |
| `GET` | `/v1/feeds/opportunities.rss` | The same feed as RSS 2.0 (`application/rss+xml`). |
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

### Feeds (Atom 1.0 and RSS 2.0)

`/v1/feeds/opportunities.atom` and `/v1/feeds/opportunities.rss` are the same content in the two
syndication formats: the newest `limit` opportunities (default 50, max 100) ordered by when the Hub
first published them (`createdAt desc`; `postedAt`, the funder's own announcement date, is carried
on each entry as `published` but is not the sort key), drawn through the same public read as
`/v1/opportunities`, so a pending or unlisted record can never surface in one. They accept exactly
two parameters — `limit` and `status` — under the same strict contract as the list endpoint, because
a feed URL is a subscription somebody saves for years and a typo in it has to fail loudly rather
than quietly return everything. Each entry carries
the title, the `applicationUrl` (or, for a record without one, its own `/v1/opportunities/{id}`
URL), a plain-text summary of the description, the funding type and ecosystems as categories, and
the operating organization as the author — `dc:creator` in RSS, whose own `<author>` element is
defined as an email address. Every document is served with a strong, content-derived `ETag` and
`Cache-Control: public, max-age=300, must-revalidate`, so a reader that polls with `If-None-Match`
gets a `304` and no body — an EMPTY feed included, whose own timestamp is a fixed constant rather
than the clock, so identical data hashes identically there too. The XML is written by a serializer
that escapes by construction (`src/modules/shared/xml.ts`), never by string concatenation.

Discovery: the service-info document at `/` lists both feeds under `feeds` (relation, media type,
href — the same three facts an HTML `<link rel="alternate">` would carry, for an API that serves no
HTML), the endpoints are documented in Swagger UI at `/v1/docs` under the **feeds** tag, and each
document points at itself with an atom `link rel="self"`.

> **Set `PUBLIC_BASE_URL` before you publish a feed URL to anyone.** Entry identity (`atom:id`, RSS
> `guid`) is derived from the record id: `<PUBLIC_BASE_URL>/v1/opportunities/{id}` when a base URL
> is configured, and the stable-but-not-dereferenceable `urn:rfphub:opportunity:{id}` when it is
> not — this API never derives its published identity from a request's `Host` header. Both forms
> are stable, but they are not the *same* identifier, so configuring the base URL afterwards makes
> every subscriber see the whole feed as new exactly once.
>
> RSS is stricter than Atom about the link elements, and the fallback follows it: RSS 2.0 requires
> the data in URL-valued elements — including the channel's **required** `<link>` — to begin with an
> IANA-registered URI scheme, so with the relative `/` default those elements carry the same
> `urn:rfphub:…` values as the identifiers rather than site-relative paths, and the document stays
> conformant in both configurations. What an unconfigured deployment loses is dereferenceability,
> not validity. Atom needs no equivalent: RFC 4287 permits a relative IRI reference in
> `link/@href`, and `atom:id` already falls back to an absolute `urn:` IRI.

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
(localhost defaults), and this table is the whole surface: every key `src/config.ts` and
`scripts/*.ts` read, and no others.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://rfphub:rfphub@localhost:5432/rfphub` | Postgres connection string. **Required in production** — with `NODE_ENV=production` the process exits non-zero at startup if unset, rather than silently using the localhost default. |
| `PORT` | `3001` | HTTP port. A set-but-unusable value — empty, whitespace-only, non-numeric, or outside `1..65535` — falls back to the default rather than binding an ephemeral port (`Number("")` is `0`, not `NaN`). |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `DB_POOL_MAX` | `10` | Max size of the pg pool. Bound this on a shared database instance, where connection budget is split across services. Defaults to pg's own default. A set-but-unusable value falls back to the default. |
| `NODE_ENV` | unset | Set to `production` to enable the `DATABASE_URL` fail-fast above. |
| `PUBLIC_BASE_URL` | `/` | The OpenAPI document's `servers[0].url`. Relative by default — correct wherever the server is reachable. Set it to the API's **own** origin (never the apex, which is the specification's origin); a trailing slash is stripped. The scheme must be `https://` for **any host that is not loopback** (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) — this value is what the published document tells every client to use, so a plaintext remote origin downgrades all of them at once. Unlike the two above, a malformed value is an error, not a fallback: `servers[0].url` is a published contract with no safe default to guess at. It also mints the feeds' entry identifiers and links — see [Feeds](#feeds-atom-10-and-rss-20). |
| `SOURCE_API_URL` | — | Upstream funding-map registry API the seed loader ingests from. |
| `SOURCE_SYSTEM` | `fundingmap` | Provenance namespace stamped on seeded entries. |
| `SOURCE_PROGRAM_URL_BASE` | — | Last-resort `applicationUrl` base for a program with no submission/website URL. |

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
  old-upstream→re-cut-Standard, query-param parsing, CSV serialization, and the feed serializer —
  escaping, entry mapping and both document formats, every assertion made through an independent
  strict XML parser (`test/helpers/xml.ts`) so a malformed document fails before any element check.
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

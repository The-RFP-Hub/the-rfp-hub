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
pnpm --filter @the-rfp-hub/api export        # write the open-data export to ./exports
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
| `EXPORT_MIN_COUNT` | `100` | Floor below which `pnpm export` writes nothing and exits non-zero (see [Open-data export](#open-data-export)). A negative or fractional value is an error, not a fallback: silently widening a guard would defeat the guard. |

### Process behaviour

- **CORS**: every response carries `Access-Control-Allow-Origin: *`, for `GET`/`HEAD`/`OPTIONS`
  only. This is a fully public, unauthenticated read API that never mutates, so there are no
  credentials to protect and no origin allowlist to maintain — and without the headers no browser
  client can call it at all.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` stop new connections, let in-flight requests finish and
  close the pg pool (a Fastify `onClose` hook) before exiting 0. A 10s forced-exit timeout means a
  hung close can never leave an un-killable process.

## Open-data export

`pnpm export` writes the public dataset (`review_status = 'approved' AND is_listed`, ordered by
public id) to `./exports` under **CC0-1.0**. Every run writes **six** files, in this order:

| # | File | Purpose |
|---|---|---|
| 1 | `LICENSE` | CC0 rights sidecar (SPDX), so a bare file set is machine-detectable as CC0 without reading the JSON envelope. |
| 2 | `opportunities-<YYYY-MM-DD>-<digest>.json` | This run's archive. |
| 3 | `opportunities-<YYYY-MM-DD>-<digest>.csv` | Same data, flat. |
| 4 | `latest.json` | Stable name a consumer can hard-code. |
| 5 | `latest.csv` | Ditto. |
| 6 | `latest.manifest.json` | The run's single authoritative pointer: a run id, and the href + full sha256 of both archives. |

The order is deliberate. The **sidecar goes first**, so no data file is ever readable without its
rights notice beside it (its content is constant, so re-writing it each run is idempotent). The
**aliases go after the archive they alias**, so a run that dies part-way leaves `latest.*` naming
the last *complete* dataset rather than a half-written one. The **manifest goes last and alone**,
because its single rename is the instant the run becomes published. Nothing makes six files land
atomically, so when a write does fail the error names which files were written and which one was
not, and no `dataset_snapshots` row is recorded for that run.

### The alias pair

`latest.json` and `latest.csv` are meant to be read together, so a run must not leave them on
different datasets for any longer than it has to. Two independently named files cannot be replaced
atomically as a pair on POSIX; what staging buys is that the window shrinks from two full file
writes to two adjacent `rename(2)` calls, and that every predictable failure now lands before either
rename.

So the pair is **staged and then promoted**. Both payloads are written to temp files beside their
destinations and `fsync`ed first, both destinations are checked, and only then are the two renames
issued back to back — and `rename` is atomic per file, so no reader ever sees a partial alias. Every
way an alias write realistically fails — a full disk, a read-only directory, a serialization error,
a destination that is not a file — now fails while the previous pair is still whole and nothing has
been promoted; the temps are cleaned up and the run exits non-zero. What is left between the two
renames is a pair of metadata operations on bytes that are already `fsync`ed, in a directory whose
own `fsync` has been attempted, onto destinations that are already checked, and a failure even
*there* is not silent: it reports that the two aliases may name different runs and that re-running
repairs them.

A reader that fetches `latest.json` and `latest.csv` as two separate requests can still, rarely,
catch one of each run. That window is **minimized, not eliminated**, and no rearrangement of the
promotion code closes it — it is a property of the reader resolving two mutable names, not of the
writer. Consumers that need a guaranteed-consistent pair read the manifest instead.

### The manifest

`latest.manifest.json` is the export's **single authoritative pointer**, and the one file whose
replacement is genuinely atomic: it is staged and promoted with **one** `rename(2)`, so there is no
gap for a reader to fall into.

```json
{
  "specVersion": "1.0.0",
  "license": "CC0-1.0",
  "runId": "9f2c…",
  "generatedAt": "2026-08-11T09:41:07.512Z",
  "count": 142,
  "artifacts": [
    { "format": "json", "href": "opportunities-2026-08-11-<digest>.json", "sha256": "<64 hex>", "count": 142 },
    { "format": "csv",  "href": "opportunities-2026-08-11-<digest>.csv",  "sha256": "<64 hex>", "count": 142 }
  ]
}
```

The consumer contract is three steps, and the third is what makes it a proof rather than a promise:

1. **Resolve the pointer once.** Fetch `latest.manifest.json` a single time and hold the result.
   Resolving it once per artifact reintroduces the window it exists to remove.
2. **Fetch what it names.** The `href`s are the digest-named archives, which are immutable — an
   older manifest keeps working, because nothing overwrites what it points at.
3. **Verify.** Each artifact carries the *full* sha256 of its bytes, so a consumer checks what it
   downloaded rather than trusting it. Two artifacts listed under one `runId`, each verified against
   its recorded digest, is a pair that is provably one run's.

`runId` is minted fresh per run. It lives only in the manifest: the JSON envelope and the 17-column
CSV are unchanged, so an unchanged CSV stays byte-stable across runs and no consumer's parser
breaks. That byte-stability is also exactly why the aliases cannot identify a run on their own, and
why the identifier had to go somewhere neither payload could carry it.

This is also the only shape that survives a move to object storage, where `rename(2)` does not
exist and a single-key pointer is the only atomic primitive available.

`<digest>` is the first 12 hex of the sha256 of the file's own bytes. That makes the archive
*effectively* immutable: the name is derived from the content, so a second run on the same UTC day —
a re-run after a partial failure, say — writes its own archive instead of overwriting the first, and
a digest recorded in `dataset_snapshots` stays true for the name it was recorded against. A re-run
over *unchanged* data rewrites byte-identical content under the same name, so re-runs do not pile
up. It is a 48-bit content-addressed name, not a storage-enforced write-once guarantee: the name is
scoped by UTC date and carries 48 bits of the digest, which puts an accidental same-day collision
far outside anything this export will produce, but nothing in the code would refuse one. The
manifest carries the full 256-bit digest for consumers that want to verify rather than address.

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

Cloud deploy; publishing the export to a public bucket and running it on a schedule (both belong
with the deployment — no bucket is provisioned, so the export writes locally and `pnpm export` is
the whole of it here); full OpenAPI live-spec test suite; DAOIP-5 `grantPools` export adapter. The
write API, auth, verification, dedup, and analytics are M3+ (see `docs/data-model.md`).

Runnable curl/TypeScript/Python client examples now live in [`examples/`](../../examples).

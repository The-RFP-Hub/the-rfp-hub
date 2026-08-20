# @the-rfp-hub/api

The public **`/v1/` read API** for the RFP Hub — an unauthenticated Fastify + Postgres service that
serves [RFP Hub Standard v1.0.0](../standard) objects, backed by a curated 174-entry dataset
committed to this repository, and repeatable open-data exports (CC0). This is milestone **M2**.

## Endpoints (`/v1`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/opportunities` | List (thin projection). Filters: `fundingType`, `status`, `ecosystem`, `category`, `organization`, `minAward`, `maxAward`, `deadlineAfter`, `deadlineBefore`, `q`; `sort` (`nextDeadlineAt\|opensAt\|postedAt\|updatedAt\|createdAt`), `order`, `page`, `limit`. |
| `GET` | `/v1/opportunities/:id` | One full Standard object (e.g. `fundingmap:1459`); `404` if not found. |
| `GET` | `/v1/opportunities/schema` | The canonical v1.0.0 JSON Schema, served as `application/schema+json`, byte-for-byte as the package ships it. A convenience alias of the canonical route below; the `$id` it carries names the canonical URL, not this one. |
| `GET` | `/v1/feeds/opportunities.atom` | Atom 1.0 feed of the most recently published opportunities (`application/atom+xml`). `limit` (1..100, default 50), `status`. |
| `GET` | `/v1/feeds/opportunities.rss` | The same feed as RSS 2.0 (`application/rss+xml`). |
| `GET` | `/v1/export/opportunities.json` | The **whole** public dataset in one response (`application/json`), in the published export envelope. Sent as an attachment; no pagination, no parameters. |
| `GET` | `/v1/export/opportunities.csv` | The same dataset as the published flat CSV projection (`text/csv`). |
| `GET` | `/v1/stats` | Totals + breakdowns by funding type/status/ecosystem. |
| `GET` | `/v1/health` | Liveness + DB readiness. |
| `GET` | `/v1/docs` | Swagger UI (OpenAPI 3.1). |

### The spec's own documents (unversioned, at the root)

Every identifier the Standard publishes is an absolute URL on `ethrfps.app`, and each one is
served here at exactly the path it names — deliberately **not** under `/v1/`: these are the
spec's identifiers, not API resources, and an identifier must not carry an API version. Bytes
are the package's own, served verbatim (a consumer that hashes the response gets the same digest
as one that hashes the file). See [`adr/0007`](../../adr/0007-canonical-domain-and-spec-identity.md).

| Method | Path | Media type |
|---|---|---|
| `GET` | `/schemas/v1.0.0/opportunity.schema.json` | `application/schema+json` |
| `GET` | `/schemas/v1.0.0/context.jsonld` | `application/ld+json` |
| `GET` | `/schemas/index.json` | `application/json` |
| `GET` | `/meta/rfphub-schema.meta.json` | `application/schema+json` |
| `GET` | `/registries/entry.schema.json` | `application/schema+json` |

Each carries an explicit cache policy and a strong `ETag` (send `If-None-Match` for a `304`).
`/schemas/v<version>/**` is `public, max-age=31536000, immutable` — the version is in the path and
the directory is frozen, so those bytes can never change at that URL. Everything whose URL carries
no version, including the `/v1/opportunities/schema` alias, is `public, max-age=3600,
must-revalidate`. No `Last-Modified`: the only timestamp available is the build's, and it changes
for bytes that did not.

These resolve once the apex is routed to this service — `ethrfps.app` is
registered and delegated already, but it points at registrar URL forwarding rather than here. Spec resolution therefore rides this service's uptime for now; the recorded end
state is the package directory on object storage behind a CDN, which retires these routes
without any identifier changing.

#### The rest of the publication tree

The five URLs above are the ones the Standard *mints an identifier for*. The API also mirrors the
**whole of the three directories they live in**, read-only, at the paths the package's own layout
gives them — because `schemas/v1.0.0/STATUS.md` says the identifiers mirror "this package's own
directory layout", and a tree that reproduces the layout for five files and `404`s the rest is a
shortlist, not a mirror. The served documents cross-link (`FIELDS.md` → `./context.jsonld`,
`CROSSWALK.md` → `./opportunity.schema.json`, both → `../../registries/…`), and those links resolve
against the URL the document was fetched from.

| Path | Media type |
|---|---|
| `/schemas/index.json` | `application/json` |
| `/schemas/v1.0.0/opportunity.schema.json` | `application/schema+json` |
| `/schemas/v1.0.0/context.jsonld` | `application/ld+json` |
| `/schemas/v1.0.0/{FIELDS,CROSSWALK,BENCHMARK,STATUS}.md` | `text/markdown; charset=utf-8` |
| `/schemas/v1.0.0/FROZEN` | `text/plain; charset=utf-8` |
| `/schemas/v1.0.0/examples/*.json` (30 documents) | `application/json` |
| `/meta/rfphub-schema.meta.json` | `application/schema+json` |
| `/registries/entry.schema.json` | `application/schema+json` |
| `/registries/{index,deadline-labels,program-models,bounty-severities,bounty-asset-types}.json` | `application/json` |

Everything above is `GET`/`HEAD`, `200` and never a redirect, with `Access-Control-Allow-Origin: *`
(browsers fetch contexts and `$ref`s cross-origin) and the same cache policy and `ETag` rules as
the identifiers. The directories the load balancer forwards to the apex are exactly these three,
so `conformance/` is deliberately **not** served: it ships in the npm package for implementers to
run offline, and no identifier names it.

**Identifiers versus locators.** `https://ethrfps.app/…` stays the canonical identifier of every
one of these documents — that is what an `$id` or a `@context` names, and it does not change when
the serving arrangement does; `https://api.ethrfps.app/…` is merely a locator that happens to hold
the same bytes today, and the apex will serve these same paths when the project site ships.

There are **no directory listings**: `GET /schemas/v1.0.0/` is a `404`. The package ships no index
for that directory, and synthesising one would put an API-shaped document — whose format could
change — inside a directory whose entire promise is that its bytes cannot. `/schemas/index.json` is
the shipped, machine-readable entry point.

These routes are deliberately **absent from the OpenAPI document**, which describes the `/v1`
surface: forty-odd operations differing only in path would outnumber the API's real ones in the
docs UI and in every generated client, and they describe files belonging to the identifier
authority rather than to `servers[0]`. The five identifiers stay documented; the mirror is
documented here. Implementation: `src/modules/shared/spec-artifacts.ts` (the directory walk) and
`src/modules/routes/spec-artifacts/` (one route per file), asserted in
`test/integration/spec-artifacts.test.ts`.

#### Hostnames: what the apex serves, and what it does not

[`adr/0007`](../../adr/0007-canonical-domain-and-spec-identity.md) reserves the apex for the spec
— *"no service is ever mounted here"* — and that reservation is the entire reason `/schemas/`,
`/meta/`, `/registries/` and `/ns/` are safe as permanent identifier paths. Routing the apex to
this service **wholesale** would not reserve it; it would publish the whole `/v1` API at
`ethrfps.app`, and every future apex path would become API collision surface.

| Host | What this service answers |
|---|---|
| `ethrfps.app` (and `www.`) | The publication tree above — the five canonical documents and the rest of `/schemas/`, `/meta/`, `/registries/`. Everything else — `/v1/**`, `/v1/docs`, the service-info root — is `404`. |
| `api.ethrfps.app`, `api-staging.ethrfps.app`, anything else | Everything, including the publication tree. An identifier that resolves on only one hostname is not more reserved, just harder to serve. |

This is enforced in the application (`src/plugins/apex-host.ts`, an `onRequest` allowlist derived
from the Standard's own `baseUrl`) and asserted with both `Host` headers in
`test/integration/apex-host.test.ts`. **The infrastructure must enforce the same contract
independently**: the apex listener rule belongs path-scoped to `/schemas/*`, `/meta/*` and
`/registries/*`, so apex traffic for `/v1` never reaches a task at all. Two layers, because the
application rule survives an infrastructure edit and the infrastructure rule survives a routing
change here.

The apex `404` says where the API actually is, and takes that from `PUBLIC_BASE_URL` — the same
value the OpenAPI document publishes, because it is the same fact and a second variable for it
would only be a way for a deployment to contradict itself. At its `/` default nothing has been
configured, so the message says the API is on a different host without naming one. What it never
does is name the apex: sending a caller back to the hostname that just refused them is a redirect
loop written in prose.

### JSON-LD

`application/json` opportunity responses (list and detail, `200` only) carry

```
Link: <https://ethrfps.app/schemas/v1.0.0/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"
```

so a conformant JSON-LD 1.1 processor reads them as linked data with no `@context` in the
payload. It is deliberately absent from the `application/schema+json` and `application/ld+json`
routes above and from error bodies: a processor MUST follow an advertised context on any `+json`
type that is not `ld+json`, so advertising there would instruct it to read a JSON Schema document
as an opportunity.

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
pnpm --filter @the-rfp-hub/api seed data/seed-corpus.json --strict   # 174 entries, offline
pnpm --filter @the-rfp-hub/api dev           # start the server (http://localhost:3001)
pnpm --filter @the-rfp-hub/api export        # write the open-data export to ./exports

# the same six files, sourced from a running API instead of the database (no DATABASE_URL needed)
EXPORT_API_URL=http://localhost:3001 pnpm --filter @the-rfp-hub/api export:api
```

### Configuration

Config is read from the process environment (see `.env-example`) — everything is optional in
development (localhost defaults). `src/config.ts` also loads a `.env` from the working directory,
which for every `pnpm` script here is `packages/api`. **A real environment variable always wins**:
dotenv never overwrites something that already reached the process, so an exported shell variable
or a deployment's injected value overrides the file rather than the other way round. With neither,
the built-in defaults apply and say so on stderr.

This table is the deployment/runtime surface: every server key read by
`src/config.ts`, plus the exporter's `EXPORT_MIN_COUNT`. Seed and converter controls are
maintainer tooling documented with their commands: `SEED_STRICT` under
[Seeding](#seeding-a-static-in-repo-corpus), and `SOURCE_API_URL`/`SOURCE_BRAND`/`CORPUS_SIZE`
under [the converter's README](./tools/converter/README.md).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://rfphub:rfphub@localhost:5432/rfphub` | Postgres connection string. **Required in production** — with `NODE_ENV=production` the process exits non-zero at startup if unset, rather than silently using the localhost default. |
| `PORT` | `3001` | HTTP port. A set-but-unusable value — empty, whitespace-only, non-numeric, or outside `1..65535` — falls back to the default rather than binding an ephemeral port (`Number("")` is `0`, not `NaN`). |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `DB_POOL_MAX` | `10` | Max size of the pg pool. Bound this on a shared database instance, where connection budget is split across services. Defaults to pg's own default. A set-but-unusable value falls back to the default. |
| `NODE_ENV` | unset | Set to `production` to enable the `DATABASE_URL` fail-fast above. |
| `PUBLIC_BASE_URL` | `/` | The OpenAPI document's `servers[0].url`. Relative by default — correct wherever the server is reachable. Set it to the API's **own** origin (never the apex, which is the specification's origin); a trailing slash is stripped. The scheme must be `https://` for **any host that is not loopback** (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) — this value is what the published document tells every client to use, so a plaintext remote origin downgrades all of them at once. Unlike the two above, a malformed value is an error, not a fallback: `servers[0].url` is a published contract with no safe default to guess at. It also mints the feeds' entry identifiers and links — see [Feeds](#feeds-atom-10-and-rss-20). It is read by the apex reservation too, which uses it to tell a caller it refused where the API is; the `/` default names no host, so the message says so plainly instead. |
| `EXPORT_MIN_COUNT` | `100` | Floor below which an export writes nothing and exits non-zero (see [Open-data export](#open-data-export)). A negative or fractional value is an error, not a fallback: silently widening a guard would defeat the guard. |
| `EXPORT_API_URL` | — | **Required by `pnpm export:api`**, ignored by everything else: the bare origin of the API to publish, e.g. `https://api.example.org`. Must be `https://` for any host that is not loopback — this value decides what gets published, so plaintext would let the network path choose the dataset. A path, query or fragment is an error rather than being trimmed off. |
| `EXPORT_OUT_DIR` | `exports` | Where `pnpm export:api` writes its six files. Relative paths resolve against the working directory. |

The seed is deliberately absent from that table: its corpus is an argument, not an environment
pointer. The one variable it reads, `SEED_STRICT=1`, only mirrors the `--strict` flag. Nothing in
`src/` or `scripts/` reads a pointer at any upstream; the one variable that does is read by
offline tooling and documented with it, under
[the converter's README](./tools/converter/README.md), rather than as a deployment variable.

### Process behaviour

- **CORS**: every response carries `Access-Control-Allow-Origin: *`, for `GET`/`HEAD`/`OPTIONS`
  only. This is a fully public, unauthenticated read API that never mutates, so there are no
  credentials to protect and no origin allowlist to maintain — and without the headers no browser
  client can call it at all.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` stop new connections, let in-flight requests finish and
  close the pg pool (a Fastify `onClose` hook) before exiting 0. A 10s forced-exit timeout means a
  hung close can never leave an un-killable process.

### One-off tasks

`migrate`, `seed` and `export` are built into the container image as their own entry points, so a
deployment can create its schema and load its data with the **same image** it serves from — no
`tsx`, no TypeScript sources, no second image. Each is a plain command a one-off task runner can
launch (a task-runner API, `docker run`, `kubectl run`), overriding the image's server command:

```bash
node packages/api/dist/migrate.js
node packages/api/dist/seed.js packages/api/data/seed-corpus.json --strict
node packages/api/dist/export.js
```

`DATABASE_URL` comes from the **task environment**, exactly as it does for the server: the image's
baked `.env` if there is one, and the task definition's own environment on top of it — a real
environment variable always wins over the file (see [Configuration](#configuration)). Nothing here
takes a connection string on the command line.

Notes on each:

- **migrate** applies pending Drizzle migrations from `src/db/migrations`, which the image carries
  as SQL files (they are data, not code, so nothing bundles them). The entry point resolves them
  relative to its own module, so it works from any working directory.
- **seed** takes the corpus as its one argument — the same committed file, run offline, no network
  and no credentials, so a container run loads exactly what CI loads. Under `--strict` a single
  schema-invalid document fails the run; a repeated id fails it with or without the flag; and the
  ≥100 floor is asserted **before the first write**, so a short or broken run leaves the database
  untouched. The write phase is one transaction. See
  [Seeding](#seeding-a-static-in-repo-corpus).
- **export** writes its six files to `./exports`, a directory the image creates and hands to the
  `node` user. Mount a volume over it to keep the output past the task's lifetime; the floor
  (`EXPORT_MIN_COUNT`) applies as usual. See [Open-data export](#open-data-export).

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
**aliases go after the archive they alias**, so a run that dies part-way leaves each `latest.*`
name pointing at a *complete* dataset rather than a half-written one — though not necessarily at
the same run; see [The alias pair](#the-alias-pair). The **manifest goes last and alone**,
because its single rename is the instant the run becomes published. Nothing makes six files land
atomically, so when a write does fail the error names which files were written and which one was
not, and no `dataset_snapshots` row is recorded for that run.

### Two sources, one writer, one format

The export has two **sources** and exactly one **writer**. The writer
(`scripts/export-writer.ts`) takes records and writes the six files; it opens no connection and
knows nothing about where its input came from. Everything above about *publishing files* — the
digests, the archive names, the floor, the promotion order, the manifest — is its single
implementation, so neither source can drift from the published shape:

| Command | Source | Reads | Records |
|---|---|---|---|
| `pnpm export` | `scripts/export.ts` | the database, through `OpportunityService` | writes a `dataset_snapshots` row per format |
| `pnpm export:api` | `scripts/export-from-api.ts` | a deployed `/v1/` API over HTTP | nothing — there is no database on this path |

The **format** is one level below that, in `src/modules/shared/export-format.ts`: the published
order (by `id` ascending, compared by code unit), the JSON envelope, and the CSV projection. It sits
in `src/` rather than beside the writer because the API serves it too — `/v1/export/*` is a live
download of the same dataset, and a server cannot import a script. So there are three consumers of
one serializer, and a record's bytes are the same in all three:

| | Produces | Floor | Ordering | Envelope |
|---|---|---|---|---|
| `pnpm export` | six files | `EXPORT_MIN_COUNT` | `orderForExport` | `toExportJson` |
| `pnpm export:api` | six files | `EXPORT_MIN_COUNT` | `orderForExport` | `toExportJson` |
| `GET /v1/export/*` | one HTTP response | **none** — see below | `orderForExport` | `toExportJson` |

The download deliberately does **not** inherit the floor. The floor exists to stop a short or
half-loaded run from replacing a good published dataset; a download replaces nothing, so an empty
database gets a valid empty envelope and a header-only CSV rather than an error. It writes no
`dataset_snapshots` row and no `LICENSE` sidecar either — nothing was published — so the CC0 grant
travels in the JSON envelope's `license` field and in the CSV operation's OpenAPI description.

The API source needs no database credentials and no network path to Postgres, which is what lets it
run from CI against a public deployment. It publishes what the public actually receives, so it is
also a **check on** the deployment rather than a second, privileged view of it. Before it writes
anything it proves four things, and fails the whole run — publishing nothing — if any of them does
not hold:

1. every page of `/v1/opportunities` was read, and the pages joined without a repeated id;
2. the number of records fetched equals `/v1/stats` `total`. Two independently computed counts
   agreeing is evidence; disagreement means a dropped page or a dataset that changed mid-walk, and
   neither is worth replacing a good export with;
3. **every** record validates against the Standard — one by one, not a sample. Advisory check-tier
   warnings are not consulted: a warning describes quality, not conformance;
4. `EXPORT_MIN_COUNT` is met. An API with no data loaded yet is exactly this case: it publishes
   nothing and exits non-zero rather than replacing `latest.*` with an empty dataset.

Records are hydrated one by one from the **detail** endpoint, at bounded concurrency, because the
list endpoint serves a thin projection that omits `fundingDetails` — a required property of the
Standard, so a list item is not a record this export could publish or even validate.

Both sources publish the same records in the same order, and their **CSV output is byte-identical**.
Their JSON differs in one respect: property order follows the source, since the API's response
serializer emits schema-declared properties first. Same data, same records, different bytes — so the
two sources' JSON archives carry different digests.

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
  "count": 174,
  "artifacts": [
    { "format": "json", "href": "opportunities-2026-08-11-<digest>.json", "sha256": "<64 hex>", "count": 174 },
    { "format": "csv",  "href": "opportunities-2026-08-11-<digest>.csv",  "sha256": "<64 hex>", "count": 174 }
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

That order is imposed by the **writer**, comparing ids by code unit, rather than taken from
whichever source produced the records: it makes the published bytes a function of the data alone.
A database orders by its own collation, which is a property of the server rather than of the
dataset, and an API list endpoint has no `id` sort key to ask for at all.

`dataset_snapshots` records one row per **data** format (not the sidecar), each pointing at the
**archive** — the per-run record — with its `sha256` and entry count, never at an alias, which
moves. It is written by the database source only, and only after the writer returns, so no row can
claim a publication that did not happen.

`EXPORT_MIN_COUNT` (default `100`) is a floor asserted **before** anything is serialized or
written: a run below it writes nothing and exits non-zero, rather than quietly replacing `latest.*`
with a header-only CSV after a broken seed. The same validation covers a floor passed
programmatically, so no caller gets a weaker guard than the environment variable does.

### Nightly publication

The export is published **into this repository**, at [`exports/`](../../exports) on the default
branch, by a scheduled workflow ([`.github/workflows/nightly-export.yml`](../../.github/workflows/nightly-export.yml)).
The job runs `pnpm export:api` against the deployed API, replaces the six files under `exports/`,
and commits them as the Actions bot. No bucket, no credentials, no infrastructure to keep alive —
and every snapshot is a commit, so what the dataset said on any past day is `git log`.

The files are served directly, over TLS, at:

```
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.json
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.csv
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.manifest.json
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/LICENSE
```

The manifest contract above is what a consumer should use: resolve
`latest.manifest.json` once, fetch the digest-named archives it lists, hash the bytes, compare.
Note that the raw host serves from a CDN with a cache of a few minutes, so a fresh commit is
visible slightly after it lands.

`exports/` holds exactly **one** run — this design keeps clones small; superseded snapshots stay in
git history rather than in the directory.

### Live download vs nightly snapshot

Two ways to get the whole dataset, serving the same bytes per record from the same serializer. They
are not interchangeable in *guarantees*, and the choice is about which guarantee you need:

| | **Live download** — `GET /v1/export/opportunities.{json,csv}` | **Nightly snapshot** — the `raw.githubusercontent.com` URLs above |
|---|---|---|
| Freshness | as of the request | up to ~24h old |
| Identity | none — nothing republishes or names this response | `runId`, digest-named archives, `latest.manifest.json` |
| Verifiable | no — there is no digest to check it against | yes — re-hash the bytes the manifest names |
| Stable over time | no — the dataset moves under it | yes — an archive URL is immutable |
| Costs | a database read and a full serialization per request | a CDN fetch; the API is not involved |
| Revalidation | `ETag` + `If-None-Match` → `304` | HTTP caching on the raw host |

Take the **live download** when you want what the Hub knows *now* — a one-off pull, a sync that
already ran this morning, a script that would otherwise page through `/v1/opportunities`. Take the
**nightly snapshot** when you need an artifact you can cite, verify or diff against later, or when
you would rather not put load on the API at all; that is the one to build a pipeline on. Both are
CC0-1.0.

Two properties of the job are worth stating plainly:

- **A green run means published AND independently verified**, never merely "ran". After pushing, the
  job polls the public raw URL until it serves the manifest it just published, then runs
  `node scripts/check-m2.mjs` against the deployment and the published export root. The checker
  re-downloads the files as any consumer would and re-hashes the archives the manifest names; a
  non-zero exit fails the job.
- **Publishing data never deploys anything.** `ci.yml` and `staging.yml` carry
  `paths-ignore: ['exports/**']` on their push triggers, so a push whose every changed file is under
  `exports/` starts neither. A push that also touches source still runs both, exactly as before.
  `production.yml` needs no such filter: it triggers only on `prod-*` tags and manual dispatch, so a
  push to the default branch cannot start it at all.

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
> re-derivable from the committed corpus. Regenerate after a schema change with
> `pnpm --filter @the-rfp-hub/api db:generate`.

## Seeding: a static, in-repo corpus

**The dataset is a repo artifact.** `data/seed-corpus.json` holds 174 finished RFP Hub Standard
v1.0.0 documents — reviewed in a pull request, versioned with the code, and diffable like any other
source file. The seed loader reads that file and nothing else:

```bash
pnpm --filter @the-rfp-hub/api seed data/seed-corpus.json --strict
```

No network, no credentials, no upstream: the same file in, the same rows out, on any machine with a
database. That is what lets CI prove on every PR that a clean checkout seeds the whole corpus with
nothing rejected. The floor is asserted **before** the first write (<100 valid fails the run with
the database untouched), and the write phase runs in one transaction, so a failure part-way through
rolls back rather than publishing a half-updated dataset.

Nothing is filtered on the way in: every document in the file reaches the gate, and **a repeated id
fails the run** — with or without `--strict`, because two documents under one id are two answers to
the same question and no loader can pick between them. The seed used to dedupe before validating,
which meant a second copy was never checked and never mentioned.

### Why the documents are already Standard

Earlier the seed ingested a foreign registry's rows and mapped them at load time. The shape a
reviewer could read was the source's, the shape that got served was the mapper's, and the two were
only ever as close as the mapper was correct. Committing finished Standard documents collapses
that: what the diff shows is what the API serves.

It also makes the data honest in a way a mapper cannot be. A mapper restates what an upstream said;
it cannot know that a program closed last month, that a budget was announced in a governance post,
or that a listing labelled `bounty` is really a hackathon. Every entry here was reconciled against
the funder's own published pages — their site, docs, blog, governance forum or code host — and
where the researched value contradicted the converted one, the researched value won. The envelope's
`note` records that, including the caveat that statuses are a point-in-time reading and go stale.

That reconciliation is evidenced by `additionalReferences` and by the dated readings written into
the descriptions — **not** by `source.verifiedAgainstSource`, which is null on all 174. That flag
records the verification-assist job, which has not run; a human pass is not the same claim and does
not get to set it.

### Refreshing it

Small corrections are ordinary edits to `data/seed-corpus.json`, reviewed like any other change.

A bulk rebuild is offline maintainer tooling in [`tools/converter/`](./tools/converter/README.md):
fetch a snapshot of an upstream registry, map it to Standard, then **curate by hand** before
anything is committed. Nothing in that directory runs at seed time, at request time, in CI or on a
deploy, and `SOURCE_API_URL` — env-only, never committed with a value — is read by exactly one file
in it.

### Ids and provenance

A document's id carries its provenance namespace, and the corpus has **two classes**:

- **`fundingmap:1459`** — converted from a snapshot of an upstream registry and then reconciled.
  `source.originalId` is that registry's own identifier, which is what the Standard means by "the
  identifier in the source system"; the public id is the namespace plus that id.
- **`curated:lido-bug-bounty`** — researched here from the funder's own published pages. There was
  never an upstream row, so there is **no `source.originalId`** and the id is a name rather than a
  foreign key. Publishing these in the upstream namespace with a synthetic numeric id would assert
  provenance they do not have, and would squat on keys that registry may later issue to something
  else.

The loader reads the namespace off the id and records it in the `source_system` column (it pairs
with `original_id` in a partial uniqueness index over the two). Taking it from the document rather
than from a constant or an env var means `source_system` can never disagree with the id consumers
already see. Re-seeding is idempotent by public id: every upsert conflicts on it.

`postedAt` follows the same rule. It means "first publicly announced **at the source**", so it may
only carry a date the source itself published. It is never the date the file was edited;
`createdAt`/`updatedAt` are the Hub timestamps and carry that. The Standard makes the field
optional and says null means unknown, so a record without one is a record whose announcement date
could not be established — not a record nobody looked at.

**125 of the 174 documents carry one.** Of the 108 researched records, 98 carry a source date — a
bug bounty's "Live Since" line, a governance topic's creation date, a launch post or a press
release. **Seven of those are archival bounds** where the funder published no announcement at all:
those records say "publicly visible by", name the first capture of the funder's own page, and the
field carries that bound. A bound is a source date, not a Hub timestamp. The other 10 researched
records are VC funds whose primary pages publish only a year, no date, or no launch history; they
carry no `postedAt` rather than a guessed timestamp.

On the converted side the field had been inherited from the upstream snapshot's own row timestamp,
byte-identical to `createdAt` on 65 of the 66 — an ingestion time, not an announcement. Those were
re-researched: **26 now carry a date the funder or organiser published** (11 exact, 13 dated launch
announcements, 2 archival bounds) and **39 carry no `postedAt` at all**, because that is what the
Standard has for unknown. Each of the 39 says in its own description what was searched.
`test/unit/seed-corpus.test.ts` asserts the rule document by document — a date, if present,
predates its own `createdAt` and never equals it — and pins the 125/98/27 split so it cannot drift.

### What the corpus contains

174 documents, all validating against v1.0.0 with zero errors: 63 bounties, 44 grants, 44
hackathons, 5 RFPs, 3 accelerators and 15 VC funds; 108 open and 66 closed; 66 converted
(`fundingmap:`) and 108 researched (`curated:`). Statuses were re-read from source during
curation, so "closed" is a
finding rather than a default. Those per-type and per-status counts are the inventory at this
commit, not a CI contract: what CI asserts is the >=130 floor, zero schema errors, unique ids, the
advisory baseline below, and the bounty split.

The corpus raises **10 advisory warnings across 8 documents**, and the exact list is pinned in
`test/unit/seed-corpus.test.ts` so a new one fails the build: 4 `unregistered-program-model`
("audit subsidy" ×2, "investment", "venture") and 6 `unregistered-deadline-label` (an RFP's
eligible-activity window ×4, a rolling solicitation's first-review date, one "results announced").
Those registries are open lists by design — a publisher's own vocabulary is valid without a schema
change — so these are the advisory tier reporting real data, not defects to launder. The one
`amount-without-currency` this list used to carry is gone, and was not silenced: that program
denominates its own budget in dollars in its own funding text, so the unit was researched rather
than guessed. Note that seed `--strict` is **schema**-strict: the gate runs with advisory checks
off, and warnings never fail a seed.

Where the honest answer is less data, the corpus carries less data:

- **Four documents carry no `applicationUrl`**, and each says in its own description why. Two
  Optimism programs were submitted through a host that no longer completes a TLS handshake, and
  their form URLs survive only as archive captures; one Polygon program's funder-branded form URL
  was never captured at all, and the only live copy of it sits on another ecosystem's branded host;
  one micro-grant program ran intake through an existing partner network rather than a public form.
  The field is optional in the Standard; leaving it absent is a fact about the program, whereas
  substituting a listing page or an archive copy would put something in the field consumers read as
  "apply here" that the funder never published.
- **27 documents carry no `fundingInfo`**, and for every one of them the absence has been chased to
  the funder's own pages and written into the record. Several are deliberate on the funder's part —
  "This is not a grant program", "Budget envelope: Open — propose your number", hackathons whose
  prizes are certificates and mentorship — and the rest are programs that fund without ever
  publishing a number. Two also lost a placeholder — a USD 1 "prize pool" and a USD 3 one — that
  had survived from a source snapshot. The two Arbitrum DDA domains joined this list when their
  budgets could not be re-evidenced: the only source for them was a third-party aggregator frozen
  at the program's Season 1/2 state, and the DAO's own governance threads size the seasons without
  publishing a remaining balance per domain. Seven newly curated VC funds also publish neither a
  check size nor a fund envelope; each record names the primary pages that were checked.

Of the 63 bounties, **62 are `security` and 1 is `task`**, and each carries exactly one
compensation shape: a security record's published ceiling is a tier table rather than a scalar
reward, because a scalar on a bug-bounty listing is a maximum and not a fee. That split and the
invariant under it are pinned by `test/unit/seed-corpus.test.ts`, so a curation pass cannot quietly
re-shape a third of the corpus.

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
  [`rfphub-validate`](../validate). **The seed loader validates every document against the schema
  before anything reaches the database** (`gateForSeed` in `scripts/seed.ts`), printing each
  rejection with its id and the rules it broke — a rejected record is never silently subtracted
  from a count. A curated file is not a trusted file: it is edited by hand, which is exactly why
  every record is re-validated on the way in. `--strict` (or `SEED_STRICT=1`) turns any rejection
  into a failed run; CI runs it on, against the committed corpus.

## Tests

- **unit** (`test/unit`, no DB): mappers round-tripped against the committed Standard examples,
  the `deadlines.ts` derivations (`nextDeadlineAt` / auto-close), the ingest normalization
  (`fundingDetails` tag stripping/reattachment, self-identification stripping), the seed's gate and
  ordering guards, the committed corpus's own contract (`seed-corpus.test.ts`), query-param
  parsing, CSV serialization, and the feed serializer — escaping, entry mapping and both document
  formats, every assertion made through an independent strict XML parser (`test/helpers/xml.ts`) so
  a malformed document fails before any element check.
- **converter** (`tools/converter/test`, no DB): the offline mapper's fidelity and its bounty-kind
  inference, on hand-built upstream fixtures. Nothing on the serving path calls it — see
  [tools/converter/README.md](./tools/converter/README.md).
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

Cloud deploy; object storage for the export (the nightly job publishes it to this repository, which
needs no bucket — the manifest's single-pointer shape is deliberately the one that survives a move
to object storage, where `rename(2)` does not exist); DAOIP-5 `grantPools` export adapter. The write API, auth, verification, dedup, and analytics are M3+ (see
`docs/data-model.md`).

Runnable curl/TypeScript/Python client examples now live in [`examples/`](../../examples).

# @the-rfp-hub/api

The public **`/v1/` read API** for the RFP Hub — an unauthenticated Fastify + Postgres service that
serves [RFP Hub Standard v1.0.0](../standard) objects, backed by a curated 142-entry dataset
committed to this repository, and repeatable open-data exports (CC0). This is milestone **M2**.

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
pnpm --filter @the-rfp-hub/api seed data/seed-corpus.json --strict   # 142 entries, offline
pnpm --filter @the-rfp-hub/api dev           # start the server (http://localhost:3001)
pnpm --filter @the-rfp-hub/api export        # write the open-data export to ./exports
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
| `PUBLIC_BASE_URL` | `/` | The OpenAPI document's `servers[0].url`. Relative by default — correct wherever the server is reachable. Set it to the API's **own** origin (never the apex, which is the specification's origin); a trailing slash is stripped. The scheme must be `https://` for **any host that is not loopback** (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) — this value is what the published document tells every client to use, so a plaintext remote origin downgrades all of them at once. Unlike the two above, a malformed value is an error, not a fallback: `servers[0].url` is a published contract with no safe default to guess at. It also mints the feeds' entry identifiers and links — see [Feeds](#feeds-atom-10-and-rss-20). |
| `EXPORT_MIN_COUNT` | `100` | Floor below which `pnpm export` writes nothing and exits non-zero (see [Open-data export](#open-data-export)). A negative or fractional value is an error, not a fallback: silently widening a guard would defeat the guard. |

The publication step has its own three (`S3_BUCKET`, `S3_PREFIX`, `AWS_REGION`), documented with
the command that reads them under [Publishing the export](#publishing-the-export) — none of them is
read by the server, and no bucket name is committed anywhere in this repo.

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

`migrate`, `seed`, `export` and `publish` are built into the container image as their own entry
points, so a deployment can create its schema, load its data and publish its dataset with the
**same image** it serves from — no `tsx`, no TypeScript sources, no second image. Each is a plain
command a one-off task runner can launch (a task-runner API, `docker run`, `kubectl run`),
overriding the image's server command:

```bash
node packages/api/dist/migrate.js
node packages/api/dist/seed.js packages/api/data/seed-corpus.json --strict
node packages/api/dist/export.js
node packages/api/dist/publish.js --dry-run
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
- **publish** uploads that directory to `S3_BUCKET` and touches no database, so it needs neither
  `DATABASE_URL` nor the migrations or corpus the other tasks read — only the export's own output
  and an identity holding `s3:PutObject`. It is the one task that must run in the *same* task as
  the export, or against the same mounted volume: it publishes what is on disk. `--dry-run` prints
  the plan and uploads nothing. See [Publishing the export](#publishing-the-export).

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

### Publishing the export

`pnpm publish:export` uploads a **finished** export directory to an S3 bucket. It runs after
`pnpm export`, shares nothing with it but the directory, and reads no database:

```bash
export S3_BUCKET=…                                   # required; never committed here
pnpm --filter @the-rfp-hub/api export
pnpm --filter @the-rfp-hub/api publish:export --dry-run   # print the plan, upload nothing
pnpm --filter @the-rfp-hub/api publish:export
```

The archive filenames come out of `latest.manifest.json`, never re-derived from today's date and a
digest: the manifest is what that run published as its own description of itself, and a publish
step with a second copy of the writer's naming rule is a publish step that can disagree with the
pointer it is uploading. Before the first upload the plan is checked whole — every file the
manifest names is on disk, and both archives hash to the `sha256` it records.

The upload order **mirrors the writer's**, and the manifest goes **last**:

| # | Key | Content type | `Cache-Control` |
|---|---|---|---|
| 1 | `LICENSE` | `text/plain` | `public, max-age=300` |
| 2 | `opportunities-<date>-<digest>.json` | `application/json` | `public, max-age=31536000, immutable` |
| 3 | `opportunities-<date>-<digest>.csv` | `text/csv` | `public, max-age=31536000, immutable` |
| 4 | `latest.json` | `application/json` | `public, max-age=300` |
| 5 | `latest.csv` | `text/csv` | `public, max-age=300` |
| 6 | `latest.manifest.json` | `application/json` | `public, max-age=300` |

A bucket has no `rename(2)` and no way to replace two keys together, so **the order is the whole
guarantee**. Uploads are sequential and fail-fast: a run that dies part-way has not replaced the
manifest, so a consumer following [the manifest contract](#the-manifest) still resolves the
previous run, whole — and the archives that run names are content-addressed, so a partial
publication cannot have overwritten them either. What a partial publication *can* leave straddling
two runs is the `latest.*` alias pair, which is the same caveat [the local writer
carries](#the-alias-pair) and the same reason the manifest exists. The error names what landed and
what did not; re-running completes the publication.

`immutable` is claimed only for the digest-named archives, whose key is derived from their own
bytes. Everything under a stable key gets the short TTL — the **manifest emphatically included**: a
long TTL there would keep serving a previous run's `generatedAt` after a publication that did
everything right, failing a ≤24h freshness check with no invalidation step to rescue it.

**Public read is a property of the bucket, not of the upload.** The bucket policy grants
`s3:GetObject` where the bucket is created; this script sets **no ACL** on anything, and the
identity it runs as needs `s3:PutObject` and nothing more. On a bucket with object ownership
enforced an ACL-bearing request is rejected outright, so an ACL here would not be harmless
belt-and-braces — it would fail every upload.

Configuration is environment-only, and **no bucket name is committed anywhere in this repo**:

| Variable | Default | Purpose |
|---|---|---|
| `S3_BUCKET` | — | **Required.** The bucket *name* — not a URI, not a path. Validated locally (3–63 chars, DNS-compatible) so a typo fails immediately instead of as an opaque SDK error. |
| `S3_PREFIX` | *(empty)* | Key prefix. Slashes are normalized: `/open-data/` and `open-data` both give keys under `open-data/`. |
| `AWS_REGION` | *(SDK default chain)* | Read only so the printed plan can name the region the upload will use. Unset falls through to the SDK's own resolution (config file, instance role). Credentials are never read by this code at all — they are the SDK's default chain, as usual. |

`--dry-run` prints the exact plan — key, content type, cache policy, byte size, order — and uploads
nothing. It needs no credentials, so it is how an operator checks a prefix layout before pointing
this at a real bucket.

Two things this deliberately does not do: it does not create, configure or police the bucket (that
is infrastructure, provisioned elsewhere), and it does not schedule itself. Recording the public
URL in `dataset_snapshots.url` is also still open — that column holds the local path the exporter
wrote, and a URL recorded *before* the upload would claim a published object that may not exist
yet.

`@aws-sdk/client-s3` is pinned to `~3.967.0`, the last release whose own `engines.node` is `>=18`;
`3.968.0` raised it to `>=20`, which this workspace does not declare. CI runs Node 22 and would
have hidden the contradiction rather than resolved it. The script issues `PutObject` and nothing
else, so the older line costs nothing — lift the pin deliberately, when the workspace raises its
Node floor on its own merits.

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

**The dataset is a repo artifact.** `data/seed-corpus.json` holds 142 finished RFP Hub Standard
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
the descriptions — **not** by `source.verifiedAgainstSource`, which is null on all 142. That flag
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

**103 of the 142 documents carry one.** All 76 researched records do: the 57 that shipped dateless
were researched one by one, and each date is written into the record it dates — a bug bounty's
"Live Since" line, a governance topic's creation date, a launch post, a press release. **Seven of
those are archival bounds** where the funder published no announcement at all: those records say
"publicly visible by", name the first capture of the funder's own page, and the field carries that
bound. A bound is a source date, not a Hub timestamp.

On the converted side the field had been inherited from the upstream snapshot's own row timestamp,
byte-identical to `createdAt` on 65 of the 66 — an ingestion time, not an announcement. Those were
re-researched: **26 now carry a date the funder or organiser published** (11 exact, 13 dated launch
announcements, 2 archival bounds) and **39 carry no `postedAt` at all**, because that is what the
Standard has for unknown. Each of the 39 says in its own description what was searched.
`test/unit/seed-corpus.test.ts` asserts the rule document by document — a date, if present,
predates its own `createdAt` and never equals it — and pins the 103/76/27 split so it cannot drift.

### What the corpus contains

142 documents, all validating against v1.0.0 with zero errors: 45 bounties, 44 grants, 44
hackathons, 5 RFPs, 3 accelerators, 1 VC fund; 76 open and 66 closed; 66 converted (`fundingmap:`)
and 76 researched (`curated:`). Statuses were re-read from source during curation, so "closed" is a
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
- **19 documents carry no `fundingInfo`**, and for every one of them the absence has been chased to
  the funder's own pages and written into the record. Several are deliberate on the funder's part —
  "This is not a grant program", "Budget envelope: Open — propose your number", hackathons whose
  prizes are certificates and mentorship — and the rest are programs that fund without ever
  publishing a number. Two also lost a placeholder — a USD 1 "prize pool" and a USD 3 one — that
  had survived from a source snapshot. The two Arbitrum DDA domains joined this list when their
  budgets could not be re-evidenced: the only source for them was a third-party aggregator frozen
  at the program's Season 1/2 state, and the DAO's own governance threads size the seasons without
  publishing a remaining balance per domain. Each record names the places that were checked.

Of the 45 bounties, **44 are `security` and 1 is `task`**, and each carries exactly one
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

Cloud deploy; **scheduling** the export/publish pair and pointing it at a provisioned bucket (the
uploader itself now ships — see [Publishing the export](#publishing-the-export) — but nothing here
runs it on a timer, and no bucket name lives in this repo); recording the published URL in
`dataset_snapshots.url`; wiring the live-spec OpenAPI compliance run into an automated suite (the
checks themselves already exist, script-only, as `pnpm check:m2` — see
[Verifying a deployment](../../README.md#verifying-a-deployment)); DAOIP-5 `grantPools` export
adapter. The write API, auth, verification, dedup, and analytics are M3+ (see
`docs/data-model.md`).

Runnable curl/TypeScript/Python client examples now live in [`examples/`](../../examples).

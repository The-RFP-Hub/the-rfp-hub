# RFP Hub

[![CI](https://github.com/The-RFP-Hub/the-rfp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/The-RFP-Hub/the-rfp-hub/actions/workflows/ci.yml)
[![code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](./LICENSE)
[![standard: CC0-1.0](https://img.shields.io/badge/standard-CC0--1.0-lightgrey.svg)](./packages/standard/LICENSE)

An open, neutral aggregation layer and **standard** for **Ethereum-ecosystem funding
opportunities** — grants, hackathons, bounties, accelerators, VC funds, and RFPs. It indexes,
verifies, and distributes opportunities through a standard format, a public API, open data
exports, and agent-friendly tooling (M2 ships these as running, tested code) — and where an entry
carries an **application link**, it sends you to the
opportunity's own submission channel to apply. (Carrying one is ingestion policy on the Hub's own
data, with named exceptions — four of the 142 seeded entries have no public application URL, each
documented in [the API README](./packages/api/README.md); the schema itself leaves
`applicationUrl` optional, so third-party documents may omit it.)

That link (`applicationUrl`) is the single link-back target in the standard, and it carries
whatever the submission channel actually is — an application portal, a form, or a forum thread
where no portal exists. The Hub is where you find the opportunity, never where you apply.

pnpm monorepo. The hand-authored **JSON Schema is the single source of truth**; TypeScript types
are generated from it, and every other format the standard does or doesn't ship is listed in
[`ARTIFACTS.md`](./packages/standard/ARTIFACTS.md).

## The Standard

The heart of the project is the **RFP Hub Standard** — a versioned, documented, validated
JSON Schema (draft 2020-12) describing a funding opportunity. It's published as
[`@the-rfp-hub/standard`](./packages/standard) (CC0-1.0) and ships generated TypeScript types.

- Schema: [`packages/standard/schemas/v1.0.0/opportunity.schema.json`](./packages/standard/schemas/v1.0.0/opportunity.schema.json)
- Field reference: [`FIELDS.md`](./packages/standard/schemas/v1.0.0/FIELDS.md)
- Status of this version (maturity, known issues): [`STATUS.md`](./packages/standard/schemas/v1.0.0/STATUS.md)
- Prior-art crosswalk (DAOIP-5 · schema.org/Grant): [`CROSSWALK.md`](./packages/standard/schemas/v1.0.0/CROSSWALK.md)
- Validated against real-world funding data: [`BENCHMARK.md`](./packages/standard/schemas/v1.0.0/BENCHMARK.md)
- What's normative vs. informative: [`NORMATIVE.md`](./packages/standard/NORMATIVE.md)

Validate anything against it:

```bash no-run
npx rfphub-validate opportunity.json
```

## Packages

| Package | npm | License | Purpose |
|---|---|---|---|
| `packages/standard` | `@the-rfp-hub/standard` | CC0-1.0 | Canonical JSON Schema, generated TS types, registries, conformance suite, migration table. Zero runtime deps. **SSoT.** |
| `packages/validate` | `rfphub-validate` | MIT | `npx rfphub-validate` CLI + typed validation library, with an advisory warning tier over the registries. |
| `packages/api` | — | MIT | Public `/v1/` REST API (Fastify + Postgres), plus the authenticated write, review and administration surfaces. |
| `packages/frontend` | — | MIT | RFP Hub frontend (Next.js) — the public directory and the publisher dashboard: submit, claim, review, keys, and per-entry analytics, one app and one deploy pipeline for both. See [`packages/frontend/README.md`](./packages/frontend/README.md). |
| `packages/client` | `@the-rfp-hub/client` | MIT | Typed HTTP client *(planned)*. |
| `packages/mcp` | `@the-rfp-hub/mcp` | MIT | MCP server + agent skill *(planned)*. |

Every package takes its *contract* from `@the-rfp-hub/standard` alone, and never reaches into
another package's internals (dependency inversion at the package level). The only non-Standard
cross-package dependency is `packages/api` → `rfphub-validate`, through that package's published
API, so the Hub validates with the same reference implementation everyone else runs.

**Two version axes.** A package's `version` is its npm distribution version and moves freely; the
**spec version** (`1.0.0`, in `specVersion` and the schema `$id`) is the data contract and moves
only under [`PROCESS.md`](./packages/standard/PROCESS.md). They are different numbers on purpose.

## Governance

The standard is governed by written process, not by whoever is around:

- [`GOVERNANCE.md`](./GOVERNANCE.md) — editors, the decision rule, review windows, appeals, and
  the list of things this project deliberately does *not* have.
- [`packages/standard/PROCESS.md`](./packages/standard/PROCESS.md) — feature stages, what
  "breaking" means operationally, deprecation, how to register a vocabulary value, the release
  checklist.
- [`adr/`](./adr) — the decision records behind the shape of the data model.

## Guides

[`docs/`](./docs) holds the handoff guides — four documents, each written for one person doing one
job, linking to the per-package detail rather than duplicating it:

- [`docs/deployment.md`](./docs/deployment.md) — what runs where, what must exist in the cloud
  account **before** the first deploy (there is no infrastructure-as-code), the required variables,
  the first-deploy sequence, rollback, the manual npm release runbook, and the three ways to deploy
  a copy of the frontend.
- [`docs/api-integration.md`](./docs/api-integration.md) — a five-minute read-only quickstart, the
  write flow from an email address to a publishing key, the scope table, and the nine contracts
  that surprise integrators.
- [`docs/publisher-onboarding.md`](./docs/publisher-onboarding.md) — for whoever operates the Hub:
  running a publisher application end to end, refusing one, revoking verification, and deciding a
  disputed claim.
- [`docs/external-deploy-test.md`](./docs/external-deploy-test.md) — the two-hour protocol that
  proves an outside developer can deploy a frontend against the public API from the docs alone.

Every shell block in those guides is marked `no-run`, `safe-read` or `staging-write`; the
convention is defined in [`docs/README.md`](./docs/README.md).

## Deploy your own copy, or install the skill

**Deploy your own copy of the frontend** with the one-click Deploy Button in
[`packages/frontend/README.md`](./packages/frontend/README.md#deploying-your-own-copy). It lives in
exactly one place on purpose — a Deploy Button URL carries the whole build configuration in its
query string, so a second copy of the button is a second configuration that drifts. The other two
paths, and the read-only limitation every copy inherits, are in
[`docs/deployment.md` §9](./docs/deployment.md#9-the-frontend-three-ways-to-deploy-a-copy).

**Install the agent skill** through any of three channels, all of which install the same directory:

```sh no-run
# 1. multi-agent installer: detects the agents you have and copies the skill into each
npx skills add The-RFP-Hub/the-rfp-hub --skill rfp-hub-funding-search

# 2. Claude Code plugin marketplace
claude plugin marketplace add The-RFP-Hub/the-rfp-hub
claude plugin install rfp-hub@rfp-hub

# 3. a plain copy into whichever agent's skill directory applies
cp -R skills/rfp-hub-funding-search ~/.claude/skills/
```

Every agent's directory, with the citation for each, is in
[`skills/README.md`](./skills/README.md).

## Repo topology

Developed as one pnpm workspace for fast iteration (the schema and its generated types move
together in a single change), and published as independent npm packages. At handoff the
packages can be split into per-component repos (`the-rfp-hub/standard`, `the-rfp-hub/validate`,
…) via `git subtree split`. The per-package `LICENSE`, `README` and `package.json` provide the
metadata for a future split. Before splitting, replace `workspace:*` dependencies with registry
ranges and verify standalone install, build and test; `packages/api` is not published.

## Develop

```bash no-run
pnpm install
pnpm codegen        # regenerate TS types from the JSON Schema
pnpm codegen:check  # fail if generated types drift from the schema (CI gate)
pnpm build          # build all packages
pnpm test           # run the test suite (vitest)
pnpm typecheck
pnpm lint           # biome
```

**Already have a dev database from M2?** It needs one upgrade before the current migrations will
apply. `packages/api/docker-compose.yml` now pins `pgvector/pgvector:pg15` instead of
`postgres:15-alpine`, because `CREATE EXTENSION vector` ships as a migration. Same major version, so
the data directory is compatible and the named volume is reused — but the C library underneath
changes with the image, and with it the collation provider. Run the script; it dumps first, refreshes
the collation version, reindexes, migrates, and compares row counts before and after:

```bash no-run
packages/api/scripts/upgrade-dev-postgres.sh
```

It takes no arguments and **refuses** anything resembling `down -v`, because the one-word-shorter
version of this operation destroys the seeded dev corpus. Details, and the escape hatch if the
collation change causes trouble, are in
[`packages/api/README.md`](./packages/api/README.md#upgrading-an-existing-dev-database-to-the-pgvector-image).

## Verifying a deployment

The milestone's completion criteria are checkable rather than assertable. `scripts/check-m2.mjs`
runs them against a live deployment — health and TLS, every operation in the *published* OpenAPI
document executed against the *live* service (including the strict-`400` negative contract), every
served document validated against the Standard, and the CC0 export's freshness and
`latest.json`/`latest.csv` pair invariant:

```bash
pnpm check:m2 --base-url https://api.example.org --export-url https://data.example.org
```

Pass/fail per criterion on stdout, a JSON report alongside, non-zero exit on any failure. Nothing
about a particular host or dataset is baked in. Run it by hand, or from any external runner, against
whichever deployment you want an answer about. See
[`scripts/m2-compliance/README.md`](./scripts/m2-compliance/README.md).

The nightly publishing job runs exactly this, against the deployment and the export it has just
pushed, and fails if it does not pass — so the job going green means *published and independently
verified*, not merely "ran". See [Open data](#open-data).

`scripts/check-m3.mjs` does the same for the write surface — the publisher lifecycle, the review
queue, the audit trail, duplicate detection, source verification, publisher analytics and the
staleness job:

```bash
pnpm check:m3 --base-url https://api.staging.example.org --namespace my-org --session-token "$SESSION"
```

**It writes**, which is why it is stricter about being allowed to run: it refuses to start without
credentials and a namespace, and refuses a target that does not look like staging unless
`--allow-production` is passed in those words. Everything it creates is prefixed `m3check-` and is
rejected and unlisted at the end. It is deliberately **not** wired into CI — CI has no deployment to
write to, and a sign-off tool needing a standing publisher credential in repository secrets would be
a worse thing to have than a tool somebody runs. See
[`scripts/m3-compliance/README.md`](./scripts/m3-compliance/README.md).

## Open data

The dataset is published to [`exports/`](./exports) on the default branch by a scheduled workflow
([`.github/workflows/nightly-export.yml`](./.github/workflows/nightly-export.yml)), under
**CC0-1.0**. No bucket and no credentials: the files are served directly, over TLS, from the
repository, and every snapshot is a commit, so what the dataset said on any past day is `git log`.

```
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.json
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.csv
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.manifest.json
```

`latest.json` and `latest.csv` are two independently named mutable files, so a consumer fetching
both can, rarely, catch one of each run. **`latest.manifest.json` is the answer to that**: it is
replaced by a single atomic operation, and it names both archives by immutable, content-addressed
filenames with the full sha256 of each. Resolve it once, fetch what it names, hash the bytes,
compare — and the pair is *provably* one run's rather than assumed to be.

The publishing job sources its data from the live API rather than from a database, validates every
record against the Standard before writing anything, and refuses to publish a dataset that is empty,
short, or inconsistent with what `/v1/stats` reports.

If you want the dataset **as of right now** rather than as of last night, the API serves the same
thing live, in one call, from the same serializer — `GET /v1/export/opportunities.json` and
`GET /v1/export/opportunities.csv`. The trade is deliberate: a live download is current but
anonymous, while a nightly snapshot is up to a day old and *verifiable* — immutable, digest-named,
and vouched for by the manifest. Build a pipeline on the snapshot; reach for the endpoint when you
want today's answer. See
[`packages/api/README.md`](./packages/api/README.md#open-data-export) for the file layout, the
manifest contract and the guarantees each one carries.

## Using the API

Runnable client examples — curl, TypeScript (zero-dependency `fetch`), and Python
(stdlib-only) — live in [`examples/`](./examples), one endpoint-by-endpoint tour each. All
three read the API's base URL from `RFPHUB_API_BASE` (default `http://localhost:3001`); see
[`packages/api/README.md`](./packages/api/README.md) to run one locally.

The [TypeScript example](./examples/typescript) installs
[`@the-rfp-hub/standard`](./packages/standard) from npm and types its responses with it, so it
doubles as a type-contract demo — CI clean-installs and typechecks it the way a consumer would.
That step covers the TypeScript client only: it makes no request, does not read the curl or Python
examples, and resolves the standard from the registry, so it catches a *published* release that
breaks a consumer, not a change to `packages/standard` in this repo.

Two syndication feeds — `/v1/feeds/opportunities.atom` (Atom 1.0) and
`/v1/feeds/opportunities.rss` (RSS 2.0) — publish the most recent opportunities for any reader or
bot that would rather subscribe than poll JSON; both are `ETag`-validated, so a poller that sends
`If-None-Match` gets a `304`. See [`packages/api/README.md`](./packages/api/README.md#feeds-atom-10-and-rss-20).

The API's list query contract is strict — an undefined parameter or an out-of-enum value is a
`400`, never a silently unfiltered `200` — so the examples show a typo failing loudly.

## Publishing to the Hub

Reading is public and unauthenticated, and stays that way. **Writing** is authenticated, and the
credential you hold decides not only whether a submission is accepted but whether it goes live:

```sh no-run
API=https://api.ethrfps.app

# Who am I, and what may I do?
curl -H "Authorization: Bearer $TOKEN" $API/v1/me

# Mint a publishing key. The secret is in this response and nowhere else, ever.
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"programme-sync","scopes":["read","write","publish"]}' $API/v1/keys

# Submit. Live on arrival only if the key carries `publish` AND the account is a verified member
# of the namespace in the entry's id; otherwise it is stored and queued for review.
curl -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  --data-binary @opportunity.json $API/v1/opportunities
```

Two credential kinds share one header: a signed-in **session**, and a long-lived scoped **API key**
(`rfph_…`). Which one you present decides real authority — keys are refused outright on the routes
that manage credentials, change account identity, review or administer, so a leaked key cannot mint
a stronger one. The tiers, the scopes, the per-route matrix and the reasoning are in
[`packages/api/docs/auth.md`](./packages/api/docs/auth.md).

**To publish under your own namespace without review**, apply as a verified publisher:
[`PUBLISHERS.md`](./PUBLISHERS.md) is the whole process — what qualifies, what is checked, what
approval grants, and how it is revoked.

Beyond the public read surface, the API serves:

| | |
|---|---|
| **Write** | `POST /v1/opportunities` · `PUT /v1/opportunities/:id` · `POST /v1/opportunities/:id/claim` |
| **Provenance** | `GET /v1/opportunities/:id/audit` · `/duplicates` · `/verification` |
| **Account** | `GET\|PATCH /v1/me` · `/v1/me/opportunities[/:id]` · `/v1/me/duplicates` · `GET\|POST /v1/keys` · `DELETE /v1/keys/:id` |
| **Publishers** | `GET /v1/publishers` (public) · `PATCH /v1/organizations/:slug` |
| **Insights** | `GET /v1/insights/opportunities/:id` · `GET /v1/insights/me/summary` |
| **Link-outs** | `GET /v1/r/:id/apply` · `GET /v1/r/:id/source` — `302` to the opportunity's own channel |
| **Review (T3)** | `/v1/review/opportunities` · `/claims` · `/duplicates` · `/organizations` · `/accounts` |
| **Administration (T4)** | `/v1/admin/accounts/:id/role` · `/direct-create` · `/v1/admin/jobs/:job/run` |

Every mutation — by a person, a key, or a job — writes a row to an append-only trail enforced by a
database trigger, and the trail for any entry is publicly readable.

The nightly maintenance jobs that close past-due and long-abandoned listings, roll up analytics and
backfill source checks are documented, schedule and runbook, in
[`packages/api/docs/jobs.md`](./packages/api/docs/jobs.md). They run as one task on the deployed
image — `node packages/api/dist/jobs.js all` runs the whole chain in order in one process — which
is scheduled outside this repository and runs before the open-data export, which publishes on its
own cron; nothing here schedules it, and an operator who needs a job run outside that starts the
same one-off task by hand.

## Licensing

Code is **MIT**; the standard and datasets are **CC0-1.0**. See [LICENSING.md](./LICENSING.md)
for the per-path breakdown.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md).
Security issues: [SECURITY.md](./SECURITY.md).

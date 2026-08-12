# RFP Hub

[![CI](https://github.com/The-RFP-Hub/the-rfp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/The-RFP-Hub/the-rfp-hub/actions/workflows/ci.yml)
[![code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](./LICENSE)
[![standard: CC0-1.0](https://img.shields.io/badge/standard-CC0--1.0-lightgrey.svg)](./packages/standard/LICENSE)

An open, neutral aggregation layer and **standard** for **Ethereum-ecosystem funding
opportunities** — grants, hackathons, bounties, accelerators, VC funds, and RFPs. It indexes,
verifies, and distributes opportunities through a standard format, a public API, open data
exports, and agent-friendly tooling — and each entry's **application link** sends you to the
opportunity's own submission channel to apply. (That guarantee is ingestion policy on the Hub's
own data; the schema itself leaves `applicationUrl` optional, so third-party documents may omit
it.)

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

```bash
npx rfphub-validate opportunity.json
```

## Packages

| Package | npm | License | Purpose |
|---|---|---|---|
| `packages/standard` | `@the-rfp-hub/standard` | CC0-1.0 | Canonical JSON Schema, generated TS types, registries, conformance suite, migration table. Zero runtime deps. **SSoT.** |
| `packages/validate` | `rfphub-validate` | MIT | `npx rfphub-validate` CLI + typed validation library, with an advisory warning tier over the registries. |
| `packages/api` | — | MIT | Public `/v1/` REST API (Fastify + Postgres). |
| `packages/client` | `@the-rfp-hub/client` | MIT | Typed HTTP client *(planned)*. |
| `packages/mcp` | `@the-rfp-hub/mcp` | MIT | MCP server + agent skill *(planned)*. |
| `packages/frontend` | — | MIT | Reference frontend *(planned)*. |

Every package depends only on `@the-rfp-hub/standard` for the contract — never on each other's
internals (dependency inversion at the package level).

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

## Repo topology

Developed as one pnpm workspace for fast iteration (the schema and its generated types move
together in a single change), and published as independent npm packages. At handoff the
packages can be split into per-component repos (`the-rfp-hub/standard`, `the-rfp-hub/validate`,
…) via `git subtree split` — the per-package `LICENSE`/`README`/`package.json` already make
each one split-ready.

## Develop

```bash
pnpm install
pnpm codegen        # regenerate TS types from the JSON Schema
pnpm codegen:check  # fail if generated types drift from the schema (CI gate)
pnpm build          # build all packages
pnpm test           # run the test suite (vitest)
pnpm typecheck
pnpm lint           # biome
```

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

The API's list query contract is strict — an undefined parameter or an out-of-enum value is a
`400`, never a silently unfiltered `200` — so the examples show a typo failing loudly.

## Licensing

Code is **MIT**; the standard and datasets are **CC0-1.0**. See [LICENSING.md](./LICENSING.md)
for the per-path breakdown.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md).
Security issues: [SECURITY.md](./SECURITY.md).

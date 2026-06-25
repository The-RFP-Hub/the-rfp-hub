# RFP Hub

[![CI](https://github.com/The-RFP-Hub/the-rfp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/The-RFP-Hub/the-rfp-hub/actions/workflows/ci.yml)
[![code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](./LICENSE)
[![standard: CC0-1.0](https://img.shields.io/badge/standard-CC0--1.0-lightgrey.svg)](./packages/standard/LICENSE)

An open, neutral aggregation layer and **standard** for **Ethereum-ecosystem funding
opportunities** — grants, hackathons, bounties, accelerators, VC funds, and RFPs. It indexes,
verifies, and distributes opportunities through a standard format, a public API, open data
exports, and agent-friendly tooling — always linking back to the original source to apply.

pnpm monorepo. The hand-authored **JSON Schema is the single source of truth**; TypeScript
types (and, later, Zod/Pydantic) are generated from it.

## The Standard

The heart of the project is the **RFP Hub Standard** — a versioned, documented, validated
JSON Schema (draft 2020-12) describing a funding opportunity. It's published as
[`@rfp-hub/standard`](./packages/standard) (CC0-1.0) and ships generated TypeScript types.

- Schema: [`packages/standard/schemas/v1.0.0/opportunity.schema.json`](./packages/standard/schemas/v1.0.0/opportunity.schema.json)
- Field reference: [`FIELDS.md`](./packages/standard/schemas/v1.0.0/FIELDS.md)
- Prior-art crosswalk (DAOIP-5 · schema.org/Grant): [`CROSSWALK.md`](./packages/standard/schemas/v1.0.0/CROSSWALK.md)
- Validated against 311 real funding-map entries: [`BENCHMARK.md`](./packages/standard/schemas/v1.0.0/BENCHMARK.md)

Validate anything against it:

```bash
npx rfphub-validate opportunity.json
```

## Packages

| Package | npm | License | Purpose |
|---|---|---|---|
| `packages/standard` | `@rfp-hub/standard` | CC0-1.0 | Canonical JSON Schema + generated TS types. Zero runtime deps. **SSoT.** |
| `packages/validate` | `rfphub-validate` | MIT | `npx rfphub-validate` CLI + typed validation library. |
| `packages/api` | — | MIT | Public `/v1/` REST API (Fastify + Postgres). |
| `packages/client` | `@rfp-hub/client` | MIT | Typed HTTP client *(planned)*. |
| `packages/mcp` | `@rfp-hub/mcp` | MIT | MCP server + agent skill *(planned)*. |
| `packages/frontend` | — | MIT | Reference frontend *(planned)*. |

Every package depends only on `@rfp-hub/standard` for the contract — never on each other's
internals (dependency inversion at the package level).

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

## Licensing

Code is **MIT**; the standard and datasets are **CC0-1.0**. See [LICENSING.md](./LICENSING.md)
for the per-path breakdown.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md).
Security issues: [SECURITY.md](./SECURITY.md).

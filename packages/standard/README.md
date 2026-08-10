# @the-rfp-hub/standard

The **canonical RFP Hub Standard** — a JSON Schema (draft 2020-12) describing an
Ethereum-ecosystem funding opportunity, plus the TypeScript types **generated from it**.

CC0-1.0. Zero runtime dependencies. This package is the single source of truth that the
validator, API, client, and agent libraries all build on.

## Usage

```ts
import { opportunitySchema, SPEC_VERSION, type Opportunity } from "@the-rfp-hub/standard";

const opp: Opportunity = {
  specVersion: SPEC_VERSION,
  id: "example:grant-1",
  fundingType: "grant",
  title: "Example Grants",
  description: "…",
  status: "open",
  operatingOrganizations: [{ name: "Example Foundation", slug: "example-foundation" }],
  source: {},
  applicationUrl: "https://example.org/grants",
  fundingInfo: { currency: "USD", budget: 250000 },
  deadlines: [{ deadlineType: "fixed", date: "2026-12-31T23:59:59.000Z", label: "application" }],
  fundingDetails: { fundingType: "grant" },
};
```

The raw schema file is also published and importable directly (the import attribute is
required under `module: nodenext`, and harmless elsewhere):

```ts
import schema from "@the-rfp-hub/standard/schemas/v1.0.0/opportunity.schema.json" with { type: "json" };
```

## What this package ships

| Artifact | What it is |
|---|---|
| `schemas/v1.0.0/opportunity.schema.json` | The **normative** schema. Everything else is derived from it or governed by it. |
| `schemas/v1.0.0/context.jsonld` | JSON-LD context. Term IRIs are versionless; the context *document* is what gets versioned. |
| `schemas/v1.0.0/examples/` | 28 curated real-world entries. |
| `conformance/v1.0.0/{pass,fail}/` | One document per rule, named after the rule. Run these against your own implementation — see [`conformance/README.md`](./conformance/README.md). |
| `registries/` | Four open vocabularies: deadline labels, program models, and bounty reward-tier severities and asset types. The schema keeps these fields free-text; the registry fixes what each value means. `ecosystems` is open too and deliberately has no registry — see [`ARTIFACTS.md`](./ARTIFACTS.md). (`eligibility-keys` was retired on 2026-08-05 when `eligibility` became free text.) |
| `meta/rfphub-schema.meta.json` | Metaschema constraining our schema file's shape and legalising `x-stability` / `x-since` / `x-deprecated`. |
| `spec.config.json` | The spec's identity. Every generated version string and URL is stamped from here. |

## Source of truth

`schemas/v1.0.0/opportunity.schema.json` is hand-authored and authoritative; `spec.config.json`
is the only place a version string or namespace IRI is hand-written. `pnpm codegen` stamps that
identity into the schema, the context and `SPEC_VERSION`, then generates
`src/generated/opportunity.ts`, `registries/index.json`, `schemas/index.json` and the field
tables in `FIELDS.md`. `pnpm codegen:check` fails CI when any of them is stale; `pnpm check` runs
the publication rules (context↔schema drift, version-string agreement, source neutrality). Never
edit a generated file by hand.

See [`schemas/v1.0.0/FIELDS.md`](./schemas/v1.0.0/FIELDS.md) for the full field reference (its
tables are generated from the schema), [`CHANGELOG.md`](./CHANGELOG.md) for the release record,
and [`schemas/v1.0.0/BENCHMARK.md`](./schemas/v1.0.0/BENCHMARK.md) for real-data validation
results.

## How this standard is governed

| Document | Answers |
|---|---|
| [`NORMATIVE.md`](./NORMATIVE.md) | Which artifacts carry authority, and which can be corrected any day without a release. |
| [`PROCESS.md`](./PROCESS.md) | Feature stages, what "breaking" means operationally, deprecation, how to register a vocabulary value, the release checklist. |
| [`ARTIFACTS.md`](./ARTIFACTS.md) | Every artifact this standard ships, plans to ship, or has declined — with the reason. |
| [`schemas/v1.0.0/STATUS.md`](./schemas/v1.0.0/STATUS.md) | Where this version stands: maturity, known issues, revision history. |
| [`CHANGELOG.md`](./CHANGELOG.md) | What changed and when — including the [field mapping tables](./CHANGELOG.md#field-mapping-old--new). No row is ever removed from it. |

Who decides, and the review windows, are in `GOVERNANCE.md` at the repository root.

## License

Dedicated to the public domain under **CC0 1.0 Universal** ([`LICENSE`](./LICENSE)). To the
extent possible under law, The RFP Hub contributors have waived all copyright and related
rights to the standard — the schema, generated types, and docs — so it can be embedded,
forked, and re-published without restriction.

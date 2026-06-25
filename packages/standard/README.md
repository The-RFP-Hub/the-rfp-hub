# @rfp-hub/standard

The **canonical RFP Hub Standard** — a JSON Schema (draft 2020-12) describing an
Ethereum-ecosystem funding opportunity, plus the TypeScript types **generated from it**.

CC0-1.0. Zero runtime dependencies. This package is the single source of truth that the
validator, API, client, and agent libraries all build on.

## Usage

```ts
import { opportunitySchema, SPEC_VERSION, type Opportunity } from "@rfp-hub/standard";

const opp: Opportunity = {
  specVersion: SPEC_VERSION,
  id: "example:grant-1",
  type: "grant",
  title: "Example Grants",
  description: "…",
  status: "open",
  organization: { name: "Example Foundation" },
  source: { url: "https://example.org/grants" },
  grant: {},
};
```

The raw schema file is also published and importable directly:

```ts
import schema from "@rfp-hub/standard/schemas/v1.0.0/opportunity.schema.json";
```

## Source of truth

`schemas/v1.0.0/opportunity.schema.json` is hand-authored and authoritative. TypeScript
types in `src/generated/` are produced from it with `pnpm codegen`
(`json-schema-to-typescript`); `src/types.ts` curates the public type names. Never edit the
generated file by hand.

See `schemas/v1.0.0/FIELDS.md` for the full field reference, and
`BENCHMARK.md` for real-data validation results.

## License

Dedicated to the public domain under **CC0 1.0 Universal** ([`LICENSE`](./LICENSE)). To the
extent possible under law, The RFP Hub contributors have waived all copyright and related
rights to the standard — the schema, generated types, and docs — so it can be embedded,
forked, and re-published without restriction.

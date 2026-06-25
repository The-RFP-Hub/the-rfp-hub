# rfphub-validate

CLI **and** typed library to validate funding opportunities against the
[RFP Hub Standard](https://github.com/The-RFP-Hub/the-rfp-hub/tree/main/packages/standard)
(JSON Schema, draft 2020-12). MIT licensed.

Built on `@rfp-hub/standard` — the schema is **not** vendored here; it comes from the
single source of truth.

## CLI (no install)

```bash
npx rfphub-validate opportunity.json
npx rfphub-validate ./exports/            # validates every *.json in the dir
cat opportunity.json | npx rfphub-validate -
```

A JSON document may be a single opportunity object **or** an array of objects.

| Option | Description |
|---|---|
| `--spec <version>` | Standard version to validate against (default: bundled) |
| `--list-specs` | List bundled spec versions |
| `--json` | Emit a machine-readable JSON report |
| `-q, --quiet` | Only print failures and the summary |
| `-h, --help` | Show help |

Exit codes: `0` all valid · `1` one or more invalid · `2` usage/IO/parse error.

```bash
npx rfphub-validate ./data/ || exit 1   # CI gate
```

## Library (typed)

```ts
import { validateOpportunity, assertOpportunity, type Opportunity } from "rfphub-validate";

const { valid, errors } = validateOpportunity(input);
if (!valid) console.error(errors);

// or narrow the type and throw on failure:
assertOpportunity(input);          // input is now typed as Opportunity
```

Exports: `validateOpportunity`, `assertOpportunity`, `createValidator` (inject a custom
schema), `humanizeError`/`humanizeErrors`, `SPEC_VERSION`, and the `Opportunity` type
(re-exported from `@rfp-hub/standard`).

## How it validates

ajv (`ajv/dist/2020`) + `ajv-formats` with the configuration the standard is authored
against: draft 2020-12, `strict: true`, `strictRequired: false` (so the conditional
type-block pattern — `opportunity[opportunity.type]` — is permitted). The same
`createValidator()` is reused by the API and tests, so validation is identical everywhere.

## Develop

```bash
pnpm install
pnpm --filter rfphub-validate build
pnpm --filter rfphub-validate test
```

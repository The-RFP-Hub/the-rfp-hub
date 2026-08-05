# rfphub-validate

CLI **and** typed library to validate funding opportunities against the
[RFP Hub Standard](https://github.com/The-RFP-Hub/the-rfp-hub/tree/main/packages/standard)
(JSON Schema, draft 2020-12). MIT licensed.

Built on `@the-rfp-hub/standard` — the schema is **not** vendored here; it comes from the
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
| `--strict` | Treat advisory warnings as failures |
| `-q, --quiet` | Only print failures, warnings and the summary |
| `-h, --help` | Show help |

Exit codes: `0` all valid · `1` one or more invalid (or, with `--strict`, any warning) ·
`2` usage/IO/parse error.

```bash
npx rfphub-validate ./data/ || exit 1   # CI gate
```

## Two tiers: errors and warnings

**Schema errors** are hard conformance failures. **Advisory warnings** cover what the schema
deliberately leaves open, and never make a document non-conformant on their own:

| Check | Fires when |
|---|---|
| `unregistered-deadline-label` | a `deadlines[].label` is not in `registries/deadline-labels.json` |
| `unregistered-program-model` | `fundingDetails.programModel` is not in `registries/program-models.json` |
| `milestone-amount-without-currency` | a `milestones[].amount` is present with no `fundingInfo.currency` to denominate it |

The split is the point. A closed enum built from one publisher's vocabulary would force every
other publisher into it, so those fields stay open — and the registries would be documentation
nobody reads if nothing ever checked them. Text output is count-phrased ("3 of 40 entries use
an unregistered deadline label") so the summary reads as coverage rather than noise. The last
check exists because its rule is real but crosses two objects, which JSON Schema cannot express:
a milestone amount MUST follow the top-level envelope currency, and warning is the only
enforcement that rule has.

(An `unregistered-eligibility-key` check shipped until 2026-08-05, when `eligibility` became
free text and its registry was retired; consumers filtering on that warning code will no longer
see it.)

Pass `--strict` in CI once your data is clean, to keep it clean.

## Library (typed)

```ts
import {
  validateOpportunity,
  assertOpportunity,
  humanizeErrors,
  type Opportunity,
} from "rfphub-validate";

const { valid, errors, warnings } = validateOpportunity(input);
if (!valid) console.error(humanizeErrors(errors, input));
for (const w of warnings) console.warn(`${w.code} ${w.instancePath}: ${w.message}`);

// or narrow the type and throw on failure:
assertOpportunity(input);          // input is now typed as Opportunity
```

Exports: `validateOpportunity`, `assertOpportunity`, `createValidator` (inject a custom
schema), `humanizeError`/`humanizeErrors`, `checks`/`runChecks`/`entryPhrase` (the advisory
tier), `SPEC_VERSION`, and the `Opportunity` type (re-exported from `@the-rfp-hub/standard`).

### Error messages

`errors` are raw ajv `ErrorObject`s. `humanizeErrors(errors, instance)` renders them as lines
naming the rule that failed. **Pass the instance as the second argument** where you have it —
it is optional, but without it a failed `fundingDetails` cannot be reduced to the one shape
its `fundingType` tag names:

```
/fundingDetails grant details: unknown field 'recuring'
fundingDetails.fundingType 'hackathon' does not match the opportunity's fundingType 'grant'
/status must be equal to one of the allowed values: upcoming, open, closed, archived
```

Two things happen behind that. When `fundingDetails` fails its `oneOf`, ajv reports every
branch's errors; the instance's own `fundingType` tag says which shape was meant, so only that
branch's errors are kept (and a missing or mismatched tag is reported as a single line). And
ajv reports every `if`/`then` failure twice — once for the real constraint and once for a
wrapper reading `must match "then" schema` — so the wrapper is dropped. The CLI does both
automatically.

## How it validates

ajv (`ajv/dist/2020`) + `ajv-formats` with the configuration the standard is authored
against: draft 2020-12, `strict: true`, `strictRequired: false` (so applicator subschemas —
the `fundingDetails` binding `allOf`, the deadline `if`/`then` — may require properties they
re-reference rather than declare), plus the standard's `x-stability` / `x-since` /
`x-deprecated` annotation keywords declared so strict mode accepts them. The same
`createValidator()` is reused by the API and tests, so validation is identical everywhere.

The test suite runs the standard's own conformance suite
(`@the-rfp-hub/standard/conformance/v1.0.0/{pass,fail}/`) rather than private fixtures, so the
reference implementation is held to exactly the contract external implementers are given.

## Develop

```bash
pnpm install
pnpm --filter rfphub-validate build
pnpm --filter rfphub-validate test
```

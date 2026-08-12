# RFP Hub Standard conformance suite

A set of whole documents that an implementation of the RFP Hub Standard is expected to accept
or reject. It is shipped inside the `@the-rfp-hub/standard` npm package so that an external
implementer — a validator in another language, an ingestion pipeline, a publisher's export
job — can run the same cases the reference implementation runs.

## Layout

```
conformance/
  v<spec version>/
    pass/   documents that MUST validate
    fail/   documents that MUST NOT validate
```

Every file is a complete opportunity document. **Each file is named after the rule it
exercises**, not after the record it contains: a red CI run therefore names the violated
constraint (`fail/deadline-fixed-without-date.json`) rather than a fixture number. Each
document's own `description` field explains what the case is testing and why the rule exists,
so the file is readable on its own. (The one exception is
`fail/missing-required-properties.json`, which cannot carry a `description` — omitting it is
the case.)

## Running the suite

An implementation is conformant with respect to this suite when every document in `pass/`
validates against `schemas/<version>/opportunity.schema.json` and every document in `fail/`
does not. Nothing else is asserted: the suite says nothing about which error is reported, how
many errors are reported, or in what order.

The reference run lives in `packages/validate/test/validate.test.ts` (the
"conformance suite — pass/ / fail/" describe blocks).

```bash
pnpm --filter rfphub-validate test
# or, against the published package:
npx rfphub-validate node_modules/@the-rfp-hub/standard/conformance/v1.0.0/pass
```

## Scope

These cases cover **schema validity only** — the hard constraints in the JSON Schema. That
includes `format` (`uri`, `date-time`, `email`): JSON Schema 2020-12 makes `format`
annotation-only by default, but this standard means it as a constraint, the fail suite asserts
it, and an implementation must therefore validate with format assertion enabled (the reference
validator uses `ajv-formats`). They do
not cover the advisory checks (`packages/validate/src/checks/`), which report *warnings* about
things the schema deliberately leaves open: unregistered
deadline labels, program models, bounty tier severities and tier asset types; inverted
reward-tier payout bounds; and monetary amounts present without a `fundingInfo.currency` to
denominate them (the bounds rule and the document-wide denomination rule both cross objects, so
warning is their only enforcement). The current list is in
[`packages/validate/README.md`](../../validate/README.md#two-tiers-errors-and-warnings).
A document may be conformant and still raise warnings; that is the point of the split.

## Contributing a case

Add one file per rule, in whichever directory expresses the expectation, and give it the
rule's name. Prefer a case that isolates a single constraint: a document that violates four
rules at once proves nothing about which of the four an implementation enforces. Cases are
versioned with the spec — a new version gets a new directory, and existing directories are not
edited once their version is frozen.

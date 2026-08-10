---
"@the-rfp-hub/standard": major
---

Adopt the canonical domain `ethrfps.app` for every identifier the package publishes.

The schema, metaschema and registry-entry-schema `$id`s, the JSON-LD `@vocab`, and the two
self-identification examples the schema teaches all move from provisional placeholders to
canonical URLs on the project's own domain (`adr/0007`). Spec v1.0.0 is declared `stable` and
frozen in the same change.

Major, even though no exported type and no validation behaviour changed: the package ships
identifiers, and a consumer that hard-coded the old `$id` — in an ajv registry, in a document's
own `$schema`, or in an `@context` value — gets a mismatch. The SPEC version stays `1.0.0`; this
is a package-axis change only.

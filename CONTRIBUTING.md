# Contributing to the RFP Hub

Thanks for helping build an open, neutral standard and aggregation layer for Ethereum-ecosystem
funding opportunities. Contributions of all kinds are welcome — schema proposals, validation
tooling, bug reports, docs, and data.

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Repository layout

This is a pnpm monorepo. See [README](./README.md) for the package map. The key rule:

> **The JSON Schema is the single source of truth.** TypeScript types are *generated* from it.

## Getting started

```bash
# prerequisites: Node >= 18, pnpm (this repo pins pnpm via packageManager)
pnpm install
pnpm build        # build all packages
pnpm test         # run the test suite (vitest)
pnpm typecheck
pnpm lint         # biome
```

## Working on the standard

- Edit the schema at `packages/standard/schemas/v<version>/opportunity.schema.json`.
- **Never edit `packages/standard/src/generated/**` by hand** — regenerate:
  ```bash
  pnpm codegen          # regenerate TS types from the schema
  pnpm codegen:check    # CI runs this; fails if generated types drift from the schema
  ```
- Run the publication rules — context↔schema drift, version-string agreement, source neutrality:
  ```bash
  pnpm check
  ```
- Validate your changes against real data:
  ```bash
  pnpm --filter rfphub-validate build
  node packages/validate/dist/cli.js packages/standard/schemas/v1.0.0/examples
  ```

### Proposing changes to the Standard

Open an issue describing the change first. The full rules live in
[`packages/standard/PROCESS.md`](./packages/standard/PROCESS.md); the short version:

**Two version axes, and they are different numbers.**

- The **package version** (`package.json`) is the npm *distribution* version. It bumps for any
  shipped change and follows ordinary semver via changesets.
- The **spec version** (`specVersion`, the schema `$id`, the `schemas/<version>/` directory) is
  the *data contract*. It bumps only under the rules below.

The package version may run well ahead of the spec version. That is the point of separating them.

**What counts as breaking.** Operationally: *a document valid under version N is invalid under
N+1* — **or the reverse**. Loosening a constraint is breaking too, because data that used to be
rejected now validates and every consumer relying on the rejection has silently changed
behaviour. Breaking changes take a **new spec version in a new directory**; the previous
directory stays published and unedited. Non-breaking changes go into the current version.

**Which stage a field is at** matters as much as the version. Fields move
`proposed → experimental → stable → deprecated`, recorded in the schema as `x-stability`. Nothing
in a registry is ever deleted, and a deprecated field survives at least one full release before it
can be removed.

**One historical exception you should know about.** `v1.0.0` was **re-cut in place** on
2026-07-27 — same version string, different bytes — because the standard was unpublished and
unadopted at the time. That was a one-off; the rule against repeating it, and the CI check that
mechanises it, are in `PROCESS.md`. See
[`adr/0001-recut-v1.0.0-in-place.md`](./adr/0001-recut-v1.0.0-in-place.md).

**Docs are cheap to fix.** [`NORMATIVE.md`](./packages/standard/NORMATIVE.md) draws the line
between normative artifacts (the schema, registered values, the conformance suite) and
informative ones (FIELDS.md prose, CROSSWALK, BENCHMARK, examples, READMEs). Informative content
can be corrected by an ordinary PR at any time — no version, no comment window. If the prose and
the schema disagree, the schema is right and the prose is the bug.

**Review windows and who decides** are in [`GOVERNANCE.md`](./GOVERNANCE.md): 72 hours minimum
open time for substantive changes, a 24-hour fast path for registry entries, none for editorial
fixes. Structural decisions get an ADR — see [`adr/`](./adr) and its
[`template.md`](./adr/template.md).

## Commits & pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
- Branch from `main`; open a PR and fill in the template.
- CI must be green: **codegen:check · typecheck · build · test · lint**.
- For user-facing changes, add a changeset: `pnpm changeset`.

## Licensing of contributions

By submitting a contribution you agree it is licensed under the license of the package it
touches — **MIT** for code, **CC0-1.0** for the standard and datasets (see [LICENSING](./LICENSING.md)).

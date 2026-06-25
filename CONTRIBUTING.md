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
- Validate your changes against real data:
  ```bash
  pnpm --filter rfphub-validate build
  node packages/validate/dist/cli.js packages/standard/schemas/v1.0.0/examples
  ```

### Proposing changes to the Standard

The standard is versioned. Open an issue describing the change first.
- **Additive, backwards-compatible** changes → a new minor (`v1.1.0`).
- **Breaking** changes → a new major at a new versioned URL; the old version stays published.

Significant changes follow an RFC-style discussion before a PR is merged (see the governance
docs, M4).

## Commits & pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
- Branch from `main`; open a PR and fill in the template.
- CI must be green: **codegen:check · typecheck · build · test · lint**.
- For user-facing changes, add a changeset: `pnpm changeset`.

## Licensing of contributions

By submitting a contribution you agree it is licensed under the license of the package it
touches — **MIT** for code, **CC0-1.0** for the standard and datasets (see [LICENSING](./LICENSING.md)).

# Licensing

The RFP Hub is open source. Per the project's commitment and the EF RFP — *"code, schemas, and
datasets published in public repositories under a permissive license (MIT, Apache 2.0, or CC0
for data)"* — different artifacts carry different permissive licenses:

| Path | Artifact | License |
|---|---|---|
| `packages/standard/` | RFP Hub Standard — JSON Schema, generated types, field docs (the standard / "data") | **CC0-1.0** |
| dataset exports & snapshots (published to the public bucket / releases) | open data | **CC0-1.0** |
| everything else — `packages/validate`, `packages/api`, client/frontend/agent tooling | code | **MIT** |

How this is expressed:
- Each package declares its license via SPDX in its `package.json` and ships its own `LICENSE`.
- The repository root `LICENSE` (MIT) covers the code.
- The **standard and datasets are dedicated to the public domain under CC0** so they can be
  embedded, forked, validated against, and re-published with no restriction — which is the
  point of a neutral, forkable standard.

This per-directory licensing is intentional and unambiguous; the license governing any file is
the most specific `LICENSE`/`package.json` that applies to it.

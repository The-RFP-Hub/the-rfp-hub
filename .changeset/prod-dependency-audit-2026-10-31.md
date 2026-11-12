---
"@the-rfp-hub/api": patch
---

Pin the transitive `glob` under `@fastify/static` (pulled in by `@fastify/swagger-ui`) to `^14.0.2` with a scoped `pnpm.overrides` entry, which also brings `minimatch` to 11.x. This clears GHSA-3g3m-2fjr-6pw4 (glob) and GHSA-g3hv-75wg-m249 (minimatch). No direct dependency changes and no major-version bumps of a direct dependency.

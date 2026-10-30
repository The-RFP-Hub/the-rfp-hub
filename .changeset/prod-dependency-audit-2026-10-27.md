---
"@the-rfp-hub/api": patch
"@the-rfp-hub/frontend": patch
"@the-rfp-hub/mcp": patch
---

Update production dependencies with published advisories: `next` 16.4.3 (critical), `@modelcontextprotocol/server` 2.3.1 (bearer-auth advisories), `zod` 4.6.7, `undici` 7.30.1 and `fastify` 5.12.7, plus `vite` 7.3.7 and `vitest`/`@vitest/mocker` 4.1.12 (reachable through `better-auth`'s peer dependencies) and the transitive `ip-address` and `fast-uri`. No new `pnpm.overrides` entries and no major-version bumps.

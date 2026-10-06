---
"@the-rfp-hub/api": patch
"@the-rfp-hub/frontend": patch
---

Update production dependencies with published advisories: `next` (critical), `undici`, and the transitive `brace-expansion`, `ip-address` and `fast-uri`. The test runner moves to vitest 4. `fastify` is deliberately not in this set; see the pull request.

---
"@the-rfp-hub/api": patch
"@the-rfp-hub/frontend": patch
---

Update production dependencies with published advisories: `next` (critical), `fastify`, `undici`, and the transitive `brace-expansion`, `ip-address`, `fast-uri` and `source-map-js`. `TRUST_PROXY` as a hop count now only applies when the connection's immediate peer has a private or loopback address, so a client reaching the container directly cannot choose its own address through `X-Forwarded-For`. The test runner moves to vitest 4, capped at four workers.

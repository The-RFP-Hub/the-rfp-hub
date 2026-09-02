---
"rfphub-validate": patch
---

Publish `humanizeIssues`, which `src/index.ts` has re-exported since 0.3.0 but the published tarball
does not contain — a mismatch invisible inside the monorepo, where consumers resolve the workspace
source rather than `dist`, and visible only to an external installer. `packages/frontend/src/lib/validate-client.ts`
imports it to turn Ajv errors into the messages the submission form shows a user, so any external
copy of the frontend built against `rfphub-validate@^0.3.0` fails with TS2305 before it fails
anything more interesting. This patch ships the same source `dist` already builds from; nothing
about the function's behavior changes.

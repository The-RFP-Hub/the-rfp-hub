---
"rfphub-validate": minor
---

Tracks the revised draft schema (breaking for 0.x consumers): the `unregistered-eligibility-key` advisory check is removed with its registry, the program-model check reads `fundingDetails.programModel`, the currency check reads `fundingInfo.currency`, and error explanation replaces the one-block-per-type rule (`explainNot`) with tag-aware `fundingDetails` branch filtering (`explainOneOf`) — messages changed. Also: dual CJS/ESM type declarations.

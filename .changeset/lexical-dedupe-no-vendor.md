---
"@the-rfp-hub/api": minor
---

Duplicate detection drops its AI vendor: the detector is now the in-process lexical featurizer
(TF-IDF over a signed-hashed token bag, weighted by a frozen document-frequency table regenerated
from the committed corpus), and `EMBEDDING_PROVIDER` accepts `lexical` (the default — no key, no
network) or `disabled`. `openai` is refused at boot by name; `deterministic` maps to `lexical` as
a deprecated alias for one release.

**The privacy line this buys: duplicate detection now processes listing text entirely on the
Hub's own servers — no AI vendor sees it, conditionally or otherwise.** (Published listings remain
public by design: the open-data exports and the public API are listing text leaving, deliberately.)
The privacy page's "what leaves our servers" section shrinks accordingly.

Measured, not asserted (`pnpm --filter @the-rfp-hub/api dedupe:threshold`, over every distinct
pair of the committed corpus): separating band 0.321 where the unweighted bag had 0.018, zero
corpus pairs above the 0.75 operating point where there were sixteen, and full recall on the
paraphrase, heavy-synonym and synonym-plus-compression mutation classes — with truncation-based
evasion recorded as out of reach for any lexical method rather than hidden.

**Operator action on deploy:** the model string changed, so every stored vector is stale by
design — run the `embedding-backfill` job to `remaining: 0` in the same maintenance step.
Detection recall is degraded (never wrong) until the drain finishes. Remove `OPENAI_API_KEY`,
`EMBEDDING_MODEL` and `EMBEDDING_TIMEOUT_MS` from the environment; they are no longer read.

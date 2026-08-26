---
"@the-rfp-hub/api": minor
"@the-rfp-hub/frontend": minor
---

Duplicate detection gains a second arm: **length-corrected term overlap**, which catches the
re-listing that copies a programme and publishes a shorter version of it. Cosine cannot do that on
its own for a structural reason — normalisation has already erased the difference in length that
IS the signal — and the corpus mutation ladder shows it: a body truncated to 40 % scored 0.635
against a 0.75 threshold. A pair is now suspected when the cosine clears 0.75 (unchanged) **or**
when the overlap clears 0.85 with at least 20 distinct tokens on the shorter side and a cosine of
at least 0.35.

`similarity` still means exactly what it meant — the lexical cosine, same rounding — and an
overlap-arm pair simply carries one below 0.75. `DuplicateMatch` and `DuplicatePair` gain
`matchedOn`, a label array (`["overlap", "application_url"]`) that names the arm that decided plus
any structural evidence corroborating it; `DuplicatePair` also gains `signal`, the numeric decision
inputs. Both are additive and both are **empty/null on every pair recorded before this change**.
Labels, never values: structural evidence is computed from the live entries at read time and never
stored, because it stops being true the moment either entry is edited.

Measured, not asserted (`pnpm --filter @the-rfp-hub/api dedupe:threshold`, every distinct pair of
the committed corpus): the hardest of 12 720 negatives measures **0.682** against a worst true
positive of **0.956** — a band of **0.274**, 0.195 out of sample — with **zero** corpus pairs
accepted by the combined rule, and full recall on all eight mutation rungs including the two the
lexical arm alone misses.

**Structural signals are recorded as explanation and barred from the decision**, which is the
opposite of the sketched design and is what the measurement says: the corpus's hardest negatives
ARE the structurally identical siblings, so gating on structure moves the safe floor by 0.024
against a worst positive of 0.598. A structural conjunction band was measured too and catches
nothing — its hardest corroborated negative is the same pair, at the same value, as the global
hardest.

The 20-token floor is a substance guard, and it is load-bearing: against a stub built from a
target's rarest terms it takes attacker wins from 147/160 to 3/160, with **zero** targets reachable
through the new arm that were not already reachable through the shipped cosine arm (which the same
harness measures at 160/160 at a median 5-token stub — a pre-existing property of the TF-IDF
detector, filed as its own issue).

New nullable columns: `opportunity_embeddings.norm` / `.token_count`, and
`opportunity_duplicates.signal` / `.rules_version`. Four new environment variables:
`DEDUPE_OVERLAP_ENABLED` (default on), `DEDUPE_OVERLAP_THRESHOLD` (per provider; **not** bounded by
1 — overlap is cosine times a norm ratio), `DEDUPE_OVERLAP_MIN_TOKENS` (20) and
`DEDUPE_OVERLAP_MIN_SIMILARITY` (0.35).

**Operator action on deploy: NO RE-EMBED OCCURS.** The norm and token count fall out of a
computation the featurizer already performed; the weights, the vectors, every `content_hash` and
the model string are untouched. The first `embedding-backfill` run after deploy nevertheless selects
the whole table on the new norm predicate, to write those two scalars — run it to `remaining: 0` in
the same maintenance step. Until it drains, the overlap arm does not fire for rows it has not
reached: degraded detection, never wrong detection. Setting `DEDUPE_OVERLAP_ENABLED=false` is a
real rollback rather than a switch that strands its own output — pairs carry the rule version that
wrote them and the backfill's resweep arm retires the orphans within a run or two. That same
mechanism fixes a latent bug of the same shape: changing `DEDUPE_SIMILARITY_THRESHOLD` used to
strand every pair the old value wrote.

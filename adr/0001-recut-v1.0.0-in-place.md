# 0001. Re-cut spec v1.0.0 in place rather than bumping the version

- **Status:** accepted
- **Deciders:** project leadership + standard maintainers
- **Date:** 2026-07-27
- **Supersedes:** —

## Context and problem statement

A round of publisher, aggregator and builder interviews (private research, conducted with the
participants' understanding that their input would shape the schema) produced a batch of design
decisions that change the opportunity model substantially. The field-level content of that batch
is [ADR-0002](./0002-v-next-field-recut.md); this record is only about **how the change is
versioned**.

Three of the changes are unambiguously breaking against a published v1.0.0:

| Change | Why it breaks |
|---|---|
| `type` → `fundingType` | Every consumer reading `opportunity.type` — or the discriminator idiom `opportunity[opportunity.type]` — fails. It also breaks the API's `type` filter parameter. |
| `organization` removed | A **required** property disappears. Every consumer reading `organization.name` fails. |
| `source.url` removed | The provenance block's only **required** property disappears, and the field is in the JSON-LD context and the prior-art crosswalk. |

Plus a longer tail: `closesAt` removed, `funding.totalBudget` and `amountDistributed` renamed,
`grant.fundingMechanism` pluralised, three `rfp` fields removed, every per-type date folded into
a shared array, and one-block-per-funding-type promoted from convention to validation rule.

So the question is not *whether* this is breaking. It is: **does a breaking change to an
artifact that nobody has adopted require a version bump?**

The constraints that were true on the day, and that this decision depends on:

- **The package was never published.** `@rfp-hub/standard` did not exist on the npm registry
  (verified: `npm view` returned a 404). There is no immutable published artifact to contradict.
- **No external consumer had adopted the shape.** No third party was reading `opportunity.type`.
- **The milestone that would have declared the schema complete had not closed.** v1.0.0 was a
  work-in-progress artifact that happened to carry a 1.0.0 label, not a shipped contract.
- **The `$id` URL did not dereference** to the schema — it served a parking page. Nobody could
  have been resolving it either.

## Decision drivers

- Semantic versioning exists to protect consumers. Where there are provably zero consumers, a
  version bump protects nobody and costs everybody the migration story it implies.
- A `2.0.0` on an artifact with no `1.x` users advertises churn that did not affect anyone.
- A reset to `0.x` advertises immaturity to exactly the audience that asked for durability — one
  interviewed publisher's stated adoption bar was that the standard not look like "something
  maintained only as long as a grant funds it".
- Whatever is chosen, the discontinuity must be **discoverable rather than silent**. A future
  reader must be able to find out that the bytes changed.
- The decision must not become a precedent. The reasoning that justifies it once justifies it
  every time, unless the boundary is written down and mechanised.

## Considered options

1. **Cut `v2.0.0`** — new version directory, new `$id`, v1.0.0 stays published unchanged.
2. **Reset to `0.2.0`** — admit pre-1.0 status and use the semver 0.x escape hatch.
3. **Re-cut `v1.0.0` in place** — replace the contents of `schemas/v1.0.0/`, keep the version
   string and the `$id` path.

### Option 1 — cut v2.0.0

- Good, because it is what the versioning rules say, with no exception needed and no precedent
  set.
- Good, because it leaves the pre-re-cut shape addressable at a stable URL forever.
- Bad, because it publishes a v1.0.0 that nobody ever used, permanently, and requires maintaining
  a directory that documents a shape with no data in it.
- Bad, because it manufactures a migration story with **no one on the receiving end** — a
  migration guide from a shape zero publishers emit to a shape zero publishers consume.
- Bad, because "we are on v2 in month four" is a signal about the project that does not match
  what actually happened.

### Option 2 — reset to 0.2.0

- Good, because it is the honest semver expression of "this is not stable yet", and it would make
  every subsequent breaking change cheap.
- Bad, because it advertises immaturity to the publishers whose stated condition for adopting was
  durability. A 0.x standard reads as "may be abandoned" to exactly the audience being courted.
- Bad, because it moves the `$id` path, and the path layout was already documented as intended to
  be stable.
- Bad, because it defers the discipline rather than adopting it: everything stays breakable
  indefinitely, and nothing forces the question of when it stops.

### Option 3 — re-cut v1.0.0 in place

- Good, because it matches the actual state of the world: a work-in-progress artifact being
  finished, not a contract being broken.
- Good, because it keeps the `$id` path and version string stable for the consumers who arrive
  after this, which is all of them.
- Good, because it costs nothing to anyone who exists.
- **Bad, because it rewrites a published artifact.** Same version string, different bytes, is the
  single thing semantic versioning exists to prevent. Anyone who did fetch the earlier bytes
  between publication and the re-cut sees a contradiction with no signal.
- Bad, because the reasoning is self-serving and reusable: "no one has adopted it yet" will feel
  true again next time, and the second time it will not be defensible.
- Bad, because it requires the versioning policy to be written down **at the same time**, or the
  policy's first act is an exception to itself.

## Decision outcome

**Chosen: Option 3 — re-cut `v1.0.0` in place.** `specVersion` stays `1.0.0`, the `$id` path is
unchanged, and the contents of `schemas/v1.0.0/` are replaced.

The basis is narrow and factual, not a matter of taste: **the artifact was unpublished,
unadopted, and undereferenceable.** There was nothing downstream to break. A version bump would
have been bookkeeping.

Three mitigations are part of the decision, not follow-ups to it:

1. **Once, and only once.** [`PROCESS.md`](../packages/standard/PROCESS.md) states the rule: a
   version directory may be edited in place only while its maturity is `draft` and no external
   consumer has adopted it, and **never** after it is declared `stable`. If a consumer appears
   before the next such change, that change becomes a version bump instead.
2. **Recorded publicly.** [`CHANGELOG.md`](../packages/standard/CHANGELOG.md) opens with the
   re-cut entry, and that entry carries the
   [field mapping table](../packages/standard/CHANGELOG.md#field-mapping-old--new) — every field
   that changed name, shape or existence, with the two semantics changes called out. No row is
   ever removed from it. Every version directory also carries a `STATUS.md` stating its maturity
   and any discontinuity.

   *A machine-readable migration sidecar was built alongside that table and removed the same
   day: it is a converter input, and the entire basis for re-cutting in place is that there is
   nobody holding pre-re-cut data to convert. See the decline in
   [`ARTIFACTS.md`](../packages/standard/ARTIFACTS.md).*
3. **The earlier bytes are preserved**, at the annotated git tag
   **`standard/spec-v1.0.0-precut-2026-07`**, created before the first re-cut commit. Without it
   the pre-re-cut shape would be recoverable only by commit archaeology.

## Consequences

- **Good:** the standard reaches its first real adopters at `1.0.0` with the shape the research
  actually supports, and without a v2 that documents a phase nobody lived through.
- **Bad:** the project has done, once, the thing it now forbids. That is a permanent asterisk on
  its versioning story, and the honest answer to anyone who asks is on this page.
- **Bad:** anyone who fetched the pre-re-cut bytes holds documents that no longer validate and
  gets no automated signal — `specVersion` reads `1.0.0` in both shapes. The migration table and
  the git tag are the whole remedy.
- **Neutral:** the npm **package** version is free to move independently. The two-axis split
  (package/distribution version vs. spec version) is written down in `PROCESS.md`, which makes
  "the package went to 2.0.0, the spec stayed at 1.0.0" an unambiguous statement rather than a
  contradiction.

## Follow-ups

- **Done:** freeze mechanism — [`.github/workflows/spec-freeze.yml`](../.github/workflows/spec-freeze.yml)
  fails any PR touching a `schemas/v*/` directory that contains a `FROZEN` marker. The marker is
  deliberately **not** present yet; it lands with the promotion to `stable`, which is the moment
  the rule above starts to bite.
- **Done:** `PROCESS.md`, `GOVERNANCE.md`, `NORMATIVE.md` and per-version `STATUS.md` written and
  shipped alongside the re-cut, so the policy is not retrofitted after the exception.
- **Open:** the `$id` and `@context` hosts still do not dereference. Until they do, "the schema at
  this URL" remains a promise rather than a fact.

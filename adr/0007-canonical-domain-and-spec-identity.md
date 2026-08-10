# 0007. Adopt `ethrfps.app` as the canonical domain, and mint spec v1.0.0's identity on it

- **Status:** accepted
- **Deciders:** standard maintainers
- **Date:** 2026-08-10
- **Supersedes:** — *(no ADR. It discharges the identifier caveat that
  [`ARTIFACTS.md`](../packages/standard/ARTIFACTS.md) and
  [`schemas/v1.0.0/STATUS.md`](../packages/standard/schemas/v1.0.0/STATUS.md) have carried since
  the first cut, and it is the "canonical domain decision" named as the trigger on two rows of
  the ARTIFACTS *Planned* table.)*

## Context and problem statement

Every identifier this standard publishes — the schema `$id`, the meta-schema `$id`, the registry
entry-schema `$id`, the JSON-LD `@vocab`, and the two self-identification examples the schema
teaches — has been **provisional since the first cut**, and provisional *on the record* rather
than by omission. The project owned no domain. Two bad options were available and both were
declined: minting on a domain nobody controlled (an identifier that looks final, never resolves,
and is inherited by every downstream fork), or minting nothing at all (a schema with no `$id`,
which JSON Schema tooling handles badly and which makes `$ref` impossible).

What shipped instead was a deliberate placeholder: `baseUrl` pointed at
`raw.githubusercontent.com` on the default branch, which **did** dereference to exactly the bytes
shipped — served as `text/plain`, the one stated limitation — and `vocabIri` pointed at a path
under the project's own GitHub organisation carrying a `draft` segment, so it read as provisional
on sight. Both were annotated PROVISIONAL in `spec.config.json`, both were explained in
`STATUS.md` under "Known issues", and the whole machinery around them — one hand-written source of
identity, everything else stamped by `codegen.mjs`, an identity sweep in `check-spec.mjs` that
fails on any hand-written copy — existed for one reason: **so that adopting a real domain would be
a two-line edit and could not be done halfway.**

The domain landed. `ethrfps.app` is registered and controlled by the project. Three questions had
to be answered at once, because answering any one of them alone produces identifiers that have to
move again later:

1. **Where on the domain do the spec identifiers live**, given that the same domain must also host
   an API, a site, and whatever comes after.
2. **What does the vocabulary namespace IRI look like**, given that it must be versionless while
   the schema `$id` must be versioned.
3. **What does this do to v1.0.0**, which is already published to npm (`@the-rfp-hub/standard`,
   three releases) and whose identifiers are, by every rule this project has written down,
   part of the published version.

Constraints that were real on the date: v1.0.0's maturity was still `draft`, the spec-freeze gate
was dormant (no version carried a `FROZEN` marker), there were **no known external adopters**, and
the M1 research round had closed without any interviewee reporting a dependency on the current
identifier strings. `.app` is an [HSTS-preloaded TLD][hsts]: every browser forces HTTPS on it, so
there is no `http://` variant of anything here to decide about.

[hsts]: https://hstspreload.org/

## Decision drivers

- **A namespace IRI must survive the spec maturing.** A namespace that renames itself when
  `draft` becomes `stable` is not a namespace — it is a build artifact, and every triple minted
  under it becomes wrong on promotion day.
- **`$id` should be resolvable from a path a human can predict.** The right end state named in
  `ARTIFACTS.md` is a publication tree mirroring `$id` byte-for-byte; a base URL that does not
  match the package's own directory layout makes that tree a translation exercise forever.
- **One wildcard certificate.** `*.ethrfps.app` covers `api.ethrfps.app` but **not**
  `api.staging.ethrfps.app` — RFC 6125 wildcards match exactly one label. A naming convention
  that permits two-label subdomains commits the project to per-host certificates or a
  multi-SAN renewal dance, forever, for a cosmetic gain.
- **Identifiers are forever; hostnames for services are not.** Whatever serves the spec today
  will not be what serves it in three years. The identifier must not encode the server.
- **The swap must be a spent event, not a precedent.** "The identifiers were provisional" is a
  true statement exactly once. It must not be available as an argument the second time.

## Considered options

### Where the spec identifiers live

1. **The apex** — `https://ethrfps.app/schemas/v1.0.0/…` *(chosen)*
2. **A dedicated subdomain** — `https://spec.ethrfps.app/…` or `https://schemas.ethrfps.app/…`
3. **A redirection service** — `https://w3id.org/rfphub/…`, resolved by a community-run redirector

#### Option 1 — the apex

- Good, because the apex is the one hostname that cannot be repurposed without a decision: by
  reserving it for the spec and its site, `/schemas/`, `/meta/`, `/registries/` and `/ns/` become
  the standard's own namespace and **no future service can ever collide with an `$id`**.
- Good, because the paths mirror `packages/standard/`'s layout exactly, so the publication tree
  named in `ARTIFACTS.md` is a copy, not a mapping.
- Good, because it leaves every single-label subdomain free for services, which is what keeps one
  wildcard certificate viable.
- Bad, because the apex now carries a real availability obligation — it is not a parking page.
- Bad, because apex records cannot be `CNAME`s in ordinary DNS; whatever fronts the apex needs
  `ALIAS`/`ANAME` support or a static IP. A known, ordinary cost.

#### Option 2 — a dedicated subdomain

- Good, because it separates "the spec" from "the marketing site" at the DNS layer, and can be
  pointed at object storage independently.
- Bad, because it spends a single-label subdomain on something that is not a service, and invites
  the sibling question immediately (`spec.` or `schemas.`? both?) — a question with no right
  answer that would be re-litigated every time an artifact type is added.
- Bad, because the apex is then unreserved, and the first product decision that wants it
  (a dashboard, a redirect to the API docs) has to be weighed against identifiers that already
  exist. Reserving it now costs nothing; reclaiming it later costs a migration.

#### Option 3 — a redirection service (`w3id.org`)

- Good, because it is genuinely permanent — it outlives the domain registration, which is the one
  failure mode Options 1 and 2 share.
- Bad, because it makes every identifier depend on a third party's uptime and on a PR to their
  repository for every path change, and `ARTIFACTS.md` already declined PURL registration and
  content negotiation on exactly this reasoning.
- Bad, because it answers a question the project does not have. The argument for it is
  "what if the domain lapses" — which is a renewal-discipline problem, not an architecture
  problem, and buying a redirector to solve it adds a second thing that can lapse.

### The vocabulary namespace IRI

1. **`https://ethrfps.app/ns/rfp#`** — versionless, maturity-free *(chosen)*
2. **`https://ethrfps.app/ns/draft/rfp#`** — carry the `draft` segment across from the placeholder
3. **`https://ethrfps.app/schemas/v1.0.0/rfp#`** — put terms under the version directory

#### Option 1 — versionless

- Good, because it is the rule, not a preference: **term IRIs are versioned by the context
  DOCUMENT, never by the term.** `schema:name` does not become `schema:v13/name` when schema.org
  releases version 13, and for the same reason `…/ns/rfp#tracks` must not move when this spec
  cuts v2.0.0. The context document at `schemas/v1.0.0/context.jsonld` is what carries the
  version; the terms it maps to are stable across every version that keeps the term.
- Good, because it makes the "same term across two spec versions" case free: two context
  documents, one namespace, and a consumer merging data from both gets one predicate.
- Bad, because a versionless namespace can only be *added to*, never revised: removing a term
  from a future spec version does not remove it from the namespace, so the namespace accretes
  terms the current spec no longer uses. That is how vocabularies work, and it is a cost.

#### Option 2 — keep the `draft` segment

- Good, because it stays honest about maturity at a glance.
- Bad, and disqualifying: the segment mirrored `status`, and `status` is now `stable`. Keeping it
  would mint a namespace that is wrong the day it is minted; changing it later would break every
  triple. The segment did its job — it made the placeholder unmistakable — and its job is over.

#### Option 3 — terms under the version directory

- Good, because everything about the spec would then live under one path.
- Bad, because it is the exact anti-pattern Option 1 states. It also makes the namespace
  non-dereferenceable-by-design in a worse way: the version directory is frozen, so the
  vocabulary could never gain a term without a new spec version.

### What this does to v1.0.0

1. **Adopt the canonical identity in place, in v1.0.0** *(chosen)*
2. **Cut v1.0.1 or v1.1.0 carrying the new identifiers**
3. **Leave v1.0.0's identifiers provisional forever; use the canonical ones from v2.0.0 onward**

#### Option 1 — in place

- Good, because **it is not a change to the data contract**. What changed is the spelling of four
  URL strings. No property was added, removed, renamed or re-typed; no constraint moved in either
  direction; the bidirectional breaking-change test in `PROCESS.md` — *a document valid under N is
  invalid under N+1, or vice versa* — returns **no** for every document in the corpus and every
  document outside it. The schema is self-contained (local `#/$defs` pointers only), so no
  validator ever dereferenced `$id` to validate anything.
- Good, because the identifiers were **published as provisional**, in the artifact itself and in
  three places of prose, with this swap named as the pending event. A reader who pinned them did
  so against a written warning not to.
- Bad, and the honest cost: a consumer who hard-coded the old `$id` string — in an ajv
  `addSchema` registry, in a `$schema` value on their own documents, in a `@context` URL — gets
  a mismatch. That consumer is not known to exist, and no such consumer could have been getting
  the correct `Content-Type` anyway.
- Bad, because it consumes the project's remaining credibility on in-place edits. The mitigation
  is that this cut also **ends** them: v1.0.0 is declared `stable` and frozen in the same change.

#### Option 2 — a new spec version

- Good, because it is the maximally conservative reading of "a published version is immutable".
- Bad, because it invents a migration with nobody on the other end of it, and publishes two spec
  versions whose schemas are **byte-identical apart from four URLs**. Every consumer would then
  face a version-selection question with no semantic content behind it.
- Bad, because it does not even work as stated: v1.0.1 would be a patch, and `PROCESS.md` defines
  a patch as *editorial by definition — it may never change what validates*. Changing `$id` is
  editorial by that test, which lands the argument back at Option 1 having spent a version number.
  A minor (`1.1.0`) would additionally re-open `specVersion`, which is `const: "1.0.0"`, making a
  no-op identity swap into a genuinely breaking change for every document in existence — the
  precise outcome the whole exercise is meant to avoid ([ADR-0003](./0003-instance-self-identification-and-version-pattern.md)).

#### Option 3 — two identity regimes

- Good, because v1.0.0 is then untouched by any definition.
- Bad, because it permanently splits the vocabulary: v1.0.0 documents would carry
  `…/ns/draft/rfp#tracks` and v2.0.0 documents `…/ns/rfp#tracks`, and a consumer merging the two
  gets two predicates for one field. That is the schema.org `http`/`https` scar
  `ARTIFACTS.md` explicitly declines to imitate, self-inflicted on day one.
- Bad, because the placeholder namespace would have to be kept meaningful forever, on an
  authority (a GitHub path) that was never intended to serve anything.

## Decision outcome

**Chosen: the apex for spec identifiers, a versionless `/ns/rfp#` vocabulary namespace, adopted
in place in v1.0.0, which is simultaneously declared `stable` and frozen.**

### The URL scheme

| URL | What it is | Why this shape |
|---|---|---|
| `https://ethrfps.app/` | The spec and its site. **Reserved** — no service is ever mounted here, and no path outside the spec's own is ever served here. | The one hostname that cannot collide with an identifier. |
| `https://ethrfps.app/schemas/v<version>/opportunity.schema.json` | Schema `$id`. | Mirrors `packages/standard/` byte-for-byte. Versioned, because the schema is. |
| `https://ethrfps.app/schemas/v<version>/context.jsonld` | The JSON-LD context document. | Versioned: the **document** is what carries the version. |
| `https://ethrfps.app/schemas/index.json` | Machine-readable version index. | Versionless by nature — it is the index *of* versions. |
| `https://ethrfps.app/meta/rfphub-schema.meta.json` | Meta-schema `$id`. | Versionless: it is a normative artifact every version rests on. |
| `https://ethrfps.app/registries/entry.schema.json` | Registry entry-schema `$id`. | Same. |
| `https://ethrfps.app/ns/rfp#` | The vocabulary namespace (`@vocab`). | Versionless and maturity-free, one hop from the apex. |
| `https://api.ethrfps.app` | The public `/v1/` REST API. | **Single label.** |
| `https://api-staging.ethrfps.app` | Staging API. | **Single label** — environment qualifiers are hyphenated (`api-staging`), never dotted (`api.staging`). |

**Every URL for this host is `https://`, everywhere, with no plaintext fallback anywhere.** `.app`
is HSTS-preloaded: a browser will not issue a plaintext request to it at all, so an `http://`
example in a document is not a lenient alternative — it is a broken one. This also settles, for
this project, the dual-namespace question `ARTIFACTS.md` declines: there is exactly one scheme.

**The single-label rule is a certificate constraint, not an aesthetic one.** A wildcard
certificate matches exactly one label, so `*.ethrfps.app` covers `api-staging.ethrfps.app` and
does **not** cover `api.staging.ethrfps.app`. Hyphenating environment qualifiers keeps one
wildcard sufficient for every service the project will add.

### What was recorded, mechanically

| # | Decision |
|---|---|
| 1 | `spec.config.json` `baseUrl` → `https://ethrfps.app`; `vocabIri` → `https://ethrfps.app/ns/rfp#`. Both PROVISIONAL notes rewritten to describe the settled decision. `pnpm codegen` re-stamped four `$id`s, the `@vocab`, both self-identification examples and the versions index. |
| 2 | `status` → `stable`, and `schemas/v1.0.0/FROZEN` lands in the same change. The draft window that permitted three in-place revisions closes permanently. |
| 3 | `spec.config.json` gains `identityStatus: "canonical"` and `identityAdoption {date, adr, note}` — the machine-readable record that the one-time swap has been spent. |
| 4 | `check-spec.mjs` gains a **maturity** rule (`status` ∈ {`draft`, `stable`}, and `stable` ⟺ a `FROZEN` marker) and an **identity-provenance** rule (`identityStatus` is a known value, `baseUrl`/`vocabIri` are `https` and share one authority, and a `canonical` status names an ADR that exists). Its identity sweep no longer hard-codes the retired `draft` namespace path, and a new neutrality rule rejects either retired provisional identifier reappearing anywhere in the package. |
| 5 | `spec-freeze.yml` gains the identity-adoption exemption described below. |
| 6 | The API serves every canonical document at its canonical path, and advertises the context by `Link` header on `application/json` opportunity responses. |
| 7 | Package axis only: `@the-rfp-hub/standard` takes a **major** bump. The spec axis stays `1.0.0`. |

### The freeze gate

`spec-freeze.yml` locks a frozen version's schema directory, its conformance suite, the
versionless normative artifacts, and the identity fields of `spec.config.json`. Read literally
against this change, it does **not** fire: it reads `FROZEN` markers from the **base** ref, and
the base ref has none — v1.0.0 was `draft` until this commit. So the change would have landed
silently, permitted by an accident of ordering rather than by a rule.

That is the part worth fixing. A sanctioned exception that is indistinguishable from an unnoticed
one teaches the next maintainer that the gate can be walked around by sequencing commits. The gate
now:

- computes frozen-ness for the **`spec.config.json` identity check and the versionless artifacts**
  from base **∪** head, so the commit that freezes a version is held to the frozen rules for those
  files — which makes this change trip the gate, on purpose;
- permits an identity-field change on exactly one transition: `identityStatus` `provisional` →
  `canonical`, where `identityAdoption.adr` is an **accepted** record at `adr/NNNN-slug.md` that
  **names the `baseUrl` and `vocabIri` it sanctions**. Anything else is a violation;
- rejects `canonical` → `provisional` outright, which is what stops the exemption from being
  re-armed by a preparatory commit;
- under the exemption, holds every touched artifact — versioned and versionless alike — to an
  explicit allowlist of JSON pointers, each of whose new values must equal the identifier
  `spec.config.json` derives. The permitted set is exactly `$id`, the two self-identification
  examples, `@vocab`, and the identifiers inside the two self-identification conformance fixtures.

**The rule is a semantic comparison, and it lives in
[`scripts/spec-freeze.mjs`](../scripts/spec-freeze.mjs) rather than in workflow YAML.** The first
version of this gate did its comparison with `grep` over diff lines, and an independent review
demonstrated both of the ways that can be walked past: a second JSON member on the same line as
`$id` (`"$id": "…", "minProperties": 1,`) was discarded whole by the `$id`-line filter, and
"the first freeze may finish the directory" let the adoption PR widen `status`'s enum in the same
commit as the `FROZEN` marker. Both attempts are now tests
([`scripts/spec-freeze.test.mjs`](../scripts/spec-freeze.test.mjs)); a gate whose own claims are
not attacked is a comment.

The exemption is self-extinguishing: after this change the base ref always reads `canonical`, so
the `provisional` → `canonical` transition can never occur again. The versioned-directory rule is
deliberately left reading base-only — a version's `FROZEN` marker necessarily lands in the same
commit that finishes its directory, and making that rule base ∪ head would make declaring any
version stable impossible. What that rule no longer does is treat "not frozen at base" as "no
rules apply": during the adoption, a version directory is judged by the allowlist above.

**And the freeze stops contradicting `PROCESS.md`.** That document says informative content may be
corrected at any time; the first gate rejected every path below `schemas/v1.0.0/`, which would
have made the stale `draft` banner in `FIELDS.md` uncorrectable the moment this ADR merged. The
gate now permits modifying the four informative documents `NORMATIVE.md` names — `FIELDS.md`,
`CROSSWALK.md`, `BENCHMARK.md`, `STATUS.md` — and freezes everything else in the directory,
including `examples/` and the whole conformance suite. Additions and deletions are frozen either
way: a correction is a modification.

### Serving

The identifiers must dereference, or the project has swapped one non-resolving namespace for
another. `packages/api` therefore serves each canonical document at its canonical path — schema,
context, versions index, meta-schema and registry entry schema — reusing the schema-serving code
path that already existed for `/v1/opportunities/schema`, with `application/schema+json` and
`application/ld+json` as appropriate. Serving is mounted at the **root**, not under `/v1/`,
because the identifiers are not API resources and must not carry an API version.

**The reservation has to be enforced, because one deployable now answers on two hostnames.**
"Point the apex at the API" is not a way to reserve the apex — it is a way to publish the entire
`/v1` API at `ethrfps.app`, which would make "no service is ever mounted here" false on the day
DNS lands and would turn every future apex path into API collision surface. So the contract is
enforced in two independent places, and both are required:

| Layer | What it enforces |
|---|---|
| The application (`packages/api/src/plugins/apex-host.ts`) | An `onRequest` allowlist: on the apex host this service answers the five canonical document paths and 404s everything else, including `/`. The allowlist is derived from the Standard's `baseUrl` and the canonical document table, so it fails closed for routes added later. Asserted with both `Host` headers in `test/integration/apex-host.test.ts`. |
| The load balancer | The apex listener rule is **path-scoped** to the canonical prefixes (`/schemas/*`, `/meta/*`, `/registries/*`), so apex traffic for `/v1` never reaches a task. `api.` and `api-staging.` keep an unscoped rule. |

Neither layer is redundant: the application rule survives an infrastructure edit, and the
infrastructure rule survives a routing change in the application. The canonical documents answer
on **every** host on purpose — an identifier that resolves on only one hostname is not more
reserved, only harder to serve.

**The tradeoff, stated plainly: spec resolution now rides the API's uptime.** A schema `$id` is a
permanent, widely-cached identifier and an API is a deployable with a database behind it; those
have very different availability profiles, and coupling them is a compromise, not a design.
It is accepted for one reason — it is what makes the identifiers resolve *at all* on the day DNS
lands, using infrastructure that already exists — and it is bounded by an explicit migration path:

> **Migration to static hosting.** The served documents are byte-identical to the files in
> `packages/standard`. Publishing that directory to object storage behind a CDN and pointing the
> apex at it retires these routes entirely, with no change to any identifier and no consumer-visible
> event. The API keeps `/v1/opportunities/schema` (an API resource, correctly versioned); the
> root-mounted canonical routes are deleted. This should happen before the first external adopter
> depends on resolution, and the freeze makes it safe: the bytes can never change, so a CDN cache
> with an unbounded TTL is correct.

Until DNS for `ethrfps.app` is delegated, **nothing resolves**, and `STATUS.md` says so rather
than claiming a resolution that does not exist.

## Consequences

- **Good:** the identifier caveat that has sat in `STATUS.md`, `FIELDS.md`, `CROSSWALK.md` and
  `ARTIFACTS.md` since the first cut is discharged. Four documents stop apologising.
- **Good:** the two `ARTIFACTS.md` rows whose stated trigger was "the canonical domain decision"
  ship — the `Link` header context advertisement, and the publication tree mirroring `$id`.
- **Good:** the design bet paid. Identity lived in one hand-written file, everything else was
  stamped, and an identity sweep failed on hand-written copies — so the swap was two lines plus
  `pnpm codegen`, and the sweep caught all five stale copies (two conformance fixtures,
  `CROSSWALK.md`, `FIELDS.md`, and a test in the API package) that would otherwise have shipped a
  half-swapped package.
- **Bad — who pays:** any consumer holding the old `$id`/`@vocab` strings. Nobody is known to.
  The strings were published as provisional and the CHANGELOG entry states the swap explicitly.
- **Bad — who pays:** the API now owns an availability obligation for the spec until static
  hosting lands. If the API is down, `$id` does not resolve. The migration path above is the
  discharge, and it is a follow-up, not a hope.
- **Bad:** the apex carries a real service. It needs `ALIAS`/`ANAME` records or a static IP,
  it needs a certificate, and "the domain is a parking page" stops being a safe assumption.
- **Neutral:** the npm package takes a major bump for a change that alters no type and no
  validation behaviour. That is the package axis working as `PROCESS.md` describes — the
  published bytes changed observably, so the package version moves, and the spec version does not.
- **Neutral:** the vocabulary namespace is now append-only. Terms retired by a future spec version
  stay minted.

## Follow-ups

- **DNS is not done and only a human can do it.** Delegate `ethrfps.app`, front the apex, issue
  the `*.ethrfps.app` wildcard, and route `api.` to the API. Until then every URL in this ADR is
  correct and unreachable. **The apex rule is path-scoped**, per the serving table above — it
  forwards `/schemas/*`, `/meta/*` and `/registries/*` and nothing else; an unscoped apex rule
  publishes the whole API at the identifier authority and is the one routing mistake this
  decision cannot absorb.
- **Migrate spec serving to static hosting behind a CDN**, per the migration path above, and
  delete the root-mounted routes when it lands.
- **The deployment configuration still carries placeholder hostnames.** Adopting `api.ethrfps.app`
  and `api-staging.ethrfps.app` there is a separate change on the deployment branch; this ADR is
  the authority for the names it should use, including the single-label rule.
- **Decide whether `https://ethrfps.app/ns/rfp` should serve anything.** A vocabulary namespace is
  not required to dereference, and `ARTIFACTS.md` already schedules `vocabulary.ttl` behind "a
  consumer asks for it". If it is ever built, that document is what the namespace resolves to.
- `adr/README.md` gains a 0007 index row.

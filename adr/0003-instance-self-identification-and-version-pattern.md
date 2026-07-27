# 0003. Permit instance self-identification, and make `specVersion` a patch-line pattern

- **Status:** **partially accepted** — self-identification accepted; the `specVersion`
  patch-line pattern **reverted the same day (2026-07-27)**, see [Revert](#revert)
- **Deciders:** standard maintainers
- **Date:** 2026-07-27
- **Supersedes:** —

## Context and problem statement

Two small schema changes landed with the re-cut that were **not** part of the interview-derived
field plan in [ADR-0002](./0002-v-next-field-recut.md). They are additions to a settled plan, made
for tooling reasons rather than domain reasons, so they get their own record rather than being
folded in silently.

### The self-identification problem

The top-level object is `additionalProperties: false`. That is deliberate — a closed core is one
of the standard's design principles. But it had a consequence nobody had decided on: **a document
could not say what it was.**

- A generic JSON Schema validator conventionally looks for a `$schema` key on the *instance* to
  find the contract. Ours rejected it, so the contract had to be supplied out of band. There was
  no way for a file sitting on disk to name the schema it claims to conform to.
- A JSON-LD processor needs `@context` and, usually, `@type` on the document. Ours rejected both
  — which meant the shipped JSON-LD context could only be applied by wrapping or rewriting the
  document first.

This was not hypothetical. The project's own published crosswalk carried a JSON-LD usage example
with `@context` and `@type` at the top level, and **that example did not validate against the
project's own schema.** The documentation demonstrated something the schema forbade.

### The version-pattern problem

`specVersion` was `const: "1.0.0"`. That works exactly until the first editorial patch of the
spec. Under it, cutting `1.0.1` — correcting a description, registering vocabulary values,
fixing prose — would invalidate every document in existence, because they all say `1.0.0`. A
constant makes the patch level of the version unusable, which in practice means patch releases
never happen and corrections queue up behind a minor bump.

## Decision drivers

- A generic validator, or a linked-data processor, should be able to work from **the instance
  alone**. Requiring out-of-band knowledge to interpret a self-describing format is a defect.
- Documentation that does not validate is worse than no documentation — it teaches the wrong
  thing and it is evidence that nobody ran the example.
- Editorial corrections must be shippable without invalidating data. If they are not, the
  standard accumulates known-wrong prose.
- A closed core is worth keeping. Any exception must be a **named, finite** set, not a general
  loosening of `additionalProperties`.

## Considered options

### For self-identification

1. **Permit `$schema`, `@context` and `@type` as three named optional properties.**
2. **Relax `additionalProperties` to allow any `@`-prefixed or `$`-prefixed key.**
3. **Do nothing; require an envelope** for linked-data use, and fix the crosswalk example to drop
   the keys.

- **Option 1** — Good, because it is a finite, enumerated exception: three keys, each documented,
  each ignored by validation. Good, because it fixes the invalid example by making the example
  legal rather than by making it less useful. Bad, because it puts JSON-LD machinery into a schema
  that is otherwise transport-agnostic.
- **Option 2** — Good, because it is future-proof against further JSON-LD keywords (`@id`,
  `@graph`). Bad, because a pattern-based hole in a closed core is not a closed core: it silently
  admits anything a publisher chooses to prefix, and the standard would have no idea what those
  keys mean.
- **Option 3** — Good, because it keeps the schema pure. Bad, because it makes the shipped
  JSON-LD context unusable in place, which is the only reason to ship a context. Bad, because the
  envelope schema it depends on is planned, not built.

### For the version pattern

1. **`pattern: ^1\.0\.\d+$`** — accept any patch on the current minor line.
2. **Keep `const`, and bump it every patch** — accepting that documents must be rewritten.
3. **Drop the constraint entirely** — any string.

- **Option 1** — Good, because it makes editorial patches shippable without invalidating data, and
  it still pins the contract to a known minor line. Bad, because it is a **loosening**, and
  loosening is a breaking change under the project's own definition.
- **Option 2** — Good, because it is maximally strict and unambiguous. Bad, because it makes the
  patch level unusable in practice, which is the same as not having one.
- **Option 3** — Good, because it never invalidates anything. Bad, because a validator can no
  longer tell whether a document is claiming conformance to something it understands, which is
  the entire purpose of the field.

## Decision outcome

**Chosen: Option 1 in both cases — and the second was then reverted the same day.**

1. **Three optional top-level properties are permitted** against `additionalProperties: false`:
   `$schema` (a URI), `@context` (a string, object, or array), and `@type` (a string or array).
   They are **ignored by validation** — a `$schema` pointing elsewhere does not change which
   schema a document is validated against, and the standard makes no claim about the contents of
   `@context`. Their only purpose is to let a document be interpreted from itself. A conformance
   case carrying all three is in the published suite, and the crosswalk example now validates.
2. ~~**`specVersion` becomes `pattern: ^1\.0\.\d+$`.**~~ **Reverted the same day — see
   [Revert](#revert) below.** `specVersion` is `const: "1.0.0"`. The rule this was paired with
   in [`PROCESS.md`](../packages/standard/PROCESS.md) survives and is the precondition for ever
   reintroducing the pattern: **a spec patch release is editorial by definition and may never
   change what validates.**

Both the `$id` and the `specVersion` constant are stamped into the schema from
`spec.config.json` by codegen, so neither can drift from the declared spec version.

## Revert

The version-pattern half of this ADR was reverted within hours of landing. The record is kept
rather than deleted, because *why it was reverted* is the more useful half of it.

**What was reverted:** `specVersion` went from `const: "1.0.0"` → `pattern: ^1\.0\.\d+$` →
back to `const: "1.0.0"`.

**Why.** Classifying the change honestly under the bidirectional definition — a loosening is
breaking, because data that used to be rejected now validates — made the next question
unavoidable: *what is this buying right now?* The answer was nothing.

- **There is no patch process in existence** for the pattern to serve. `PROCESS.md` defines what
  an editorial patch would be, but none has ever been cut, none is pending, and the spec has
  exactly one live version.
- **No document anywhere carries a `1.0.x` value other than `1.0.0`** — not an example, not a
  conformance case, not a row in a database. The only file that exercised the pattern was a
  conformance fixture written specifically to exercise it.
- **A breaking change with no beneficiary is just risk.** Accepting one on the strength of a
  process that does not exist yet is exactly the reasoning the project's own re-cut rule exists
  to prevent.

**When to revisit.** At the first real editorial patch — a correction that must ship without
invalidating published documents. At that point the pattern has a concrete beneficiary and the
same argument runs the other way. The `PROCESS.md` rule it depends on is already written.

**What this cost.** Nothing published. One conformance pass case (`specversion-patch-line`) was
removed and the corresponding fail case renamed to `wrong-specversion`.

**What it bought, beyond the revert itself.** `PROCESS.md` keeps this as its worked example of a
loosening, now with its ending attached. A definition of "breaking" that only ever produces a
line in a changelog is decoration; this one produced a decision to undo a change.

## Consequences

- **Good:** a document is now self-describing. A validator, a linked-data processor, or a human
  opening the file can find the contract without being told.
- **Good:** the crosswalk's JSON-LD example validates. Documentation and schema agree.
- **Reverted — and this is the interesting part: the version-pattern change was itself breaking.**
  Under the bidirectional definition adopted in `PROCESS.md`, a change is breaking if a document
  valid under N is invalid under N+1 **or** if a document invalid under N is valid under N+1.
  `{"specVersion": "1.0.7"}` used to be rejected and briefly was accepted. No existing document
  was invalidated, and it reads to most people as a harmless relaxation — which is exactly why it
  was worth naming.

  It was landed **together with** the process document that defines breaking, deliberately: a
  policy whose first real case is quietly exempted from it is not a policy. Naming it correctly
  is what surfaced that it had no beneficiary, and it was reverted the same day. Editorial
  corrections to the spec therefore still cannot ship on a patch line — an accepted cost, with a
  named trigger for revisiting it.
- **Neutral — how `PROCESS.md` classifies the self-identification change.** It falls under the
  **indeterminate-state carve-out**: `additionalProperties: false` produced a definite rejection,
  but the schema had never taken a position on self-identification; it had simply never
  considered it. The carve-out is narrow and easy to abuse, and the honest reading is that this
  case sits near its edge rather than comfortably inside it. Either way the practical answer is
  the same, because the change shipped inside a re-cut that was breaking on other grounds.
- **Bad:** three JSON-LD and JSON Schema keywords now live in a schema that is otherwise about
  funding opportunities. That is a small, permanent smear of transport concern into the data
  model, accepted for what it buys.

## Follow-ups

- If further JSON-LD keywords are ever needed (`@id`, `@graph`), they are **new named
  exceptions**, decided one at a time. The named-exception approach is the decision; do not widen
  it to a pattern without a new ADR.
- `$schema` is permitted but not *used*: nothing dispatches on it, because there is only one live
  spec version to dispatch to. Instance-declared version negotiation is deliberately out of scope
  until there is more than one version to negotiate between.
- The `specVersion` patch-line pattern is revisited at the **first real editorial patch**, not
  before. Reintroducing it is a decision with its own evidence, not a resumption of this one.

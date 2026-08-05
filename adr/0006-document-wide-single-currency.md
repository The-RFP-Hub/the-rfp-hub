# 0006. Denominate every monetary amount in the single document-wide `fundingInfo.currency`

- **Status:** accepted — same 2026-08-05 draft-revision window as [0004](./0004-second-draft-revision-org-swap-and-closure.md)/[0005](./0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md)
- **Deciders:** standard maintainers
- **Date:** 2026-08-05
- **Supersedes:** [ADR-0002](./0002-v-next-field-recut.md) **in part** — decision #17, the
  envelope-only scoping of the single-currency rule. Decision #16 (one `currency` scalar on the
  envelope) is not superseded; its rule is **extended** from the envelope to the whole document.
  ADR-0004 #15's restatement — that "#17's single-currency scoping survives verbatim" — is
  overtaken with it, together with the two inlined `{amount, currency}` shapes that decision
  produced. Per the amendment rule, ADR-0002 and ADR-0004 are not edited; their status lines
  point forward.

## Context and problem statement

ADR-0002 #16 put a single `currency` scalar on the funding envelope, governing `budget`,
`allocated`, `minAward`, `maxAward` and `milestones[].amount`. ADR-0002 #17 deliberately
**scoped that rule to the envelope**: `bounty.reward`, each `hackathon.prizes[]` entry and
`accelerator.funding` kept their own currency, on the reasoning that a prize pool can
legitimately be denominated differently from the programme budget, and collapsing them would
lose information. ADR-0004 #15 carried the scoping forward verbatim when it inlined the
`monetaryAmount` def at `reward` and `funding`; the `amountRange` def behind `vc_fund.checkSize`
carried its own `currency` too.

The maintainer reopened the scoping in the same 2026-08-05 draft window, and the corpus was
measured rather than argued over: **every corpus document carrying per-type currency keys uses
exactly one distinct currency value, and where the envelope also names one, they agree — zero
mismatches.** The differently-denominated prize pool that #17 was protecting has **zero
instances** in the corpus. What the scoping actually produced in practice was the same currency
string repeated per prize (one hackathon example repeats `"USD"` 23 times) plus a permanent
consumer obligation to check two currency sites before comparing any two amounts.

## Considered options

1. **Keep the envelope-only scoping** (status quo).
2. **One document-wide currency** — `fundingInfo.currency` denominates every amount; the
   per-type currency fields are removed.
3. **Per-amount currency objects** — `{amount, currency}` at every denominated site, envelope
   included.

### Option 1 — keep the scoping

- Good, because it preserves the one expressiveness the corpus might someday need: a prize pool
  or reward denominated differently from the programme budget.
- Bad, because the corpus evidence says that need is currently hypothetical (zero instances),
  while the cost is paid on every document: duplicated currency strings, and no single answer to
  "what currency is this opportunity in".
- Bad, because it leaves the standard half-and-half — one rule for the envelope and milestones,
  another for the detail payloads — which is exactly the two-models-for-one-concept shape the
  re-cut existed to remove.

### Option 2 — document-wide single currency (chosen)

- Good, because it is what the data already does: hoisting was conflict-free across the entire
  corpus.
- Good, because every amount in a document becomes comparable and filterable against one
  currency site, and the generated types collapse three object shapes to plain numbers.
- Bad — the accepted cost, named honestly below: differently-denominated sub-amounts become
  inexpressible, not merely unusual.

### Option 3 — per-amount currency objects

- Good, because it is maximally expressive and locally self-describing.
- Bad, because it generalises the problem instead of the rule: it re-opens multi-currency
  drift *within* the envelope (which #16 closed on purpose), bloats every instance, and the
  corpus contains no document that would use the expressiveness. Rejected for the same reason
  the deeper modelling was rejected in ADR-0002: structure on speculation.

## Decision outcome

**Chosen: Option 2.** Every monetary amount in a document is denominated in the single
`fundingInfo.currency`. No sub-block carries a currency of its own.

| # | Decision |
|---|---|
| 1 | **`bounty.reward`** — `{amount, currency}` (both required) becomes a **plain required number**. |
| 2 | **`accelerator.funding`** — `{amount, currency}` becomes a **plain nullable number**. |
| 3 | **`hackathon.prizes[]`** — entries become `{track, amount}`; the per-prize `currency` key is removed. |
| 4 | **`vc_fund.checkSize`** (`$defs/amountRange`) — becomes `{min, max}`; its `currency` key is removed. |
| 5 | **`fundingInfo.currency` denominates all six sites:** the envelope amounts (`budget`, `allocated`, `minAward`, `maxAward`), `milestones[].amount`, `reward`, `prizes[].amount`, `funding` and `checkSize`. The dependency still crosses objects, so it stays schema-unenforceable; the validator's advisory milestone-currency check **generalises to every denominated amount**. |
| 6 | **Corpus, measured:** 24 documents had their single per-type currency hoisted into `fundingInfo.currency` (one already named it there); 97 per-type currency keys were stripped across 25 documents; **zero conflicts existed**. A new conformance fail case, `prize-with-currency.json`, pins the removal via `additionalProperties`. |

## Consequences

- **The accepted cost, named honestly:** a prize pool or reward can **no longer be denominated
  differently from the programme budget** — ETH prizes on a USD budget are inexpressible, not
  merely discouraged. The corpus contained zero such cases. A publisher with that need must
  publish per-currency entries (one document per denomination) or convert into the envelope
  currency; both are lossy at the edge #17 existed to protect. This compounds the two-asset-caps
  cost already recorded in ADR-0002's consequences — with `extensions` gone (ADR-0004), the
  overflow is `description` prose only.
- **Breaking for instances, both directions:** old-shape documents fail (`reward`/`funding`
  objects are no longer valid; `prizes[].currency` and `checkSize.currency` fail on
  `additionalProperties`), and the new plain-number shapes were previously invalid. The
  field-mapping table in `CHANGELOG.md` is the migration record; `specVersion` stays `1.0.0`
  under the same draft-window permission as ADR-0004/0005.
- **Good:** one question, one answer — a consumer comparing any two amounts in a document, or
  across documents, reads one currency site. The cross-object caveat that used to apply to
  milestones alone now applies uniformly, and the advisory tier covers it uniformly.
- **Package axis:** the generated `Prize`/`AmountRange` types shrink and the inlined
  `{amount, currency}` shapes disappear — the drift risk ADR-0004 #15 accepted when it inlined
  them is retired along with the shapes.

## Follow-ups

- `adr/README.md` gains a 0006 index row; ADR-0002's status line gains "#17 superseded by
  ADR-0006" and ADR-0004's status line notes #15's overtaken restatement — per the amendment
  rule, only the status lines move.
- If a real differently-denominated prize pool ever appears, the additive path is a per-entry
  `currency` **override** (absent = envelope currency), which would loosen this decision without
  reversing #16. Do not re-add required per-type currencies.

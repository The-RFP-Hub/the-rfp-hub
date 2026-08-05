# RFP Hub Standard v1.0.0 — Real-Data Benchmark

Validation of the standard against **real-world funding-opportunity data** from a production
funding aggregator's public API, plus a ranked benchmark set for schema/CLI testing.

**This document is informative** ([`NORMATIVE.md`](../../NORMATIVE.md)). It records a
measurement, not a rule.

> ⚠️ **Two measurements, two shapes.** The 311-entry pull below was run against the schema **as
> it stood before the 2026-07-27 in-place re-cut**, and has **not** been re-run. The 28 committed
> example documents **have** been converted to the re-cut shape and re-validated. Read the
> corpus-wide numbers as evidence about the data model, and the fixture numbers as evidence about
> the current schema. See the [field mapping table](../../CHANGELOG.md#field-mapping-old--new).

## Result

| Metric | Value | Measured against |
|---|---|---|
| Unique entries pulled | **311** | pre-re-cut shape |
| Mapped to source-neutral examples + validated | **289 / 289 valid (0 failures)** | pre-re-cut shape |
| Curated benchmark fixtures | **28** (in [`examples/`](./examples)) | **re-cut shape — 28/28 valid** |
| Funding types covered by fixtures | grant, hackathon, bounty, accelerator, rfp | — |

289 of the 311 pulled entries mapped to public-source, source-neutral examples and all validated
with 0 failures — evidence that the data model is faithful to a real funding corpus. The
remaining ~22 were set aside for lacking a public original-posting URL or to keep the sample free
of any one aggregator's branding. Example ids use a neutral `fundingmap:` namespace.

The **28 committed fixtures are the live claim**: they were converted field-by-field to the
re-cut shape and all 28 validate against the current
[`opportunity.schema.json`](./opportunity.schema.json).

```bash
npx rfphub-validate packages/standard/schemas/v1.0.0/examples
# 28 passed, 0 failed
```

## What the re-cut conversion did to these 28 documents

Mechanical, and lossless where a real value existed. Each move follows a row in the
[field mapping table](../../CHANGELOG.md#field-mapping-old--new):

- **`type` → `fundingType`**, and each document's type block re-keyed to match. No document
  carried a second, non-matching type block, so the newly enforced one-block-per-type rule cost
  nothing here.
- **`organization` → `sponsoringOrganizations[0]`** — a wrap, no data change. No fixture needed
  `operatingOrganizations`.
- **`source.url` has no successor.** Where a document had no `applicationUrl`, the old source URL
  became the `applicationUrl` — it was the only link-back target left. Where `applicationUrl`
  already pointed somewhere else, the source URL was preserved in **`resourceLinks`** rather than
  dropped: **6 of the 28 documents** carry one for that reason.
- **Hackathon date folding.** `registrationDeadline`, `submissionDeadline`, `startDate` and
  `endDate` all folded into `deadlines[]` with labels `registration` / `submission` /
  `event start` / `event end`; `closesAt` and `rfp.proposalDeadline` folded in as `application`.
  Across the corpus this produced **28 `application`, 18 `registration`, 19 `event start` and 19
  `event end`** entries — which is exactly why a consumer must select by label: 19 of these
  documents carry event boundaries alongside the application deadline (on 7 of them the
  earliest-dated entry is an event boundary rather than a deadline), and array order carries no
  meaning at all.
- **`funding.totalBudget` → `budget`**, `amountDistributed` → `allocated`. Only one document had
  a non-zero `funding.awardsToDate`, a field with no successor; that value was preserved under
  **`extensions`** rather than deleted. It is the only fixture using `extensions`.
- No fixture exercises `milestones[]`, `eligibility`, `serviceAgreement` or `prerequisites` —
  the source corpus carries none of them. Those fields are exercised by the
  [conformance suite](../../conformance/v1.0.0), not by this benchmark.

## Methodology (original pull)

- **Source:** a production funding aggregator's public REST API (`isValid=accepted`, sorted by
  recency); 3 general pages (100/page) plus one page per type for diversity, deduped to 311.
- **Mapping:** each entry mapped to the Standard's public shape; source-system internal fields
  are dropped (the standard is source-agnostic).
- **Validation:** ajv 8 (`ajv/dist/2020`) + `ajv-formats`, `strict: true, strictRequired: false`.
- **Fill score** — count of *populated* Standard fields (scalar leaves + non-empty arrays and
  their items), excluding the always-present `specVersion`/`id`/type discriminator and
  `extensions`. Higher = richer entry, better for exercising schema breadth.
- **Activity score** — `status` weight (`open` 4 / `upcoming` 3 / `closed` 1 / `archived` 0)
  `+3` if the application deadline is in the future, `+1` if `opensAt` is in the future,
  `+` recency (up to `+4`, linearly decaying over 1 year from `updatedAt`). *(Computed on the
  pre-re-cut single `closesAt` scalar; under the re-cut shape the same score would read the
  `application`-labelled entry of `deadlines[]`.)*

Both scores are **ranking heuristics for choosing fixtures**, not quality metrics of the
standard, and neither is normative.

## Per-type coverage (original pull)

| Type | Sampled | Valid |
|---|--:|--:|
| grant | 99 | 99 |
| hackathon | 130 | 130 |
| bounty | 42 | 42 |
| accelerator | 16 | 16 |
| rfp | 2 | 2 |
| **vc_fund** | **0** | — |

> ⚠️ **`vc_fund` coverage gap:** there are **zero** VC-fund entries in the source data, so the
> `vc_fund` block still cannot be benchmarked against real data. Its only coverage is the
> conformance suite — [`conformance/v1.0.0/pass/vc-fund.json`](../../conformance/v1.0.0/pass/vc-fund.json)
> exercises the full block — and real VC-fund entries should be added during later seeding.
> `rfp` is also thin (2 entries) — worth expanding given this is the *RFP* Hub.

## Benchmark fixture set

The 28 fixtures in [`examples/`](./examples) are the top entries by fill, with type diversity
injected (≥1 of each available type): **19 hackathon, 6 grant, 1 bounty, 1 accelerator, 1 rfp**.
They serve as (a) the real-data validation corpus, (b) golden inputs for the `rfphub-validate`
CLI, and (c) realistic seed candidates for the public dataset. They are **examples, not
conformance cases** — the pass/fail rule documents live in
[`conformance/v1.0.0/`](../../conformance/v1.0.0). The single best all-round benchmark entry is
**Prezenti Boost Pool S2** (`fundingmap:1459`) — open at pull time and high fill. (Its single
application deadline, 2026-06-30, has since passed: fixtures are a snapshot of the original
pull, not live state, so a stale `status`/deadline pair here is expected rather than an error.)

### Top 15 by FILL (most complete entries, original pull)

| # | Fill | Activity | Type | Status | Name | id |
|--:|--:|--:|---|---|---|---|
| 1 | 73 | 2.86 | hackathon | archived | Electrothon 8.0 | fundingmap:1200 |
| 2 | 49 | 2.86 | hackathon | archived | HACKANOVA 5.O | fundingmap:1197 |
| 3 | 46 | 3.11 | hackathon | archived | ETHGlobal Cannes 2026 | fundingmap:1095 |
| 4 | 42 | 10.58 | grant | open | Prezenti Boost Pool S2 | fundingmap:1459 |
| 5 | 39 | 2.92 | hackathon | archived | HackByte 4.0 | fundingmap:1210 |
| 6 | 37 | 3.13 | hackathon | archived | Hack-Helix | fundingmap:1340 |
| 7 | 36 | 9.81 | hackathon | upcoming | ETHGlobal Lisbon 2026 | fundingmap:1093 |
| 8 | 36 | 9.81 | hackathon | upcoming | ETHGlobal Mumbai | fundingmap:1091 |
| 9 | 36 | 3.88 | hackathon | archived | ETHGlobal New York 2026 | fundingmap:1094 |
| 10 | 35 | 4.58 | grant | closed | Prezenti Mint Round | fundingmap:600 |
| 11 | 34 | 3.44 | hackathon | archived | Locus' Paygentic Hackathon - #2 | fundingmap:1389 |
| 12 | 34 | 3.22 | hackathon | archived | Locus' Paygentic Hackathon - #1 | fundingmap:1356 |
| 13 | 33 | 10.58 | grant | open | Prezenti Anchor Pool | fundingmap:1458 |
| 14 | 33 | 3.87 | grant | closed | Build Agents for the Real World Hackathon V2 | fundingmap:1059 |
| 15 | 33 | 3.44 | hackathon | archived | Locus' Paygentic Hackathon - #4 | fundingmap:1430 |

### Top 15 by ACTIVITY (most live opportunities, original pull)

| # | Activity | Fill | Type | Status | Name | id |
|--:|--:|--:|---|---|---|---|
| 1 | 10.91 | 27 | hackathon | upcoming | FutureForge Hackathon 2026 | fundingmap:1494 |
| 2 | 10.91 | 25 | hackathon | upcoming | MicroCraft - Vibeathon | fundingmap:1493 |
| 3 | 10.91 | 25 | hackathon | upcoming | Ignisys 1.O | fundingmap:1495 |
| 4 | 10.81 | 29 | hackathon | upcoming | DSU DEVHACK 3.0 | fundingmap:1488 |
| 5 | 10.81 | 25 | hackathon | upcoming | Hack On Hills 8.0 | fundingmap:1490 |
| 6 | 10.81 | 25 | hackathon | upcoming | Hack4Brahma 2.0 | fundingmap:1489 |
| 7 | 10.81 | 25 | hackathon | upcoming | HackNex Season 2 | fundingmap:1483 |
| 8 | 10.81 | 25 | hackathon | upcoming | SheBuilds Chennai Hack | fundingmap:1487 |
| 9 | 10.81 | 25 | hackathon | upcoming | ccuhacks | fundingmap:1478 |
| 10 | 10.81 | 25 | hackathon | upcoming | HACKER HOUSE GOA 2026 | fundingmap:1480 |
| 11 | 10.58 | 42 | grant | open | Prezenti Boost Pool S2 | fundingmap:1459 |
| 12 | 10.58 | 33 | grant | open | Prezenti Anchor Pool | fundingmap:1458 |
| 13 | 10.24 | 25 | hackathon | upcoming | Citadel Hackathon - Season 1 | fundingmap:1390 |
| 14 | 10.05 | 24 | grant | open | infraBUIDL(AI) | fundingmap:938 |
| 15 | 10.05 | 15 | grant | open | Arbitrum Audit Program | fundingmap:1320 |

*Both scores are as measured on the pre-re-cut shape at pull time. The re-cut removed some fields
and added others, so the absolute fill numbers would shift, and activity scores decay with the
calendar; the ranking that selected these fixtures would not change materially.*

## Reproduce

An internal pull/map/rank script reads a production funding aggregator's public API, maps each
entry to the Standard, validates with ajv, and ranks by fill/activity. Raw pulled data and full
scored rankings stay local (reproducible from the public API) and are not committed. Re-running
it against the re-cut shape is worthwhile before the next cut, and would replace the pre-re-cut
figures above.

# RFP Hub Standard v1.0.0 — Real-Data Benchmark

Validation of the standard against **real-world funding-opportunity data** from a production
funding aggregator's public API, plus a ranked benchmark set for schema/CLI testing. Satisfies
the M1 criterion: *"Schema validates successfully against ≥20 real-world funding-opportunity
entries seeded from existing funding-map data."*

## Result

| Metric | Value |
|---|---|
| Unique entries pulled | **311** |
| Mapped to source-neutral examples + validated | **289 / 289 valid (0 failures)** |
| Curated benchmark fixtures | **28** (in [`examples/`](./examples)) |
| Types covered by fixtures | grant, hackathon, bounty, accelerator, rfp |

289 of the 311 pulled entries mapped to public-source, source-neutral examples and **all
validate (0 failures)** — strong evidence the schema is faithful to a real funding model. The
remaining ~22 were set aside for lacking a public `source.url` or to keep the sample free of
any one aggregator's branding. Example ids use a neutral `fundingmap:` namespace.

## Methodology

- **Source:** a production funding aggregator's public REST API (`isValid=accepted`, sorted by
  recency); 3 general pages (100/page) plus one page per type for diversity, deduped to 311.
- **Mapping:** each entry mapped to the Standard's public shape; source-system internal fields
  are dropped (the standard is source-agnostic).
- **Validation:** ajv 8 (`ajv/dist/2020`) + `ajv-formats`, `strict: true, strictRequired: false`.
- **Fill score** — count of *populated* Standard fields (scalar leaves + non-empty arrays and
  their items), excluding the always-present `specVersion`/`id`/`type` and `extensions`.
  Higher = richer entry, better for exercising schema breadth.
- **Activity score** — `status` weight (`open` 4 / `upcoming` 3 / `closed` 1 / `archived` 0)
  `+3` if `closesAt` is in the future, `+1` if `opensAt` is in the future, `+` recency (up to
  `+4`, linearly decaying over 1 year from `updatedAt`).

## Per-type coverage

| Type | Sampled | Valid |
|---|--:|--:|
| grant | 99 | 99 |
| hackathon | 130 | 130 |
| bounty | 42 | 42 |
| accelerator | 16 | 16 |
| rfp | 2 | 2 |
| **vc_fund** | **0** | — |

> ⚠️ **`vc_fund` coverage gap:** there are **zero** VC-fund entries in the source data, so the
> `vc_fund` block cannot be benchmarked against real data yet. The block is unit-tested in the
> schema smoke test; real VC-fund entries should be added during later seeding. `rfp` is also
> thin (2 entries) — worth expanding given this is the *RFP* Hub.

## Top 15 by FILL (most complete entries)

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

## Top 15 by ACTIVITY (most live opportunities)

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

## Benchmark fixture set

The 28 fixtures in [`examples/`](./examples) are the top entries by fill, with type diversity
injected (≥1 of each available valid type). They double as: (a) the M1 ≥20-entry validation
corpus, (b) golden inputs for the `rfphub-validate` CLI, and (c) realistic seed candidates for
the public dataset. The single best all-round benchmark entry is **Prezenti Boost Pool S2**
(`fundingmap:1459`) — open, future deadline, and high fill (42).

## Reproduce

An internal pull/map/rank script reads a production funding aggregator's public API, maps each
entry to the Standard, validates with ajv, and ranks by fill/activity. Raw pulled data and full
scored rankings stay local (reproducible from the public API) and are not committed.

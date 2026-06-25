# RFP Hub Standard v1.0.0 — Real-Data Benchmark (DEV-441)

Validation of the standard against **real Karma Funding Map data**, plus a ranked benchmark
set for schema/CLI testing. Satisfies the M1 criterion: *"Schema validates successfully
against ≥20 real-world funding-opportunity entries seeded from existing Karma Funding Map
data."*

## Result

| Metric | Value |
|---|---|
| Unique entries pulled (live prod API) | **311** |
| Mapped → Standard v1.0.0 and validated | **311 / 311 valid (0 failures)** |
| Curated benchmark fixtures | **28** (in [`examples/`](./examples)) |
| Types covered by fixtures | grant, hackathon, bounty, accelerator, rfp |

The standard validated **100%** of real, mapped data on the first pass — strong evidence the
schema is faithful to the live funding model while staying decoupled from Karma internals.

## Methodology

- **Source:** `GET https://gapapi.karmahq.xyz/v2/program-registry/search` (production),
  `isValid=accepted`, `sortField=updatedAt&sortOrder=desc`. Pulled 3 general pages (100/page)
  plus one page per type for diversity, then deduped by `programId` → 311 unique entries.
- **Mapping:** each entry mapped to the Standard via the `program_registry → Standard` table
  in [FIELDS.md](./FIELDS.md). Karma/on-chain internals were pushed to `extensions.karma.*`.
- **Validation:** ajv 8 (`ajv/dist/2020`) + `ajv-formats`, `strict: true, strictRequired: false`.
- **Fill score** — count of *populated* Standard fields (scalar leaves + non-empty arrays and
  their items), excluding the always-present `specVersion`/`id`/`type` and `extensions`.
  Higher = richer entry, better for exercising schema breadth.
- **Activity score** — `status` weight (`open` 4 / `upcoming` 3 / `closed` 1 / `archived` 0)
  `+3` if `closesAt` is in the future, `+1` if `opensAt` is in the future, `+` recency (up to
  `+4`, linearly decaying over 1 year from `updatedAt`).

## Per-type coverage

| Type | Registry count (accepted) | In sample | Valid |
|---|--:|--:|--:|
| grant | 268 | 121 | 121 |
| hackathon | 143 | 130 | 130 |
| bounty | 50 | 42 | 42 |
| accelerator | 19 | 16 | 16 |
| rfp | 2 | 2 | 2 |
| **vc_fund** | **0** | 0 | — |

> ⚠️ **`vc_fund` coverage gap:** there are **zero** VC-fund entries in the live registry, so
> the `vcFund` block cannot be benchmarked against real data yet. The block was unit-tested in
> the schema smoke test, but real-world VC-fund entries should be added during M5 seeding.
> `rfp` is also thin (2 entries) — worth expanding given this is the *RFP* Hub.

## Top 15 by FILL (most complete entries)

| # | Fill | Activity | Type | Status | Name | id |
|--:|--:|--:|---|---|---|---|
| 1 | 73 | 2.87 | hackathon | archived | Electrothon 8.0 | karma:1200 |
| 2 | 49 | 2.87 | hackathon | archived | HACKANOVA 5.O | karma:1197 |
| 3 | 46 | 3.13 | hackathon | archived | ETHGlobal Cannes 2026 | karma:1095 |
| 4 | 42 | 10.60 | grant | open | Prezenti Boost Pool S2 | karma:1459 |
| 5 | 39 | 2.93 | hackathon | archived | HackByte 4.0 | karma:1210 |
| 6 | 37 | 3.14 | hackathon | archived | Hack-Helix | karma:1340 |
| 7 | 36 | 9.83 | hackathon | upcoming | ETHGlobal Lisbon 2026 | karma:1093 |
| 8 | 36 | 9.83 | hackathon | upcoming | ETHGlobal Mumbai | karma:1091 |
| 9 | 36 | 3.90 | hackathon | archived | ETHGlobal New York 2026 | karma:1094 |
| 10 | 36 | 1.31 | grant | closed | Proof of Ship - Season 7 | karma:954 |
| 11 | 35 | 4.59 | grant | closed | Prezenti Mint Round | karma:600 |
| 12 | 34 | 3.46 | hackathon | archived | Locus' Paygentic Hackathon - #2 | karma:1389 |
| 13 | 34 | 3.24 | hackathon | archived | Locus' Paygentic Hackathon - #1 | karma:1356 |
| 14 | 33 | 10.60 | grant | open | Prezenti Anchor Pool | karma:1458 |
| 15 | 33 | 3.88 | grant | closed | Build Agents for the Real World Hackathon V2 | karma:1059 |

## Top 15 by ACTIVITY (most live opportunities)

| # | Activity | Fill | Type | Status | Name | id |
|--:|--:|--:|---|---|---|---|
| 1 | 10.93 | 27 | hackathon | upcoming | FutureForge Hackathon 2026 | karma:1494 |
| 2 | 10.93 | 25 | hackathon | upcoming | MicroCraft - Vibeathon | karma:1493 |
| 3 | 10.93 | 25 | hackathon | upcoming | Ignisys 1.O | karma:1495 |
| 4 | 10.91 | 26 | hackathon | upcoming | Girlathon 4.0 | karma:1492 |
| 5 | 10.82 | 29 | hackathon | upcoming | DSU DEVHACK 3.0 | karma:1488 |
| 6 | 10.82 | 25 | hackathon | upcoming | Hack On Hills 8.0 | karma:1490 |
| 7 | 10.82 | 25 | hackathon | upcoming | Hack4Brahma 2.0 | karma:1489 |
| 8 | 10.82 | 25 | hackathon | upcoming | HackNex Season 2 | karma:1483 |
| 9 | 10.82 | 25 | hackathon | upcoming | SheBuilds Chennai Hack | karma:1487 |
| 10 | 10.82 | 25 | hackathon | upcoming | ccuhacks | karma:1478 |
| 11 | 10.82 | 25 | hackathon | upcoming | HACKER HOUSE GOA 2026 | karma:1480 |
| 12 | 10.69 | 26 | grant | open | Prezenti Frontier Pool | karma:1484 |
| 13 | 10.60 | 42 | grant | open | Prezenti Boost Pool S2 | karma:1459 |
| 14 | 10.60 | 33 | grant | open | Prezenti Anchor Pool | karma:1458 |
| 15 | 10.25 | 25 | hackathon | upcoming | Citadel Hackathon - Season 1 | karma:1390 |

## Benchmark fixture set

The 28 fixtures in [`examples/`](./examples) are the top entries by fill, with type diversity
injected (≥1 of each available valid type). They double as: (a) the M1 ≥20-entry validation
corpus, (b) golden inputs for the `rfphub-validate` CLI (DEV-442), and (c) realistic seed
candidates for the M2 dataset. The single best all-round benchmark entry is
**Prezenti Boost Pool S2** (`karma:1459`) — open, future deadline, and high fill (42).

## Reproduce

Pull/map/rank script: `scratchpad/pull-rank.js` (uses the FIELDS.md mapping + ajv). Raw pulled
data and full scored rankings are saved to scratchpad (`raw-entries.json`, `scored.json`,
`summary.json`) — not committed, since they are reproducible from the live API.

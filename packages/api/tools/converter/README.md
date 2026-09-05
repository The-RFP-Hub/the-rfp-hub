# Offline converter (developer tooling)

**Nothing in this directory runs at seed time, at request time, in CI, or on a deploy.** It is
maintainer tooling for one job: rebuilding the curated dataset in bulk when it drifts too far to
edit by hand.

The dataset the API serves is [`../../data/seed-corpus.json`](../../data/seed-corpus.json) — RFP
Hub Standard v1.0.0 documents, committed, reviewed and versioned with the repository. The seed
loader reads that file and nothing else. These tools sit *upstream of a human*, not upstream of the
seed.

## The pipeline

```
fetch-corpus.ts ──► out/raw-programs.json ──► convert.ts ──► out/draft-corpus.json ──► [ curate ] ──► data/seed-corpus.json
   (network)          (working file)          (pure mapper)     (working file)          (a person)      (the dataset)
```

```bash
# 1. snapshot an upstream registry (the only step that opens a socket)
SOURCE_API_URL=https://… SOURCE_BRAND="acme,acme-labs" pnpm --filter @the-rfp-hub/api corpus:fetch

# 2. map to Standard v1.0.0 and validate; non-conforming records are named, not repaired
pnpm --filter @the-rfp-hub/api corpus:convert

# 3. curate by hand, then commit the result as data/seed-corpus.json
```

`out/` is gitignored. Neither working file is a repo artifact: the raw snapshot is somebody else's
data in somebody else's shape, and the draft is a machine's first guess at ours.

## Why step 3 is a person

A mapper can only restate what the upstream said. It cannot know that a program closed last month,
that a budget was announced in a governance post, that a listing labeled `bounty` is really a
hackathon, or that an organization renamed itself. Every one of those is a fact about the funder,
published on the funder's own site, and the committed corpus is what it is because a human went and
read them. Step 2's output is the *starting point* for that pass, never a substitute for it.

This is also why the converter is tooling rather than a pipeline stage. Wiring it into the seed
would mean the served data is whatever an upstream said at some unrecorded moment, which is the
design this dataset deliberately replaced.

## `SOURCE_API_URL`

`fetch-corpus.ts` is the only file in the package that reads it. It is env-only, supplied for one
command by hand, and no value for it is ever committed — the upstream host appears in no tracked
file in this repo. `SOURCE_BRAND` (comma-separated) and `CORPUS_SIZE` are its optional companions.

Neutralization runs inside the fetch, not after it: vendor-named keys are stripped at every depth
and any record still naming the vendor is excluded outright rather than rewritten. Real-world data
— organization names, ecosystems, the programs' own URLs — is public and kept verbatim.

## The provenance namespace

`SOURCE_SYSTEM` in `map-program.ts` (`fundingmap` in `fundingmap:1459`) forms every public id and
fills the `source_system` column, where it pairs with `original_id` in a uniqueness constraint that
makes re-seeding idempotent. It is a constant here because it is a data contract, not a knob.

The seed loader does not import it: it reads each document's namespace off the document's own id,
so what lands in `source_system` is what consumers already see in the id. In M3 the namespace
becomes a property of a publisher record rather than one global.

## Tests

`test/` holds the mapper's own suites — fidelity (what the upstream carries that the Standard has a
home for, and what the closed core cannot carry) and the bounty-kind inference. They run in the
normal `pnpm test` sweep, on hand-built upstream fixtures: the mapper's contract is worth keeping
green even though nothing on the serving path calls it.

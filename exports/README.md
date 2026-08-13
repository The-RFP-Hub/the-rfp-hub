# Open data

This folder is **machine-written**. A scheduled job
([`.github/workflows/nightly-export.yml`](../.github/workflows/nightly-export.yml)) reads the
public API, checks what it gets back, and commits the result here. Nothing in it is edited by
hand, and a pull request should not need to touch it.

The data files appear after the first publishing run. Until then this README is the only file
here.

## What lands here

Every run replaces the same six files:

| File | What it is |
|---|---|
| `LICENSE` | The CC0-1.0 rights sidecar, so a bare file set is machine-detectable as CC0. |
| `opportunities-<YYYY-MM-DD>-<digest>.json` | That run's archive. The digest is a prefix of the sha256 of the file's own bytes. |
| `opportunities-<YYYY-MM-DD>-<digest>.csv` | The same records, flat. |
| `latest.json` | A stable name a consumer can hard-code. |
| `latest.csv` | Ditto. |
| `latest.manifest.json` | The run's single authoritative pointer: a run id, and the href + full sha256 of both archives. |

The folder holds exactly one run. Superseded snapshots are not deleted so much as replaced — every
one of them stays in this repository's history, which is a better archive than a directory that
grows by two files a day and that every clone has to carry.

## Reading it

The files are served directly, over TLS, with no API key:

```
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.json
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.csv
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/latest.manifest.json
https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/exports/LICENSE
```

`latest.json` and `latest.csv` are two independently named mutable files, so a consumer fetching
both can, rarely, catch one of each run. **Read `latest.manifest.json` first** if the pair has to
be consistent: it names both archives by their immutable filenames and records the full sha256 of
each, so what you download can be verified rather than assumed. Resolve the manifest once, fetch
what it names, hash the bytes, compare.

These files are a **nightly snapshot**: at most ~24 hours old, and in exchange, immutable and
verifiable. The API serves the same dataset **live**, from the same serializer, at
`/v1/export/opportunities.json` and `/v1/export/opportunities.csv` — one call, no pagination, byte
for byte the same per record. That response is current but carries no run id and no digest, so
nothing can vouch for it after the fact. Use the endpoint for today's answer; use these files when
you need an artifact you can cite, verify or diff against later.

The dataset is released under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) — the
same terms in the JSON envelope, in the manifest and in the `LICENSE` sidecar beside them. The
repository's own MIT licence covers the code, not this data.

See [packages/api/README.md](../packages/api/README.md#open-data-export) for the format in full.

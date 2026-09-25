# Status of this version — RFP Hub Standard v1.0.1

*This section describes the status of this version of the standard at the time of publication.
Other documents may supersede it. A machine-readable index of all versions is at
[`schemas/index.json`](../index.json).*

| | |
|---|---|
| **Version** | `1.0.1` |
| **Maturity** | **`stable`** — declared 2026-09-25; this directory is frozen (`FROZEN`) |
| **Identifiers** | **Canonical**, on `rfpsear.ch`. Stamped from [`spec.config.json`](../../spec.config.json) — see [`adr/0013`](../../../../adr/0013-move-spec-identity-to-rfpsear-ch.md) |
| **Supersedes** | [`v1.0.0`](../v1.0.0/STATUS.md), whose identifiers stay on `ethrfps.app` |
| **Superseded by** | none — this is the current version |
| **Feedback** | GitHub issues on [`The-RFP-Hub/the-rfp-hub`](https://github.com/The-RFP-Hub/the-rfp-hub/issues) |
| **License** | CC0 1.0 |

## What changed from v1.0.0

Only the identity. The project moved from `ethrfps.app` to `rfpsear.ch`, and v1.0.0's
identifiers are frozen bytes, so the move takes a new version directory.

| | v1.0.0 | v1.0.1 |
|---|---|---|
| Schema `$id` | `https://ethrfps.app/schemas/v1.0.0/opportunity.schema.json` | `https://rfpsear.ch/schemas/v1.0.1/opportunity.schema.json` |
| Context | `https://ethrfps.app/schemas/v1.0.0/context.jsonld` | `https://rfpsear.ch/schemas/v1.0.1/context.jsonld` |
| `@vocab` | `https://ethrfps.app/ns/rfp#` | `https://rfpsear.ch/ns/rfp#` |
| `specVersion` | `"1.0.0"` | `"1.0.0"` or `"1.0.1"` |

Every other constraint, `$def`, example and conformance case is v1.0.0's. A document that
validates against v1.0.0 validates against v1.0.1, and the only document valid under v1.0.1 and
not under v1.0.0 is one declaring `specVersion: "1.0.1"`. Under the bidirectional definition in
[`PROCESS.md`](../../PROCESS.md#what-breaking-means) that one value is a loosening; it is also
the version marker itself, which any new version has to change.

Linked-data consumers: term IRIs moved with the vocabulary. `https://ethrfps.app/ns/rfp#x` and
`https://rfpsear.ch/ns/rfp#x` name the same term, as [`ns/rfp.jsonld`](../../ns/rfp.jsonld)
records.

## Maturity: `stable`

**This version is frozen**, on the same terms as v1.0.0: the `FROZEN` marker sits beside this
document and [`.github/workflows/spec-freeze.yml`](../../../../.github/workflows/spec-freeze.yml)
fails any PR that edits its normative bytes. The history of the contract itself — the re-cut,
the four draft revisions, the feature stages — is in [v1.0.0's `STATUS.md`](../v1.0.0/STATUS.md).

## How to comment

Open a GitHub issue. Substantive changes stay open for a minimum comment window before merge;
editorial corrections to informative documents do not need one. Both rules, and the errata
labels used to triage them, are in [`PROCESS.md`](../../PROCESS.md).

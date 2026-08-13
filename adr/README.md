# Architecture decision records

Numbered, dated records of the decisions that shaped the RFP Hub Standard — kept because the
schema itself can only show *what* was decided, never *why*, and "why did this field disappear?"
is the question a publisher actually asks.

These are **batch records**, not one per change. A single re-cut touching two dozen fields is one
decision made in one sitting for one set of reasons; splitting it into twenty-six files would
lose the reasoning that connects them. Comparable projects keep on the order of a dozen ADRs
total, not one per commit.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-recut-v1.0.0-in-place.md) | Re-cut spec v1.0.0 in place rather than bumping the version | accepted | 2026-07-27 |
| [0002](./0002-v-next-field-recut.md) | The v-next field re-cut — what changed in the data model and why | accepted | 2026-07-27 |
| [0003](./0003-instance-self-identification-and-version-pattern.md) | Permit instance self-identification, and make `specVersion` a patch-line pattern | partially accepted — self-identification kept; version pattern reverted same day | 2026-07-27 |
| [0004](./0004-second-draft-revision-org-swap-and-closure.md) | Revise draft v1.0.0 in place a second time — swap the organisation roles, close the top level, retire the eligibility registry | accepted — supersedes parts of 0002 | 2026-08-05 |
| [0005](./0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md) | Revise draft v1.0.0 in place a third time — mandate UTC `Z` timestamps and collapse the type blocks into a tagged `fundingDetails` union | accepted — supersedes 0002 #3 | 2026-08-05 |
| [0006](./0006-document-wide-single-currency.md) | Denominate every monetary amount in the single document-wide `fundingInfo.currency` | accepted — supersedes 0002 #17 | 2026-08-05 |
| [0007](./0007-canonical-domain-and-spec-identity.md) | Adopt `ethrfps.app` as the canonical domain, and mint spec v1.0.0's identity on it | accepted | 2026-08-10 |
| [0008](./0008-security-bounty-payout-tiers.md) | Split `bounty` into task and security kinds, and give the security kind a payout table | accepted | 2026-08-10 |

## When to write one

Write an ADR for anything **structural**: a change to the shape of the data model, to the
versioning policy, to what is normative, or to the process itself. Do not write one for a typo,
a new registry entry, a new example, or a tooling tweak — the changelog and the git history
already carry those.

The test: *if someone six months from now asked "why is it like this?", would the answer be
non-obvious and would getting it wrong be expensive?* If yes, it needs an ADR.

## How

Copy [`template.md`](./template.md), take the next number, and open a PR. Follow the MADR shape:
Status / Deciders / Date / Context / Decision Drivers / Considered Options (with
good-because / bad-because for each) / Decision Outcome / Consequences.

Two rules that matter more than the format:

- **Record the options you rejected**, with why. An ADR listing one option is an announcement.
  The rejected options are the part that stops the same argument from being had again.
- **Record the costs.** A consequences section with only benefits in it means the analysis was
  not finished. Every decision here that declined an asked-for capability says who asked and
  what they lost.

## Amending

**ADRs are not edited after they are accepted** — they are a record of what was decided with the
information available at the time, and rewriting that record destroys its only value. A decision
that changes gets a **new ADR** that supersedes the old one; the old one's `Status` line is
updated to point forward, and nothing else about it changes.

Typo fixes are fine. Rewriting the reasoning is not.

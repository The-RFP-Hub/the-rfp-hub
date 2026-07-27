# Governance

How decisions get made in this project, in one page. It is short on purpose: a governance
document that describes a larger organisation than the one that exists is worse than none,
because it tells contributors to expect a process nobody will actually run.

- **What counts as a change to the standard, and what has to be true before it ships:**
  [`packages/standard/PROCESS.md`](./packages/standard/PROCESS.md)
- **Which artifacts carry authority:** [`packages/standard/NORMATIVE.md`](./packages/standard/NORMATIVE.md)
- **How to contribute anything:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Editors

The standard has **editors**: the people with merge access to this repository. At the project's
current size, "editor" and "maintainer with write access" are the same set, so there is no
separate roster to maintain — the repository's collaborator list is the authoritative record.

**Enforced path-level review is deliberately not set up yet.** A `CODEOWNERS` file requiring an
editor's review on the normative paths (`schemas/**`, `registries/**`, the process docs) will be
introduced when the first external contribution arrives — that is the moment the distinction
between "contributor" and "editor" starts doing real work. Before then it would be process
pointing at a distinction that does not exist.

**Becoming an editor.** There is no application and no membership tier. Someone becomes an editor
when they have been reviewing and landing changes in this repo for long enough that an existing
editor proposes it, and no other editor objects. That is the whole mechanism — recorded by
granting merge access (and, once it exists, a PR to `CODEOWNERS`).

**Stepping back** is symmetrical and expected: an editor who is no longer active removes
themselves, or is removed after a period of inactivity. No ceremony, no vote.

## The decision rule

Consensus, with a named tiebreak:

1. Anyone may propose a change by opening an issue.
2. A change lands when **at least one editor approves it and no editor objects**. An objection is
   not a veto by rank — it is a request to keep talking, and it must come with a reason. "I don't
   like it" is not a reason; "this breaks X for consumer Y" is.
3. If editors cannot converge, the question is: **can anyone not live with this choice?** Not
   "does everyone prefer it". A choice nobody prefers but everybody can live with is a decision;
   a choice a majority prefers and one participant cannot live with is not.
4. If that still does not resolve it, the change does not land, and the disagreement is written
   into an ADR as a considered-and-rejected option so the next person does not re-litigate it
   from scratch.

**Structural decisions get an ADR** — anything that changes the shape of the data model, the
versioning policy, or the process itself. See [`adr/`](./adr).

## Review windows

A minimum time a change stays open before merge, so that "I was travelling" is never how a
decision gets made.

| Change | Minimum open time |
|---|---|
| **Substantive** — the schema, the JSON-LD context, the conformance suite, `PROCESS.md`, `NORMATIVE.md`, this file | **72 hours** |
| **Registry entry** — adding or deprecating a value in `registries/` | **24 hours** (fast path) |
| **Editorial** — informative docs, typos, links, tooling, tests, examples | none |

Notes on the windows:

- The window is a **minimum, not a target**. A contentious change stays open until it is
  resolved, not until 72 hours elapse.
- The **registry fast path** exists because registering a value changes nothing about what
  validates — unregistered values were already valid data. It is a documentation change with a
  review criterion attached ([`PROCESS.md`](./packages/standard/PROCESS.md)), and pricing it like
  a schema change would push publishers to skip the registry entirely, which defeats the point.
- A window may be waived for a **security fix or a broken build**. Say on the PR that it was
  waived and why.

## Appeals

**Open an issue.** That is the appeal path, and it is the whole appeal path.

If a change was declined, a registry entry rejected, or a decision made that you think is wrong,
open an issue saying so and why. It gets an answer on the issue — not in a private channel, not
in a call summary. If the decision stands, the reasoning goes on the record; if the reasoning is
already in an ADR, the answer points at it. Decisions that cannot be explained in public are
decisions that should not have been made.

There is no escalation body above this, because there is no organisation above this.

## What this project deliberately does not have

Written down so nobody wastes time looking for them, and so nobody proposes adding them without
arguing for the problem first:

- **No charter.** Chartering exists to bound the scope of a multi-organisation working group. The
  scope here is bounded by `PROCESS.md` and the ADRs.
- **No membership tiers, no seats, no fees, no voting percentages, no vote windows.** These solve
  coordination problems between competing vendors. Two people with a 72-hour comment window carry
  the same signal at this size and cost nothing to run.
- **No patent policy and no IP working group.** The standard is **CC0 1.0** — the most permissive
  option available, and more permissive than every comparable project. Honest footnote: CC0
  grants **no patent licence**. If a patent commitment is ever genuinely needed, the cheap
  legitimate wrapper is a W3C Community Group; it is not needed now.
- **No CLA.** CC0 already covers reuse of the standard, and code is MIT. A CLA is a legal project
  with no problem attached here.
- **No DCO sign-off — yet.** A DCO is the right call over a CLA when it is needed, but with no
  external contributors its value today is one workflow file enforcing a ritual on two people.
  **Trigger: the first pull request from outside the maintainer group.** At that point add the
  DCO check, not before.
- **No formal maturity ladder beyond four stages**, no candidate-recommendation mechanics, no
  horizontal review, no incorporated foundation.

The second honest footnote on CC0: it **waives attribution**. Data partners who want credit for
contributing entries cannot get it from the licence — that has to be a *policy* and a *field*
(`source.submittedBy`, `source.publisher`), and the policy is owed to them separately.

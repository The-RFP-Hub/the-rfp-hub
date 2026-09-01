# Governance

How decisions get made in this project, in one page. It is short on purpose: a governance
document that describes a larger organisation than the one that exists is worse than none,
because it tells contributors to expect a process nobody will actually run.

- **What counts as a change to the standard, and what has to be true before it ships:**
  [`packages/standard/PROCESS.md`](./packages/standard/PROCESS.md)
- **Which artifacts carry authority:** [`packages/standard/NORMATIVE.md`](./packages/standard/NORMATIVE.md)
- **What a reviewer checks on one submitted listing:** [`REVIEW-CRITERIA.md`](./REVIEW-CRITERIA.md)
- **How an organization becomes a verified publisher:** [`PUBLISHERS.md`](./PUBLISHERS.md)
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
- A **substantive amendment** to an open change restarts its window from the amendment; an
  **editorial** one — wording, a typo, a broken link — does not.
- The **registry fast path** exists because registering a value changes nothing about what
  validates — unregistered values were already valid data. It is a documentation change with a
  review criterion attached ([`PROCESS.md`](./packages/standard/PROCESS.md)), and pricing it like
  a schema change would push publishers to skip the registry entirely, which defeats the point.
- A window may be waived for a **security fix or a broken build**. Say on the PR that it was
  waived and why.

## Appeals

**Open an issue** — there is an
[appeal form](https://github.com/The-RFP-Hub/the-rfp-hub/issues/new?template=appeal.yml) for it,
because blank issues are disabled and a path with no door is not a path. That is the appeal path,
and it is the whole appeal path.

If a change was declined, a registry entry rejected, or a decision made that you think is wrong,
open an issue saying so and why. It gets an answer on the issue — not in a private channel, not
in a call summary. If the decision stands, the reasoning goes on the record; if the reasoning is
already in an ADR, the answer points at it. Decisions that cannot be explained in public are
decisions that should not have been made.

There is no escalation body above this, because there is no organisation above this.

## Non-discrimination and ranking

The sections above govern **the standard**. This one governs **the index** — which entries get
listed, and in what order.

**What decides indexing.** Three principles, and nothing else: the entry describes a **genuine
funding opportunity**; the document **conforms to the Standard**; the id's namespace belongs to an
**organization that operates the program**. Those are the principles, not the checklist — the
operational list a reviewer actually works through, including the ones that only apply
conditionally, is [`REVIEW-CRITERIA.md`](./REVIEW-CRITERIA.md), and that file is authoritative for
how each principle is applied.

**What does not influence indexing or ordering.**

- **Payment.** There is no way to pay to be listed, to be listed sooner, or to be listed higher.
  There is no field for it in the schema, no column for it in the database, and no parameter for it
  anywhere in the API — which is the only form of this promise worth making.
- **The size, age or funding of the organization.** Likewise unrepresented anywhere. A two-person
  program and a foundation are the same kind of row.
- **Any commercial relationship with the Hub or whoever operates it.** Likewise unrepresented.
- **The ecosystem or chain — with a precise caveat.** `ecosystems` *is* a real field: it is in the
  schema, it is a column, and `?ecosystem=` is a documented public filter, because "show me
  Ethereum programs" is a question readers legitimately ask. The invariant is narrower and it is
  the one that matters: ecosystem is **never used for admission and never used for ranking**. It
  does not decide whether an entry is indexed, and it does not appear in the default order or in
  any of the sort keys below. The Hub's focus is Ethereum; that is a focus, not an exclusion rule,
  and other ecosystems are indexed rather than turned away ([`PUBLISHERS.md`](./PUBLISHERS.md),
  *Who qualifies*). What a caller filters on is the caller's business.

**Ordering.** The public list endpoint's default is `nextDeadlineAt` **ascending** — soonest
deadline first, records with no upcoming fixed deadline last — with the row id as a tiebreak, so
the same query returns the same page twice. Every other order is a **parameter the caller chooses**,
never a judgment the server makes, and the sort keys are a **closed set** published in the OpenAPI
document: `nextDeadlineAt`, `opensAt`, `postedAt`, `updatedAt`, `createdAt`, each `asc` or `desc`.
Over the public API a key outside that set is a `400`, not a silent
fallback to something else — the querystring schema rejects it before any handler runs. (The
in-process parser behind it does fall back to the default for a bad key; that is a defensive guard
for direct callers inside the server, and nothing a client can reach.) `GET /v1/publishers`
orders by slug. There is no relevance score, no per-entry weight, and no operator thumb.

**No paid placement.** No featured tier, no boost, no promoted entry, no recommendation surface.
**If that ever changes, the policy changes before the code**: it would be a substantive edit to this
file, in public, under the 72-hour window, with an ADR recording what problem it solves and what was
rejected. A commit that introduces a ranking weight, a placement field or a paid tier before that
has happened is a defect to revert, not a fact to document afterwards.

**Symmetry, stated accurately.** Third-party listings and the operator's own listings are judged by
the same **content** criteria: the same schema, the same checks, the same revocation when they are
not met. The **queue** is not the same, and claiming it were would be false.

Publication decisions are made by people, never by a classifier or a language model. What varies is
*when* the person decided — before the fact, by granting an authority, or after it, by reading a
submission. Skipping the queue takes **two** things at once, an account authority and a credential
that carries publishing power, and either one missing means the entry lands pending:

| | Grants it |
|---|---|
| **Account authority** over the namespace | A **verified membership** on that organization — the ordinary path, audited as `verified_publisher_namespace` — **or** an admin-granted `directCreate`, which publishes into any namespace and is deliberately independent of the reviewer and admin roles |
| **Credential** used for the write | A signed-in **session**, or an **API key carrying the `publish` scope**. A `write`-only key never auto-publishes, even for a verified member of the namespace — its submissions queue like anyone else's |

That second row is a feature, not an oversight: an integration that only files submissions should
not be able to publish them, and a leaked key should be the smaller problem. Everything without
both halves waits in a queue a person decides. Duplicate detection flags a pair and never rejects
one. How verification is granted, and how it is taken away, is
[`PUBLISHERS.md`](./PUBLISHERS.md); the full credential model is
[`packages/api/docs/auth.md`](./packages/api/docs/auth.md).

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

# Review criteria for a submitted opportunity

What a reviewer checks on **one listing**, and what they deliberately do not check.

[`PUBLISHERS.md`](./PUBLISHERS.md) covers the other question — how an *organization* becomes a
verified publisher. This page is about a single entry: yours, or somebody else's transcription of
your program. The policy the two share, and the promise that nothing about money or size or
ecosystem moves an entry up or down, is in
[`GOVERNANCE.md`](./GOVERNANCE.md#non-discrimination-and-ranking).

---

## What is checked, in order

**1. It is a genuine funding opportunity.** A grant, hackathon, bounty, accelerator, RFP, or a fund
that invests. Something a builder could actually receive money from. A newsletter, a job posting, a
conference or a service pitch is not one, and that is the whole of this check.

**2. The id names an organization that operates the program.** Every public id is
`<namespace>:<local>`, and the namespace has to appear in the document's `operatingOrganizations`.
That part is machine-enforced on write — the API answers `400` naming the required form, and a
`source.publisher` that does not operate the program is refused before a person sees it. What the
reviewer adds is the part a machine cannot do: that the organization is real and publicly
identifiable, and that it *operates* the program rather than sponsoring one somebody else runs.
Sponsorship is a real relationship, it is recorded in `sponsoringOrganizations`, and it is not
ownership.

**3. The document validates against the Standard.** Machine-checked on every write with
[`rfphub-validate`](./packages/validate) — a non-conforming document never reaches the queue at
all, so a reviewer never rejects one for shape. What is left for a person is whether the required
fields are answered honestly: a `description` reading "TBD" validates and is still not a
description.

**4. It is not a duplicate of an entry that is already live.** Duplicate detection **signals; it
never rejects.** A flagged pair records the arm that decided it — `lexical` or `overlap` — plus any
corroborating labels in `matchedOn`, and it opens at status `suspected`
(`packages/api/src/modules/shared/api-views.ts`, `DuplicateMatchView`). Detection changes neither
entry's review status. A person then confirms, dismisses, or merges the pair; merging is a reviewer
action, and it is the only one that rejects and unlists the losing entry, pointing it at the
survivor so ids already published keep resolving. If your program is already here because somebody
transcribed it from a public source, the right move is a **claim**, not a second copy — see
[`PUBLISHERS.md`](./PUBLISHERS.md#claiming-an-entry-that-is-already-here).

**5. Where `applicationUrl` is present, it resolves.** `applicationUrl` is **optional** in the
Standard — it is not in the `required` list of
[`schemas/v1.0.0/opportunity.schema.json`](./packages/standard/schemas/v1.0.0/opportunity.schema.json)
— so its absence is not a rejection reason for a third-party document, and four entries in the
Hub's own seeded corpus have none, each named in [the API README](./packages/api/README.md). When
it *is* there, it has to be a real, public way to apply; a
forum thread or a shared form is fine, because that thread *is* the channel. Carrying one is a
standing commitment of the **verified publisher program** ([`PUBLISHERS.md`](./PUBLISHERS.md), *Who
qualifies*, item 3), not a universal criterion for being indexed.

---

## What is not a criterion

- **How good the program is.** The Hub indexes; it does not rate. Whether the selection process is
  fair, fast, or well run is not a reviewer's question.
- **How much it awards.** There is no floor and no ceiling.
- **Which ecosystem or chain it funds.** The Hub's focus is Ethereum, and a focus is not an
  exclusion rule.
- **Who submitted it.** Anyone may submit an entry *about* somebody else's program; that is how
  most of the corpus started. The operator can claim it afterwards and take ownership of the id,
  its history and everything pointing at it.
- **Anything about payment or relationship.** See
  [`GOVERNANCE.md`](./GOVERNANCE.md#non-discrimination-and-ranking).

---

## What "pending" means

**Received, not accepted.** A pending entry is not published: it is absent from the public API, the
site and the open-data exports. It is also not a rejection, and it carries no judgment about the
program — it is a row waiting for a person.

Two consequences worth knowing before they surprise you:

- An account with no verified membership may hold **at most five entries awaiting review at once**.
  Over the cap, `POST /v1/opportunities` answers `409 pending_limit_reached` naming the count and
  the limit. Every decision frees a slot, and editing something already pending is not a new
  submission.
- **Changing the content of an approved entry sends it back to pending** unless the writer may
  auto-publish, recorded in the audit trail as `replaced_without_auto_approval`. Saving an entry
  without changing anything does not.

---

## Who decides

Publication decisions are made by people, never by a classifier or a language model. What differs
between the two paths is *when* the person decided — before the fact, by granting an authority, or
after it, by reading the submission. The same content criteria apply on both, and the same
revocation applies when they are not met. Duplicate detection flags a pair and never rejects one.

Skipping the queue takes **two** things at once
(`canPublishImmediately`, `packages/api/src/modules/shared/capabilities.ts`), and either one
missing means the entry lands pending:

1. **An account authority over the namespace** — a **verified membership** on the organization,
   which is the ordinary path and is audited with the reason `verified_publisher_namespace`
   (`packages/api/src/modules/services/opportunities/opportunity-write.service.ts`); **or** an
   admin-granted `directCreate`, which publishes into any namespace without a membership, is
   independent of the reviewer and admin roles, and is itself audited as `grant_direct_create`.
2. **A credential that carries publishing power** — a signed-in **session**, or an **API key with
   the `publish` scope**.

The second condition catches people by surprise, so it is worth saying flatly: **a verified member
of an organization, writing with a `write`-only API key, still lands in the queue.** That is
deliberate. An integration that only files submissions should not be able to publish them, and a
leaked key should be the smaller problem. The full credential model is
[`packages/api/docs/auth.md`](./packages/api/docs/auth.md).

Two people can decide one entry:

- **A Hub reviewer**, anywhere in the corpus —
  `POST /v1/review/opportunities/{id}/{approve,reject}`.
- **A verified member of the organization the entry is filed under**, for that namespace only —
  `POST /v1/organizations/{slug}/opportunities/{id}/{approve,reject}`. Session credential only: a
  leaked API key must not be able to publish somebody else's submission under your banner. An entry
  filed under a namespace you do not publish for answers `404`, so these routes cannot be used to
  read another organization's queue.

### A written reason, where the API requires one

On the **organization** route, `reason` is a **required, non-empty** body field: rejecting there is
refused without one. That is the counterweight to an obvious conflict of interest — anyone may
submit an entry *about* an organization, so the organization refusing a third party's account of
its own program is the decision that most needs a name against it. The trail attributes it to the
deciding member **by handle**, and the reason is shown to the submitter on their own listing as
`lastDecision` — rendered as plain text, never as markup, since a reviewer's free-text reason is
third-party content like any other.

On the **Hub reviewer** route the API accepts `reason` and does not require it. That is the honest
state of the code, not an endorsement: a decision worth making is worth explaining, and a null
reason is exactly what an appeal will ask about.

Every decision is audited either way, but "audited" and "public" are not the same word, and the
difference matters most in exactly the case you care about:

- **Once an entry is approved and listed**, its trail is readable by anyone at
  `GET /v1/opportunities/{id}/audit` — no credential needed. Public callers see the changed field
  *names* and a coarse actor; the entry's submitter, its publisher and reviewers additionally see
  the full `patch`, which is where a written reason lives.
- **While an entry is pending or rejected**, that route answers `404` to anonymous and unrelated
  callers, matching what the detail route says about the same entry. Only its submitter, its
  publisher and reviewers can read it at all.

So a rejection's reasoning is not automatically world-readable — it is readable by the person it
was addressed to, which is the point. If it needs to be public, the route for that is an appeal
issue, and putting the reasoning on the record in public is what appeals are for.

---

## Appeals

**Open an issue**, using the
[appeal form](https://github.com/The-RFP-Hub/the-rfp-hub/issues/new?template=appeal.yml).
[`GOVERNANCE.md`](./GOVERNANCE.md#appeals) is the whole appeal path, and it applies here unchanged: the answer goes on the issue, in public, with the reasoning. If the entry
was rejected inside an organization's namespace and you believe the organization is wrong about
your listing, say so there too — the decision has a handle against it precisely so it can be
argued with.

---

## Service level

**Publisher applications** get a first response within **five working days**
([`PUBLISHERS.md`](./PUBLISHERS.md), *What is checked*).

**Individual submissions have no published turnaround, and this page is not going to invent one.**
What is true instead: the review queue is capped at five pending entries per unverified account
precisely because reviewing is human work and the queue is a shared resource, and a verified
publisher does not wait at all inside its own namespace. If waiting is the problem you are trying
to solve, [`PUBLISHERS.md`](./PUBLISHERS.md) is the path that solves it.

---

## Related

- [`GOVERNANCE.md`](./GOVERNANCE.md) — who decides, review windows, appeals, non-discrimination.
- [`PUBLISHERS.md`](./PUBLISHERS.md) — becoming a verified publisher, claiming an entry, revocation.
- [`packages/standard/PROCESS.md`](./packages/standard/PROCESS.md) — how the *standard* changes,
  which is a different question from whether one listing gets indexed.
- [`packages/api/docs/auth.md`](./packages/api/docs/auth.md) — the credential model behind every
  route named here.

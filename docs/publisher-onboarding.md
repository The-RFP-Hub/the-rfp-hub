# Onboarding a publisher — the operator's runbook

**This page is for whoever operates the Hub.** [`PUBLISHERS.md`](../PUBLISHERS.md) is the other
side of the same conversation: it tells an organization what qualifies, what to send and what
approval grants. Send applicants there. This one is what you do with what arrives.

Every route below is **reviewer (T3) and session-only** — an API key is a `403` on all of them, by
design: a leaked key must not be able to verify an organization or grant a membership. Sign in as a
reviewer and use that session token.

Shell blocks are marked `no-run`, `safe-read` or `staging-write` — see
[the convention](./README.md#shell-blocks-carry-a-marker-and-the-marker-is-a-contract). The
`staging-write` blocks here are the real onboarding commands: they are marked that way because
running them against production is a decision, not a demonstration. Read them, then run them
knowingly.

```sh no-run
API=https://api.ethrfps.app
REVIEWER=<your session token>       # from `set-auth-token` on sign-in; NOT an rfph_ key
```

---

## 1. What you are actually deciding

Verification attaches three things to an **organization**, never to a person:

1. **A namespace** — the organization's slug, and the permanent prefix of every id it publishes.
2. **Auto-approval inside that namespace** — its members' writes go live without review.
3. **Verified provenance** — entries carry the slug as publisher, so a consumer can tell a
   publisher's own listing from a third party's transcription of it.

So the decision has two halves, and they are separable: *is this organization what it says it is*
(verification), and *does this account speak for it* (membership). You can grant one without the
other, and sometimes should.

**Auto-approval is per namespace.** The same account submitting into somebody else's namespace is
an ordinary submitter there and lands in the review queue. That is the point of a namespace, not a
limitation of it.

---

## 2. Running an application end to end

An application arrives as a public **Publisher application** issue, from
`.github/ISSUE_TEMPLATE/publisher-application.yml`. The template asks for exactly what the checks
below need, so you should not have to ask for anything to start.

### Step 0 — the organization has to exist before you can verify it

**There is no create-organization route, for you or for anybody.** An organization is registered as
an unverified directory stub by the **first submission that names it** in
`operatingOrganizations`, inside that submission's own transaction, whether or not the entry is
ever approved.

So if the applicant has not submitted anything yet, `POST /v1/review/organizations/:slug/verify`
has nothing to verify. Reply on the issue asking them to sign in and submit one program naming
their organization — it will land `pending`, which is correct and expected — and pick the thread up
when it appears.

```sh staging-write
# does the stub exist, and is it already verified?
curl -s -H "Authorization: Bearer $REVIEWER" "$API/v1/review/organizations?q=example-foundation" | jq
```

### Step 1 — the organization exists, and the URL is theirs

Check the URL in the application resolves to something that exists independently of the issue: a
site, a governance forum, a repository, a public treasury. Then check **control**, not just
existence — that the organization the URL belongs to is the one applying:

* a DNS record, or a file the applicant placed at a path on that domain;
* the application URL appearing on the organization's own site, forum or repository;
* an announcement from the organization's published channel.

Whichever mechanism, write in the issue **which one you used**. That sentence is what makes the
decision reviewable a year later.

### Step 2 — the applying account belongs to the organization

**The organization has to say it, not the applicant.** This is the check people try hardest to skip
and the only one that cannot be inferred from a URL. Acceptable, in rough order of strength:

* a post from the organization's own forum account;
* a commit or a file in a repository the organization controls;
* a message from its published contact address;
* a signature from an address the organization is publicly known by.

The mechanism is flexible. What is not flexible is the direction: a statement *from* the
organization *about* the applicant, in a channel the organization controls. An applicant asserting
their own membership is not evidence, no matter how plausible.

### Step 3 — they operate the programs, and each one can be applied to

Sponsorship is a real relationship and it is recorded — but it is not publisher ownership, and it
does not qualify anyone to publish or to claim. Check that the applicant decides who is funded, or
runs the process that decides.

Open each `applicationUrl` and confirm it resolves to a real, public way to apply. A forum thread
or a shared form is fine — that thread *is* the link.

### Step 4 — the namespace slug is unclaimed and specific

Lowercase, hyphenated, and theirs: `example-foundation`, not `grants`, `ethereum` or `bounties`.
Generic terms somebody else has an equal claim to are refused, and the reason is that the slug is
**permanent**: it prefixes every id they ever publish, and reassigning it later would break
identifiers other people have already stored.

### Step 5 — existing entries are claims, not duplicates

If the Hub already lists the same programs, those entries are **claimed**, not re-submitted, so the
ids, the history and anything already pointing at them survive. Say so on the issue and point at
[`PUBLISHERS.md` § Claiming an entry that is already here](../PUBLISHERS.md#claiming-an-entry-that-is-already-here).

If a claim is already in the queue, decide it here rather than opening a second path:

```sh staging-write
curl -s -H "Authorization: Bearer $REVIEWER" "$API/v1/review/claims" | jq
curl -X POST -H "Authorization: Bearer $REVIEWER" -H 'content-type: application/json' \
  -d '{"verifyOrganization":true}' "$API/v1/review/claims/7/approve"
```

**`verifyOrganization` is an explicit decision, not a side effect.** With `false`, ownership
transfers but the organization stays unverified, so that publisher's later writes keep landing
`pending` — which, undocumented, becomes the support ticket "the claim was approved, why is my next
submission still in review".

### Step 6 — verify the organization

```sh staging-write
curl -X POST -H "Authorization: Bearer $REVIEWER" \
  "$API/v1/review/organizations/example-foundation/verify"
```

This is what flips the namespace: **every member of that organization becomes a publisher of it.**
Verify before granting membership only if you already know who the members are; the safer order is
to verify and grant in the same sitting, so the window in which the organization is verified with
the wrong members is zero.

Verified organizations are listed publicly at `GET /v1/publishers` and on the site's `/publishers`
page, ordered deterministically by slug. The verification is audited.

### Step 7 — grant the membership

Two paths. Prefer the invite when you do not already hold the account id.

**By account id** — find it first:

```sh staging-write
curl -s -H "Authorization: Bearer $REVIEWER" "$API/v1/review/accounts?q=their-handle" | jq
curl -X POST -H "Authorization: Bearer $REVIEWER" -H 'content-type: application/json' \
  -d '{"accountId":123,"role":"publisher"}' \
  "$API/v1/review/organizations/example-foundation/members"
```

**By email invite** — when the maintainer has not signed in yet, or you would rather not resolve an
address to an account by hand:

```sh staging-write
curl -X POST -H "Authorization: Bearer $REVIEWER" -H 'content-type: application/json' \
  -d '{"email":"maintainer@example.org","role":"publisher"}' \
  "$API/v1/review/organizations/example-foundation/invites"
```

**The invited membership is not active yet.** It is applied the first time somebody signs in with,
and proves ownership of, that address. That is the property that makes an invite safe to send
before an account exists — and it is also why an invite to a stale address is a standing grant:
list and revoke pending invites when a contact changes.

```sh staging-write
curl -s -H "Authorization: Bearer $REVIEWER" \
  "$API/v1/review/organizations/example-foundation/invites" | jq
curl -X DELETE -H "Authorization: Bearer $REVIEWER" \
  "$API/v1/review/organizations/example-foundation/invites/4"
```

Roles are `owner`, `admin` and `publisher`. `publisher` is the right default: it is what publishing
needs, and it is what a maintainer who is not administering the organization's directory entry
should hold.

### Step 8 — clear the entry that created the stub

The submission that registered the organization is still `pending`. Decide it now, on its merits —
verification does not retroactively approve it:

```sh staging-write
curl -s -H "Authorization: Bearer $REVIEWER" "$API/v1/review/opportunities?reviewStatus=pending" | jq
curl -X POST -H "Authorization: Bearer $REVIEWER" \
  "$API/v1/review/opportunities/example-foundation:2026-round-1/verify"   # check it against its own applicationUrl
curl -X POST -H "Authorization: Bearer $REVIEWER" \
  "$API/v1/review/opportunities/example-foundation:2026-round-1/approve"
```

### Step 9 — confirm the publisher can actually publish

Do not close the issue on the strength of the routes returning `200`. Ask the maintainer to do the
two things the grant was for, and confirm from the outside:

1. Mint a key with `["read","write","publish"]` and publish one entry under their own namespace.
2. Confirm it is **live on arrival**, not pending.

```sh safe-read
curl -s "$API/v1/publishers" | jq '.items[] | select(.slug=="example-foundation")'
curl -s "$API/v1/opportunities?organization=example-foundation" | jq '.total'
```

If the entry lands `pending` instead, the cause is almost always one of three, in this order: the
key has no `publish` scope; the organization is not verified; the id's namespace is not the
verified one. All three are visible from the reviewer routes above.

Then close the issue with what was checked and how — the issue is the record.

---

## 3. Refusing an application

Refusals are as much a public record as approvals. Say which criterion was not met and what would
change the answer. Never refuse on a criterion that is not written down in `PUBLISHERS.md` or
`REVIEW-CRITERIA.md`; if you find yourself wanting to, that is a signal to amend the criteria under
[`GOVERNANCE.md`](../GOVERNANCE.md), not to decide ad hoc.

| Criterion not met | What to say |
|---|---|
| **Sponsors rather than operates** | The relationship is real and it is recorded as sponsorship. Publishing and claiming require operating the program — the operator can apply, and this organization will still appear on every entry |
| **No public way to apply** | The link is the whole point of the index. A forum thread or a shared form qualifies; nothing at all does not |
| **Organization not independently identifiable** | Something has to exist outside the application: a site, a repository, a governance forum, a public treasury |
| **The organization did not confirm the applicant** | The evidence has to come from a channel the organization controls. This is the most common gap, and it is usually one message away from being closed |
| **Generic namespace slug** | Ask for a slug specific to them. The prefix is permanent; a generic one takes a term other applicants have an equal claim to |
| **Aggregator republishing other people's programs** | Claim the individual entries instead — the ids, history and inbound links survive, and provenance stays accurate |
| **No accountable maintainer** | Verification is a standing commitment. Name someone reachable who will keep the listings current |

Two templates. Use them verbatim and add the specifics:

> **Incomplete.** Thanks for applying. Before this can be reviewed we need one more thing: *[the
> missing item]*. Everything else in the application is in order. This issue stays open — add it
> here whenever you have it. Applications with no activity for 30 days are closed, and reopening
> one later is fine and costs nothing.

> **Refused.** We are not verifying *[organization]* as a publisher of *[programs]*, because *[the
> criterion, named, from PUBLISHERS.md]*. Concretely: *[what was checked and what was found]*.
>
> What would change this: *[the specific thing]*. Reapplying afterwards is welcome and starts from
> where this left off.
>
> Note that verification is not required to be listed. These programs can be submitted by anyone,
> including you, and go through review; corrections to any entry are welcome as ordinary issues.
> If you think this decision is wrong, say so here — [`GOVERNANCE.md`](../GOVERNANCE.md) describes
> how disagreements are settled.

**Service level:** a first response within five working days. A complete application usually closes
in one round. An incomplete one waits on the missing item and is closed after 30 days of silence.

---

## 4. Revoking

A membership or an organization's verified status is revoked for: publishing programs the
organization does not operate, listings repeatedly wrong or abandoned, misrepresented provenance,
using a namespace to publish somebody else's programs, or a credential the holder has lost control
of.

```sh staging-write
# one account stops publishing for this organization
curl -X DELETE -H "Authorization: Bearer $REVIEWER" \
  "$API/v1/review/organizations/example-foundation/members/123"

# the whole namespace stops auto-approving
curl -X POST -H "Authorization: Bearer $REVIEWER" \
  "$API/v1/review/organizations/example-foundation/unverify"
```

Revocation takes effect on the **next request** — membership and role are re-read from the database
on every request, so a key belonging to a revoked member stops auto-approving immediately. There is
no cache to wait out.

**What revocation does not do**, and every line here has bitten somebody:

* **It does not unpublish anything.** Existing entries stay live and keep their ids and history.
  Removing a listing is a separate, deliberate act on that listing.
* **It does not delete the organization or its account.** Both remain; the audit trail points at
  them, and history is not something a revocation may erase.
* **It does not revoke API keys.** The account's keys stay valid — they simply no longer carry
  publishing authority in that namespace, so later writes go back into the **review queue** rather
  than failing. If the reason for revoking is a *lost credential*, revoking the membership is not
  enough: the key holder must delete the key, or an admin must act on the account.
* **It does not stop them submitting.** They become an ordinary submitter, subject to the five-entry
  pending cap like anyone else.
* **It is not silent.** Both the revocation and the reason are audited, and the trail for any entry
  is public.

Unverifying an organization is the broader hammer: it removes auto-approval for **every** member at
once. Revoking one membership is the right tool when the problem is one person; unverifying is the
right tool when the problem is the organization.

---

## 5. Disputed claims

Two organizations asserting the same program, or a claim over an entry somebody else published.

The rule that decides most of them: **publisher ownership follows operation.** Whoever decides who
gets funded, or runs the process that decides, publishes it. A sponsor does not, however large the
check. An aggregator that transcribed the entry does not, however early they were.

* **The entry already belongs to a verified organization, and another claims it.**
  `POST .../claim` answers `409` in that case, so it reaches you as an issue rather than a queued
  claim. Decide it with both organizations in the thread, in public, and record which evidence
  moved the decision. If the current owner is wrong, unverify or revoke first, then approve the
  claim.
* **The entry was transcribed by a third party.** The operator's claim is the correct outcome; the
  transcriber loses `PUT` on it once the claim is granted, which is exactly the intent — the
  program's operator publishes it now. Say so plainly in the thread, because from the transcriber's
  side it reads as losing something.
* **Co-operated programs.** Two organizations genuinely running one program: only one namespace can
  own the entry, and both appear in `operatingOrganizations`. Pick the one that holds the
  `applicationUrl`, say why, and record the other as an operating organization.
* **A rejection by a member of the entry's own organization requires a written reason.** That is
  the counterweight to the obvious conflict of interest: anyone may submit an entry *about* an
  organization, so the organization refusing a third party's account of its own program is the
  decision that most needs a name against it. The trail attributes it by handle — not coarsened to
  "reviewer" — and the reason is shown to the submitter.

Everything above is written to the audit log in the same transaction as the change it records, so
"who decided this, and when" is answerable without anybody's memory. Appeals go to
[`GOVERNANCE.md`](../GOVERNANCE.md).

---

## 6. Related

| Document | What it covers |
|---|---|
| [`PUBLISHERS.md`](../PUBLISHERS.md) | The publisher's own guide — eligibility, applying, what approval grants, keeping it |
| `REVIEW-CRITERIA.md` (repository root) | What is checked on an **individual listing**, what is not a criterion, what "pending" means, and who decides |
| [`GOVERNANCE.md`](../GOVERNANCE.md) | Editors, the decision rule, review windows, appeals, and what this project deliberately does not have |
| [`packages/api/docs/auth.md`](../packages/api/docs/auth.md) | Tiers, scopes, the full route matrix, and what the server owns on a write |
| [`api-integration.md`](./api-integration.md) | What the publisher on the other end of the issue is reading |

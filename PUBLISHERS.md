# Becoming a verified publisher

Anyone may submit a funding opportunity to the RFP Hub. A **verified publisher** is different: your
submissions go live immediately, under your own namespace, attributed to your organization, and you
can keep them current through the API without waiting for a human.

This page is the whole process — what qualifies, what to send, what we check, what approval grants,
and how it is taken away again.

---

## What a publisher is, exactly

The Hub is an **aggregation layer**, not an application portal. It indexes funding opportunities and
sends applicants to your own submission channel through `applicationUrl`. Publishing here does not
move your program, your forms, or your applicants anywhere.

Verification attaches three things to an **organization**, not to a person:

| | Meaning |
|---|---|
| **A namespace** | Your organization's slug. Every entry you publish has an id of the form `<your-slug>:<your-own-id>` |
| **Auto-approval inside it** | Entries you publish under your own namespace go live without review |
| **Verified provenance** | Entries carry `source.publisher` = your slug and `source.submittedBy` = your organization, so a consumer can tell your listing from a third-party transcription of it |

Auto-approval is **per namespace**. The same account submitting into somebody else's namespace is an
ordinary submitter there and lands in the review queue — that is the point of the namespace, not a
limitation of it.

---

## Who qualifies

You are eligible if **all** of these are true.

1. **You operate the program.** You decide who gets funded, or you run the process that decides.
   Sponsoring or funding a program somebody else operates is a real relationship and it is
   recorded — `sponsoringOrganizations` — but it is not publisher ownership, and it does not
   qualify you to publish or to claim.
2. **It is a genuine funding opportunity.** A grant, hackathon, bounty, accelerator, RFP, or a
   fund that invests. The Hub's focus is the Ethereum ecosystem, but that is not an exclusion rule —
   other ecosystems are indexed too, not turned away. Scope is about the work being funded, not
   about which ecosystem or chain the money moves on.
3. **Your entries carry a public `applicationUrl`.** The link is the whole point of the index: the
   Hub is where an opportunity is found, never where it is applied to. A program whose only
   channel is a forum thread or a shared form is fine — that thread or form *is* the link.
4. **The organization is real and publicly identifiable.** A website, a repository, a governance
   forum, a public treasury: something that exists independently of the application.
5. **Somebody is accountable for the data.** One named maintainer who can be reached when a listing
   is wrong, and who will keep it current. Verification is a standing commitment, not a one-off
   import.

**What does not qualify:** aggregators re-publishing other people's programs under their own
namespace (claim the individual entries instead — see below); an organization asking to publish for
a program it merely sponsors; a listing with no public way to apply.

---

## How to apply

Open a **Publisher application** issue:

<https://github.com/The-RFP-Hub/the-rfp-hub/issues/new?template=publisher-application.yml>

The form asks for exactly what the review below checks, so nothing else is needed to start:

* **Organization name and requested namespace slug** — lowercase, hyphenated, and yours: `my-org`,
  not `grants` or `ethereum`. It becomes the permanent prefix of every id you publish.
* **A public URL for the organization** and, if they exist, a governance forum and a repository.
* **The programs you intend to publish** — one line each, with the `applicationUrl` for each.
* **Your relationship to each program** — operator, or something else.
* **The maintainer**: the account handle that will hold the membership, and a public contact channel.
* **Whether entries already exist on the Hub for these programs.** If so, say so: those are
  **claimed**, not duplicated.
* **How the data will be kept current** — by hand, by an integration, or by an agent.

Applications are public issues on purpose. Who is allowed to publish as whom is exactly the kind of
decision that should be visible, arguable and citable afterwards.

---

## What is checked

A reviewer checks, in this order:

1. **That the organization exists** and that the URL you supplied is controlled by it.
2. **That the applying account belongs to it.** A statement from the organization's own channel —
   a post from its forum account, a commit or a file in its repository, a message from its
   published contact address, or a signature from an address the organization is publicly known by.
   The mechanism is flexible; what is not flexible is that the *organization* has to say it, not the
   applicant.
3. **That you operate the programs**, and that the `applicationUrl` of each resolves to a real,
   public way to apply.
4. **That the namespace slug is unclaimed** and is not a generic term somebody else has an equal
   claim to.
5. **That existing Hub entries for the same programs are handled as claims**, so ids and history
   survive rather than being duplicated.

**Service level:** a first response within **five working days**. A complete application usually
closes in one round; an incomplete one waits on the missing item and is closed after 30 days of
silence — reopening it later is fine and costs nothing.

---

## What approval does

**The organization is inferred from the program — nobody creates it by hand.** The sequence is:

1. **Sign in.** A first visit provisions your account from your identity alone (a just-in-time
   account, with no membership yet). Set the public handle your submissions are attributed to with
   `PATCH /v1/me`.
2. **Submit the program, naming your organization in `operatingOrganizations`.** That first
   submission **registers your organization as an unverified directory stub** — its slug is the
   `operatingOrganizations[].slug` you named — and files the entry `pending`, since you hold no
   membership yet. The stub is created inside the submission's own transaction, whether or not the
   entry is ever approved. There is no separate "create organization" step, for you or for a
   reviewer.
3. **A reviewer verifies that existing stub** and grants your account a **membership** on it.

Both the verification and the membership are audited, and both are visible: verified organizations
are listed publicly at `GET /v1/publishers`.

Then, as the maintainer:

```sh
API=https://api.ethrfps.app

# Mint a publishing key. The secret is in this response and nowhere else, ever.
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"programme-sync","scopes":["read","write","publish"]}' $API/v1/keys

# Publish. Approved on arrival, because the key carries `publish` and the account is a verified
# member of `my-org`.
curl -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  --data-binary @opportunity.json $API/v1/opportunities
```

The full credential model — key format, scopes, rotation, and which routes accept which credential —
is in [`packages/api/docs/auth.md`](./packages/api/docs/auth.md).

Two rules worth knowing before the first submission, because both are easy to be surprised by:

* **The id must be `<your-namespace>:<your-own-id>`.** Anything else is a `400` naming the required
  form. It is what makes provenance checkable rather than asserted.
* **`publish` is a separate scope from `write`.** A key without it still submits — the entry simply
  lands `pending` instead of going live. That is deliberate: an integration that only files
  submissions should not be able to publish them, and a leaked key should be the smaller problem.

---

## Claiming an entry that is already here

If the Hub already lists your program — transcribed from a public source, or submitted by
somebody else — **claim it** rather than submitting a second copy:

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"organizationSlug":"my-org"}' $API/v1/opportunities/some-namespace:1459/claim
```

Granted immediately when your organization is verified **and** already appears among the entry's
operating organizations; queued for a reviewer otherwise. The entry keeps its id, its history and
anything already pointing at it, and publisher ownership moves to you.

Two things about the scopes, if you claim with a key rather than a session:

* **Filing a claim needs `write`.** A `read`-only key cannot start one, queued or not — a claim
  puts a decision in flight over somebody else's entry, which is not a read.
* **A claim that would be granted immediately needs `publish`,** on top of that. You get a `403`
  naming the scope, never a claim that quietly downgrades itself into the review queue.

And once a claim is granted, ownership really has moved: whoever submitted the entry originally
stops being able to `PUT` over it unless they are also a member of the organization it now belongs
to. That is the point — the program's operator publishes it now.

---

## Keeping it

Verification is a standing relationship, and these are the terms:

* **Entries stay accurate.** A listing whose deadline has passed is closed automatically; one with
  no future deadline that nobody has touched or re-verified for **90 days** is closed as inactive.
  Any update, granted claim or successful source check resets that clock — so keeping a program
  open is a matter of keeping it current, which is the same thing.
* **Publish only what you operate.** Sponsorship is recorded as sponsorship.
* **Entries are checked against their own `applicationUrl`.** An automated check fetches the page
  and records what it found; a persistent mismatch is a reviewer's business.
* **Every write is audited**, and the trail for any entry is public at
  `GET /v1/opportunities/{id}/audit`.

### Revocation

A membership or an organization's verified status can be revoked by a reviewer for: publishing
programs you do not operate, listings that are repeatedly wrong or abandoned, misrepresenting
provenance, using a namespace to publish somebody else's programs, or a credential you have lost
control of.

Revocation takes effect on the **next request** — a key belonging to a revoked member stops
auto-approving immediately. It is **not** a deletion: existing entries stay published and keep their
history, later writes simply go back into the review queue. Both the revocation and the reason are
audited.

If you believe a decision is wrong, say so on the original application issue.
[`GOVERNANCE.md`](./GOVERNANCE.md) describes how disagreements are settled.

---

## Not applying?

Nothing here is required to be listed. The Hub indexes public Ethereum-ecosystem funding
opportunities either way, and anyone can submit one — it just goes through review first. Verification
is for organizations that want to own their own listings and keep them current themselves.

Corrections to any entry, verified or not, are welcome as ordinary issues.

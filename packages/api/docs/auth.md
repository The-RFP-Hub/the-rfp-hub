# Authentication and authorization

The read surface of this API is public and unauthenticated, and stays that way. What follows
describes the **write** surface: who may submit, who may publish without review, and which
credential each route accepts.

Everything here is implemented in `src/modules/shared/capabilities.ts` (the pure rules),
`src/modules/services/auth/*` (the resolution) and `src/plugins/auth.ts` (the gates). Where this
document and the code disagree, the code is what runs — but they are meant to be read together, and
each rule below names the file that enforces it.

---

## 1. The two credential kinds, in one header

```
Authorization: Bearer <credential>
```

One header carries either kind, and **which kind it is decides real authority**:

| | What it is | How it is recognized |
|---|---|---|
| **Session** | An opaque, signed session token, held by a signed-in human | Anything that does **not** start with `rfph_` |
| **API key** | A long-lived, scoped delegation of one account | Starts with `rfph_` |

The discrimination is made on the **token itself**, never on a header or parameter the caller
chooses (`modules/shared/api-key-token.ts` → `isApiKeyToken`). That is what keeps the session-only
routes session-only: a caller cannot present a key and ask for it to be treated as a session.

### Sessions

A session is a **row**, and the token is an opaque reference to it plus a signature. There is no
JWT: nothing about the session travels inside the credential, so nothing about it can be stale.

Verification, in order:

1. **HMAC-SHA256 over this deployment's `BETTER_AUTH_SECRET`, before any database access.** A
   forged, truncated or foreign-deployment token costs one hash and no query. A token with no
   signature at all is refused outright — `bearer({ requireSignature: true })` — so the signature
   can never become decoration.
2. **The session row**, looked up by token: it must exist and not have expired.

This replaces what an audience claim used to do, and is stronger: a token minted for another
environment fails locally even if that environment shares this database, because the secret differs.
**Rotating `BETTER_AUTH_SECRET` signs everyone out** — the bearer path verifies against exactly one
secret, there is no dual-secret window, and that is a deliberate property rather than an oversight.

Every failure mode — bad signature, unsigned, expired row, deleted row, garbage — returns the same
401 with the same message. Distinguishing them tells a prober which half of an attempt worked.
`test/integration/auth.test.ts` asserts that as a set: six different failures, one message.

**Revocation is now real, and immediate.** Signing out deletes the row, so the very next request
with that token is a 401. Under the previous verifier a token was self-describing and could not be
invalidated at all; role, membership and API-key revocation were already immediate (they are re-read
from our tables on every request) and remain so.

**Lifetime: 90 days, refreshed at most once a day** (`expiresIn` / `updateAge`). People should not
be logged out of a tool they use weekly. The refresh is one `UPDATE` per session per day, and it
re-issues the token — the client stores whatever the newest `set-auth-token` header carried.

**Sign-in is a one-time code to an email address.** No password is stored, so there is no reset
flow, no strength policy and nothing to leak; holding an address means controlling the mailbox,
which is the same proof a password reset ultimately rests on. Codes are six digits, valid for five
minutes, three attempts, and are stored **hashed** — a dump of the verification table is a list of
short-lived digests, not live codes. Google sign-in is configured but ships dark: with no
`GOOGLE_CLIENT_ID` the provider is not registered and no button is rendered.

**A second provider on an address somebody already holds is the same person.** Account linking is
enabled with `trustedProviders: []` (nothing links on an unverified address),
`allowDifferentEmails: false` and `updateUserInfoOnLink: false`. One identity, one `accounts` row,
role and history preserved — `test/integration/account-linking.test.ts` is the tripwire that keeps a
dependency upgrade from quietly forking one person into two.

**Accounts are provisioned just in time, keyed on the identity's SUBJECT and nothing else.** The
subject is the opaque user id (`accounts.auth_user_id`), never an email address: an address is
transferable and changeable, and it is what `audit_log` would end up pointing at through
`accounts.id`. The `/v1/me.email` field is served by joining the identity table at read time, so the
system keeps exactly one copy of that address.

**Logging in grants nothing.** A session resolves to whatever role the database already holds. No
environment variable promotes anybody, and that is the point: a role re-derived from configuration
on every request is granted to whoever holds the deployment configuration and cannot be revoked in
the product.

### Administrators

| Which admin | How | Credential |
|---|---|---|
| the first one | `pnpm --filter @the-rfp-hub/api grant-admin -- --email <address> --create --yes` | the **migration** `DATABASE_URL` |
| every later one | `POST /v1/admin/accounts/:id/role` with `{"role": "admin"}` | an admin's session |
| a lockout | the same script | the migration `DATABASE_URL` |

The ceremony is a one-time install step, run with the same credential that creates the tables.
Bring `--create` by default — the `accounts` row is provisioned lazily (see below), so running this
right after sign-in, before the dashboard has made its first request, finds no account yet.

**The address is a LOOKUP, never the stored value.** An operator knows an email address; the column
stores the identity's opaque subject. So `--email` resolves through the identity table to that
subject and reports it, and `--subject <id>` is the alternative for an operator who already has one.
An address nobody has ever signed in as is a refusal that says so — *that person must sign in once*
— because an identity is created by signing in, not by this script. `--create` is the other case
entirely: it provisions the `accounts` row for an identity that exists but has never made a `/v1`
request, and it cannot conjure an identity.

The script prints what it resolved and which `host:port/database` it is pointed at — never the URL, which carries a password —
refuses a non-loopback target without `--allow-remote`, refuses to write at all without `--yes`, and
exits non-zero on every refusal. It is idempotent: an account that is already an admin is a reported
no-op with no second audit row. The grant is audited as an ordinary `assign_role` with
`reason: "operator_grant_admin"` and no acting account, because no account acted — an operator did.

**The product manages administrators after that.** An admin grants and revokes `admin` over the
normal route, self-demotion included, with one floor: the **last remaining admin cannot be demoted**
(`409 last_admin`). Zeroing the admins is not a state the product can undo — every route that could
restore one requires an admin — so the dashboard must not be able to reach it by accident. It stays
recoverable, by an operator, with the script.

### API keys

Format:

```
rfph_<8-char base32 prefix>_<32 CSPRNG bytes, base64url>
```

* the **prefix** is public and stored in the clear — it is how a key is named in a UI and in an
  audit row without the secret existing anywhere to name it by;
* the **secret** is 256 bits from the CSPRNG and is returned **exactly once**, at mint;
* the database stores `sha256(full token)`, hex, over a unique index.

#### Why a plain SHA-256 and not a KDF

This is the first thing a reviewer questions, so the answer lives in the code as well as here.

A KDF's cost exists to make **guessing** expensive, and guessing is only a threat when the secret
comes from a small space — a human-chosen password. This secret is 256 bits of CSPRNG output. There
is no dictionary, no rainbow table and no plausible search; an attacker holding the hash has nothing
to attack it with. What a KDF would buy in exchange is an argon2 on the hot path of **every**
authenticated request. So: one indexed lookup of a SHA-256 digest.

#### Scopes

| Scope | Grants |
|---|---|
| `read` | Authenticated reads. Always present; it is the floor. |
| `write` | Create and replace entries (which may land `pending`). |
| `publish` | Strictly stronger than `write`. Required for **any** path that causes immediate publication. |

#### Lifecycle

* **Rotation is create-then-revoke** — `POST /v1/keys`, deploy, `DELETE /v1/keys/:id`. The overlap is
  by construction, which is why there is no rotate endpoint.
* **Revocation is soft** (`revoked_at`). `audit_log.actor_api_key_id` points at keys, and a hard
  delete would leave history unable to answer the one question soft revocation exists for: *which
  key did this*.
* `last_used_at` is refreshed at most once per five minutes per key, fire-and-forget, with the
  staleness test in the SQL predicate so two concurrent requests do not both write.

---

## 2. Tiers, and where each one actually lives

| Tier | Meaning | Stored as |
|---|---|---|
| **T1** | Any authenticated account | the default — no row says so |
| **T2** | Verified publisher of **one namespace** | a row in `org_memberships` **and** `organizations.verified = true` |
| **T3** | Reviewer | `accounts.global_role = 'reviewer'` |
| **T4** | Administrator | `accounts.global_role = 'admin'` |
| — | Publish anywhere without a membership | `accounts.direct_create` |

**T2 is not a role.** It is a relationship, held per namespace, so the same account is T2 in one
namespace and T1 in the next within a single request. That is why the authorization function is
`effectiveCaps(principal, namespace)` and never `principal.tier`: a single field would have to pick
one answer, and whichever it picked would be wrong somewhere.

`direct_create` is independent of the global role, deliberately: reviewing is not publishing.

### What a T2 verified publisher may do

Within **their own namespace** (`source.publisher` — never merely an organization they co-operate
or sponsor):

* **write and auto-publish**, when the credential also permits it (`publish` on a key, any session);
* **see everything filed under it**, whatever its review status — `GET /v1/organizations/:slug/opportunities`.
  This one admits **any** membership, verified or not: looking is not publishing;
* **decide** what somebody else filed under it —
  `POST /v1/organizations/:slug/opportunities/:id/{approve,reject}`. **Verified membership, session
  only.** Approving publishes to the world, so it rides the same trust event auto-publish does, and
  a leaked key must not hold it.

**Verified members decide within their own namespace; Hub reviewers (T3) decide anywhere.** A
rejection here **requires a written reason**, and that is the counterweight to the obvious conflict
of interest: anyone may submit an entry *about* an organization, so the organization refusing a
third party's account of its own program is the decision that most needs a name against it. The
trail attributes both verbs to the deciding member **by handle** — never coarsened to `reviewer`,
which is the anonymity a neutral reviewer gets and a self-interested party should not — carries
`via: "operating_org"` so a reader can tell the two apart, and the reason is shown to the submitter
on their own listing (`lastDecision`).

The scope is the **namespace**, not "any organization named in `operatingOrganizations`". Widening it
was considered and rejected: an entry may name several operators, approving publishes it in the
namespace's name, and a co-operator could then publish under somebody else's banner — the same
cross-org hazard the write path's containment rule exists to close. An entry filed under a namespace
you do not publish for answers `404`, not `403`, so these routes cannot enumerate another
organization's pending queue.

### What limits an account with no verified membership

At most **5 entries awaiting review at once**, counted as rows currently `pending` and owned by the
account. The review queue is a shared resource and reviewing is human work; without a ceiling one
account can deny that work to everybody else at no cost to itself. The limit is a product rule fixed
in code (`pendingSubmissionLimit` in `src/config.ts`), not a deployment setting — no operator can
raise it by configuring the environment.

It is a ceiling on the **queue**, not a quota on a lifetime: every decision frees a slot, replacing
an entry that is already pending is not a new submission, and anybody holding a verified membership
**anywhere** is exempt entirely — their own writes auto-approve and never reach the queue, and
metering their proposals into other namespaces would meter exactly the people the Hub has already
vouched for. Over the cap, `POST /v1/opportunities` answers `409 pending_limit_reached` naming the
count, the limit, and the fact that slots free as reviews happen.

---

## 3. The rule that closes the escalation hole

> **A global role never elevates an API key.**

Concretely:

* **Any API-key path that causes immediate publication requires the `publish` scope** — including a
  reviewer's key, an admin's key, and a key belonging to an account with `direct_create`. Without
  it, an otherwise-auto-approving submission **lands `pending`**: it fails closed to the safe
  outcome rather than erroring, because a submitter who cannot publish still wants their submission
  recorded.
* **A claim has two bars, and neither of them is `read`.** Filing one at all requires `write` on
  an API-key credential; a claim that would be **granted immediately** additionally requires
  `publish`. Each absence is a `403` naming the missing scope. For the grant path that is
  deliberately **not** a silent queue — a claim that quietly became a review request would be
  actively misleading — and for the queue path there is no weaker outcome to fall back to: a
  queued claim is still a write on somebody else's entry, with a reviewer decision in flight
  behind it, and a `read`-only key is the scope an integration is given precisely so it cannot
  start one.
* **`requireSession()` — API keys refused with `403` — on every route in the next section.**

---

## 4. Session-only routes

A leaked API key must not be able to mint a stronger key, change the account's identity, approve
anything, or grant itself a role. So these accept a signed-in session and nothing else:

* `GET|POST /v1/keys`, `DELETE /v1/keys/:id`
* `PATCH /v1/me`
* every route under `/v1/review/*`
* every route under `/v1/admin/*`
* `PATCH /v1/organizations/:slug`

`/v1/keys/*` is additionally scoped to `account_id = <mine>` on every statement, and a key id
belonging to another account is a **404**, not a 403 — a 403 would confirm the id exists, which is
an existence oracle over other people's credentials.

---

## 5. Route matrix

Every write route in this table is authorized by `effectiveCaps(principal, namespace)` and audited.
"optional" means the route accepts a credential and answers differently with one, but does not
require it; a **presented-but-invalid** credential is a 401 there too, because silently serving the
anonymous view to somebody whose token expired tells them nothing and shows them less.

### Public and optional

| Route | Credential | Notes |
|---|---|---|
| `GET /v1/opportunities`, `/:id`, `/schema` | none | public read surface, unchanged |
| `GET /v1/stats`, `/v1/health`, `/v1/feeds/*`, `/v1/export/*` | none | unchanged |
| `GET /v1/publishers` | none | verified organizations only |
| `GET /v1/r/:id/apply`, `/v1/r/:id/source` | none | `302` for approved **and** listed entries only; `404` otherwise |
| `GET /v1/opportunities/:id/audit` | optional | redacted for the public; full patch for the owner and T3+ |
| `GET /v1/opportunities/:id/duplicates` | optional | an unprivileged caller never sees a non-public other side |
| `GET /v1/opportunities/:id/verification` | optional | 404 when never checked — a real state |

### Authenticated (either credential kind)

| Route | Credential | Notes |
|---|---|---|
| `POST /v1/opportunities` | T1 + `write` | auto-approves only via `canPublishImmediately` |
| `PUT /v1/opportunities/:id` | the submitter *while the entry is still theirs*, or T2 of the namespace, + `write` | `body.id` must equal the path id. Once publisher ownership has been **granted** away by a claim, the submitter keeps `PUT` only as a member of the organization that publishes it now; otherwise it takes T2 of that namespace, or T3+ |
| `POST /v1/opportunities/:id/claim` | membership on the claiming org, + `write` | filing needs `write` on a key; an **immediate grant** needs `publish`. Either absence is a 403 naming the scope, never a silent queue |
| `GET /v1/me`, `/v1/me/opportunities`, `/v1/me/opportunities/:id`, `/v1/me/duplicates` | T1 | `/me/opportunities/:id` is the owner-visible full detail for a pending or rejected entry the public route 404s |
| `GET /v1/insights/opportunities/:id` | owner or T3+ | 403 for anyone else — a publisher's numbers are not public |
| `GET /v1/insights/me/summary` | T1 | every entry the caller may see the numbers for |

### Session-only

| Route | Credential | Notes |
|---|---|---|
| `PATCH /v1/me` | T1, **session** | |
| `GET\|POST /v1/keys`, `DELETE /v1/keys/:id` | T1, **session** | account-scoped; 404 on a foreign id |
| `PATCH /v1/organizations/:slug` | org `owner`/`admin`, **session** | never the verified flag |
| `GET /v1/review/opportunities`, `POST …/:id/approve\|reject`, `PATCH …/:id` | T3, **session** | |
| `GET /v1/review/opportunities/:id` | T3, **session** | one entry in full, whatever its review status. The owner route `GET /v1/me/opportunities/:id` is scoped to entries the caller owns, and everything a reviewer is sent to is by definition somebody else's |
| `POST /v1/review/opportunities/:id/verify` | T3, **session** | triggering a source check is a reviewer capability |
| `GET /v1/review/claims`, `POST …/:id/approve\|reject` | T3, **session** | approval carries `verifyOrganization` |
| `GET /v1/review/duplicates`, `POST …/:id/confirm\|dismiss\|merge` | T3, **session** | |
| `POST /v1/review/organizations/:slug/verify\|unverify`, `PATCH …/:slug`, `POST\|DELETE …/:slug/members` | T3, **session** | |
| `GET /v1/review/accounts`, `GET /v1/review/organizations` | T3, **session** | discovery for the review screens |
| `POST /v1/admin/accounts/:id/role`, `…/direct-create` | T4, **session** | |
| `POST /v1/admin/opportunities/:id/verify` | T4, **session** | the same action as the review route, kept for bulk/scripted runs |
| `POST /v1/admin/jobs/:job/run` | T4, **session** | a convenience only — the schedule starts jobs as container tasks ([`jobs.md`](./jobs.md)) |

### Rate limits

**Keyed per credential-holder, not per address.** A metered route counts against
`acct:<accountId>` whenever the request proved an account, and falls back to `ip:<address>` only
when it proved nothing. Two people behind one office egress are two budgets; one account calling
from a laptop and from CI is one budget. Nothing is stored: the key lives in an in-memory counter
that expires with its window and never reaches a row, a log line or an analytics event.

**The two namespaces are disjoint, and that is a security property.** With `TRUST_PROXY` set,
`request.ip` is a token out of `X-Forwarded-For` — text a caller who can reach the proxy chooses.
`acct:` and `ip:` therefore cannot collide, and an address that is not a valid address never
becomes a key: it goes to one fixed `ip:invalid` bucket rather than being used verbatim.

**The address fallback is canonicalized before it is used** (`modules/routes/shared/rate-limit-key.ts`):

| Form | Bucket |
|---|---|
| IPv4 `203.0.113.9` | `ip:203.0.113.9` — unchanged |
| IPv6 `2001:db8:1:1::9` | `ip:2001:db8:1:1::/64` — grouped |
| IPv4-mapped `::ffff:203.0.113.9`, IPv4-compatible `::203.0.113.9` | `ip:203.0.113.9` — folded to the address they embed |
| Port-bearing `203.0.113.9:4000`, `[2001:db8::1]:4000` | the port is stripped |
| Scope id `fe80::1%eth0` | the scope is dropped |
| Anything else — empty, whitespace, a header value, `acct:1` | `ip:invalid` |

The /64 grouping is the load-bearing one: the smallest allocation an IPv6 customer receives is a
/64, so a key on the full address hands a fresh bucket to anyone willing to increment the host bits
— no limit at all for the caller best equipped to abuse it. The two embedded-IPv4 folds are the
opposite failure: both forms are zero where the /64 lives, so without them every mapped caller —
which is every v4 client of a dual-stack listener — would share one bucket. Stripping the port
matters for the same reason as the /64: a source port changes on every connection.

**An invalid credential is metered by address, and is refused for being over the limit before it is
refused for being invalid.** Resolving the credential is split from rejecting it
(`plugins/auth.ts`): a route runs `resolvePrincipal` → limiter → gate, so a caller hammering
`POST /v1/opportunities` with a junk Bearer sees `401` for the whole budget and `429` once it is
spent. Before the split the gate answered inside the same `onRequest` chain and ended it, so the
limiter never ran and anonymous write traffic was unlimited.

**An auth-store outage is not metered; any other response is.** `resolvePrincipal` replies to
nothing at all — it resolves the credential and records the outcome. When that outcome is "could
not be CHECKED" (a `503 auth_unavailable` from the session lookup, a `500` from a broken key
lookup) the limiter skips the increment and emits no rate headers, and the gate behind it sends the
preserved status and code. An outage therefore never spends the caller's budget and is never
replaced by a `429`, even from an address whose bucket is already empty.

That exemption is the only one. **Every other response counts, including a `5xx` produced after
the limiter has run** — a handler, a service, a serializer or a later hook that fails has already
incremented the bucket, so a run of server failures can eventually be answered with `429`. A refund
for post-limiter failures needs a store that can atomically decrement the same route/key/window and
is not built; the honest statement is the one above, not "5xx is never metered".

**Every authenticated `/v1` mutation is metered.** Not a chosen subset: an unmetered write route
is indistinguishable from a deliberately public one, so the rule is the whole surface and
`test/integration/route-inventory.test.ts` reads the router back and fails on any exception.

| Metered surface | Ceiling | Why that number |
|---|---|---|
| `POST`/`PUT /v1/opportunities`, `POST /v1/opportunities/:id/claim` | 60/min | a publisher's own bulk sync is the fastest legitimate caller here |
| `POST /v1/me/notifications/read-all`, `POST /v1/me/notifications/:id/read` | 60/min | clearing an inbox is one call per row, so it is bursty |
| Every `/v1/review` write (17 routes), `DELETE /v1/keys/:id`, the two organization decisions | 30/min | a review decision is human-paced: read the entry, click once |
| `POST /v1/admin/opportunities/:id/verify` | 30/min | the same outbound fetch as the reviewer's verify |
| `PATCH /v1/me`, `PATCH /v1/organizations/:slug`, `POST /v1/admin/accounts/:id/{role,direct-create}` | 20/min | a deliberate, one-at-a-time act |
| `POST /v1/keys` | 10/min | minting a credential |
| `POST /v1/admin/jobs/:job/run` | 10/min | each call starts real work under an advisory lock |
| `GET /v1/r/:id/{apply,source}` | 120/min | **address-keyed** — a link-out accepts no credential, so there is no account to meter |

Each route holds its OWN bucket: the ceilings are per route per credential-holder, not one budget
across a surface.

Two documented exceptions, and only two. The **Better Auth mount** (`/api/auth/*`) is where a
credential is minted, so there is nothing for the resolver to resolve; it keeps its own
address-keyed pair of ceilings (10/min for the four mail-sending routes, 120/min for the rest). The
**two redirects** are anonymous by construction, as above.

The public read surface — the list, the detail, the feeds, the export — is deliberately **uncapped**
(`global: false` in `app.ts`); it is the traffic this project exists to serve, and an address-keyed
cap on it would be one number for a whole organization.

A `429` answers with the same stable body everywhere — the metered writes, the two redirects and
the auth mount all take it from one `errorResponseBuilder` on the plugin registration:

```json
{ "error": "rate_limited", "message": "Rate limit exceeded, retry in 60 seconds" }
```

`error` is what a client branches on. The default body would have arrived as the generic
`client_error`, which an integrator cannot tell from a validation failure — and backing off is the
one `4xx` with a correct automatic response. Obey `retry-after` rather than parsing the message.

The response carries `retry-after` as a whole number of seconds, plus
`x-ratelimit-limit`/`-remaining`/`-reset`; the last three appear on a metered response below the
ceiling too. **All four are on `Access-Control-Expose-Headers` in both CORS policies**, or a
cross-origin page could receive a `429` and read nothing off it. An `OPTIONS` preflight is not
metered: it is the browser asking permission, not the caller acting. A `HEAD` is served off the
`GET` route and is metered on its own bucket at the same ceiling; it records no view and no
link-out click, because it returns no body and nobody left for anywhere.

**Operational facts a limit is meaningless without:**

- **The ceilings are per PROCESS.** The store is this process's memory, so with *N* tasks behind a
  load balancer every number above is multiplied by *N* — "60/min per account" across 3 tasks is
  180/min in practice — and every bucket resets when a task restarts or is replaced. A shared store
  (Redis) would fix both and is not built. Size the numbers, and any statement made to an
  integrator, against the task count actually running (see [`deploy.md`](./deploy.md)).
- **Each bucket store holds 5,000 keys.** `@fastify/rate-limit`'s in-memory store is an LRU with a
  default bound of 5,000, and every route gets its own. That bound is part of the effective limit:
  past 5,000 distinct keys on one route inside one window, the least recently used entry is
  evicted and whoever it belonged to starts again from zero. Reaching it needs 5,000 distinct
  accounts or /64s on a single route in a single minute, which is far above this deployment's
  traffic — but it is why the address key is grouped and namespaced rather than left free-form:
  a key an attacker can mint per request is also a key that evicts everybody else's.
- **`TRUST_PROXY` decides whether the address half works at all.** `request.ip` is the socket peer
  unless it is set, so behind a load balancer *every* anonymous caller shares one bucket — a
  self-inflicted denial of service that looks like a working rate limit. It is **not a boolean**
  (`true` is rejected at boot): use a hop count (`1`) or a comma-separated list of proxy
  addresses/CIDRs. See `config.ts` (`readTrustProxy`) and the config table in
  [`../README.md`](../README.md).
- **Which hop a hop count selects.** `TRUST_PROXY=1` trusts one proxy, so Fastify takes the
  RIGHTMOST `X-Forwarded-For` entry — the address that proxy saw. With
  `X-Forwarded-For: 198.51.100.1, 192.0.2.2` from a socket peer of `10.0.0.5`, `request.ip` is
  `192.0.2.2`; `198.51.100.1` is whatever the client claimed and is ignored. **Set the count to
  the number of proxies actually in front of this process.** Too low and the bucket is a proxy's
  address (one bucket for everyone behind it); too high and it is a client-chosen string, which
  the canonicalization then sends to `ip:invalid` — one shared bucket again, and a noisy one.

---

## 6. What the server owns on a write

A submission's `source.*` attribution is **entirely server-set**. Leaving any of it client-controlled
permits attribution impersonation, forged submission times, and deliberate collisions against the
cross-system unique key.

| Field | Set to |
|---|---|
| `source.publisher` | the resolved namespace |
| `source.submittedBy` | the publishing organization's slug when the account holds a verified membership on the namespace; else the account's public handle; else `"community"` |
| `source.submittedAt` | server `now()` on create, **preserved** on update |
| `source.ingestedVia` | `publisher_api` for a key, `submission` for a session |
| `source.originalId` | accepted **only** from a credential that could publish here; otherwise forced null |
| `verifiedAgainstSource`, `verifiedAt`, `snapshotUrl` | the verifier's, never the submitter's |

The namespace is `source.publisher ?? operatingOrganizations[0].slug`, and the public id **must** be
`<namespace>:<local>` — the same derivation `source_system` uses, so an entry cannot be filed under a
system it was not authorized for. The namespace **must also appear in `operatingOrganizations[].slug`**:
you may only publish under an organization that operates the program, so a stated `source.publisher`
that names an org which does not run the program is a `400` `publisher_not_operating`. When
`source.publisher` is absent the namespace *is* `operatingOrganizations[0].slug`, so the rule holds
trivially. A `PUT` is held to the same containment against the entry's **stored** publisher — a
replacement may not strip out the operating org that authorizes the entry. The one exemption is
**import-provenance-scoped**: a row that both entered through a legacy ingest route
(`ingestedVia ∈ {import, scrape, outbox}`) **and** never conformed (its stored publisher was never
one of its operating orgs) is grandfathered and stays editable. A row created through the
authenticated write path (`publisher_api`/`submission`) went through the create-time gate, so it is
held to containment on replace — a foreign-operated one of those is still a `400`.

---

## 7. CORS — two policies, and why they differ

There is **one** `@fastify/cors` registration and it chooses between two policies per request. Not
by preference: the plugin decorates the request object unconditionally, so registering it twice —
even inside an encapsulated scope — throws. Its `delegator` seam is the supported way, and it has
the better property anyway, because both policies are then chosen in one visible place instead of
depending on which registration's hook ran first (`src/app.ts`, `src/plugins/better-auth.ts`).

### `/v1` — `origin: "*"`, `credentials: false`

`credentials: false` is the load-bearing half. **Every `/v1` credential is header-borne**, so a
cross-site request carries no ambient authority: a browser attaches nothing the attacker's page does
not already possess, and a page that possesses the token did not need CORS to use it.

> **Introducing any cookie on `/v1` breaks this.** The moment a `/v1` credential becomes a cookie,
> `origin: "*"` becomes a cross-site request forgery surface and this must become an explicit origin
> allowlist with `credentials: true`. Stated here and in `src/app.ts` because the change that breaks
> it will not look like a CORS change. **The session cookie the auth routes set does not break it**:
> it is host-only on the API's own origin, `/v1` never reads it, and `/v1` authenticates from the
> `Authorization` header alone.

### `/api/auth/*` — an exact-origin allowlist, still `credentials: false`

These routes do not inherit the wide policy, because they are not like `/v1`: they **mint** the
credential, and they expose `set-auth-token` so a browser can read it.

The honest version of the argument: `credentials: false` alone would not be a vulnerability here.
There is no cryptographic bypass — signing in still requires a code that arrives in a mailbox the
caller must control — so `origin: "*"` would not hand anybody a session. What it would hand them is
a **working login client on any page on the web**: a phishing page that completes the flow in its
own tab and reads the token out of the response. That widens phishing and violates least privilege
for no benefit, so the allowlist is exact:

* `TRUSTED_ORIGINS` — exact origins, compared whole. No suffix matching, no scheme guessing.
* `PREVIEW_ORIGIN_PATTERN` — staging only, an **anchored** regular expression tied to our project
  *and* our team slug. **Never a bare `*.vercel.app`**, which accepts any tenant on the platform.
  The reader should know the residual trust it does carry: *this assumes the preview host will not
  issue our team slug to somebody else.* The pattern must be anchored with `^`/`$` or the process
  refuses to boot, because an unanchored pattern matches inside an origin an attacker chooses.

The same list backs `trustedOrigins` for CSRF and the handoff redirect, so the CORS answer and the
sign-in answer cannot drift apart. A disallowed origin gets **no** `Access-Control-Allow-Origin`
header at all — not an echo, not a `*` — which is what a browser needs to see. Accept and reject
cases are asserted in `test/integration/better-auth-mount.test.ts`.

Google never touches CORS: it is a top-level navigation out and a top-level redirect back.

---

## 8. Curl walkthrough

Signing in is two calls: ask for a code, then exchange it. The session token comes back in the
**`set-auth-token`** response header — that is the value the browser stores and the value every
`/v1` call carries afterwards.

```sh
API=https://api.example.org
EMAIL=you@example.org

# 1. Ask for a code. The answer is the same whether or not the address is known — that is
#    deliberate, and it is why the send is not awaited internally either.
curl -X POST -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"type\":\"sign-in\"}" \
  $API/api/auth/email-otp/send-verification-otp

# 2. Exchange the six-digit code for a session. Read the token out of the RESPONSE HEADER.
curl -sS -D headers.txt -X POST -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"otp\":\"123456\"}" \
  $API/api/auth/sign-in/email-otp
TOKEN=$(grep -i '^set-auth-token:' headers.txt | tr -d '\r' | cut -d' ' -f2)

# Signing out deletes the row, so the very next request with this token is a 401.
#   curl -X POST -H "Authorization: Bearer $TOKEN" $API/api/auth/sign-out

# Who am I, and what may I do?
curl -H "Authorization: Bearer $TOKEN" $API/v1/me

# Choose the public handle attribution will use (session only).
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"handle":"my-handle"}' $API/v1/me

# Mint a publishing key. The secret is in this response and nowhere else, ever.
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"ci","scopes":["read","write","publish"]}' $API/v1/keys

KEY=rfph_xxxxxxxx_...

# Publish. Approved immediately only if the key carries `publish` AND the account is a verified
# member of the namespace (or holds direct-create).
curl -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  --data-binary @opportunity.json $API/v1/opportunities

# Rotate: mint the replacement, deploy it, then revoke the old one.
curl -X DELETE -H "Authorization: Bearer $TOKEN" $API/v1/keys/123
```

`/v1/me` answers with the address the session belongs to (`email`), read from the identity table
rather than copied into `accounts`. An **API key** presents an account without presenting a session,
so `email` is `null` for one — the field says which credential you are holding as much as who you
are.

An invalid document comes back as:

```json
{
  "error": "validation_failed",
  "message": "the submission is not a valid RFP Hub Standard opportunity.",
  "errors": ["`title` must be a string.", "`status` must be one of upcoming, open, closed, archived."]
}
```

…rather than a generic schema message, because the route installs a pass-through Fastify validator
and the service is the sole validator. The published OpenAPI document still `$ref`s `Opportunity` as
the request schema: it is the accurate contract, it is simply not the enforcement point.

### Claiming an entry somebody else published

An entry ingested into your namespace before you had an account is claimed rather than
re-submitted, so its id, its history and anything already pointing at it survive.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"organizationSlug":"my-org","note":"we run this programme"}' \
  $API/v1/opportunities/some-namespace:1459/claim
```

Two outcomes, and the status code is the whole answer:

* **`200 {"outcome":"granted"}`** — your organization is **verified** *and* its slug appears in the
  entry's `operatingOrganizations`. Publisher ownership transfers immediately.
  *Sponsorship is not operation:* appearing only in `sponsoringOrganizations` does not grant, or a
  sponsor could seize an entry it merely funds.
* **`202 {"outcome":"queued","claimId":…}`** — anything else. A reviewer decides.

`409` when the entry is already owned by a **different** verified organization;
`200 {"outcome":"unchanged"}` when your organization already owns it. On an API key, filing a claim
at all needs the `write` scope, and a claim that *would* be granted immediately needs `publish` —
each absence is a 403 naming the scope, never a quiet downgrade to a queued claim.

**A granted claim moves `PUT` with it.** Ownership is the row's `source.publisher`, not who first
typed the entry in, so once a claim is granted the original submitter's account no longer holds
`PUT` on it — unless they are a member of the claiming organization, which is the ordinary case of
somebody submitting on their own organization's behalf and then claiming. A refused replacement is
the same `403 not_your_entry`, with a message saying ownership moved by claim rather than the
misleading "submitted by another account".

*Which entries this bites* is decided by the **trail**, not by the id: the check is whether a
`grant_publisher` action was ever recorded against the entry (`audit_log` is append-only and both
grant paths write it). Two shapes make the cheaper guesses wrong, and both are real — a legacy
import whose publisher never matched its id prefix and never involved a claim, and an entry claimed
away and later claimed back, whose id and publisher agree again while ownership has moved twice. An
ordinary submission filed into a namespace you hold no membership on is untouched: you may still
edit what you filed.

### Reviewing, as T3

```sh
REVIEWER=<reviewer's access token>       # a session. An API key is 403 on every route below.

curl -H "Authorization: Bearer $REVIEWER" "$API/v1/review/opportunities?reviewStatus=pending"
curl -X POST -H "Authorization: Bearer $REVIEWER" $API/v1/review/opportunities/my-org:42/approve

# Check the entry against its own applicationUrl before deciding.
curl -X POST -H "Authorization: Bearer $REVIEWER" $API/v1/review/opportunities/my-org:42/verify

# Claims. `verifyOrganization` is an explicit decision, not a side effect:
curl -X POST -H "Authorization: Bearer $REVIEWER" -H 'content-type: application/json' \
  -d '{"verifyOrganization":true}' $API/v1/review/claims/7/approve
```

> **`verifyOrganization: false` transfers ownership but does *not* unlock auto-approval.**
> Auto-approval requires a **verified** organization, so that publisher's later writes keep landing
> `pending`. The response says so, and this paragraph exists because "the claim was approved, why is
> my next submission still in review" is otherwise a support ticket rather than a documented rule.

Verifying an organization is what actually flips a namespace to T2, and revoking a membership takes
it back on the very next request:

```sh
curl -X POST -H "Authorization: Bearer $REVIEWER" $API/v1/review/organizations/my-org/verify
curl -X POST -H "Authorization: Bearer $REVIEWER" -H 'content-type: application/json' \
  -d '{"accountId":123,"role":"publisher"}' $API/v1/review/organizations/my-org/members
```

---

## 9. Audit

Every mutation writes a row to `audit_log`, in the **same transaction** as the mutation, so a
rolled-back change cannot leave history claiming it happened.

* The row records `actor_kind`, `actor_account_id` **and `actor_api_key_id`** — "an api key acted,
  belonging to this account" cannot say *which* key, and that is the question asked first when a key
  is suspected of leaking.
* The table is **append-only, enforced by a database trigger** (migration `0004`), not by a
  convention. A correction is a further row; history is not edited.
* `GET /v1/opportunities/:id/audit` gives the public the changed field **names** and a coarse actor
  (`reviewer`, `job`, a handle, or `community`); the entry's submitter, its publisher and T3+ get
  the full `{field: {before, after}}` patch. A non-public entry's trail 404s for everyone else,
  matching the detail route.

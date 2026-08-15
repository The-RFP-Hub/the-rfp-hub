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

| | What it is | How it is recognised |
|---|---|---|
| **Session** | An identity-provider access token, held by a signed-in human | Anything that does **not** start with `rfph_` |
| **API key** | A long-lived, scoped delegation of one account | Starts with `rfph_` |

The discrimination is made on the **token itself**, never on a header or parameter the caller
chooses (`modules/shared/api-key-token.ts` → `isApiKeyToken`). That is what keeps the session-only
routes session-only: a caller cannot present a key and ask for it to be treated as a session.

### Sessions

Verified **locally**, with `jose`, against the identity provider's app verification key:

* algorithm pinned to **ES256** — never read from the token's own header, which is the
  `alg: none` family of forgeries;
* `iss` must be `privy.io`;
* `aud` must equal `PRIVY_APP_ID` — separate applications are used per environment, so a staging
  token does not open production;
* `exp` enforced, with no clock tolerance.

`PRIVY_VERIFICATION_KEY` (a PEM public key) is **the** mechanism. `PRIVY_JWKS_URL` is supported as
an explicitly optional override and is **unverified**: no JWKS endpoint is documented for app access
tokens. When both are set, the PEM wins.

Every failure mode — bad signature, expired, wrong audience, wrong issuer — returns the same 401 and
the same message. Distinguishing them tells a prober which half of an attempt worked.

**Accounts are provisioned just in time, keyed on the DID and nothing else.** A wallet address that
reaches the API arrived in a request, which makes it self-asserted, which makes it a forgeable
authorization input. `accounts.primary_wallet` exists but is filled by the enrichment job from the
provider's own record, and is usable as an authorization input only because of where it came from.

**Enrichment is never on the authentication path.** The provider's user endpoint needs a second
credential and is heavily rate-limited, so a login completes with the DID alone and `enriched_at`
stays `NULL` — which is the cursor the enrichment job selects on. A request never waits on the
provider, and a provider outage never locks anyone out.

**Bootstrap admins are re-evaluated on every login**, not only at provisioning:
`BOOTSTRAP_ADMIN_PRIVY_DIDS` takes effect without anybody touching the database, which is the entire
point of having the variable. The promotion is audited like any other role change.

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

---

## 3. The rule that closes the escalation hole

> **A global role never elevates an API key.**

Concretely:

* **Any API-key path that causes immediate publication requires the `publish` scope** — including a
  reviewer's key, an admin's key, and a key belonging to an account with `direct_create`. Without
  it, an otherwise-auto-approving submission **lands `pending`**: it fails closed to the safe
  outcome rather than erroring, because a submitter who cannot publish still wants their submission
  recorded.
* **A claim that would be granted immediately requires `publish`** on an API-key credential.
  Its absence is a `403` naming the missing scope, **not** a silent queue — a claim that quietly
  became a review request would be actively misleading.
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

| Route | Credential | Notes |
|---|---|---|
| `GET /v1/opportunities`, `/:id`, `/schema` | none | public read surface, unchanged |
| `GET /v1/opportunities/:id/audit` | optional | redacted for the public; full patch for the owner and T3+ |
| `GET /v1/opportunities/:id/duplicates` | optional | an unprivileged caller never sees a non-public other side |
| `GET /v1/opportunities/:id/verification` | optional | 404 when never checked — a real state |
| `POST /v1/opportunities` | T1 + `write` | auto-approves only via `canPublishImmediately` |
| `PUT /v1/opportunities/:id` | owner or T2 of the namespace | `body.id` must equal the path id |
| `POST /v1/opportunities/:id/claim` | membership on the claiming org | grant needs `publish` on a key |
| `GET /v1/me`, `/v1/me/opportunities[/:id]`, `/v1/me/duplicates` | T1 | either credential kind |
| `PATCH /v1/me` | T1, **session** | |
| `GET|POST /v1/keys`, `DELETE /v1/keys/:id` | T1, **session** | account-scoped; 404 on a foreign id |
| `GET /v1/review/opportunities`, `POST …/:id/approve|reject`, `PATCH …/:id` | T3, **session** | |
| `GET /v1/review/claims`, `POST …/:id/approve|reject` | T3, **session** | approval carries `verifyOrganization` |
| `POST /v1/review/organizations/:slug/verify|unverify`, `PATCH …/:slug`, `POST|DELETE …/:slug/members` | T3, **session** | |
| `GET /v1/review/accounts`, `GET /v1/review/organizations` | T3, **session** | discovery for the review screens |
| `POST /v1/admin/accounts/:id/role`, `…/direct-create` | T4, **session** | |
| `PATCH /v1/organizations/:slug` | org `owner`/`admin`, **session** | never the verified flag |
| `GET /v1/publishers` | none | verified organisations only |

---

## 6. What the server owns on a write

A submission's `source.*` attribution is **entirely server-set**. Leaving any of it client-controlled
permits attribution impersonation, forged submission times, and deliberate collisions against the
cross-system unique key.

| Field | Set to |
|---|---|
| `source.publisher` | the resolved namespace |
| `source.submittedBy` | the publishing organisation's slug when the account holds a verified membership on the namespace; else the account's public handle; else `"community"` |
| `source.submittedAt` | server `now()` on create, **preserved** on update |
| `source.ingestedVia` | `publisher_api` for a key, `submission` for a session |
| `source.originalId` | accepted **only** from a credential that could publish here; otherwise forced null |
| `verifiedAgainstSource`, `verifiedAt`, `snapshotUrl` | the verifier's, never the submitter's |

The namespace is `source.publisher ?? operatingOrganizations[0].slug`, and the public id **must** be
`<namespace>:<local>` — the same derivation `source_system` uses, so an entry cannot be filed under a
system it was not authorized for.

---

## 7. The CORS invariant

`origin: "*"`, all the write verbs, `allowedHeaders: ["Content-Type", "Authorization"]`,
**`credentials: false`**.

That last one is the load-bearing half. **Every credential this API accepts is header-borne**, so a
cross-site request carries no ambient authority: a browser attaches nothing the attacker's page does
not already possess, and a page that possesses the token did not need CORS to use it.

> **Introducing any cookie breaks this.** The moment a credential becomes a cookie, `origin: "*"`
> becomes a cross-site request forgery surface and this must become an explicit origin allowlist
> with `credentials: true`. Stated here and in `src/app.ts` because the change that breaks it will
> not look like a CORS change.

---

## 8. Curl walkthrough

```sh
API=https://api.example.org
TOKEN=<identity-provider access token>

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

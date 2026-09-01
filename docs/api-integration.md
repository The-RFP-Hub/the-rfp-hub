# Integrating with the RFP Hub API

For a developer building against the public API: read it in five minutes, write to it in twenty,
and know the handful of contracts that would otherwise cost you an afternoon.

The read surface is public and unauthenticated, and stays that way. Only writing needs a
credential.

Shell blocks are marked `no-run`, `safe-read` or `staging-write` — see
[the convention](./README.md#shell-blocks-carry-a-marker-and-the-marker-is-a-contract). Every block
in [§1](#1-five-minute-quickstart) is `safe-read`: run them against any deployment, as often as you
like.

Throughout, `$API` is the API's origin — `https://api.ethrfps.app` in production,
`https://api-staging.ethrfps.app` in staging, `http://localhost:3001` locally.

---

## 1. Five-minute quickstart

### Is it up?

```sh safe-read
curl -s "$API/v1/health" | jq
```

`200` with `status: ok, db: up` is healthy. A `200` that says `degraded` is not — the body is the
answer, not the status code.

### What does this deployment serve?

```sh safe-read
curl -s "$API/" | jq
```

The service-info document names the API, the Standard version it serves, the docs path and the
endpoints. Ask the deployment rather than trusting a version pasted into a guide.

### List, with filters

```sh safe-read
curl -s "$API/v1/opportunities" | jq
curl -s "$API/v1/opportunities?fundingType=grant,hackathon&status=open&ecosystem=Optimism" | jq
curl -s "$API/v1/opportunities?q=public%20goods&page=2&limit=50" | jq
```

Filters: `fundingType`, `status`, `ecosystem`, `category`, `organization`, `minAward`, `maxAward`,
`deadlineAfter`, `deadlineBefore`, `q`. Comma-separated values are ANY-of. Sorting: `sort` over
`nextDeadlineAt` (the default), `opensAt`, `postedAt`, `updatedAt`, `createdAt`, with `order`.
Paging: `page`, `limit`.

`organization` matches **any** entry in `operatingOrganizations` **or** `sponsoringOrganizations`,
not only the first operating one.

### One entry, in full

```sh safe-read
ID=$(curl -s "$API/v1/opportunities?limit=1" | jq -r '.items[0].id')
curl -s "$API/v1/opportunities/$ID" | jq
```

The list is a thin projection that omits `fundingDetails` — the type-specific slot, a tagged union
whose shape its own `fundingType` tag names. The detail endpoint serves it in full. Everything
else, including `title`, `summary` and `description`, is present on both.

### The contract itself

```sh safe-read
curl -s "$API/v1/docs/json" | jq '.info, (.paths | keys)'
```

`/v1/docs` is Swagger UI; `/v1/docs/json` is the OpenAPI 3.1 document, and it is the authority.
Generate a client from it. `GET /v1/opportunities/schema` serves the canonical JSON Schema
byte-for-byte as the package ships it.

### Feeds and exports

```sh safe-read
curl -s "$API/v1/feeds/opportunities.atom" | head -40      # Atom 1.0; also .rss
curl -s "$API/v1/export/opportunities.json" -o dataset.json # the whole public dataset, CC0
curl -s "$API/v1/export/opportunities.csv"  -o dataset.csv  # the same data, flat
```

Feeds take exactly two parameters, `limit` (1–100, default 50) and `status`, and carry a strong
`ETag` — poll with `If-None-Match` and get a `304` with no body. The export endpoints take no
parameters at all and send the whole dataset as an attachment.

For a dataset you do not want to pull from the live API, the nightly snapshot is committed to
`exports/` in the repository, with a manifest naming every artifact by sha256.

### Where to go next

* [`examples/curl`](../examples/curl/README.md) — a copy-pastable command for every endpoint.
* [`examples/typescript`](../examples/typescript/README.md) — a zero-dependency Node client that
  also demonstrates the published types.
* [`examples/python`](../examples/python/README.md) — stdlib only, Python 3.9+.

---

## 2. Writing: from an email address to a publishing key

Four steps. The first three happen once.

### 2.1 Ask for a sign-in code

```sh staging-write
curl -X POST -H 'content-type: application/json' \
  -d "{\"email\":\"you@example.org\",\"type\":\"sign-in\"}" \
  "$API/api/auth/email-otp/send-verification-otp"
```

Six digits, valid five minutes, three attempts, stored hashed. The answer is the same whether or
not the address is known — deliberately.

### 2.2 Exchange it — and read the token out of the HEADER

```sh staging-write
curl -sS -D headers.txt -X POST -H 'content-type: application/json' \
  -d "{\"email\":\"you@example.org\",\"otp\":\"123456\"}" \
  "$API/api/auth/sign-in/email-otp"

TOKEN=$(grep -i '^set-auth-token:' headers.txt | tr -d '\r' | cut -d' ' -f2)
```

**The session token arrives in the `set-auth-token` response header, not in the response body.**
This is the single most common thing to get wrong on the write path. A client that parses the body
looking for a token finds a user object and concludes sign-in failed.

The session is a **row**, not a JWT: signing out deletes it and the very next request with that
token is a `401`. It lives 90 days, refreshed at most once a day, and the refresh re-issues the
token — so store whatever the newest `set-auth-token` header carried.

### 2.3 Mint an API key

```sh staging-write
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"ci","scopes":["read","write","publish"]}' "$API/v1/keys"
```

**The secret is in that response and nowhere else, ever.** The database stores a SHA-256 of it. The
`rfph_<prefix>_<secret>` prefix is public and is how a key is named in a UI or an audit row without
the secret existing anywhere to name it by.

Rotation is create-then-revoke — mint the replacement, deploy it, then `DELETE /v1/keys/:id`. The
overlap is by construction, which is why there is no rotate endpoint. Revocation is soft, because
the audit trail points at keys and history has to keep being able to answer *which key did this*.

### 2.4 Use it

```sh staging-write
curl -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  --data-binary @opportunity.json "$API/v1/opportunities"
```

One header carries either credential kind, and **which kind it is decides real authority**: a token
starting with `rfph_` is a key, anything else is a session. The discrimination is made on the token
itself, never on a header or parameter the caller chooses, which is what keeps the session-only
routes session-only.

---

## 3. Scopes: pick one, and know what you gave away

| Scope | Grants | Give it to |
|---|---|---|
| `read` | Authenticated reads. Always present — it is the floor | Anything that only consumes. The public read surface needs no credential at all, so this is for reading **your own** pending and rejected entries via `/v1/me/*` |
| `write` | Create and replace entries, and file a claim | An integration that files submissions and should not be able to publish them |
| `publish` | Strictly stronger than `write`. Required for **any** path that causes immediate publication | A publisher's own sync job, and nothing else |

Three consequences worth internalizing:

* **A `write`-only key never errors on a namespace it does not publish for — the entry lands
  `pending`.** It fails closed to the safe outcome rather than to an error, because a submitter who
  cannot publish still wants their submission recorded. If your integration "works" but nothing
  appears publicly, check the key's scopes before checking anything else.
* **A global role never elevates a key.** A reviewer's key, an admin's key, and a key belonging to
  an account with direct-create authority all still need `publish` to publish. A leaked key must
  not be able to do more than the integration it was minted for.
* **Session-only routes refuse keys with a `403`, always.** Minting a key, changing your account,
  approving anything, granting a role, and everything under `/v1/review/*` and `/v1/admin/*`
  require a signed-in session. A leaked key must not be able to mint a stronger key.

Claims split the two bars: filing one needs `write`, and a claim that would be **granted
immediately** additionally needs `publish`. Each absence is a `403` naming the missing scope, never
a quiet downgrade into the review queue — a claim that silently became a review request would be
actively misleading.

---

## 4. The contracts that surprise integrators

Nine of them. Each one has cost somebody an afternoon.

### 4.1 Query validation is strict — an unknown parameter is a `400`

```sh safe-read
# The 400 is the point, so swallow it: a strict runner shims `curl -f`, where a 4xx is a failure.
curl -si "$API/v1/opportunities?funding_type=grant" | head -1 || true   # 400, not "filter ignored"
```

Every list and feed endpoint declares `additionalProperties: false`. A typo, a renamed parameter or
a parameter from another API is a `400` naming it — never a silently unfiltered result set. That is
deliberate: a feed URL is a subscription somebody saves for years, and a typo in it has to fail
loudly rather than quietly return everything.

Handle the `400` by showing the parameter name. Do not retry without it.

### 4.2 `source.*` is entirely server-owned

Whatever you send in `source` is discarded. The server sets the publisher namespace, the submitting
organization or handle, the submission time (preserved across updates), how it was ingested, and
every verification field. Leaving any of it client-controlled would permit attribution
impersonation, forged submission times and deliberate collisions against the cross-system key.

`source.originalId` is accepted **only** from a credential that could publish in that namespace;
otherwise it is forced null.

### 4.3 The id is `<namespace>:<local>`, and the namespace must operate the program

An id of any other shape is a `400` naming the required form. The namespace is
`source.publisher ?? operatingOrganizations[0].slug`, and it **must also appear** in
`operatingOrganizations[].slug` — you may only publish under an organization that operates the
program. A `source.publisher` naming an organization that does not run it is
`400 publisher_not_operating`.

Sponsorship is not operation. Appearing only in `sponsoringOrganizations` grants nothing.

### 4.4 `PUT` is a full replace, not a patch

`PUT /v1/opportunities/:id` replaces the stored document. A field you omit is **gone**, not
retained. `body.id` must equal the path id.

Read the entry, modify the object, send the whole thing back. The reference frontend's edit screen
does exactly that — it loads the stored document and carries every field it does not itself render
through untouched, and that behavior has its own round-trip test, because it is the most damaging
bug a form of this shape can have.

A replace is held to the same containment rule as a create: it may not strip out the operating
organization that authorizes the entry.

### 4.5 `duplicateCheck` has three states, and they are not interchangeable

A `201` from a submission carries a `duplicateCheck` string:

| Value | Meaning |
|---|---|
| `ok` | Detection ran. An empty `duplicates` array then means *checked, nothing similar* |
| `unavailable` | The check failed or timed out. A backfill still owes this entry a check — **this is not "no duplicates"** |
| `disabled` | No provider is configured on this deployment |

Detection never blocks a write: a failure is reported here, not as an error. The `duplicates` array
on a submission result is searched over **publicly visible** entries only — a duplicate check must
never disclose another account's pending or unlisted title.

### 4.6 The counted path is `/v1/r/:id/apply` and `/v1/r/:id/source`

Link out through the redirect routes, never straight to the stored URL:

```sh safe-read
# `DNT: 1` is not decoration here — see below. Without it this line records a click.
ID=$(curl -s "$API/v1/opportunities?limit=1" | jq -r '.items[0].id')
curl -si -H 'DNT: 1' "$API/v1/r/$ID/apply" | head -3      # 302 to the program's own page
```

Click counters only move for hops the API sees. A frontend that links directly leaves `applyClicks`
at zero forever and makes the publisher's analytics quietly wrong — while the traffic it was hiding
is the traffic it had itself generated. The same argument applies to the detail page: `detailViews`
is counted by `GET /v1/opportunities/{id}`, so a browse surface built on some other read leaves a
publisher's numbers at zero while people are reading.

Both routes `302` for approved **and** listed entries only, and `404` otherwise. They honor
`DNT: 1`, and capture happens **before** the redirect — so an automated check that follows one
records a click. Inspect the `href`, or send `DNT: 1`.

### 4.7 CORS on `/v1` is `*`, with only two request headers allowed

`/v1` answers `Access-Control-Allow-Origin: *` with `credentials: false`, for the read verbs and
the write ones, allowing exactly `Content-Type` and `Authorization`.

**A custom request header fails the browser preflight.** No `X-Client-Version`, no
`X-Request-Id` — send what you need in the body or the query string.

The invariant that makes `*` safe is that every `/v1` credential is header-borne, so a cross-site
request carries no ambient authority. The auth routes under `/api/auth/*` are different: they
**mint** credentials and expose `set-auth-token`, so they use an exact-origin allowlist
(`TRUSTED_ORIGINS`). If sign-in fails from your origin while reads work perfectly, that is the
allowlist, and it is a configuration change on the API side.

### 4.8 Rate limits are per credential, and a `429` tells you when to come back

The public read surface — the list, the detail, the feeds, the export — is deliberately
**uncapped**. It is the traffic this project exists to serve. **Every `/v1` mutation is metered**,
along with the credential and link-out routes, and the per-route ceilings are in
[`packages/api/docs/auth.md` § Rate limits](../packages/api/docs/auth.md#rate-limits) rather than
repeated here, because that is where they are maintained.

What an integrator has to build around:

* **The key is your account, not your address.** A metered route counts against `acct:<accountId>`
  whenever the request proved a credential, and against `ip:<address>` when it proved nothing. The
  two namespaces are disjoint, so no address can land in an account's bucket. Two people behind one
  office egress are two budgets; one account calling from a laptop and from CI is **one**. Nothing
  is stored — the counter expires with its window and never reaches a row or a log line.
* **Anonymous and invalid-credential traffic is metered too, by address, and the limiter answers
  first.** Hammering a write route with a missing or junk Bearer gets `401` for the whole budget
  and `429` once it is spent — so a `429` on a request you believe is unauthenticated is the
  limiter, not a bug.
* **A `429` carries `Retry-After` in seconds**, plus `x-ratelimit-limit`, `-remaining` and
  `-reset`. Read them rather than backing off blindly. All four are on the CORS
  `Access-Control-Expose-Headers` list, so browser JavaScript can read them cross-origin — most
  APIs send these headers and hide them, and a fetch client that sees `429` with no readable
  `Retry-After` is usually looking at that mistake rather than at a missing header.

  ```json
  { "error": "rate_limited", "message": "Rate limit exceeded, retry in 60 seconds" }
  ```

  Branch on `error === "rate_limited"` and obey `Retry-After`; the message names the same number of
  seconds and is for humans.
* **The `429` is in the published contract.** `GET /v1/docs/json` carries the response and its
  headers on every metered operation, so a generated client models the throttle instead of
  discovering it.
* **A failure to *check* your credential is never metered.** A `503 auth_unavailable` from the
  session lookup, or a `500` from the key lookup, means the credential store is unreachable rather
  than your budget being spent, so an outage never turns into a `429`. **Any other response does
  spend it**, `5xx` included: a request that reached the handler has already been counted, so a
  client retrying into a server fault can exhaust its window and start seeing `429` instead of the
  real error.
* **The ceilings are per API process.** With several tasks behind a load balancer the effective
  number is a multiple of the published one, because each process counts in its own memory. Do not
  build a client that paces itself exactly at the documented ceiling and assume the margin is real
  in either direction. Whether the address half of the key works at all is a deployment setting
  (`TRUST_PROXY`); the operator's side of both facts is in
  [`deployment.md` §4](./deployment.md#rate-limits-are-per-process--n-tasks-multiply-every-ceiling).

### 4.9 Errors have one shape, and unverified accounts have a queue cap

```json
{ "error": "validation_failed",
  "message": "the submission is not a valid RFP Hub Standard opportunity.",
  "errors": ["`title` must be a string."],
  "issues": [{ "path": "/title", "message": "must be a string" }] }
```

`error` is a stable snake_case code — branch on it. `message` is for humans. `errors` and `issues`
appear only on a rejected write that failed Standard validation: `errors` is one humanized sentence
per violation, `issues` the same violations as JSON Pointer plus message. Rejections that are about
*one* thing — a mismatched id, a namespace that cannot be resolved — carry neither, because the
message is the whole answer.

**An account with no verified membership may have at most 5 entries awaiting review at once.** Over
the cap, `POST /v1/opportunities` answers `409 pending_limit_reached`, naming the count, the limit,
and the fact that slots free as reviews happen. It is a ceiling on the queue, not a lifetime quota:
every decision frees a slot, replacing an already-pending entry is not a new submission, and anyone
holding a verified membership anywhere is exempt entirely. It is a product rule fixed in code — no
deployment setting raises it.

---

## 5. Other ways to call it

### The MCP server

[`@the-rfp-hub/mcp`](../packages/mcp/README.md) puts the API in front of an agent over stdio.
Install it into a client with `npx -y @the-rfp-hub/mcp@<exact version>` — the README carries the
configuration snippet for each client.

| Tool | Kind | Notes |
|---|---|---|
| `search_opportunities` | read | The full filter set, `limit` capped at 25. **It returns no `description` and no `summary`** — the two longest fields a publisher controls, which is where an instruction addressed to your agent would live |
| `fetch_opportunity` | read | One record in full, structurally unmodified, wrapped in `{ notice, opportunity, links }`. Ask for it when you actually need the prose |
| `submit_opportunity` | write | Not registered at all unless `RFPHUB_MCP_ENABLE_SUBMIT=1`. `tools/list` shows two tools without it |

Configuration is read **from the environment only**, never as a tool parameter: `RFPHUB_API_BASE`
(default the production API, and it **must be `https:`** unless it points at loopback — a plain
`http:` host is refused at startup rather than quietly carrying a key in the clear),
`RFPHUB_API_KEY` (needed only to submit, never sent on a read), `RFPHUB_MCP_ENABLE_SUBMIT`,
`RFPHUB_MCP_TIMEOUT_MS` (the per-request timeout), and `RFPHUB_MCP_HOME` (default `~/.rfphub`,
where approvals, rate-limit counters and the local audit log live — it must be writable). Exact
defaults, the precedence `RFPHUB_MCP_HOME` takes over that default, and the companion agent skill
are in [`packages/mcp/README.md`](../packages/mcp/README.md).

**Submitting is two calls with a person in between.** The first returns
`{ status: "pending", approvalId, preview }` and writes nothing. A human then runs
`rfphub-mcp approve <approvalId>` in their own terminal, which prints the destination, the
credential fingerprint, the operation and the whole document before asking for confirmation; the
second call claims that single-use approval and posts. `rfphub-mcp pending` lists what is waiting
and `rfphub-mcp revoke <id>` deletes one. An agent cannot approve its own write, because approving
is not something the protocol can reach. The reasoning is in
[`adr/0012`](../adr/0012-mcp-server-per-user-credential-stdio-out-of-band-approval.md).

Pin the exact version in any configuration snippet — never `@latest`. An example that floats hands
whoever controls the package the ability to change what a user already installed.

### The agent skill

[`rfp-hub-funding-search`](../skills/rfp-hub-funding-search/SKILL.md) teaches an agent to search the
Hub without an MCP client. It ships zero-dependency Node helpers — `scripts/search.mjs` (defaulting
to `status=open`) and `scripts/get.mjs` — which build the query, refuse parameters the API does not
declare, and **project** the response down to a small, bounded set of fields before the agent ever
sees it. That projection is code rather than an instruction in prose, on purpose: by the time a
rule in a prompt could apply, third-party description text has already reached the model.

Install channels — a multi-agent installer, the Claude Code plugin marketplace, or a plain directory
copy — are in [`skills/README.md`](../skills/README.md).

### Building your own frontend

`packages/frontend` is the reference implementation and is deliberately readable as one. What it
does that yours should:

* **All API knowledge in one module.** `src/lib/api.ts` is the only file that knows the API exists;
  every screen calls it. One place to change when a contract moves.
* **Link out through the API**, per [§4.6](#46-the-counted-path-is-v1ridapply-and-v1ridsource).
* **Treat every string that came from a submitter as untrusted.** The reference frontend renders
  third-party text through components that never emit markup, and only links `http:`/`https:` URLs
  — anything else is rendered as text. A test sweeps the source for raw HTML.
* **Never load remote images.** The content-security policy is `img-src 'self' data:` unless the
  deployment opts into analytics, because fetching a logo from a host a submitter named leaks every
  reader's IP address to it.
* **`NEXT_PUBLIC_API_URL` is the only required variable**, it is not a secret, and it is inlined at
  build time — so a configuration change needs a rebuild, not a restart. The two optional ones —
  `NEXT_PUBLIC_SITE_ORIGIN`, which decides whether the copy is indexable, and `NEXT_PUBLIC_GA_ID`,
  which is what opens those Google origins in the CSP — are in
  [`deployment.md` §4](./deployment.md#the-frontends-variables).

Deploying a copy: [`deployment.md` §9](./deployment.md#9-the-frontend-three-ways-to-deploy-a-copy).
The short version is that reads work everywhere and sign-in needs your origin on the API's
allowlist.

---

## 6. Reference

| Question | Where |
|---|---|
| The exact request and response schema of every operation | `GET /v1/docs/json`, and Swagger UI at `/v1/docs` |
| Which credential does each route accept, and what does each tier mean? | [`packages/api/docs/auth.md`](../packages/api/docs/auth.md) |
| What does each field mean? | [`packages/standard`](../packages/standard) — the JSON Schema is the source of truth, with `FIELDS.md` beside it |
| Validate a document before sending it | `npx rfphub-validate opportunity.json` |
| How do I become a verified publisher? | [`PUBLISHERS.md`](../PUBLISHERS.md) |
| What will a reviewer check on my submission? | [`REVIEW-CRITERIA.md`](../REVIEW-CRITERIA.md) |

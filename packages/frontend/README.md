# RFP Hub frontend — the directory and the workbench

This package is the project's **reference frontend** and the **operational workbench** at once —
one app, one deploy pipeline, both roles. There is no separate marketing site and no separate admin
tool: the same Next.js build that serves the public directory to an anonymous visitor also serves
the signed-in publisher, reviewer and administrator surfaces, gated by nothing more than the session
`GET /v1/me` returns.

A browser client for the RFP Hub `/v1/` API, and two surfaces rather than one:

* **The directory** — every published opportunity, browsable, searchable and readable by anybody,
  with **no account and no sign-in**. It is the front door (`/`), because the people the data is for
  are applicants and an applicant has no reason to hold an account here.
* **The workbench** — submit and maintain funding opportunities, read what they get read for, manage
  API keys, and, for the people who hold those capabilities, run the review and administration
  queues. It starts at `/dashboard` and needs a session.

**It is a client and nothing else.** There are no route handlers, no server actions that talk to the
API, and no server-side session. Every authenticated request is made from the browser with the
signed-in user's own session token, so the API remains the single authority on what an account may
do. Nothing this client renders is a permission decision it made itself; the capability flags on the
navigation come from `GET /v1/me`.

**The public half is public all the way down.** `GET /v1/opportunities`, `GET /v1/opportunities/{id}`
and its audit sub-resource are unauthenticated on the API; the client attaches an `Authorization`
header only when there is a token to attach, and the directory never asks for one. A signed-in
reader sees exactly what a stranger sees there — the routes serve `approved AND is_listed` entries
and nothing else, whoever asks.

---

## Environment

**One** variable, `NEXT_PUBLIC_`, **inlined at build time**. Setting it on a running host changes
nothing until the next build — the frontend says so on screen when it is missing, because it is the
most common way to lose an afternoon here. Copy `.env-example` to `.env.local` to start.

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_API_URL` | Origin of the API, e.g. `http://localhost:3004`. It is where `/v1` lives, where sign-in lives (`/api/auth`), and it is written into the page's CSP `connect-src`, so the browser may talk to this API and nothing else. |

It is not a secret — an API origin is an identifier, readable by anyone who loads the page.
**Nothing secret may ever be added with this prefix.** This package holds no server-side credential
at all.

### There used to be a second one

A third-party auth application id, which had to name a **different** application per environment or
a throwaway login in development became a real account in production's directory. Sessions are now
issued by the API itself, from its own database, so the environments are separated by the same thing
that separates everything else about them — which API you are pointed at. That whole class of
misconfiguration is gone with the variable.

What replaces it, on the API side, is `TRUSTED_ORIGINS`: the API must list this frontend's origin,
or the browser's preflight for the sign-in calls is refused. `/v1` is unaffected — it stays
`origin: "*"` with `credentials: false`, because every `/v1` credential is header-borne.

---

## Running it locally

```bash
pnpm install
pnpm --filter rfphub-validate build      # the frontend imports it for in-browser validation
cp packages/frontend/.env-example packages/frontend/.env.local
pnpm --filter @the-rfp-hub/frontend dev  # http://localhost:3005
```

Signing in locally needs the API running with a mail transport that does not send mail: set
`EMAIL_TRANSPORT=stdout` and the six-digit code is printed to the API's console. Nothing else about
sign-in differs from production. It also needs the API's `TRUSTED_ORIGINS` to list this frontend's
origin (uncomment `TRUSTED_ORIGINS=http://localhost:3005` in `packages/api/.env`) — without it the
browser's preflight for the sign-in calls is refused, which shows up as a CORS error in the console
rather than anything the sign-in form itself explains.

The API has to be running for anything past the login screen to have data — see
[`packages/api/README.md`](../api/README.md#local-development). `pnpm --filter
@the-rfp-hub/frontend... build` (note the `...`) builds the workspace dependencies first, which is
what a clean checkout needs.

```bash
pnpm --filter @the-rfp-hub/frontend test        # jsdom, offline, no database
pnpm --filter @the-rfp-hub/frontend typecheck
pnpm --filter @the-rfp-hub/frontend build
```

The frontend runs **its own** vitest with a jsdom environment. The repository-wide `pnpm test`
excludes this package deliberately: pulling a jsdom suite into the node-environment root run would
change the environment every other suite executes in.

---

## The pages

### Public — no session

| Route | What it does |
|---|---|
| `/` | The directory. Every published opportunity, from `GET /v1/opportunities`: title, organisation, next deadline and award, with search, funding-type / status / ecosystem filters, ordering and pagination. Every filter is a parameter that endpoint declares — it validates its querystring with `additionalProperties: false`, so an invented one is a 400 rather than a control that quietly does nothing. Below the listing, the demoted sign-in card for publishers. |
| `/opportunities/[id]` | One published opportunity in full, from `GET /v1/opportunities/{id}` — **the read the API counts as a detail view**. Dates, money, organisations, milestones, eligibility, links, the type-specific `fundingDetails` block verbatim, the provenance and source-check state the payload exposes, and the public, redacted change history from the audit route. The "open the application page" action goes through `/v1/r/{id}/apply`. |

### Signed in — the workbench

| Route | What it does |
|---|---|
| `/dashboard` | Signed out: what an account is for, and the login button. Signed in: this account's traffic across everything it publishes, most-read first. (This was `/` until the directory took that route.) |
| `/listings` | Everything this account submitted or publishes, **whatever its review status** — the public reads 404 a pending entry, and its owner still needs to see it. Review status, listing state, and the last source-check verdict per row. |
| `/listings/[id]` | One entry, with four tabs: **Analytics** (daily reads and link-outs), **Audit** (every mutation, with the full patch for the owner), **Verification** (the last source check, and a reviewer's button to run one), **Duplicates** (suspected matches against published entries). Also where an entry is claimed for an organisation. |
| `/listings/new`, `/listings/[id]/edit` | Submit or replace, validated in the browser against the Standard before it is sent. |
| `/keys` | Mint, list and revoke API keys. The secret is shown exactly once. |
| `/duplicates` | Suspected duplicates touching this account's entries. Read-only — merging is a reviewer's action. |
| `/review` | Reviewer only: the pending queue, ownership claims, the duplicate queue including the merge, and organisation verification. |
| `/admin` | Administrator only: global roles and the direct-create grant, plus the organisation directory. |
| `/account` | Handle and display name, and what the API says this account may do. |

Every one of them renders an explicit loading, empty and error state, and an error carries the API's
own machine-readable code so a report can quote it.

### Link-outs go through the API

Every "open the application page" control points at `GET /v1/r/{id}/apply` or `…/source`, not at the
stored URL. The click counters only move for hops the API sees; linking directly would leave
`applyClicks` at zero forever and make the Analytics tab quietly wrong.

This is why the public detail page reads the **public** route rather than any other: `detailViews`
is counted by `GET /v1/opportunities/{id}` and `applyClicks` by the redirect. A browse surface built
on a different read would leave a publisher's numbers at zero while people were reading and applying
— and the traffic it was hiding would be the traffic it had itself generated.

### Analytics are best-effort, and every surface says so

They are API reads and link-outs, not page views. The project's own exporter and compliance checker
are excluded by name, crawlers and `DNT: 1` are dropped, capture is buffered in memory and so is
lossy across a restart, and feeds and exports are not instrumented at all. Days before today come
from the nightly rollup; today is aggregated live.

### The submission form, honestly scoped

Typed inputs for the common top-level fields, plus a JSON editor for `fundingDetails` and one for
`deadlines`. A fully typed form per funding type — six different shapes, each with nested arrays —
is **not** in this cut. `fundingDetails` in particular is the Standard's structural discriminator; a
half-typed version of it would silently drop fields a publisher had entered.

Editing is a **replace** (`PUT`), so the edit screen loads the stored document and carries every
field it does not itself render through untouched. That behaviour has its own round-trip unit test:
it is the most damaging bug a form of this shape can have.

Validation runs twice: in the browser against the Standard (`rfphub-validate`, the same package the
API validates with), and on the API, which is the only validation that decides anything. If the
in-browser half cannot run the form says so and submits anyway, rendering the API's humanized 400 in
the same place — degraded, and never a false all-clear.

---

## Security

**Sessions.** Sign-in is ours now, not an embedded third-party modal: an email address, a six-digit
code, and — where the deployment configures it — Google.

* **The code flow** is two steps on one panel (`src/components/SignIn.tsx`). The API mints the code,
  counts the attempts and issues the session; this package renders the three failures apart, because
  "wrong code", "expired code" and "too many attempts" have three different next steps.
* **Google** is a top-level navigation. Google returns to the **API**, which is where the session
  cookie belongs; the API exchanges that cookie for a one-time token and bounces the browser to
  `/auth/complete`, which trades it for the bearer session this client uses. The frontend never
  sees the cookie, and the API is never handed a redirect target it did not choose. The token
  arrives in the URL **fragment** — never sent to a server — and `/auth/complete` rewrites the URL
  before its first `await`, navigates on with `replace`, and relies on the token being single-use.
* **The Google button is offered, not advertised.** Nothing the API serves says which social
  providers are configured, so the button renders optimistically and removes itself the once if the
  API answers `404 PROVIDER_NOT_FOUND` — which that call does from its first statement, before
  writing anything. The honest cost is one dead click on an email-only deployment; see "Known gaps".
* **The token lives in `localStorage`**, and it is a **90-day** session rather than the roughly
  one-hour access token that preceded it. Both are XSS-reachable; the window and the blast radius
  are not comparable, and `src/lib/auth-client.ts` states that trade in full rather than implying
  they are. The compensating controls are the CSP above, the no-raw-HTML test, and the fact that
  sessions are now revocable server-side — a compromise is remediable, which it previously was not.

**Untrusted content.** Titles, descriptions, organisation names and URLs are publisher-supplied; the
Standard says a `description` must be treated as untrusted. They are rendered as **text**, never as
markup — no HTML injection API is used anywhere in `src/`, and `test/no-raw-html.test.ts` scans the
source on every run to keep it that way, including a check that no markdown or sanitiser dependency
has crept into `package.json`. Markdown is therefore shown as the characters the publisher typed;
rendering it safely means an allowlisting renderer with raw HTML disabled, and adding one should be
reviewed as the change it is.

**Content-Security-Policy.** Built in `src/lib/csp.ts`, unit-tested, and applied by `src/proxy.ts`
with a fresh per-request nonce. The auth migration made this materially stronger, because removing
the third-party SDK removed everything that was forcing it to be weak:

| Directive | Before | Now |
|---|---|---|
| `script-src` | `'self' 'nonce-…' 'unsafe-eval' 'wasm-unsafe-eval'` + a bot-check origin | **`'self' 'nonce-…'`** |
| `connect-src` | `'self' <api>` + 3 auth-vendor + 5 wallet origins | **`'self' <api>`** |
| `frame-src` | `'self'` + 5 third-party origins | **`'none'`** |
| `worker-src` | `'self' blob:` | **`'self'`** |

Dropping `'unsafe-eval'` and `'wasm-unsafe-eval'` is the largest single security change in this
package's history: with them present, anything that could get a string onto this origin could
execute it — and the session token in `localStorage` is now a 90-day credential rather than an
hour-long one. No third-party origin is named anywhere any more. Google sign-in does not reappear
here, because it is a top-level navigation out and back rather than an embedded widget.

The table above is the **deployed** header. `next dev` compiles with an eval-based devtool, so
`contentSecurityPolicy` widens `script-src` for the dev server alone, behind an explicit parameter
rather than an ambient `NODE_ENV` read — and `test/csp.test.ts` asserts both sides, so the dev
allowance cannot quietly become a shipped one.

**This briefly cost the submit form its in-browser validation**, and the fix went the right way.
ajv normally compiles the Standard's schema with `new Function`, which `script-src` no longer
permits; rather than restore the relaxation, `rfphub-validate` now ships that validator
**precompiled** with ajv's standalone code generator, so nothing evaluates a string at runtime and
live validation works under the strict header. (ajv's compiler is still *present* in the bundle —
`ajv-formats` requires it unconditionally — but it is unreachable from this package's code paths.)

One relaxation remains, named rather than buried:

* `style-src 'unsafe-inline'` — the framework emits inline style attributes. Inline styles are not
  script execution; the prohibition that matters is on `script-src`, and that one is now absolute.

Because the nonce is per request, **every page is rendered per request** (`export const dynamic` in
the root layout). A prerendered page cannot carry a nonce a later request's header will match. There
is no server-side content to cache anyway — the public directory is fetched in the browser like
every other screen here.

**Indexing stays off** (`robots: { index: false }` in the root layout), even though half the app is
now public. That is a statement about this deployment, not about the directory's audience: nothing
here is served from a canonical public host yet, and a preview URL that indexes competes with the
real one for every listing it carries. Turning it on is an operator decision to take once the
directory has an address worth indexing.

---

## Deployment — main is staging, a tag is production

**Production is the apex: `https://ethrfps.app`.** That hostname is also the Standard's canonical
identity — every schema `$id`, the meta-schema, the registries and the vocabulary namespace are
URLs on it ([`adr/0007`](../../adr/0007-canonical-domain-and-spec-identity.md)) — so this app
carries four path prefixes it does not own. `next.config.ts` proxies `/schemas/`, `/meta/`,
`/registries/` and `/ns/` to `NEXT_PUBLIC_API_URL`'s origin, in Next's `beforeFiles` bucket so the
decision is made before the filesystem is consulted; they are never redirected, because an
identifier that 301s resolves somewhere else. Adding a route under any of the four is forbidden and
`test/canonical-namespace.test.ts` fails if one appears. Staging is
`https://staging.ethrfps.app` — a single label, by the certificate rule that gives the API
`api-staging.` rather than `api.staging.`.

CI/CD lives in `.github/workflows/frontend-staging.yml` and `frontend-production.yml`: every
frontend-affecting push to `main` deploys to the staging alias through Vercel's preview
environment, and production moves only on a `prod-*` (whole-product) or `frontend-prod-*`
(frontend-only) tag — each pulling that environment's own variables so the build-time
`NEXT_PUBLIC_*` values match the environment they ship to. The Git integration is disabled for
`main` (`vercel.json`) so a push cannot double-deploy; feature-branch previews are unaffected.
The API's image build still excludes `packages/frontend` (`.dockerignore`) precisely so that this
package can never fail the API image and block a service deploy.

To deploy it by hand instead — any host that can run a Next.js server (Vercel, or any Node
runtime); this is also the reference-frontend path for anyone deploying their own copy against the
public API:

1. Point the host at this repository, with **root directory** `packages/frontend` and pnpm
   workspaces enabled — the package depends on `rfphub-validate` and `@the-rfp-hub/standard` from
   this workspace, so a build that cannot see the repository root will fail.
2. Build command `pnpm --filter @the-rfp-hub/frontend... build` (the `...` builds workspace
   dependencies first). Install command `pnpm install --frozen-lockfile`.
3. Set `NEXT_PUBLIC_API_URL` **for that environment** as a build-time variable, and add this
   deployment's own origin to the API's `TRUSTED_ORIGINS` — without it the browser's preflight for
   the sign-in calls is refused and nobody can log in, while the public directory keeps working
   (`/v1` is `origin: "*"`). That asymmetry is the symptom to recognise.
4. `output: "standalone"` is set, so a self-hosted deployment runs `node .next/standalone/server.js`
   with `.next/static` and `public/` copied alongside it.

Redeploy on every configuration change: the variable is baked into the bundle.

If a pipeline is added later, it needs exactly two things this repository does not yet have — a
build step with a per-environment API origin, and a way to register each preview URL with the API's
trusted origins.

---

## Manual acceptance checklist

The render test proves the analytics tab turns a series into bars and numbers. It does not prove the
whole path from a real login through real traffic. **The login half of that gap has closed**: sign-in
is now this project's own code against this project's own API, and the E2E suite drives a real code
through a deterministic mail transport — it no longer depends on an interactive third-party login
that could not run unattended. What is still checked by hand is everything downstream of it.

Run against a staging deployment with a real publisher account, after generating traffic with
`packages/api/scripts/demo-traffic.ts`. Capture a screenshot for each numbered item.

1. **The directory, signed out.** In a private window, `/` lists published opportunities with no
   sign-in of any kind. Search, filter by funding type and ecosystem, change the ordering and page
   forward and back. Confirm a **pending** entry is absent, and that the network tab shows no
   `Authorization` header on `/v1/opportunities`.
2. **A public entry, signed out.** Open one from the directory. `/opportunities/{id}` shows the
   dates, money, organisations, provenance and change history. Click "Open the application page";
   confirm it lands on the programme's own site via `/v1/r/{id}/apply`. Then, as that entry's
   publisher, confirm `detailViews` and `applyClicks` both moved — this is the whole point of the
   public page reading the public route.
3. **Login.** `/` signed out shows the directory *and* the publisher card with its login button.
   Click it, enter an address, receive the code, and sign in. Check the three failures on the way:
   a wrong code, an expired one (wait five minutes), and a fourth attempt on the same code — each
   must say something different and specific. After signing in, the header shows the account handle
   and the navigation matches the account's capabilities (no Review link for a submitter, no
   Administration link for a reviewer), with the Directory link present in both states.
4. **Google, where configured.** "Continue with Google" leaves for Google, returns via the API, and
   lands on `/dashboard` signed in. Confirm the address bar shows **no** `#ott=` fragment when it
   settles, and that pressing Back does not sign you in again or re-expose the token. On a
   deployment without Google configured, the button withdraws with a plain sentence and email still
   works.
5. **Sign out.** The header's Log out clears the session; a reload does not restore it, and
   `/dashboard` offers a login rather than data.
6. **Listings.** `/listings` lists the account's entries including a **pending** one, with its review
    status, listing state and source-check verdict.
7. **Analytics.** `/listings/{id}` → Analytics shows non-zero totals and a bar chart with one bar per
    day of the window, and the day-by-day table matches the tiles. Switch the window to 7 days and
    confirm the chart redraws. **This is the screenshot the milestone asks for.**
8. **Link-out counting.** Click "Open the application page", return, reload the Analytics tab, and
    confirm `applyClicks` has increased — proving the redirect route is the counted path.
9. **Audit.** The Audit tab shows one row per mutation, with the patch visible to the owner — and
    the public `/opportunities/{id}` history shows the same actions with field names only.
10. **Verification.** The Verification tab shows the last run, or the honest "not checked yet" state.
11. **Submit.** `/listings/new` with a deliberately invalid document shows the in-browser errors and
    keeps the submit button disabled; correcting them submits, and the result panel states the review
    status **and** the duplicate-check state. This works under the strict CSP because
    `rfphub-validate` ships the Standard's validator **precompiled**; if the form instead reports
    validation "unavailable", something has reintroduced runtime schema compilation — treat that as
    the finding, and do not fix it by restoring `'unsafe-eval'`.
12. **Duplicate check states.** Submit a near-copy of an existing published entry and confirm the
    result panel names the match. On a deployment with detection disabled, confirm the panel says the
    check did not run rather than "nothing similar found".
13. **Keys.** `/keys` mints a key, shows the secret once, and the secret is gone after a reload.
    Revoking it moves the row to revoked.
14. **Review.** As a reviewer, `/review` approves a pending entry (it appears in the public directory
    within a reload), approves a claim **without** verifying the organisation and shows the API's
    sentence about future writes staying pending, and merges a duplicate pair with the survivor
    chosen explicitly.
15. **Administration.** As an administrator, `/admin` changes an account's role and toggles
    direct-create.
16. **Refusals.** As a submitter, open `/review` directly by URL and confirm the page reports the
    missing capability rather than showing a queue.

---

## Known gaps

* **The Google button is offered rather than advertised.** Nothing the API serves says which social
  providers are configured, so the button renders and withdraws on `404 PROVIDER_NOT_FOUND`. One
  field on a public endpoint — `GET /v1/health` gaining `auth: { google: boolean }`, say — would
  make it conditional on load and cost the API one line. Worth taking when the API is next touched.
* **`/auth/complete` is not exercised by a unit test.** Its correctness is an ordering property
  (`history.replaceState` before the first `await`) and a navigation property, both of which need a
  real history stack to mean anything; they are covered by the E2E back-button case instead.
* The verification badge on `/listings` is fetched **per row** — the list payload does not carry the
  last run. At most 20 rows, each failing soft, but the right fix is a field on the list row.
* No pagination controls on the review queues; they take the API's first 50–100 rows.
* Organisation directory editing (`PATCH /v1/review/organizations/{slug}`) has no screen yet;
  verification and membership are the parts a reviewer needs day to day.
* No dark theme, and no per-funding-type submission form (see above).
* **The directory is client-fetched, so it is invisible to anything that does not run JavaScript.**
  That is the same trade every other screen here makes, and it is fine while indexing is off; the day
  the directory gets a canonical host it wants server rendering and metadata per entry, which is a
  larger change than this cut (the CSP nonce is why every page is `force-dynamic` today).
* The directory's filters are one value at a time. The endpoint accepts a comma-separated list on
  every list filter and the client passes the string straight through, so multi-select is a UI change
  and not an API one.
* `/opportunities/{id}` renders `fundingDetails` as the record's own JSON. A typed layout per funding
  type is the same six-shapes problem the submission form has, and the same answer: showing it
  verbatim cannot drop a field a publisher entered.
* The public change history is fetched on mount rather than when its `<details>` is opened — one
  small extra public GET per detail view.

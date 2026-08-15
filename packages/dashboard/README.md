# RFP Hub publisher dashboard

A browser client for the RFP Hub `/v1/` API: submit and maintain funding opportunities, read what
they get read for, manage API keys, and — for the people who hold those capabilities — run the
review and administration queues.

**It is a client and nothing else.** There are no route handlers, no server actions that talk to the
API, and no server-side session. Every authenticated request is made from the browser with the
signed-in user's own access token, so the API remains the single authority on what an account may
do. Nothing this dashboard renders is a permission decision it made itself; the capability flags on
the navigation come from `GET /v1/me`.

---

## Environment

Two variables, both `NEXT_PUBLIC_`, both **inlined at build time**. Setting them on a running host
changes nothing until the next build — the dashboard says so on screen when one is missing, because
it is the most common way to lose an afternoon here. Copy `.env-example` to `.env.local` to start.

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_API_URL` | Origin of the API, e.g. `http://localhost:3004`. Also written into the page's CSP `connect-src`, so the browser may talk to this API and nothing else. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | The auth application this environment logs in against. |

Neither is a secret — an API origin and an application id are identifiers, readable by anyone who
loads the page. **Nothing secret may ever be added with this prefix.** The dashboard holds no
server-side credential at all.

### One auth application per environment

Development, staging and production each get **their own** application, and all of them are separate
from any other product's. This is not tidiness:

* The application **is** the user pool. Sharing one means a throwaway login in development is a real
  account in production's directory, and it means one environment's data-subject requests reach
  across all of them.
* The API verifies an access token by checking that its `aud` equals its own configured application
  id. One application across environments makes that check unable to tell them apart: a token minted
  against development would be accepted by production.

The API's `PRIVY_APP_ID` must name the **same** application this dashboard does, per environment. A
mismatch is a 401 on every authenticated call with a perfectly valid-looking session.

---

## Running it locally

```bash
pnpm install
pnpm --filter rfphub-validate build      # the dashboard imports it for in-browser validation
cp packages/dashboard/.env-example packages/dashboard/.env.local
# fill in NEXT_PUBLIC_PRIVY_APP_ID, then:
pnpm --filter @the-rfp-hub/dashboard dev # http://localhost:3005
```

The API has to be running for anything past the login screen to have data — see
`packages/api/README.md`. `pnpm --filter @the-rfp-hub/dashboard... build` (note the `...`) builds the
workspace dependencies first, which is what a clean checkout needs.

```bash
pnpm --filter @the-rfp-hub/dashboard test        # jsdom, offline, no database
pnpm --filter @the-rfp-hub/dashboard typecheck
pnpm --filter @the-rfp-hub/dashboard build
```

The dashboard runs **its own** vitest with a jsdom environment. The repository-wide `pnpm test`
excludes this package deliberately: pulling a jsdom suite into the node-environment root run would
change the environment every other suite executes in.

---

## The pages

| Route | What it does |
|---|---|
| `/` | Signed out: what an account is for, and the login button. Signed in: this account's traffic across everything it publishes, most-read first. |
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

**Untrusted content.** Titles, descriptions, organisation names and URLs are publisher-supplied; the
Standard says a `description` must be treated as untrusted. They are rendered as **text**, never as
markup — no HTML injection API is used anywhere in `src/`, and `test/no-raw-html.test.ts` scans the
source on every run to keep it that way, including a check that no markdown or sanitiser dependency
has crept into `package.json`. Markdown is therefore shown as the characters the publisher typed;
rendering it safely means an allowlisting renderer with raw HTML disabled, and adding one should be
reviewed as the change it is.

**Content-Security-Policy.** Built in `src/lib/csp.ts`, unit-tested, and applied by
`src/middleware.ts` with a fresh per-request nonce. Scripts carry that nonce and inline scripts are
refused; framing and object embedding are refused outright; `connect-src` is an allowlist naming the
configured API origin and the auth SDK's own origins; no remote images are loaded, so a
publisher-supplied `logoUrl` cannot phone home from a reader's browser.

Two relaxations are deliberate and named rather than buried:

* `'unsafe-eval'` — ajv compiles the Standard's JSON Schema with `new Function`, and without it the
  submit form loses its live validation. Nothing here evaluates a string it did not author, so there
  is no gadget to reach. Removing it means precompiling the schema with ajv's standalone code
  generator at build time; that is the right fix and is not in this cut.
* `style-src 'unsafe-inline'` — the framework and the auth SDK emit inline style attributes. Inline
  styles are not script execution; the prohibition that matters is on `script-src`, and it is kept.

Because the nonce is per request, **every page is rendered per request** (`export const dynamic` in
the root layout). A prerendered page cannot carry a nonce a later request's header will match. There
is no server-side content to cache anyway.

---

## Deployment — manual, and there is no pipeline

**This cut ships no CI/CD for the dashboard.** Nothing builds or deploys it automatically; saying
otherwise would be the misleading part. The API's image build excludes `packages/dashboard`
(`.dockerignore`) precisely so that this package can never fail the API image and block a service
deploy.

To deploy it by hand, on a host that can run a Next.js server (a preview host such as Vercel, or any
Node runtime):

1. Point the host at this repository, with **root directory** `packages/dashboard` and pnpm
   workspaces enabled — the package depends on `rfphub-validate` and `@the-rfp-hub/standard` from
   this workspace, so a build that cannot see the repository root will fail.
2. Build command `pnpm --filter @the-rfp-hub/dashboard... build` (the `...` builds workspace
   dependencies first). Install command `pnpm install --frozen-lockfile`.
3. Set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_PRIVY_APP_ID` **for that environment** as build-time
   variables, and add the deployment's own origin to the auth application's allowed origins.
4. `output: "standalone"` is set, so a self-hosted deployment runs `node .next/standalone/server.js`
   with `.next/static` and `public/` copied alongside it.

Redeploy on every configuration change: both variables are baked into the bundle.

If a pipeline is added later, it needs exactly two things this repository does not yet have — a
build step with per-environment variables, and a preview URL registered with the auth application.

---

## Manual acceptance checklist

The render test proves the analytics tab turns a series into bars and numbers. It does not prove the
whole path from a real login through real traffic, and no automated test in this cut does: a full
end-to-end run needs an interactive login against a real auth application, which cannot run
unattended in CI. That gap is covered here, by hand, once per release.

Run against a staging deployment with a real publisher account, after generating traffic with
`packages/api/scripts/demo-traffic.ts`. Capture a screenshot for each numbered item.

1. **Login.** `/` signed out shows the explanation and the login button. After signing in, the
   header shows the account handle and the navigation matches the account's capabilities (no Review
   link for a submitter, no Administration link for a reviewer).
2. **Listings.** `/listings` lists the account's entries including a **pending** one, with its review
   status, listing state and source-check verdict.
3. **Analytics.** `/listings/{id}` → Analytics shows non-zero totals and a bar chart with one bar per
   day of the window, and the day-by-day table matches the tiles. Switch the window to 7 days and
   confirm the chart redraws. **This is the screenshot the milestone asks for.**
4. **Link-out counting.** Click "Open the application page", return, reload the Analytics tab, and
   confirm `applyClicks` has increased — proving the redirect route is the counted path.
5. **Audit.** The Audit tab shows one row per mutation, with the patch visible to the owner.
6. **Verification.** The Verification tab shows the last run, or the honest "not checked yet" state.
7. **Submit.** `/listings/new` with a deliberately invalid document shows the in-browser errors and
   keeps the submit button disabled; correcting them submits, and the result panel states the review
   status **and** the duplicate-check state.
8. **Duplicate check states.** Submit a near-copy of an existing published entry and confirm the
   result panel names the match. On a deployment with detection disabled, confirm the panel says the
   check did not run rather than "nothing similar found".
9. **Keys.** `/keys` mints a key, shows the secret once, and the secret is gone after a reload.
   Revoking it moves the row to revoked.
10. **Review.** As a reviewer, `/review` approves a pending entry (it becomes visible in the public
    read), approves a claim **without** verifying the organisation and shows the API's sentence about
    future writes staying pending, and merges a duplicate pair with the survivor chosen explicitly.
11. **Administration.** As an administrator, `/admin` changes an account's role and toggles
    direct-create.
12. **Refusals.** As a submitter, open `/review` directly by URL and confirm the page reports the
    missing capability rather than showing a queue.

---

## Known gaps

* The verification badge on `/listings` is fetched **per row** — the list payload does not carry the
  last run. At most 20 rows, each failing soft, but the right fix is a field on the list row.
* No pagination controls on the review queues; they take the API's first 50–100 rows.
* Organisation directory editing (`PATCH /v1/review/organizations/{slug}`) has no screen yet;
  verification and membership are the parts a reviewer needs day to day.
* No dark theme, and no per-funding-type submission form (see above).

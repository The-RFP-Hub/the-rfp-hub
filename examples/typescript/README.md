# TypeScript example

A zero-dependency Node client for the RFP Hub public `/v1/` API: plain global `fetch`, no HTTP
library and no runtime TypeScript loader — `npm start` is a bare `node index.ts`, which Node
22.18+ runs by stripping the types. `@the-rfp-hub/standard` is used only as a **type**, to show
that the detail endpoint returns a real `Opportunity` from the standard's generated types; it is
erased at run time and never called. That makes this a **type-contract demo** as well as a
client: it is installed from the npm registry the way any consumer would install it.

## Prerequisites

Node **22.18+** (for `node index.ts`) and a running RFP Hub API. Bring one up locally (Postgres +
migrate + seed) — see [`packages/api/README.md`](../../packages/api/README.md) — or point at a
hosted instance via `RFPHUB_API_BASE` (default `http://localhost:3001`).

## Run

```bash
npm ci             # or `npm install` if you are changing the dependency versions
npm start          # runs index.ts directly on node
```

Typecheck only (needs the install first — `@types/node` supplies the Node globals the example
uses: `process`, `console`, `fetch`, `Response`, `URLSearchParams`):

```bash
npm run typecheck
```

Point at a different API (always `https` for a hosted instance):

```bash
RFPHUB_API_BASE=https://api.ethrfps.app npm start           # production
RFPHUB_API_BASE=https://api-staging.ethrfps.app npm start   # staging
```

## What it exercises

- `listOpportunities()` — the list endpoint with filters (`fundingType`, `status`, `ecosystem`),
  sort/order, and pagination. Its params type carries the **complete** parameter set.
- `getOpportunity(id)` — the full Standard object for one opportunity by its public id.
- `getStats()` — dataset totals and breakdowns.

`index.ts` exports all three functions, the `displayOrg`/`money` formatting helpers, and every
type they use — `ListOpportunitiesParams`, `OpportunitySummary`, `Paginated<T>`, `Stats` and
`ApiError`. **Importing it runs nothing**: the demo sits behind an entrypoint guard, so
`import { listOpportunities } from "./index.js"` makes no request. Copy the file into your own
project, or import from it as-is.

If the API isn't reachable, the client throws a clear "could not reach the API" error rather
than an opaque `fetch failed`. HTTP errors are unwrapped from the API's `{error, message}`
envelope, so a failure names the stable error code; a non-JSON error body (an HTML 502 from a
proxy, say) is surfaced verbatim rather than swallowed.

## A mistyped filter is a 400, never a silent full result set

The API's query contract is **strict**: a parameter it does not define — a typo, or a filter from
an older version of the API — is rejected with `400 bad_request`, as is an out-of-enum
`fundingType`, `status`, `sort` or `order`. That is the property to lean on. The worst failure
mode for a discovery API is a filter that quietly does nothing, because the response still looks
like a valid 200 — it is just the *entire* dataset. `ListOpportunitiesParams` mirrors the contract
exactly, so `tsc` catches the same class of mistake one step earlier, before the request is made.

## What the standard's types buy you

Four things the example leans on, all of them enforced by `tsc` rather than by comment:

- **The list projection is `Opportunity` minus one key.** The re-cut collapsed the six per-type
  blocks into a single tagged `fundingDetails` slot, so the thin list type is
  `Omit<Opportunity, "fundingDetails">` — one omission, not six.
- **`fundingDetails` narrows exhaustively.** Its own `fundingType` tag equals the top-level
  discriminator, so a `switch` over it narrows to the right detail shape (`milestoneBased` on a
  grant, `reward` on a bounty) with no casts. `describeFundingDetails()` handles all six shapes and
  ends in a `const unhandled: never = details` — a seventh funding type would stop the example
  compiling rather than fall through to a `default`.
- **`operatingOrganizations[0]` always exists.** The schema requires at least one entry and the
  generated type is a non-empty tuple, so the display organization needs no `?.` — even under
  `noUncheckedIndexedAccess`, which this example enables. Sponsors are a separate, optional role.
- **The file stays runnable without a build step.** `erasableSyntaxOnly` makes `tsc` reject syntax
  Node's type stripping cannot erase, which is what lets `npm start` be `node index.ts`.

## What CI checks, and what it does not

CI runs `npm ci && npm run typecheck` in this directory. Precisely:

- It **does** typecheck `index.ts` against the `@the-rfp-hub/standard` version pinned in
  `package-lock.json`, resolved from the **npm registry** — not from `packages/standard` in this
  repo. So a *published* release that breaks this consumer's usage fails here rather than in
  someone's downstream repo.
- It **does not** make a single HTTP request, so nothing about the API's runtime behaviour — the
  responses, the strict query contract, the error envelope — is verified by it.
- It **does not** look at the curl or Python examples at all; those are unchecked prose and are
  kept current by hand.
- It **does not** see uncommitted changes to `packages/standard`. Because the lockfile pins a
  published version, a change to the standard *in this repo* cannot fail this step; only
  publishing, then bumping the dependency here, exercises it.

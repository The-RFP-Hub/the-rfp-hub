# TypeScript example

A zero-dependency Node 18+ client for the RFP Hub public `/v1/` API: plain global `fetch`, no
HTTP library. `@the-rfp-hub/standard` is used only as a **type**, to show that the detail endpoint
returns a real `Opportunity` from the standard's generated types — it is erased at build/run time
and never called at runtime. That makes this a **type-contract demo** as well as a client: it is
installed from the npm registry the way any consumer would install it, so `npm run typecheck`
checks the live API's shape against the published standard. CI runs exactly that.

## Prerequisites

A running RFP Hub API. Bring one up locally (Postgres + migrate + seed) — see
[`packages/api/README.md`](../../packages/api/README.md) — or point at a hosted instance via
`RFPHUB_API_BASE` (default `http://localhost:3001`).

## Run

```bash
npm install
npm start          # runs index.ts via tsx
```

Typecheck only (needs `npm install` first — `@types/node` supplies the Node globals the example
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

`index.ts` exports these three functions plus their param/response types — copy them directly
into your own project, or use `index.ts` as a starting point.

If the API isn't reachable, the client throws a clear "could not reach the API" error rather
than an opaque `fetch failed`. HTTP errors are unwrapped from the API's `{error, message}`
envelope, so a failure names the stable error code.

## What the standard's types buy you

Three things the example leans on, all of them enforced by `tsc` rather than by comment:

- **The list projection is `Opportunity` minus one key.** The re-cut collapsed the six per-type
  blocks into a single tagged `fundingDetails` slot, so the thin list type is
  `Omit<Opportunity, "fundingDetails">` — one omission, not six.
- **`fundingDetails` narrows.** Its own `fundingType` tag equals the top-level discriminator, so a
  `switch` over it narrows to the right detail shape (`milestoneBased` on a grant, `reward` on a
  bounty) with no casts.
- **`operatingOrganizations[0]` always exists.** The schema requires at least one entry and the
  generated type is a non-empty tuple, so the display organization needs no `?.` — even under
  `noUncheckedIndexedAccess`, which this example enables. Sponsors are a separate, optional role.

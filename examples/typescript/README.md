# TypeScript example

A zero-dependency Node 18+ client for the RFP Hub public `/v1/` API: plain global `fetch`, no
HTTP library. `@the-rfp-hub/standard` is used only as a **type**, to show that the detail
endpoint returns a real `Opportunity` from the standard's generated types — it is erased at
build/run time and never called at runtime.

## Prerequisites

A running RFP Hub API. Bring one up locally (Postgres + migrate + seed) — see
[`packages/api/README.md`](../../packages/api/README.md) — or point at a hosted instance via
`RFPHUB_API_BASE` (default `http://localhost:3001`).

## Run

```bash
npm install
npm start          # runs index.ts via tsx
```

or, without a package-lock step:

```bash
npx --package typescript --package tsx --package @the-rfp-hub/standard tsx index.ts
```

Typecheck only (needs `npm install` first — `@types/node` supplies the Node globals the example
uses: `process`, `console`, `fetch`, `Response`, `URLSearchParams`):

```bash
npm run typecheck
```

Point at a different API:

```bash
RFPHUB_API_BASE=https://api.example.org npm start
```

## What it exercises

- `listOpportunities()` — the list endpoint with filters (`fundingType`, `status`, `ecosystem`),
  sort/order, and pagination.
- `getOpportunity(id)` — the full Standard object for one opportunity by its public id.
- `getStats()` — dataset totals and breakdowns.

`index.ts` exports these three functions plus their param/response types — copy them directly
into your own project, or use `index.ts` as a starting point.

If the API isn't reachable, the client throws a clear "could not reach the API" error rather
than an opaque `fetch failed`.

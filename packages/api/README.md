# @rfp-hub/api

The public **`/v1/` read API** for the RFP Hub — an unauthenticated Fastify + Postgres service that
serves [RFP Hub Standard v1.0.0](../standard) objects, backed by a 100+ entry seed dataset ingested
from a configurable upstream funding-map source and nightly open-data exports (CC0). This is
milestone **M2**.

## Endpoints (`/v1`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/opportunities` | List (thin projection). Filters: `type`, `status`, `ecosystem`, `network`, `category`, `tag`, `organization`, `minAward`, `maxAward`, `q`; `sort` (`closesAt\|opensAt\|postedAt\|updatedAt\|createdAt`), `order`, `page`, `limit`. |
| `GET` | `/v1/opportunities/:id` | One full Standard object (e.g. `fundingmap:1459`); `404` if not found. |
| `GET` | `/v1/opportunities/schema` | The canonical v1.0.0 JSON Schema. |
| `GET` | `/v1/stats` | Totals + breakdowns by type/status/ecosystem. |
| `GET` | `/v1/health` | Liveness + DB readiness. |
| `GET` | `/v1/docs` | Swagger UI (OpenAPI 3.1). |

Public reads return only `review_status = 'approved' AND is_listed` rows. List responses omit the
`opportunity[type]` block and `extensions` (a delivery optimization; see the Standard's FIELDS.md).

## Local development

```bash
docker compose up -d                     # Postgres 15 (see docker-compose.yml)
export DATABASE_URL=postgres://rfphub:rfphub@localhost:5432/rfphub
pnpm --filter @rfp-hub/api migrate       # apply Drizzle migrations
export SOURCE_API_URL=https://…          # upstream funding-map registry API (see .env-example)
pnpm --filter @rfp-hub/api seed          # ingest 100+ entries from SOURCE_API_URL
pnpm --filter @rfp-hub/api dev           # start the server (http://localhost:3001)
pnpm --filter @rfp-hub/api export        # write JSON + CSV to ./exports
```

Config is read from the environment (see `.env-example`): `DATABASE_URL`, `PORT`, `HOST`, and the
seed source (`SOURCE_API_URL`, `SOURCE_SYSTEM`, `SOURCE_PROGRAM_URL_BASE`).

## Architecture

Layered, module-per-folder — full pattern in [`docs/architecture.md`](./docs/architecture.md):
`routes/<module>/<entity>.controller.ts` (HTTP handlers) → `services/<module>/<name>.service.ts`
(logic + data over Drizzle) → `mappers/<entity>.mapper.ts` (pure row ↔ Standard). Route
registration lives in `routes/<module>/index.ts`.

- **DB**: Drizzle ORM over node-postgres; schema in `src/db/schema.ts`, migrations in
  `src/db/migrations`. The schema is the **M2 subset** of the full design in
  [`docs/data-model.md`](./docs/data-model.md) (which tags what's deferred to M3/M4).
- **Search**: `ILIKE` over title/summary/description (the generated `tsvector` column is deferred).
- **Validation/types**: reuses [`@rfp-hub/standard`](../standard) (schema + types) and
  [`rfphub-validate`](../validate) (the seed loader hard-validates every entry).

## Tests

- **unit** (`test/unit`, no DB): mappers vs the committed Standard examples, `map-program`
  registry→Standard, query-param parsing.
- **integration** (`test/integration`, gated on `DATABASE_URL`): each endpoint via `app.inject()`
  against Postgres, with isolated self-cleaning fixtures.

```bash
pnpm --filter @rfp-hub/api typecheck
DATABASE_URL=… pnpm test     # integration tests run when DATABASE_URL is set; otherwise skipped
```

## Deferred (later in M2 / beyond)

Cloud deploy + public export bucket + nightly cron; full OpenAPI live-spec test suite; TS/Python/curl
client examples; DAOIP-5 `grantPools` export adapter. The write API, auth, verification, dedup, and
analytics are M3+ (see `docs/data-model.md`).

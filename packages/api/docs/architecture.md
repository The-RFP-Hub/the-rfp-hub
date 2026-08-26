# API architecture & organization

The organizational pattern to adopt across `packages/api`. It is a **layered, module-per-folder**
structure: horizontal layers (`routes`, `services`, `repositories`, `mappers`), each subdivided by **module**
(a resource such as `opportunities`). A module can hold multiple files per layer.

Dependency direction is one-way: **controller → service → repository → db**. Mappers stay pure and
may be called wherever a database row crosses the application boundary.

## Layers

| Layer | Lives in | Responsibility | Never does |
|---|---|---|---|
| **Controller** | `modules/routes/<module>/<entity>.controller.ts` | The HTTP boundary. Parse the request, call a service, shape the response, set status codes. | SQL, business rules |
| **Service** | `modules/services/<module>/<name>.service.ts` | Business logic. Composes repositories; enforces domain rules. | Touch HTTP. Import `drizzle-orm` or a schema table — repositories own **ALL** database access ([ADR-0011](../../../adr/0011-repositories-own-all-database-access.md)). |
| **Repository** | `modules/repositories/<domain>.repository.ts` | Every database read and write for its owned aggregate, expressed over a pool or transaction executor supplied by the unit of work. | HTTP, business policy, or exposing its raw executor to a service. |
| **Mapper** | `modules/mappers/<entity>.mapper.ts` | Pure functions: DB row ↔ Standard object, plus the ingest guards (one block per `fundingType`) and the write-time derivations. | Any I/O |
| **Shared** | `modules/shared/*.ts` | Pure cross-cutting helpers used by more than one layer (pagination; the `deadlines[]` derivations that back `next_deadline_at` and auto-close). | Any I/O |

Route **registration** (paths + schemas) lives in `modules/routes/<module>/index.ts`; the aggregator
`modules/routes/index.ts` mounts each module under `/v1/<module>`.

## Directory map

```
packages/api/src/
  app.ts                    Fastify app factory — shared schemas, error/not-found handlers, plugins, routes
  server.ts                 process entry (listen)
  config.ts                 env config
  db/
    client.ts               Drizzle client + pg pool (the shared `db`)
    schema.ts               Drizzle tables (the M2 subset of docs/data-model.md)
    migrations/             drizzle-kit SQL + meta (generated — do not hand-edit)
  openapi/schemas.ts        reusable response schemas ($ref'd by routes → OpenAPI components)
  plugins/swagger.ts        @fastify/swagger + swagger-ui
  modules/
    routes/
      index.ts              aggregator: mounts each module under /v1
      opportunities/
        index.ts            route registration for the module (paths, schemas, response refs)
        opportunity.controller.ts   HTTP handlers → call the service
        types.ts            request query parsing/validation (per-module, optional)
      stats/    { index.ts, stats.controller.ts }
      health/   { index.ts, health.controller.ts }
    services/
      opportunities/
        opportunity.service.ts       class OpportunityService (business logic over repositories)
        opportunity-ownership.ts     shared submission-or-namespace owner rule
      notifications/
        notification.service.ts      notification domain rules
      stats/    { stats.service.ts }
      health/   { health.service.ts }
    repositories/
      index.ts                        public repository bundle + unit-of-work exports
      unit-of-work.ts                 lazy executor-bound bundle; withTransaction(db, run)
      <domain>.repository.ts          all queries for one aggregate (added as domains migrate)
    mappers/
      opportunity.mapper.ts          pure row ↔ Standard
    shared/
      pagination.ts                  cross-cutting helpers
      deadlines.ts                   pure deadlines[] derivations (nextDeadlineAt, isPastDue)
```

## Conventions

- **Module folder** — named for the resource / URL segment (plural where natural: `opportunities`).
  Exists in parallel under both `routes/` and `services/`.
- **Controller** — `<entity>.controller.ts`, exporting a handlers object `<entity>Controller`
  (e.g. `opportunityController.getAll`). Handlers are thin: `const service = new OpportunityService();
  return res.send(await service.getAll(query))`.
- **Service** — `<name>.service.ts`, exporting `class <Name>Service`. Plain class with
  a repository-bundle dependency. It composes repository calls and enforces policy, but never
  imports `drizzle-orm`, `db/schema.js`, or `db/auth-schema.js`, and never starts a transaction.
- **Repository** — `<domain>.repository.ts`, exporting `class <Domain>Repository`. It owns every
  query for that aggregate and accepts the pool-or-transaction executor supplied by
  `repositories(exec)`. Keep the executor private. Cross-aggregate joins belong to the repository
  whose aggregate owns the result; when that is not obvious, decide and document the owner.
- **Unit of work** — `repositories(db)` supplies the lazy non-transactional bundle.
  `withTransaction(db, run)` supplies the same bundle bound to one transaction and gives `run`
  only repositories, never the raw `tx`; this prevents a nested helper read from escaping to the
  pool while the transaction holds a connection.
- **Mapper** — `<entity>.mapper.ts`, only pure functions.
- **Multiple per module** — need a second service/controller for a module? Add another
  `*.service.ts` / `*.controller.ts` file in the same module folder. Need a new resource? Add its
  route/service module and an owning repository when it persists data, then register it in
  `modules/routes/index.ts`.
- **Boundary guard** — `test/unit/data-access-boundary.test.ts` scans the API tree without a
  database. Its temporary allowlist is migration debt with an exact two-way ratchet: both a new
  offender and a stale migrated entry fail the test.

## Testing

- **Unit** (no DB, always run): mappers vs the committed Standard examples, pure helpers
  (query parsing, pagination, LIKE escaping), repositories with a fake executor, and services with
  injected fake repositories.
- **Integration** (gated on `DATABASE_URL`): the full stack via `app.inject()` against Postgres,
  with self-cleaning fixtures (isolate by a unique ecosystem tag + public-id prefix, delete in
  `afterAll`).

## Adding a resource — checklist

1. `modules/repositories/<domain>.repository.ts` — every database read/write the resource needs;
   add its lazy getter to the `Repositories` bundle.
2. `modules/services/<module>/<entity>.service.ts` — domain logic over repositories
   (`class <Entity>Service`), with no Drizzle or schema imports.
3. `modules/mappers/<entity>.mapper.ts` — if it maps to the Standard.
4. `modules/routes/<module>/<entity>.controller.ts` — HTTP handlers calling the service.
5. `modules/routes/<module>/index.ts` — register the routes (+ response `$ref`s from
   `openapi/schemas.ts`).
6. Mount the module in `modules/routes/index.ts`.
7. Tests: unit for repository queries (fake executor), mapper/helpers, and service policy (fake
   repositories), plus integration coverage for the endpoints.

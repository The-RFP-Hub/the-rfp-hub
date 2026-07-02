# API architecture & organization

The organizational pattern to adopt across `packages/api`. It is a **layered, module-per-folder**
structure: horizontal layers (`routes`, `services`, `mappers`), each subdivided by **module**
(a resource such as `opportunities`). A module can hold multiple files per layer.

Dependency direction is one-way: **controller → service → mapper / db**.

## Layers

| Layer | Lives in | Responsibility | Never does |
|---|---|---|---|
| **Controller** | `modules/routes/<module>/<entity>.controller.ts` | The HTTP boundary. Parse the request, call a service, shape the response, set status codes. | SQL, business rules |
| **Service** | `modules/services/<module>/<name>.service.ts` | Business logic + data access over Drizzle. Enforces domain rules (e.g. public reads are always `approved + listed`). | Touch HTTP (no `req`/`res`) |
| **Mapper** | `modules/mappers/<entity>.mapper.ts` | Pure functions: DB row ↔ Standard object. | Any I/O |

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
        opportunity.service.ts       class OpportunityService (logic + data)
      stats/    { stats.service.ts }
      health/   { health.service.ts }
    mappers/
      opportunity.mapper.ts          pure row ↔ Standard
    shared/
      pagination.ts                  cross-cutting helpers
```

## Conventions

- **Module folder** — named for the resource / URL segment (plural where natural: `opportunities`).
  Exists in parallel under both `routes/` and `services/`.
- **Controller** — `<entity>.controller.ts`, exporting a handlers object `<entity>Controller`
  (e.g. `opportunityController.getAll`). Handlers are thin: `const service = new OpportunityService();
  return res.send(await service.getAll(query))`.
- **Service** — `<name>.service.ts`, exporting `class <Name>Service`. Plain class with
  `constructor(private readonly db: DB = defaultDb) {}` — defaults to the shared client and is
  injectable so unit tests can pass a fake `db`. **No abstract base** (the DB handle + a couple of
  helpers don't warrant one; put shared helpers in `modules/shared/`).
- **Mapper** — `<entity>.mapper.ts`, only pure functions.
- **Multiple per module** — need a second service/controller for a module? Add another
  `*.service.ts` / `*.controller.ts` file in the same module folder. Need a new resource? Add a new
  `<module>/` folder under `routes/` and `services/`, and register it in `modules/routes/index.ts`.

## Testing

- **Unit** (no DB, always run): mappers vs the committed Standard examples, pure helpers
  (query parsing, pagination, LIKE escaping), and services with an injected fake `db`.
- **Integration** (gated on `DATABASE_URL`): the full stack via `app.inject()` against Postgres,
  with self-cleaning fixtures (isolate by a unique ecosystem tag + public-id prefix, delete in
  `afterAll`).

## Adding a resource — checklist

1. `modules/services/<module>/<entity>.service.ts` — the logic (`class <Entity>Service`).
2. `modules/mappers/<entity>.mapper.ts` — if it maps to the Standard.
3. `modules/routes/<module>/<entity>.controller.ts` — HTTP handlers calling the service.
4. `modules/routes/<module>/index.ts` — register the routes (+ response `$ref`s from `openapi/schemas.ts`).
5. Mount the module in `modules/routes/index.ts`.
6. Tests: unit for the mapper/helpers + service (fake `db`), integration for the endpoints.

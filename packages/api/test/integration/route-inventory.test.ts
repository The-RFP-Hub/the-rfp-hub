/**
 * Every `/v1` mutation is metered — asserted over the ROUTER, not a list somebody maintains. With
 * `global: false` a forgotten route looks exactly like a deliberately public one.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { RATE_LIMIT_HEADERS } from "../../src/modules/routes/shared/rate-limit-key.js";
import { testAuth } from "../helpers/auth.js";
import { describeWithDb } from "./db-gate.js";

interface RouteRow {
  method: string;
  path: string;
  onRequest: string[];
}

/**
 * `commonPrefix: false` stops the tree compressing paths, so a node's label appended to its
 * parent's is the whole path. Four characters per level; methods and hooks print at the node's
 * own level, children one deeper.
 */
function inventory(app: FastifyInstance): RouteRow[] {
  const rows: RouteRow[] = [];
  const parents: string[] = [];
  let current: RouteRow[] = [];
  for (const line of app.printRoutes({ commonPrefix: false, includeHooks: true }).split("\n")) {
    if (line.trim() === "") continue;
    const body = line.replace(/^(?:[│ ] {3})*(?:[├└]── )?/, "");
    const level = (line.length - body.length) / 4;

    const hook = /^• \((\w+)\) \[(.*)\]$/.exec(body);
    if (hook) {
      if (hook[1] !== "onRequest") continue;
      const names = (JSON.parse(`[${hook[2]}]`) as string[]).map((n) => n.replace(/\(\)$/, ""));
      for (const row of current) row.onRequest = names;
      continue;
    }

    const route = /^(.*) \(([A-Z, ]+)\)$/.exec(body);
    if (!route) continue;
    const path = (parents[level - 1] ?? "") + (route[1] ?? "");
    parents[level] = path;
    current = (route[2] ?? "").split(", ").map((method) => {
      const row: RouteRow = { method, path, onRequest: [] };
      rows.push(row);
      return row;
    });
  }
  return rows;
}

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
const isMutation = (row: RouteRow) => !SAFE_METHODS.includes(row.method);

const run = describeWithDb;

run("route inventory", () => {
  let app: FastifyInstance;
  let routes: RouteRow[];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    routes = inventory(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  }, 60_000);

  it("reads the router back, and finds the surface it is supposed to find", () => {
    // A parser matching nothing would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((r) => r.path.startsWith("/v1/") && isMutation(r)).length).toBeGreaterThan(
      30,
    );
    expect(routes.some((r) => r.path === "/v1/opportunities" && r.method === "POST")).toBe(true);
  });

  it("puts exactly one limiter between the resolver and the gate on every /v1 mutation", () => {
    // BETWEEN the two, and exactly one: handlers from one registration share a marker, so a
    // second would never run.
    const wired = (row: RouteRow): boolean => {
      const resolver = row.onRequest.indexOf("resolvePrincipal");
      return (
        resolver !== -1 &&
        row.onRequest.filter((hook) => hook === "rateLimiter").length === 1 &&
        row.onRequest.indexOf("rateLimiter") === resolver + 1 &&
        row.onRequest.length > resolver + 2
      );
    };
    expect(
      routes
        .filter((row) => row.path.startsWith("/v1/") && isMutation(row) && !wired(row))
        .map((row) => `${row.method} ${row.path} [${row.onRequest.join(", ")}]`),
    ).toEqual([]);
  });

  it("leaves the mutations outside /v1 to the auth mount, and nothing else", () => {
    // The auth mount keeps its own ceilings and runs no resolver: it MINTS credentials.
    expect(
      routes.filter((row) => isMutation(row) && !row.path.startsWith("/v1/")).map((r) => r.path),
    ).toEqual([
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/email-otp/request-password-reset",
      "/api/auth/email-otp/request-email-change",
      "/api/auth/forget-password/email-otp",
      "/*",
    ]);
  });

  it("leaves the public read surface uncapped", () => {
    const capped = routes
      .filter((row) => !isMutation(row) && row.onRequest.includes("rateLimiter"))
      .map((row) => row.path);
    expect(capped).toEqual([]);
  });

  it("publishes the 429 contract on every metered operation", async () => {
    // Against the LIVE document, because that is what a client is generated from.
    const doc = (await app.inject({ method: "GET", url: "/v1/docs/json" })).json<OpenApiDocument>();

    const documented = Object.entries(doc.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([verb]) => !["get", "head", "options"].includes(verb))
        .map(([verb, operation]) => ({ name: `${verb.toUpperCase()} ${path}`, operation })),
    );
    expect(documented.length).toBe(
      routes.filter((row) => row.path.startsWith("/v1/") && isMutation(row)).length,
    );

    const redirects = ["/v1/r/{id}/apply", "/v1/r/{id}/source"].map((path) => ({
      name: `GET ${path}`,
      operation: doc.paths[path]?.get,
    }));

    for (const { name, operation } of [...documented, ...redirects]) {
      const response = operation?.responses?.["429"];
      expect(response?.content?.["application/json"]?.schema?.$ref, name).toBe(
        "#/components/schemas/RateLimitedResponse",
      );
      expect(Object.keys(response?.headers ?? {}).sort(), name).toEqual(
        [...RATE_LIMIT_HEADERS].sort(),
      );
      // A nested `schema.schema` is a raw JSON Schema wrapped twice, which no generator reads.
      for (const header of Object.values(response?.headers ?? {})) {
        expect(header.schema.type, name).toBe("integer");
      }
    }
  }, 60_000);
});

interface OpenApiHeader {
  schema: { type?: string };
}

interface OpenApiOperation {
  responses?: Record<
    string,
    {
      headers?: Record<string, OpenApiHeader>;
      content?: Record<string, { schema?: { $ref?: string } }>;
    }
  >;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

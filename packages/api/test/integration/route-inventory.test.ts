/**
 * Every `/v1` mutation is metered — asserted over the ROUTER, not over a list somebody maintains.
 *
 * The defect this exists to prevent is a route that is simply forgotten. Ten of the thirty-two
 * `/v1` write declarations were behind a limiter and twenty-two were not, and nothing failed:
 * `global: false` means an unmetered route looks exactly like a deliberately public one. So the
 * inventory is read back out of the built app and the rule is applied to all of it.
 *
 * Isolation tag: none — this suite reads the route table and issues no request.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { testAuth } from "../helpers/auth.js";
import { describeWithDb } from "./db-gate.js";

interface RouteRow {
  method: string;
  path: string;
  onRequest: string[];
}

/**
 * `printRoutes` renders the radix tree, one node per line, its `onRequest` names underneath.
 * `commonPrefix: false` stops the tree compressing a path into shared fragments, so a node's label
 * appended to its parent's is the whole path. Indentation is four characters per level, and a
 * node's methods and hooks are printed at its OWN level, its children one deeper.
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
    // A parser that silently matched nothing would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((r) => r.path.startsWith("/v1/") && isMutation(r)).length).toBeGreaterThan(
      30,
    );
    expect(routes.some((r) => r.path === "/v1/opportunities" && r.method === "POST")).toBe(true);
  });

  it("puts exactly one limiter between the resolver and the gate on every /v1 mutation", () => {
    // The limiter must sit BETWEEN the two: before it nothing has answered yet, and after it a
    // gate refuses a request that has already been counted. Exactly one, because every handler
    // from one plugin registration shares a marker and only the first of them runs.
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
    // The Better Auth surface keeps its own two ceilings (mail 10/min, session 120/min) and does
    // not run the principal resolver: it is where a credential is MINTED, so there is none yet.
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
});

/**
 * WHO a metered route counts, and WHETHER an unauthenticated caller is counted at all.
 *
 * The existing coverage (`better-auth-mount.test.ts`) asserts that the two auth routes advertise
 * DIFFERENT ceilings. Nothing asserted what a bucket is keyed on, and the answer used to be wrong
 * in both directions:
 *
 *   · every credentialed route was keyed by ADDRESS, so one office egress was one budget for
 *     everybody behind it, and a second address was a free reset;
 *   · a request whose credential was refused was never counted at ALL, because the gate answered
 *     401 during `onRequest` and answering ends that hook chain before the limiter appended after
 *     it could run. Hammering `POST /v1/opportunities` with a junk Bearer cost nothing.
 *
 * The four cases below pin the fix from the outside: per-credential keys, address as the fallback,
 * a real 429 for the anonymous hammer, and the public read still uncapped. `remoteAddress` is what
 * makes the address half testable — `config.trustProxy` is unset here, so `request.ip` is the
 * socket address `inject` was given.
 *
 * TWO ROUTES, DELIBERATELY. `DELETE /v1/keys/:id` carries the smallest useful ceiling and a
 * nonexistent id has no side effect, so the key-identity cases can read
 * `x-ratelimit-remaining` after a handful of calls instead of exhausting anything.
 * `POST /v1/opportunities` is the route the threat model actually cares about, so the exhaustion
 * case is run there for real.
 *
 * Isolation tag: `M4RATE` / `m4rate-*@rfphub.invalid`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { bearer, seedIdentity, testAuth } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAILS = {
  first: "m4rate-first@rfphub.invalid",
  second: "m4rate-second@rfphub.invalid",
};
const FIRST_HANDLE = "m4rate-first";
const SECOND_HANDLE = "m4rate-second";

/** Two addresses that are unmistakably distinct, and neither of them the inject default. */
const IP_A = "198.51.100.11";
const IP_B = "203.0.113.22";

/** A key id no account owns: the route answers 404 having changed nothing, and still counts. */
const ABSENT_KEY_ID = "999999999";
/** `DELETE /v1/keys/:id` — see `modules/routes/keys/index.ts`. */
const KEYS_MAX = 30;
/** `POST /v1/opportunities` — see `modules/routes/submissions/index.ts`. */
const SUBMIT_MAX = 60;

const run = describeWithDb;

run("M4RATE rate-limit keys", () => {
  let app: FastifyInstance;
  let firstToken: string;
  let secondToken: string;
  const userIds: string[] = [];

  /** One metered, side-effect-free call. Returns the status and what the limiter said was left. */
  async function meteredDelete(token: string, ip: string) {
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${ABSENT_KEY_ID}`,
      headers: bearer(token),
      remoteAddress: ip,
    });
    return { status: res.statusCode, remaining: Number(res.headers["x-ratelimit-remaining"]) };
  }

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const first = await seedIdentity(EMAILS.first, { handle: FIRST_HANDLE });
    const second = await seedIdentity(EMAILS.second, { handle: SECOND_HANDLE });
    userIds.push(first.userId, second.userId);
    firstToken = first.token;
    secondToken = second.token;
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      userIds,
      handles: [FIRST_HANDLE, SECOND_HANDLE],
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  }, 60_000);

  it("gives two accounts on ONE address two separate budgets", async () => {
    // The case that keying by address gets wrong: a shared egress — an office, a CI runner, a
    // university — would have made these two people one budget, and the second person's 429 would
    // have been caused entirely by the first person's traffic.
    const one = await meteredDelete(firstToken, IP_A);
    const two = await meteredDelete(firstToken, IP_A);
    const other = await meteredDelete(secondToken, IP_A);

    // The route ran to completion each time: the limiter counts a request the handler then 404s.
    expect([one.status, two.status, other.status]).toEqual([404, 404, 404]);

    expect(one.remaining).toBe(KEYS_MAX - 1);
    expect(two.remaining).toBe(KEYS_MAX - 2);
    // Same address, different credential — a budget of its own, untouched by the two above.
    expect(other.remaining).toBe(KEYS_MAX - 1);
  }, 60_000);

  it("gives ONE account on two addresses a single budget", async () => {
    // The other half of the same decision. An account is not entitled to a fresh budget by moving
    // — a laptop, a CI job and a phone are one caller, and a limit a second address resets is not
    // a limit. This continues the first account's window from the case above.
    const moved = await meteredDelete(firstToken, IP_B);
    expect(moved.status).toBe(404);
    expect(moved.remaining).toBe(KEYS_MAX - 3);
  }, 60_000);

  it("counts — and eventually refuses — an anonymous hammer with a junk Bearer", async () => {
    // THE GAP THIS SUITE EXISTS FOR. Before the split, every one of these was a 401 forever: the
    // gate answered inside `onRequest` and the limiter that came after it never ran.
    //
    // The designed sequence is explicit: the credential is refused every time, so the caller sees
    // 401 for the whole budget and 429 the moment it is spent. The 429 REPLACES the 401 rather
    // than following it — once the limiter answers, the gate behind it never runs — which is the
    // right way round: a caller over its ceiling learns it is over its ceiling.
    const junk = bearer("m4rate-not-a-real-credential");
    const statuses: number[] = [];
    for (let i = 0; i < SUBMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/opportunities",
        headers: junk,
        remoteAddress: IP_A,
      });
      statuses.push(res.statusCode);
    }
    expect(new Set(statuses)).toEqual(new Set([401]));

    const exceeded = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: junk,
      remoteAddress: IP_A,
    });
    expect(exceeded.statusCode).toBe(429);
    // Case (e): a 429 without this is a wall with no clock on it. `@fastify/rate-limit` emits it
    // in seconds, which is what an agent's backoff reads.
    expect(Number(exceeded.headers["retry-after"])).toBeGreaterThan(0);

    // Keyed by ADDRESS, not globally: the same junk credential from somewhere else is still on its
    // first request. Without this the case above would also pass on a single shared bucket, which
    // is a denial-of-service on every anonymous caller at once.
    const elsewhere = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: junk,
      remoteAddress: IP_B,
    });
    expect(elsewhere.statusCode).toBe(401);

    // And the address the hammer spent is NOT the address a signed-in account is charged to: the
    // same route, the same exhausted address, a real credential — a bucket of its own.
    const credentialed = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: { ...bearer(secondToken), "content-type": "application/json" },
      payload: JSON.stringify({}),
      remoteAddress: IP_A,
    });
    expect(credentialed.statusCode).not.toBe(429);
  }, 120_000);

  it("leaves the public read uncapped, which is the point of `global: false`", async () => {
    // The list, the feeds and the export are the traffic this project exists to serve, and they are
    // measured per address — which behind a shared egress is one number for a whole organization.
    // No limiter is attached to them at all, and the absence of the headers is how that is visible
    // from outside: a capped route always advertises its ceiling.
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/opportunities?limit=1",
        remoteAddress: IP_A,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(res.headers["retry-after"]).toBeUndefined();
    }
  }, 60_000);
});

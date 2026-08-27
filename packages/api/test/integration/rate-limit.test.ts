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
import type { Auth } from "../../src/auth/better-auth.js";
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
/** A third, for the outage case, so it starts on an untouched budget. */
const IP_C = "198.51.100.33";
/** Three IPv6 hosts: the first two are one customer's, the third is somebody else's. */
const IPV6_HOST = "2001:db8:5:5::1";
const IPV6_SAME_64 = "2001:db8:5:5:ffff:ffff:ffff:ffff";
const IPV6_OTHER_64 = "2001:db8:5:6::1";

/**
 * Synthetic bearers. Neither is a credential of any kind — what matters is which PATH each takes:
 * the `rfph_` marker routes to the API-key verifier (a plain 401 refusal), anything else routes to
 * the session verifier, which is the one the outage case breaks.
 */
const JUNK_KEY = "rfph_aaaaaaaa_this-is-not-a-real-secret";
const JUNK_SESSION = "m4rate-not-a-real-credential";

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
    const junk = bearer(JUNK_SESSION);
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

  it("meters an IPv6 caller by /64, not by the address they picked this second", async () => {
    // The bucket an attacker would otherwise never share with themselves. A residential or cloud
    // IPv6 customer is assigned a /64 and may use any of its 2^64 addresses, so a key on the full
    // address is a free reset on every request — the limit would be no limit at all for exactly
    // the caller best equipped to abuse it. `@fastify/rate-limit`'s default generator groups by
    // /64 for this reason; supplying a `keyGenerator` replaces that generator, so the grouping has
    // to be carried across with it.
    const junk = bearer(JUNK_SESSION);
    const spend = async (ip: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/opportunities",
        headers: junk,
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(401);
      return Number(res.headers["x-ratelimit-remaining"]);
    };

    expect(await spend(IPV6_HOST)).toBe(SUBMIT_MAX - 1);
    // Same allocation, every host bit different: the same caller, and the same budget.
    expect(await spend(IPV6_SAME_64)).toBe(SUBMIT_MAX - 2);
    // A different /64 is a different customer, and must NOT inherit the two above.
    expect(await spend(IPV6_OTHER_64)).toBe(SUBMIT_MAX - 1);
  }, 60_000);

  it("never meters — or masks — a failure to CHECK the credential", async () => {
    // `SessionService.verify` answers 503 `auth_unavailable` when the lookup could not be performed,
    // deliberately, so an outage does not appear as every signed-in user's session being invalid.
    // Metering that would undo the distinction one layer up: the outage would spend the address's
    // budget and then be served as 429 — the operator's 503 signal replaced by one that reads as
    // the caller's own fault. So the resolver answers a 5xx BEFORE the limiter, uncounted.
    const broken = await buildApp({ auth: { auth: brokenSessionAuth(await testAuth()) } });
    await broken.ready();
    try {
      const call = (token: string) =>
        broken.inject({
          method: "DELETE",
          url: `/v1/keys/${ABSENT_KEY_ID}`,
          headers: bearer(token),
          remoteAddress: IP_C,
        });

      const outage = await call(JUNK_SESSION);
      expect(outage.statusCode).toBe(503);
      expect(outage.json()).toMatchObject({ error: "auth_unavailable" });
      // The limiter never ran, so it never wrote its headers — the visible form of "not counted".
      expect(outage.headers["x-ratelimit-remaining"]).toBeUndefined();

      // And the budget really is untouched: the next real refusal is the FIRST charge, not the
      // second. This is the assertion an `allowList` or a post-hoc refund could not satisfy.
      const first = await call(JUNK_KEY);
      expect(first.statusCode).toBe(401);
      expect(Number(first.headers["x-ratelimit-remaining"])).toBe(KEYS_MAX - 1);

      // Spend the rest of the address's budget on genuine refusals, then confirm it is spent.
      for (let i = 1; i < KEYS_MAX; i++) expect((await call(JUNK_KEY)).statusCode).toBe(401);
      expect((await call(JUNK_KEY)).statusCode).toBe(429);

      // The case the split exists for: with the bucket exhausted, an outage is STILL a 503. A 429
      // here would tell an operator watching for auth failures that a database outage was a caller
      // exceeding its quota.
      const stillOutage = await call(JUNK_SESSION);
      expect(stillOutage.statusCode).toBe(503);
      expect(stillOutage.json()).toMatchObject({ error: "auth_unavailable" });
    } finally {
      await broken.close();
    }
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

/**
 * The same auth instance with ONE thing broken: the session lookup throws, exactly as it would if
 * the database behind it stopped answering. A proxy rather than a stub because everything else —
 * the mount, the cookie name, the context — has to keep working, or the case would be testing a
 * half-built app instead of an outage.
 */
function brokenSessionAuth(real: Auth): Auth {
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== "api") return value;
      return new Proxy(value as object, {
        get(api, method) {
          if (method !== "getSession") return Reflect.get(api, method);
          return async () => {
            throw new Error("m4rate: simulated session-store outage");
          };
        },
      });
    },
  }) as Auth;
}

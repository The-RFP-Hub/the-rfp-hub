/**
 * WHO a metered route counts, and whether an unauthenticated caller is counted at all.
 *
 * `config.trustProxy` is unset here, so `remoteAddress` is `request.ip` and the address half is
 * testable. Isolation tag: `M4RATE` / `m4rate-*@rfphub.invalid`.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Auth } from "../../src/auth/better-auth.js";
import { type DB, db, pool } from "../../src/db/client.js";
import { apiKeys } from "../../src/db/schema.js";
import { RATE_LIMIT_HEADERS } from "../../src/modules/routes/shared/rate-limit-key.js";
import { analyticsEvents } from "../../src/modules/services/insights/event-buffer.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { bearer, mintApiKeyFor, seedIdentity, testAuth, testAuthConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAILS = {
  first: "m4rate-first@rfphub.invalid",
  second: "m4rate-second@rfphub.invalid",
  third: "m4rate-third@rfphub.invalid",
  cors: "m4rate-cors@rfphub.invalid",
};
const HANDLES = ["m4rate-first", "m4rate-second", "m4rate-third"];
const [FIRST_HANDLE, SECOND_HANDLE, THIRD_HANDLE] = HANDLES;

const IP_A = "198.51.100.11";
const IP_B = "203.0.113.22";
const IP_C = "198.51.100.33";
const IP_D = "198.51.100.44";
const IP_E = "198.51.100.55";
const IP_F = "198.51.100.66";

const BROWSER_ORIGIN = "https://dashboard.example";
/** The one origin the auth mount's exact allowlist admits — see `test/helpers/auth.ts`. */
const AUTH_ORIGIN = "http://127.0.0.1:3005";

const exposedHeadersOf = (headers: Record<string, unknown>): string[] =>
  String(headers["access-control-expose-headers"] ?? "").split(", ");
/** The first two are one customer's /64, the third is somebody else's. */
const IPV6_HOST = "2001:db8:5:5::1";
const IPV6_SAME_64 = "2001:db8:5:5:ffff:ffff:ffff:ffff";
const IPV6_OTHER_64 = "2001:db8:5:6::1";

/** `rfph_` routes to the key verifier, anything else to the session one. Neither is real. */
const JUNK_KEY = "rfph_aaaaaaaa_this-is-not-a-real-secret";
const JUNK_SESSION = "m4rate-not-a-real-credential";

const ABSENT_KEY_ID = "999999999";
const KEYS_MAX = 30;
const SUBMIT_MAX = 60;
const REDIRECT_MAX = 120;

const NS = "m4rate";
const REDIRECT_ID = `${NS}:link`;

const run = describeWithDb;

run("M4RATE rate-limit keys", () => {
  let app: FastifyInstance;
  let firstToken: string;
  let secondToken: string;
  let thirdToken: string;
  let thirdKeyA: string;
  let thirdKeyB: string;
  let thirdAccountId: number;
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
    const third = await seedIdentity(EMAILS.third, { handle: THIRD_HANDLE });
    userIds.push(first.userId, second.userId, third.userId);
    firstToken = first.token;
    secondToken = second.token;
    thirdToken = third.token;
    thirdAccountId = third.account.id;
    thirdKeyA = await mintApiKeyFor(thirdAccountId);
    thirdKeyB = await mintApiKeyFor(thirdAccountId);

    await new OpportunityService().upsertFromStandard(
      {
        specVersion: "1.0.0",
        id: REDIRECT_ID,
        fundingType: "grant",
        title: "Rate-limit redirect fixture",
        description: "A fixture with both link-out columns filled.",
        status: "open",
        operatingOrganizations: [{ name: "Rate Limit Org", slug: NS }],
        source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M4RATE"],
        applicationUrl: "https://apply.example.org/m4rate",
        website: "https://programme.example.org/m4rate",
        fundingDetails: { fundingType: "grant" },
        // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture, not a mapper output
      } as any,
      { reviewStatus: "approved", isListed: true, sourceSystem: NS },
    );
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      userIds,
      handles: HANDLES.filter((handle): handle is string => handle !== undefined),
      emails: Object.values(EMAILS),
      opportunityPrefix: `${NS}:`,
      organizationSlugs: [NS],
    });
    await app.close();
    await pool.end();
  }, 60_000);

  it("gives two accounts on ONE address two separate budgets", async () => {
    const one = await meteredDelete(firstToken, IP_A);
    const two = await meteredDelete(firstToken, IP_A);
    const other = await meteredDelete(secondToken, IP_A);

    expect([one.status, two.status, other.status]).toEqual([404, 404, 404]);

    expect(one.remaining).toBe(KEYS_MAX - 1);
    expect(two.remaining).toBe(KEYS_MAX - 2);
    expect(other.remaining).toBe(KEYS_MAX - 1);
  }, 60_000);

  it("gives ONE account on two addresses a single budget", async () => {
    const moved = await meteredDelete(firstToken, IP_B);
    expect(moved.status).toBe(404);
    expect(moved.remaining).toBe(KEYS_MAX - 3);
  }, 60_000);

  it("counts — and eventually refuses — an anonymous hammer with a junk Bearer", async () => {
    // The 429 REPLACES the 401: once the limiter answers, the gate behind it never runs.
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
    expect(Number(exceeded.headers["retry-after"])).toBeGreaterThan(0);

    // Keyed by ADDRESS, not globally — one shared bucket is a denial of service on every
    // anonymous caller at once, and would also pass the assertion above.
    const elsewhere = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: junk,
      remoteAddress: IP_B,
    });
    expect(elsewhere.statusCode).toBe(401);

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
    // An IPv6 customer holds a whole /64: a key on the full address is a free reset per request.
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
    expect(await spend(IPV6_SAME_64)).toBe(SUBMIT_MAX - 2);
    expect(await spend(IPV6_OTHER_64)).toBe(SUBMIT_MAX - 1);
  }, 60_000);

  it("charges every credential of ONE account to the same bucket", async () => {
    const keyA = await meteredDelete(thirdKeyA, IP_A);
    const keyB = await meteredDelete(thirdKeyB, IP_A);
    const session = await meteredDelete(thirdToken, IP_A);

    // Session-only, so a key is refused AFTER the limiter counted it — the ordering asserted here.
    expect([keyA.status, keyB.status, session.status]).toEqual([403, 403, 404]);

    expect(keyA.remaining).toBe(KEYS_MAX - 1);
    expect(keyB.remaining).toBe(KEYS_MAX - 2);
    expect(session.remaining).toBe(KEYS_MAX - 3);
  }, 60_000);

  it("moves a credential revoked mid-window onto the address bucket", async () => {
    // A credential that can no longer be PROVEN is not the account, and must neither spend nor
    // inherit its budget.
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.accountId, thirdAccountId));

    const revoked = await meteredDelete(thirdKeyA, IP_F);
    expect(revoked.status).toBe(401);
    expect(revoked.remaining).toBe(KEYS_MAX - 1);

    const stillTheAccount = await meteredDelete(thirdToken, IP_F);
    expect(stillTheAccount.status).toBe(404);
    expect(stillTheAccount.remaining).toBe(KEYS_MAX - 4);
  }, 60_000);

  it("never meters — or masks — a failure to CHECK the credential", async () => {
    // A 503 `auth_unavailable` is ours: metering it would spend the caller's budget on our outage
    // and then serve it as 429.
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
      // The limiter never ran, so it wrote no headers — the visible form of "not counted".
      expect(outage.headers["x-ratelimit-remaining"]).toBeUndefined();

      // The budget really is untouched: the next real refusal is the FIRST charge, not the second.
      const first = await call(JUNK_KEY);
      expect(first.statusCode).toBe(401);
      expect(Number(first.headers["x-ratelimit-remaining"])).toBe(KEYS_MAX - 1);

      for (let i = 1; i < KEYS_MAX; i++) expect((await call(JUNK_KEY)).statusCode).toBe(401);
      expect((await call(JUNK_KEY)).statusCode).toBe(429);

      const stillOutage = await call(JUNK_SESSION);
      expect(stillOutage.statusCode).toBe(503);
      expect(stillOutage.json()).toMatchObject({ error: "auth_unavailable" });
    } finally {
      await broken.close();
    }
  }, 120_000);

  it("never meters — or masks — a failure to CHECK an API KEY either", async () => {
    // A key is verified by a query, so a broken database is the same distinction as a broken
    // session lookup. One decision, two arms, and they must not drift apart.
    const broken = await buildApp({
      auth: { auth: await testAuth(), db: brokenKeyLookupDb() },
    });
    await broken.ready();
    try {
      const call = (headers: Record<string, string>) =>
        broken.inject({
          method: "DELETE",
          url: `/v1/keys/${ABSENT_KEY_ID}`,
          headers,
          remoteAddress: IP_D,
        });

      const outage = await call(bearer(JUNK_KEY));
      expect(outage.statusCode).toBe(500);
      expect(outage.json()).toMatchObject({ error: "internal_error" });
      expect(outage.headers["x-ratelimit-remaining"]).toBeUndefined();

      // No credential needs no lookup, so this is refused for real — and its being the FIRST
      // charge is what proves the outage above cost nothing.
      const first = await call({});
      expect(first.statusCode).toBe(401);
      expect(Number(first.headers["x-ratelimit-remaining"])).toBe(KEYS_MAX - 1);

      for (let i = 1; i < KEYS_MAX; i++) expect((await call({})).statusCode).toBe(401);
      expect((await call({})).statusCode).toBe(429);

      const stillOutage = await call(bearer(JUNK_KEY));
      expect(stillOutage.statusCode).toBe(500);
      expect(stillOutage.json()).toMatchObject({ error: "internal_error" });
    } finally {
      await broken.close();
    }
  }, 120_000);

  it("lets a BROWSER read the limit and the backoff, on both CORS policies", async () => {
    const junk = bearer(JUNK_SESSION);
    const cors = { ...junk, origin: BROWSER_ORIGIN };

    const below = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: cors,
      remoteAddress: IP_E,
    });
    expect(below.statusCode).toBe(401);
    expect(below.headers["access-control-allow-origin"]).toBe("*");
    expect(exposedHeadersOf(below.headers)).toEqual(expect.arrayContaining(RATE_LIMIT_HEADERS));
    expect(Number(below.headers["x-ratelimit-remaining"])).toBe(SUBMIT_MAX - 1);

    for (let i = 1; i < SUBMIT_MAX; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/opportunities",
        headers: cors,
        remoteAddress: IP_E,
      });
    }
    const exceeded = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: cors,
      remoteAddress: IP_E,
    });
    expect(exceeded.statusCode).toBe(429);
    expect(exposedHeadersOf(exceeded.headers)).toEqual(expect.arrayContaining(RATE_LIMIT_HEADERS));
  }, 120_000);

  it("does the same on the auth mount, which is the OTHER CORS policy", async () => {
    // A second policy is where a header list gets added once and forgotten.
    const mounted = await buildApp({
      auth: { auth: await testAuth(), config: testAuthConfig() },
    });
    await mounted.ready();
    try {
      const send = () =>
        mounted.inject({
          method: "POST",
          url: "/api/auth/email-otp/send-verification-otp",
          headers: { origin: AUTH_ORIGIN, "content-type": "application/json" },
          payload: JSON.stringify({ email: EMAILS.cors, type: "sign-in" }),
          remoteAddress: IP_E,
        });

      const below = await send();
      expect(below.headers["access-control-allow-origin"]).toBe(AUTH_ORIGIN);
      expect(exposedHeadersOf(below.headers)).toEqual(expect.arrayContaining(RATE_LIMIT_HEADERS));
      const mailMax = Number(below.headers["x-ratelimit-limit"]);
      expect(mailMax).toBeGreaterThan(0);

      for (let i = 1; i < mailMax; i++) await send();
      const exceeded = await send();
      expect(exceeded.statusCode).toBe(429);
      expect(exposedHeadersOf(exceeded.headers)).toEqual(
        expect.arrayContaining(RATE_LIMIT_HEADERS),
      );
    } finally {
      await mounted.close();
    }
  }, 120_000);

  it("emits `Retry-After` as a positive whole number of seconds", async () => {
    const junk = bearer(JUNK_SESSION);
    const exceeded = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: junk,
      remoteAddress: IP_A,
    });
    expect(exceeded.statusCode).toBe(429);
    const retryAfter = exceeded.headers["retry-after"];
    expect(String(retryAfter)).toMatch(/^[1-9][0-9]*$/);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  }, 60_000);

  it("does not meter an OPTIONS preflight", async () => {
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/v1/opportunities",
        headers: {
          origin: BROWSER_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
        remoteAddress: IP_E,
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(res.headers["retry-after"]).toBeUndefined();
    }
  }, 60_000);

  it("meters a HEAD on a redirect, and records no click for it", async () => {
    // HEAD is served off the GET route, so the click-counting handler ran and only the body was
    // dropped. The automatic HEAD is its OWN route, so it is bounded on a bucket of its own.
    const reader = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) TestReader/1.0" };
    // Every `buildApp` close shuts this module singleton, and the outage cases above closed two.
    analyticsEvents.reopen();
    for (const kind of ["apply", "source"] as const) {
      await analyticsEvents.flush();
      const before = analyticsEvents.depth;

      const head = await app.inject({
        method: "HEAD",
        url: `/v1/r/${REDIRECT_ID}/${kind}`,
        headers: reader,
        remoteAddress: IP_F,
      });
      expect(head.statusCode, kind).toBe(302);
      expect(analyticsEvents.depth, kind).toBe(before);
      expect(Number(head.headers["x-ratelimit-limit"]), kind).toBe(REDIRECT_MAX);

      const get = await app.inject({
        method: "GET",
        url: `/v1/r/${REDIRECT_ID}/${kind}`,
        headers: reader,
        remoteAddress: IP_F,
      });
      expect(get.statusCode, kind).toBe(302);
      expect(analyticsEvents.depth, kind).toBe(before + 1);
      expect(Number(get.headers["x-ratelimit-remaining"]), kind).toBe(REDIRECT_MAX - 1);
    }
  }, 60_000);

  it("leaves the public read uncapped, which is the point of `global: false`", async () => {
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
 * The same auth instance with ONE thing broken: the session lookup throws. A proxy rather than a
 * stub because everything else has to keep working, or the case tests a half-built app.
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

/** The same database with the read that verifies a key broken, and nothing else changed. */
function brokenKeyLookupDb(): DB {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "select") return Reflect.get(target, property, receiver);
      return () => {
        throw new Error("m4rate: simulated key-store outage");
      };
    },
  });
}

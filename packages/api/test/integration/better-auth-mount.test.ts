/**
 * The HTTP mount around the session authority — the walls, not the library.
 *
 * Everything here is a property of how this API exposes somebody else's routes: that the body
 * reaches them byte-exact, that the browser can read the one header it needs and no more, that the
 * origin allowlist is exact, and that none of it leaks into the published contract. The library's
 * own behaviour is its business; these are the decisions this repo made around it.
 *
 * Isolation tag: `M3MOUNT` / `m3mount-*@rfphub.invalid`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/better-auth.js";
import { db, pool } from "../../src/db/client.js";
import { testAuth, testAuthConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const ALLOWED = "http://127.0.0.1:3005";
const EMAIL = "m3mount-body@rfphub.invalid";

const run = describeWithDb;

run("M3MOUNT the auth mount", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth(), config: testAuthConfig() } });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({ emails: [EMAIL] });
    await app.close();
    await pool.end();
  }, 60_000);

  it("hands the auth routes a body they can actually read", async () => {
    // The fidelity test that matters: the official integration guide re-serialises the parsed body
    // with `JSON.stringify`, which changes the bytes. If that were happening here, this request
    // would still probably work — which is exactly why the assertion is that a REAL request with a
    // body succeeds end to end rather than that some string round-trips.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: EMAIL, type: "sign-in" }),
    });
    expect(res.statusCode, res.body).toBe(200);
  }, 60_000);

  it("refuses a malformed body without a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      headers: { "content-type": "application/json" },
      payload: "{not json at all",
    });
    // Whatever the library answers, it must be a client error: a parser that threw before the
    // handler saw the bytes would surface as our own 500.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("allows exactly the configured origin, and exposes only the session header", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/sign-in/email-otp",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBe(ALLOWED);
    // Credentials are ALLOWED here, and only here — the OAuth state cookie must be storable from
    // the trusted origin's sign-in fetch, or every Google callback dies on `state_mismatch` (the
    // browser discards the Set-Cookie in `omit` mode). The safety envelope is the pairing this
    // test pins: the answer names exactly one origin (never `*`, which the spec forbids with
    // credentials anyway) and exposes exactly one header. `/v1` keeps its own wide,
    // credential-free policy, asserted elsewhere.
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");

    const actual = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email-otp",
      headers: { origin: ALLOWED, "content-type": "application/json" },
      payload: JSON.stringify({ email: EMAIL, otp: "000000" }),
    });
    expect(actual.headers["access-control-expose-headers"]).toBe("set-auth-token");
  }, 60_000);

  it("does NOT answer a disallowed origin, however plausible", async () => {
    for (const origin of [
      "https://evil.example",
      // The near-misses an unanchored or wildcard rule would let through.
      "http://127.0.0.1:3006",
      "https://the-rfp-hub-dashboard.vercel.app",
      `${ALLOWED}.evil.example`,
    ]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/auth/sign-in/email-otp",
        headers: { origin, "access-control-request-method": "POST" },
      });
      // No ACAO header at all — the browser is the enforcement point, and this is what it needs to
      // see (an echoed origin, or a `*`, would both be failures).
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("keeps `/v1` on the wide policy, which is a different decision from the one above", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/opportunities",
      headers: { origin: "https://anywhere.example" },
    });
    // Every `/v1` credential is header-borne, so a cross-site read carries no ambient authority.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-expose-headers"]).toBeUndefined();
  });

  it("publishes none of it — `/api/auth` is not part of the versioned contract", async () => {
    const doc = (await app.inject({ method: "GET", url: "/v1/docs/json" })).json();
    const paths = Object.keys(doc.paths);
    expect(paths.filter((p: string) => p.startsWith("/api/auth"))).toEqual([]);
    // And nothing that merely mentions it either — a hidden route that leaked a schema component
    // would show up here.
    expect(JSON.stringify(doc)).not.toContain("/api/auth");
  });

  it("refuses to promise a code it cannot deliver", async () => {
    // THE LOCKED DOOR THAT ANSWERS YES. With no delivery configured the library still answers 200 —
    // it does not await the send, deliberately, so a discarding transport cannot make itself heard
    // from inside — and the caller waits forever for a code that was never going to arrive. The
    // refusal has to happen at the mount, before delegating, and it has to be honest about whose
    // fault it is: 503, nothing wrong with the request.
    const email = { ...testAuthConfig().email, transport: "null" as const };
    const config = { ...testAuthConfig(), email };
    const undeliverable = await buildApp({
      auth: { auth: createAuth({ db, config }), config },
    });
    await undeliverable.ready();

    try {
      const send = await undeliverable.inject({
        method: "POST",
        url: "/api/auth/email-otp/send-verification-otp",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: EMAIL, type: "sign-in" }),
      });
      expect(send.statusCode).toBe(503);
      expect(send.json()).toEqual({
        error: "auth_unconfigured",
        message: "email delivery is not configured, so no sign-in code can be sent.",
      });

      // …and the route that CONSUMES a code is untouched. Guarding it would change what a caller
      // learns from submitting one, which is an oracle where there was none: a code that was never
      // sent simply fails to verify, exactly as a wrong code does.
      const verify = await undeliverable.inject({
        method: "POST",
        url: "/api/auth/sign-in/email-otp",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: EMAIL, otp: "000000" }),
      });
      expect(verify.statusCode).toBe(400);
      expect(verify.json().code).toBeDefined();
    } finally {
      await undeliverable.close();
    }
  }, 60_000);

  it("still delivers on a transport that goes somewhere readable", async () => {
    // The other half of the guard: only `null` is refused. `file`, `stdout` and `memory` all put
    // the message somewhere a person or a test can read it, which is why they are usable seams.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: EMAIL, type: "sign-in" }),
    });
    expect(res.statusCode).toBe(200);
  }, 60_000);

  it("meters mail and session traffic in SEPARATE buckets", async () => {
    // One bucket for both was a real hazard rather than an untidiness: a dashboard restores its
    // session on every tab it is opened in, so a handful of tabs behind one NAT address would spend
    // the mail budget and start answering 429 to people who are simply signed in.
    //
    // The assertion is on the CEILING each route advertises, not on exhausting either — the latter
    // would make this suite a function of how many requests the cases above it made.
    const mail = await app.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: EMAIL, type: "sign-in" }),
    });
    const session = await app.inject({ method: "GET", url: "/api/auth/get-session" });

    const mailLimit = Number(mail.headers["x-ratelimit-limit"]);
    const sessionLimit = Number(session.headers["x-ratelimit-limit"]);
    expect(Number.isFinite(mailLimit)).toBe(true);
    expect(Number.isFinite(sessionLimit)).toBe(true);
    // Sending mail is expensive, abusable and rare; reading a session is routine and bursty.
    expect(sessionLimit).toBeGreaterThan(mailLimit);
  }, 60_000);
});

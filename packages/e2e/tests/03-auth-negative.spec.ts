/**
 * What the API refuses.
 *
 * THIS FILE USED TO BE THE CONSOLATION PRIZE. Identities came from a third-party tenant, so when the
 * tenant was unreachable — no acknowledgement, no credentials, a laptop on a train — this was the
 * one spec that still executed, and its header said so. Every other case in the suite reported
 * BLOCKED and the run proved nothing about authentication except that forgeries were refused.
 *
 * It is now simply a spec. Every case here runs on every run, along with everything else, because
 * signing in needs nothing but an address and a file the API wrote. What that buys is not
 * convenience but REACH: three of the cases below could not be written at all before. A session was
 * a self-contained assertion that stayed valid until it expired, so "sign out, then reuse the token"
 * had nothing to assert against; the code was a fixed tenant constant, so "get it wrong too many
 * times" could not be exercised without breaking the shared fixture. Sessions are rows now, and
 * codes are single-use, so revocation and attempt limits are observable facts.
 *
 * THE TWO PROPERTIES BEING PINNED, stated once so the individual cases stay short:
 *
 *   `requireSignature: true` — a bearer value is `<token>.<hmac>`, and the HMAC is verified against
 *   the server secret BEFORE any database access. A value with no `.` is refused outright rather
 *   than looked up. That ordering is what stops an unauthenticated caller from turning the session
 *   table into an oracle, and case 4 is there to keep it true.
 *
 *   One message for every refusal. A distinct message per failure mode tells a caller holding a bad
 *   credential WHICH of the six things is wrong with it, and therefore what to try next.
 */
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { seedApiKey, seedIdentity } from "../src/db-seed.js";
import { DESKTOP_UA, expect, test } from "../src/fixtures.js";
import { ApiClient } from "../src/http.js";
import { discardOtp, outboxFileFor, waitForOtp } from "../src/identity/outbox.js";
import { addressFor, identityFor, signOut } from "../src/identity/sessions.js";
import { register } from "../src/redact.js";

/** A fresh address per case, so no test can consume another's identity or code. */
const address = (stack: { runId: string }, label: string) =>
  addressFor(stack.runId, `neg-${label}-${Date.now()}`);

test.describe("a bad session token is refused, and always the same way", () => {
  test("every malformed, forged, expired or revoked credential is a 401 with one message", async ({
    stack,
    anonApi,
    db,
  }) => {
    const messages = new Set<string>();
    const refusals: Array<[string, string]> = [];

    // 1 — a random opaque string. No structure at all.
    refusals.push(["random opaque string", randomBytes(24).toString("base64url")]);

    // 4 — an UNSIGNED raw session token: the right shape for a row, but no `.` and so no HMAC.
    //     This is the one that pins `requireSignature: true`. It is built from a REAL session's
    //     value, so the only thing wrong with it is the missing signature.
    const victim = await identityFor(address(stack, "unsigned"));
    const rawValue = victim.token.split(".")[0] as string;
    refusals.push(["unsigned raw session token", rawValue]);

    // 2 — a valid token with one byte flipped in the HMAC half.
    const [value, mac] = victim.token.split(".") as [string, string];
    const flipped = `${mac.slice(0, -1)}${mac.slice(-1) === "A" ? "B" : "A"}`;
    refusals.push(["one byte flipped in the HMAC", `${value}.${flipped}`]);

    // 3 — the same session value, signed under a DIFFERENT secret. Structurally perfect; the only
    //     thing wrong is who signed it. This is the strongest form of the forgery case: it proves
    //     the server verifies against its own secret rather than merely checking a shape.
    const foreignMac = createHmac("sha256", randomBytes(32).toString("base64url"))
      .update(rawValue)
      .digest("base64url");
    refusals.push(["signed under a different secret", `${rawValue}.${foreignMac}`]);

    // 5 — an expired session row. Aged in the database because there is no route that expires one
    //     on demand, and waiting out a 90-day lifetime is not a test.
    const expiring = await identityFor(address(stack, "expired"));
    await db.query(
      "UPDATE auth_session SET expires_at = now() - interval '1 day' WHERE token = $1",
      [expiring.token.split(".")[0]],
    );
    refusals.push(["expired session row", expiring.token]);

    // 6 — a REVOKED session: signed out, then reused. The capability the previous provider could not
    //     give this suite at all, because its tokens were self-contained assertions that stayed
    //     valid until they expired no matter who wanted them stopped.
    const revoked = await identityFor(address(stack, "revoked"));
    const beforeSignOut = await anonApi.get("/v1/me", { auth: revoked.token });
    expect(beforeSignOut.status, "the session must work before it is revoked").toBe(200);
    await signOut(revoked.token);
    refusals.push(["revoked session, reused", revoked.token]);

    for (const [name, token] of refusals) {
      const response = await anonApi.get<{ error: string; message: string }>("/v1/me", {
        auth: token,
      });
      expect(response.status, `${name} must be 401`).toBe(401);
      expect(response.body.error, `${name} must be \`unauthorized\``).toBe("unauthorized");
      messages.add(response.body.message);
    }

    // 7 — and all six are indistinguishable from one another.
    expect(
      [...messages],
      "every refusal must carry the same message: a per-mode message tells a caller which of the six things is wrong with their credential",
    ).toHaveLength(1);
  });

  test("no credential at all, and an unknown key-shaped value, are also 401", async ({
    anonApi,
  }) => {
    const none = await anonApi.get<{ error: string }>("/v1/me");
    expect(none.status).toBe(401);
    expect(none.body.error).toBe("unauthorized");

    // 8 — an `rfph_`-shaped value that matches no key row. Still 401, and NOT a 404 or a different
    //     code that would confirm the shape was recognised.
    const unknownKey = await anonApi.get<{ error: string }>("/v1/me", {
      auth: "rfph_abcdefgh_0123456789abcdef0123456789abcdef",
    });
    expect(unknownKey.status).toBe(401);
  });
});

test.describe("the one-time code is single-use and attempt-limited", () => {
  test("reading a code preserves notification mail in the shared address outbox", async ({
    stack,
    anonApi,
  }) => {
    const email = address(stack, "notification-outbox");
    const path = outboxFileFor(stack.outboxDir, email);
    mkdirSync(stack.outboxDir, { recursive: true, mode: 0o700 });
    // Six digits on purpose: subject filtering, not merely the body regex, must keep this line from
    // being consumed as a sign-in code.
    appendFileSync(
      path,
      `${JSON.stringify({
        to: email,
        subject: "A possible duplicate was found",
        text: "Possible match 123456 is waiting for review.",
      })}\n`,
      { mode: 0o600 },
    );

    const requested = await anonApi.post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(requested.status).toBe(200);
    const otp = await waitForOtp(stack.outboxDir, email);
    expect(readFileSync(path, "utf8")).toContain("A possible duplicate was found");

    const signedIn = await anonApi.post("/api/auth/sign-in/email-otp", { email, otp });
    expect(signedIn.status).toBe(200);
  });

  test("a wrong code, tried past the allowance, invalidates the code entirely", async ({
    stack,
    anonApi,
  }) => {
    // 10 — `allowedAttempts` is 3 (`OTP_ALLOWED_ATTEMPTS` in the API's auth configuration). A code
    //      that survived unlimited guessing would be a six-digit password.
    const email = address(stack, "attempts");
    const requested = await anonApi.post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(requested.status).toBe(200);
    const real = await waitForOtp(stack.outboxDir, email);

    // Wrong every time, one more time than the allowance.
    const wrong = real === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 4; attempt++) {
      const guess = await anonApi.post("/api/auth/sign-in/email-otp", { email, otp: wrong });
      expect(guess.status, "a wrong code never signs anybody in").not.toBe(200);
    }

    // …and now the REAL code is dead too. This is the property that matters: the limit has to
    // invalidate the code, not merely rate-limit the guesser, or an attacker just waits.
    const withReal = await anonApi.post("/api/auth/sign-in/email-otp", { email, otp: real });
    expect(withReal.status, "the code must be invalidated by exhausting its attempts").not.toBe(
      200,
    );

    // A fresh code still works, so the address is not bricked.
    discardOtp(stack.outboxDir, email);
    const again = await anonApi.post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(again.status).toBe(200);
    const fresh = await waitForOtp(stack.outboxDir, email);
    const signedIn = await anonApi.post("/api/auth/sign-in/email-otp", { email, otp: fresh });
    expect(signedIn.status, "a new code signs in normally").toBe(200);
  });

  test("a code cannot be replayed once it has been used", async ({ stack, anonApi }) => {
    const email = address(stack, "replay");
    expect(
      (await anonApi.post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }))
        .status,
    ).toBe(200);
    const otp = await waitForOtp(stack.outboxDir, email);

    const first = await anonApi.post("/api/auth/sign-in/email-otp", { email, otp });
    expect(first.status).toBe(200);

    const replay = await anonApi.post("/api/auth/sign-in/email-otp", { email, otp });
    expect(replay.status, "a consumed code is spent").not.toBe(200);
  });
});

test.describe("the sign-in surface answers only its own origins", () => {
  test("a preflight from a disallowed origin gets no cross-origin permission", async ({
    stack,
    anonApi,
  }) => {
    // 11 — `/v1` is deliberately `origin:"*"` because every credential there is header-borne. The
    //      sign-in surface does NOT inherit that: it mints credentials and exposes `set-auth-token`,
    //      so `origin:"*"` would turn any page on the web into a readable login client. The
    //      allowlist is `TRUSTED_ORIGINS`, which this run sets to the frontend and the API.
    const evil = "https://evil.example";
    const preflight = await anonApi.request({
      method: "OPTIONS",
      path: "/api/auth/sign-in/email-otp",
      headers: {
        origin: evil,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(
      preflight.headers.get("access-control-allow-origin") ?? null,
      "a disallowed origin must not be granted access",
    ).not.toBe(evil);

    // The control: the frontend's own origin IS allowed, so the absence above is a decision rather
    // than CORS being switched off altogether.
    const allowed = await anonApi.request({
      method: "OPTIONS",
      path: "/api/auth/sign-in/email-otp",
      headers: {
        origin: stack.urls.frontend,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(
      allowed.headers.get("access-control-allow-origin"),
      "the frontend's own origin is allowed, so the refusal above is a policy and not an outage",
    ).toBe(stack.urls.frontend);
  });
});

test.describe("an API key cannot reach a session-only surface", () => {
  /**
   * The key is seeded directly. This criterion is about the CREDENTIAL KIND, not about identity, and
   * seeding lets it name the account's role — `admin`, deliberately — so the refusals below cannot
   * be explained away as a missing role.
   *
   * The FIRST assertion is a positive control: the key must work where a key is allowed. Without it
   * every refusal that follows could be a refusal of a malformed key.
   */
  test("a valid key is accepted where keys are allowed, and refused on every session-only route", async ({
    stack,
    db,
  }) => {
    const email = address(stack, "keyholder");
    const accountId = await seedIdentity(db, `e2e-key-${stack.runId}`, email, "admin");
    const seeded = await seedApiKey(db, accountId, ["read", "write", "publish"]);
    register(seeded.token, { label: "api-key", longLived: true });

    const keyClient = new ApiClient({
      baseUrl: stack.urls.api,
      token: seeded.token,
      userAgent: DESKTOP_UA,
    });

    const control = await keyClient.get<{ credentialKind: string; accountId: number }>("/v1/me");
    expect(control.status, "the seeded key must be a working credential").toBe(200);
    expect(control.body.credentialKind).toBe("api_key");
    expect(control.body.accountId).toBe(accountId);

    // The account holds the `admin` role. A role must never elevate a key: that is what stops a
    // leaked key from inheriting the reach of the person it belongs to.
    const sessionOnly: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ["GET /v1/keys", () => keyClient.get("/v1/keys")],
      ["POST /v1/keys", () => keyClient.post("/v1/keys", { name: "nope", scopes: ["read"] })],
      ["PATCH /v1/me", () => keyClient.patch("/v1/me", { displayName: "nope" })],
      ["GET /v1/review/opportunities", () => keyClient.get("/v1/review/opportunities")],
      [
        "POST /v1/admin/jobs/staleness/run",
        () => keyClient.post("/v1/admin/jobs/staleness/run", {}),
      ],
    ];

    for (const [name, call] of sessionOnly) {
      const response = await call();
      expect(response.status, `${name} must refuse an API key`).toBe(403);
      expect(response.body, `${name} must say why`).toMatchObject({ error: "session_required" });
    }
  });
});

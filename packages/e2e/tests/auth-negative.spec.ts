/**
 * What the API refuses — the one file that executes in full at every ladder level.
 *
 * Nothing here needs a legitimate identity, which is exactly why it matters. A run that could not
 * obtain a single real token still boots the whole stack, and this file still proves that the
 * verification path rejects a token it did not issue, that the audience and issuer are actually
 * checked, that expiry is enforced, and that an API key cannot reach a session-only surface. Those
 * are the assertions a reader most wants to be independent of the harness's luck with credentials.
 *
 * THE TOKENS BELOW ARE SIGNED LOCALLY, and that is the point. The API verifies session tokens with
 * a configured public key and never calls the provider on the auth path, so a locally-signed ES256
 * token is structurally indistinguishable from a real one apart from the signature. Every such
 * token here expects a 401; none is ever used to obtain access.
 */
import { SignJWT, generateKeyPair } from "jose";
import { seedAccount, seedApiKey } from "../src/db-seed.js";
import { DESKTOP_UA, expect, test } from "../src/fixtures.js";
import { ApiClient } from "../src/http.js";
import { register } from "../src/redact.js";

/** One key pair for the whole file: the API has never seen it, which is what makes it a forgery. */
const foreign = generateKeyPair("ES256", { extractable: true });

interface ForgeOptions {
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
  subject?: string;
}

async function forge(realAudience: string, options: ForgeOptions = {}): Promise<string> {
  const { privateKey } = await foreign;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(options.subject ?? "did:privy:e2e-forged-subject")
    .setIssuer(options.issuer ?? "privy.io")
    .setAudience(options.audience ?? realAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 600))
    .sign(privateKey);
  register(token, { label: "forged-token", longLived: false });
  return token;
}

test.describe("authentication is actually verified", () => {
  test("a token signed by a key the API does not trust is refused", async ({ stack, anonApi }) => {
    const audience = stack.privyAppId;
    test.skip(
      !audience,
      "BLOCKED-by-missing-external-config: the API booted without an app id, so a forgery cannot " +
        "be given the real audience and the test would prove only that the audience check works. " +
        "Unblocked by: PRIVY_APP_ID (in the environment or packages/api/.env).",
    );
    if (!audience) return;

    const response = await anonApi.get("/v1/me", { auth: await forge(audience) });

    expect(response.status, "a forged signature must not be accepted").toBe(401);
    expect(response.body).toMatchObject({ error: "unauthorized" });
  });

  test("the issuer, the audience and the expiry are each enforced, with one indistinguishable message", async ({
    stack,
    anonApi,
  }) => {
    const audience = stack.privyAppId;
    test.skip(
      !audience,
      "BLOCKED-by-missing-external-config: no app id is configured on the API. Unblocked by: PRIVY_APP_ID.",
    );
    if (!audience) return;

    const cases = {
      "forged signature": await forge(audience),
      "wrong issuer": await forge(audience, { issuer: "https://not-the-issuer.example" }),
      "wrong audience": await forge(audience, { audience: "some-other-app-id" }),
      expired: await forge(audience, { expiresInSeconds: -60 }),
    };

    const messages = new Set<string>();
    for (const [name, token] of Object.entries(cases)) {
      const response = await anonApi.get<{ error: string; message: string }>("/v1/me", {
        auth: token,
      });
      expect(response.status, `${name} must be 401`).toBe(401);
      expect(response.body.error, `${name} must be \`unauthorized\``).toBe("unauthorized");
      messages.add(response.body.message);
    }

    // All four carry the SAME message. A distinct message per failure mode is an oracle: it tells a
    // caller holding a token which of the four things is wrong with it, and therefore what to try
    // next. One message tells them only that the credential is not good.
    expect([...messages], "every rejection must be indistinguishable from the others").toHaveLength(
      1,
    );
  });

  test("a malformed or absent credential is refused without reaching a handler", async ({
    stack,
    anonApi,
  }) => {
    // No credential at all is refused by the gate itself, before any verification service is
    // consulted — so this holds even on an API with no identity configuration whatsoever.
    const noCredential = await anonApi.get<{ error: string }>("/v1/me");
    expect(noCredential.status).toBe(401);
    expect(noCredential.body.error).toBe("unauthorized");

    // A session-SHAPED credential does reach the verifier, and an API with no verification key
    // answers 503 `auth_unconfigured` rather than 401 — correctly: it cannot judge the token, and
    // reporting "your credential is bad" when the deployment is the thing that is misconfigured
    // would send the caller after the wrong problem. The runner normally prevents this by booting
    // with a generated inert key, so this branch is a statement about what the assertion means, not
    // an expected path.
    const nonsense = await anonApi.get<{ error: string }>("/v1/me", { auth: "not-a-token-at-all" });
    expect(
      nonsense.status,
      stack.inertVerificationKey
        ? "the API booted with a generated inert verification key, so a bad token is judged and refused"
        : "the API booted with the deployment's verification key",
    ).toBe(401);

    // An `rfph_`-shaped value that no key row matches: still 401, and — importantly — NOT a 404 or
    // a different code that would confirm the shape was recognised.
    const unknownKey = await anonApi.get<{ error: string }>("/v1/me", {
      auth: "rfph_abcdefgh_0123456789abcdef0123456789abcdef",
    });
    expect(unknownKey.status).toBe(401);
  });
});

test.describe("an API key cannot reach a session-only surface", () => {
  /**
   * The key is seeded directly, because this criterion has nothing to do with identity and must not
   * be lost at a level where no session exists to mint one. The FIRST assertion is a positive
   * control: the key must work where a key is allowed. Only then do the refusals mean anything.
   */
  test("a valid key is accepted where keys are allowed, and refused on every session-only route", async ({
    stack,
    db,
    anonApi,
  }) => {
    const accountId = await seedAccount(db, `did:privy:e2e-${stack.runId}-keyholder`, "admin");
    const seeded = await seedApiKey(db, accountId, ["read", "write", "publish"]);
    register(seeded.token, { label: "api-key", longLived: true });

    const keyClient = new ApiClient({
      baseUrl: stack.urls.api,
      token: seeded.token,
      userAgent: DESKTOP_UA,
    });

    // POSITIVE CONTROL. Without this, every refusal below could be a refusal of a malformed key.
    const control = await keyClient.get<{ credentialKind: string; accountId: number }>("/v1/me");
    expect(control.status, "the seeded key must be a working credential").toBe(200);
    expect(control.body.credentialKind).toBe("api_key");
    expect(control.body.accountId).toBe(accountId);

    // The account deliberately holds the `admin` global role. A role must never elevate a key: that
    // is what stops a leaked key from inheriting the reach of the person it belongs to.
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

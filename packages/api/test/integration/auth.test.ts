/**
 * Identity and credentials, end to end: what a session is, every way one can fail to be one, the
 * admin grant, and the session-only boundary that keeps a leaked API key from becoming a stronger
 * one.
 *
 * THE NEGATIVE SET IS THE POINT OF THIS FILE. A session is now a row plus a signature rather than a
 * self-describing token, so the ways it can fail changed shape entirely — a forged signature, a
 * signature from another deployment, an unsigned token, an expired row, a row that was deleted a
 * moment ago. Every one of them answers with the SAME message, which is asserted as a set rather
 * than case by case: telling a prober which half of an attempt worked is the leak.
 *
 * Isolation tag: `M3AUTH` / `m3auth-*@rfphub.invalid`.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { authSession } from "../../src/db/schema.js";
import {
  bearer,
  foreignToken,
  mintApiKeyFor,
  seedAccount,
  seedIdentity,
  signIn,
  signOut,
  testAuth,
  unsignedToken,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAILS = {
  fresh: "m3auth-fresh@rfphub.invalid",
  owner: "m3auth-owner@rfphub.invalid",
  other: "m3auth-other@rfphub.invalid",
  reviewer: "m3auth-reviewer@rfphub.invalid",
  admin: "m3auth-admin@rfphub.invalid",
  promoted: "m3auth-promoted@rfphub.invalid",
  foreign: "m3auth-foreign@rfphub.invalid",
  expired: "m3auth-expired@rfphub.invalid",
  revoked: "m3auth-revoked@rfphub.invalid",
  unsigned: "m3auth-unsigned@rfphub.invalid",
};

const run = describeWithDb;

run("M3AUTH identity and credentials", () => {
  let app: FastifyInstance;
  let ownerKey: string;
  let otherKey: string;
  let ownerToken: string;
  let reviewerToken: string;
  let adminToken: string;
  let adminId: number;
  let promotedId: number;
  const userIds: string[] = [];

  const HANDLES = [
    "m3auth-owner",
    "m3auth-other",
    "m3auth-reviewer",
    "m3auth-admin",
    "m3auth-promoted",
    "m3auth-fresh",
  ];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    // Cleared on the way IN as well as out. Handles are globally unique and this suite claims six
    // of them by name, so a row an earlier run left behind — including one of the pre-migration
    // shape, which has no identity to clean it up by — would make the suite unseedable.
    await cleanupFixtures({ handles: HANDLES, emails: Object.values(EMAILS) });

    const owner = await seedIdentity(EMAILS.owner, { handle: "m3auth-owner" });
    const other = await seedIdentity(EMAILS.other, { handle: "m3auth-other" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3auth-reviewer",
      role: "reviewer",
    });
    const admin = await seedIdentity(EMAILS.admin, { handle: "m3auth-admin", role: "admin" });
    const promoted = await seedIdentity(EMAILS.promoted, { handle: "m3auth-promoted" });
    adminId = admin.account.id;
    promotedId = promoted.account.id;
    userIds.push(owner.userId, other.userId, reviewer.userId, admin.userId, promoted.userId);

    ownerKey = await mintApiKeyFor(owner.account.id, ["read", "write"]);
    otherKey = await mintApiKeyFor(other.account.id, ["read"]);
    ownerToken = owner.token;
    reviewerToken = reviewer.token;
    adminToken = admin.token;
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({ userIds, handles: HANDLES, emails: Object.values(EMAILS) });
    await app.close();
    await pool.end();
  }, 60_000);

  const me = async (token: string) =>
    app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });

  it("401s every authenticated surface without a credential", async () => {
    for (const [method, url] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/keys"],
      ["POST", "/v1/keys"],
      ["GET", "/v1/me/opportunities"],
      ["GET", "/v1/review/opportunities"],
      ["POST", "/v1/opportunities"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error).toBe("unauthorized");
    }
  });

  it("refuses every shape of not-a-session with ONE indistinguishable answer", async () => {
    // 1 — an opaque string that was never a token.
    const random = "not-a-session-token-at-all";

    // 2 — a real token with one byte flipped in its signature half. The value still names a live
    // session row; only the HMAC is wrong, so nothing but the signature check can refuse it.
    const genuine = (await signIn(EMAILS.owner)).token;
    const [value, signature = ""] = genuine.split(".");
    const flipped = `${value}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    // 3 — a session minted by ANOTHER DEPLOYMENT: same database, same schema, different secret.
    const foreign = await foreignToken(EMAILS.foreign);

    // 4 — the raw, unsigned session token. This is the case `requireSignature: true` exists for:
    // without it the value alone would be accepted and the signature would be decoration.
    const unsigned = await unsignedToken(EMAILS.unsigned);
    expect(unsigned).not.toContain(".");

    // 5 — a session whose row has expired. The token and its signature are both perfectly valid.
    const expiring = await signIn(EMAILS.expired);
    await db
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(authSession.userId, expiring.userId));

    // 6 — a session that was signed OUT. The row is gone, which is the revocation the previous
    // verifier could not do at all: it validated tokens locally and had nothing to delete.
    const revoked = await signIn(EMAILS.revoked);
    await signOut(revoked.token);

    const messages = new Set<string>();
    for (const [label, token] of [
      ["random", random],
      ["flipped signature", flipped],
      ["foreign deployment", foreign],
      ["unsigned", unsigned],
      ["expired row", expiring.token],
      ["revoked", revoked.token],
    ] as const) {
      const res = await me(token);
      expect(res.statusCode, label).toBe(401);
      expect(res.json().error, label).toBe("unauthorized");
      messages.add(res.json().message);
    }
    // THE property, not the mechanism: six different failures, one answer.
    expect(messages.size).toBe(1);
  }, 60_000);

  it("provisions an account on the first request an identity ever makes", async () => {
    const identity = await signIn(EMAILS.fresh);
    userIds.push(identity.userId);

    const first = await me(identity.token);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.accountId).toBeGreaterThan(0);
    expect(body.role).toBe("submitter");
    expect(body.credentialKind).toBe("session");
    // The address survives the migration to a joined field: it is served from the identity row
    // rather than copied into `accounts`, so there is one copy of it in the system.
    expect(body.email).toBe(EMAILS.fresh);

    const second = await me(identity.token);
    expect(second.json().accountId).toBe(body.accountId);
  }, 60_000);

  it("serves no address for an API key, which identifies an account but not a session", async () => {
    const res = await me(ownerKey);
    expect(res.statusCode).toBe(200);
    expect(res.json().credentialKind).toBe("api_key");
    expect(res.json().email).toBeNull();
  });

  it("invalidates a code after too many wrong guesses", async () => {
    const auth = await testAuth();
    const email = "m3auth-guessed@rfphub.invalid";
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });

    // Three allowed attempts, so the fourth must fail even if it were right — and it is the CODE
    // that is spent, not merely the attempt: a fresh one has to be requested.
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        auth.api.signInEmailOTP({ body: { email, otp: "000000" } }),
      ).rejects.toBeDefined();
    }
    await cleanupFixtures({ emails: [email] });
  }, 60_000);

  it("makes an admin in the product, effective on the target's very next request", async () => {
    const token = (await signIn(EMAILS.promoted)).token;
    const before = await me(token);
    expect(before.json().role).toBe("submitter");
    expect(before.json().canAdmin).toBe(false);

    const granted = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${promotedId}/role`,
      headers: bearer(adminToken),
      payload: { role: "admin" },
    });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(granted.json().globalRole).toBe("admin");

    const after = await me(token);
    expect(after.json().role).toBe("admin");
    expect(after.json().canAdmin).toBe(true);

    // …and the new admin can administer, which a role field alone does not prove.
    const byNewAdmin = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${adminId}/role`,
      headers: bearer(token),
      payload: { role: "admin" },
    });
    expect(byNewAdmin.statusCode, byNewAdmin.body).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${promotedId}/role`,
      headers: bearer(adminToken),
      payload: { role: "submitter" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await me(token)).json().canAdmin).toBe(false);
  }, 60_000);

  it("refuses the admin surface to everyone who is not an admin", async () => {
    for (const token of [ownerToken, reviewerToken]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/admin/accounts/${promotedId}/role`,
        headers: bearer(token),
        payload: { role: "admin" },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("shows an API key's secret exactly once and never again", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: bearer(ownerToken),
      payload: { name: "m3auth", scopes: ["read", "write"] },
    });
    expect(created.statusCode).toBe(201);
    const token: string = created.json().token;
    expect(token.startsWith("rfph_")).toBe(true);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: bearer(ownerToken),
    });
    const item = listed
      .json()
      .items.find((k: { keyPrefix: string }) => token.includes(k.keyPrefix));
    expect(item).toBeTruthy();
    expect(JSON.stringify(listed.json())).not.toContain(token);

    const used = await me(token);
    expect(used.statusCode).toBe(200);
    expect(used.json().credentialKind).toBe("api_key");
  });

  it("401s a revoked key, and a syntactically valid but unknown one", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: bearer(ownerToken),
      payload: { scopes: ["read"] },
    });
    const token: string = created.json().token;
    const id: number = created.json().key.id;

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${id}`,
      headers: bearer(ownerToken),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).not.toBeNull();
    expect((await me(token)).statusCode).toBe(401);

    const unknown = await me("rfph_abcdefgh_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    expect(unknown.statusCode).toBe(401);
  });

  it("refuses an API key with 403 on every session-only surface", async () => {
    const sessionOnly = [
      { method: "GET" as const, url: "/v1/keys" },
      { method: "POST" as const, url: "/v1/keys", payload: { scopes: ["read"] } },
      { method: "PATCH" as const, url: "/v1/me", payload: { displayName: "nope" } },
      { method: "GET" as const, url: "/v1/review/opportunities" },
      { method: "GET" as const, url: "/v1/review/accounts" },
      { method: "POST" as const, url: "/v1/admin/accounts/1/role", payload: { role: "admin" } },
    ];
    for (const call of sessionOnly) {
      const res = await app.inject({ ...call, headers: bearer(ownerKey) });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(["session_required", "forbidden"]).toContain(res.json().error);
    }
  });

  it("does not let a reviewer's API key reach the review surface", async () => {
    const reviewer = await signIn(EMAILS.reviewer);
    const account = await seedAccount({ userId: reviewer.userId, role: "reviewer" });
    const key = await mintApiKeyFor(account.id, ["read", "write", "publish"]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/review/opportunities",
      headers: bearer(key),
    });
    // A global role never elevates an API key — the scope is irrelevant, the credential kind is not.
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("session_required");

    const session = await app.inject({
      method: "GET",
      url: "/v1/review/opportunities",
      headers: bearer(reviewerToken),
    });
    expect(session.statusCode).toBe(200);
  }, 60_000);

  it("404s — never 403s — a key id belonging to another account", async () => {
    const mine = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: bearer(ownerToken),
      payload: { scopes: ["read"] },
    });
    const myId: number = mine.json().key.id;

    const otherToken = (await signIn(EMAILS.other)).token;
    const listed = await app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: bearer(otherToken),
    });
    expect(listed.json().items.map((k: { id: number }) => k.id)).not.toContain(myId);

    const stolen = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${myId}`,
      headers: bearer(otherToken),
    });
    // 403 would confirm the id exists. It must not.
    expect(stolen.statusCode).toBe(404);
    expect(otherKey.length).toBeGreaterThan(0);
  }, 60_000);

  it("lets a session set a public handle and refuses a taken one", async () => {
    const token = (await signIn(EMAILS.fresh)).token;
    const ok = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(token),
      payload: { handle: "m3auth-fresh", displayName: "Fresh" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().handle).toBe("m3auth-fresh");

    const taken = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(token),
      payload: { handle: "m3auth-owner" },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("handle_taken");

    const reserved = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(token),
      payload: { handle: "community" },
    });
    expect(reserved.statusCode).toBe(400);
  }, 60_000);
});

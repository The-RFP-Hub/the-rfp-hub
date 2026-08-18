/**
 * Identity and credentials, end to end: token verification, just-in-time provisioning, the admin
 * grant, and the session-only boundary that keeps a leaked API key from becoming a stronger one.
 *
 * Isolation tag: `M3AUTH` / `m3auth:`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import {
  type SeedAccountInput,
  bearer,
  mintApiKeyFor,
  mintForeignToken,
  mintPrivyToken,
  seedAccount,
  testPrivyConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const DIDS = {
  fresh: "did:privy:m3auth-fresh",
  owner: "did:privy:m3auth-owner",
  other: "did:privy:m3auth-other",
  admin: "did:privy:m3auth-admin",
  promoted: "did:privy:m3auth-promoted",
  reviewer: "did:privy:m3auth-reviewer",
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

  const account = async (input: SeedAccountInput) => seedAccount(input);

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const owner = await account({ did: DIDS.owner, handle: "m3auth-owner" });
    const other = await account({ did: DIDS.other, handle: "m3auth-other" });
    await account({ did: DIDS.reviewer, handle: "m3auth-reviewer", role: "reviewer" });
    const admin = await account({ did: DIDS.admin, handle: "m3auth-admin", role: "admin" });
    const promoted = await account({ did: DIDS.promoted, handle: "m3auth-promoted" });
    promotedId = promoted.id;
    adminId = admin.id;

    ownerKey = await mintApiKeyFor(owner.id, ["read", "write"]);
    otherKey = await mintApiKeyFor(other.id, ["read"]);
    ownerToken = await mintPrivyToken(DIDS.owner);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);
    adminToken = await mintPrivyToken(DIDS.admin);
  });

  afterAll(async () => {
    await cleanupFixtures({ privyDids: Object.values(DIDS) });
    await app.close();
    await pool.end();
  });

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

  it("refuses a token signed by another key, an expired one and a wrong audience alike", async () => {
    const cases = [
      await mintForeignToken(DIDS.owner),
      await mintPrivyToken(DIDS.owner, { expiresIn: -60 }),
      await mintPrivyToken(DIDS.owner, { audience: "some-other-app" }),
      await mintPrivyToken(DIDS.owner, { issuer: "https://evil.example" }),
    ];
    for (const token of cases) {
      const res = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
      expect(res.statusCode).toBe(401);
      // One message for every failure mode: telling a prober which half worked is the leak.
      expect(res.json().message).toBe("the access token could not be verified.");
    }
  });

  it("refuses a correctly signed token that simply omits `exp`", async () => {
    const token = await mintPrivyToken(DIDS.owner, { omitExpiry: true });
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("the access token could not be verified.");
  });

  it("provisions an account on first login, keyed on the DID alone", async () => {
    const token = await mintPrivyToken(DIDS.fresh);
    const first = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.accountId).toBeGreaterThan(0);
    expect(body.role).toBe("submitter");
    expect(body.credentialKind).toBe("session");
    // Enrichment is off the auth path, so nothing but the DID is known yet.
    expect(body.email).toBeNull();
    expect(body.primaryWallet).toBeNull();

    const second = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(second.json().accountId).toBe(body.accountId);
  });

  it("makes an admin in the product, effective on the target's very next request", async () => {
    // Nothing in the environment grants a role: a session resolves to whatever the database holds.
    // So the promotion is an ACTION by an admin, and the only thing worth asserting about it is
    // that the next request the target makes is already the request of an admin — a role that took
    // a re-login to become real would be a role nobody could rely on having revoked either.
    const token = await mintPrivyToken(DIDS.promoted);
    const before = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
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

    const after = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(after.json().role).toBe("admin");
    expect(after.json().canAdmin).toBe(true);

    // …and the new admin can administer, which is the half a role field alone does not prove.
    const byNewAdmin = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${adminId}/role`,
      headers: bearer(token),
      payload: { role: "admin" },
    });
    expect(byNewAdmin.statusCode, byNewAdmin.body).toBe(200);

    // Revocation is the same route, and takes effect just as immediately.
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${promotedId}/role`,
      headers: bearer(adminToken),
      payload: { role: "submitter" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const demoted = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(demoted.json().canAdmin).toBe(false);
  });

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

    // …and the key works, which is what makes "shown once" a constraint rather than a loss.
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().credentialKind).toBe("api_key");
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

    const after = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(after.statusCode).toBe(401);

    const unknown = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer("rfph_abcdefgh_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
    });
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
    const reviewer = await seedAccount({ did: DIDS.reviewer });
    const key = await mintApiKeyFor(reviewer.id, ["read", "write", "publish"]);
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
  });

  it("404s — never 403s — a key id belonging to another account", async () => {
    const mine = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: bearer(ownerToken),
      payload: { scopes: ["read"] },
    });
    const myId: number = mine.json().key.id;

    const otherToken = await mintPrivyToken(DIDS.other);
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
  });

  it("lets a session set a public handle and refuses a taken one", async () => {
    const token = await mintPrivyToken(DIDS.fresh);
    const ok = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(token),
      payload: { handle: "m3auth-fresh", displayName: "Fresh" },
    });
    expect(ok.statusCode).toBe(200);
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
  });
});

/**
 * The whole publisher journey in one pass: an account arrives, a reviewer verifies its organisation
 * and grants it a membership, it mints a `publish` key, submits, is published without review,
 * replaces the entry — and both mutations are in the trail, attributed to the key that made them.
 *
 * Isolation tag: `M3LIFE` / `m3life:`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { auditLog, opportunities } from "../../src/db/schema.js";
import {
  bearer,
  mintPrivyToken,
  seedAccount,
  seedOrganization,
  testPrivyConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3life";
const DIDS = {
  publisher: "did:privy:m3life-publisher",
  reviewer: "did:privy:m3life-reviewer",
};
const PUBLIC_ID = `${NS}:programme`;

const run = describeWithDb;

run("M3LIFE publisher lifecycle", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let reviewerToken: string;
  let accountId: number;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();
    await seedAccount({ did: DIDS.reviewer, handle: "m3life-reviewer", role: "reviewer" });
    await seedOrganization({ slug: NS, name: "Lifecycle Foundation", verified: false });
    publisherToken = await mintPrivyToken(DIDS.publisher);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      privyDids: Object.values(DIDS),
    });
    await app.close();
    await pool.end();
  });

  it("runs the whole path from first login to a published, replaceable entry", async () => {
    // 1. First login provisions the account, with nothing but the DID known.
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(publisherToken) });
    expect(me.statusCode).toBe(200);
    accountId = me.json().accountId;
    expect(me.json().memberships).toEqual([]);
    expect(me.json().handle).toBeNull();

    // …and chooses the public handle attribution will use. Session only.
    const named = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(publisherToken),
      payload: { handle: "m3life-publisher", displayName: "Lifecycle" },
    });
    expect(named.json().handle).toBe("m3life-publisher");

    // 2. The submitter's first attempt lands pending — no relationship to the namespace yet.
    const first = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publisherToken),
      payload: submission(`${NS}:early`, NS),
    });
    expect(first.json().reviewStatus).toBe("pending");

    // 3. A reviewer verifies the organisation and grants the membership.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/review/organizations/${NS}/verify`,
          headers: bearer(reviewerToken),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/review/organizations/${NS}/members`,
          headers: bearer(reviewerToken),
          payload: { accountId, role: "owner" },
        })
      ).statusCode,
    ).toBe(200);

    // 4. `/v1/me` now reports the membership, verified.
    const after = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(publisherToken),
    });
    expect(after.json().memberships).toEqual([
      { slug: NS, name: "Lifecycle Foundation", role: "owner", verified: true },
    ]);

    // 5. A `publish` key, minted from the session — the only credential that can mint one.
    const minted = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: bearer(publisherToken),
      payload: { name: "ci", scopes: ["read", "write", "publish"] },
    });
    expect(minted.statusCode).toBe(201);
    const token: string = minted.json().token;
    const keyId: number = minted.json().key.id;

    // 6. The key publishes without review, and the entry is immediately public.
    const created = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(token),
      payload: submission(PUBLIC_ID, NS, { title: "Ecosystem Grants, Round 1" }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reviewStatus).toBe("approved");
    expect(created.json().opportunity.source.submittedBy).toBe(NS);
    expect(created.json().opportunity.source.ingestedVia).toBe("publisher_api");

    const publicDetail = await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}` });
    expect(publicDetail.statusCode).toBe(200);
    expect(publicDetail.json().title).toBe("Ecosystem Grants, Round 1");

    // 7. A replace, through the same key.
    const replaced = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${PUBLIC_ID}`,
      headers: bearer(token),
      payload: submission(PUBLIC_ID, NS, { title: "Ecosystem Grants, Round 2" }),
    });
    expect(replaced.statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}` })).json().title).toBe(
      "Ecosystem Grants, Round 2",
    );

    // 8. Both mutations are in the trail, attributed to the key.
    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, PUBLIC_ID)).limit(1)
    )[0];
    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "opportunity"), eq(auditLog.subjectId, row?.id ?? 0)));
    expect(trail.map((t) => t.action)).toEqual(
      expect.arrayContaining(["create", "approve", "update"]),
    );
    expect(trail.every((t) => t.actorApiKeyId === keyId)).toBe(true);

    // 9. …and the public trail says what changed, without saying what it changed to.
    const publicTrail = await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}/audit` });
    const update = publicTrail
      .json()
      .entries.find((e: { action: string }) => e.action === "update");
    expect(update.changedFields).toContain("title");
    expect(update.patch).toBeUndefined();
    // The publisher published as its organisation, so that is what the trail credits.
    expect(update.actor).toBe("m3life-publisher");

    // 10. Revoking the key stops it, and leaves the trail resolvable.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/keys/${keyId}`,
          headers: bearer(publisherToken),
        })
      ).statusCode,
    ).toBe(200);
    const blocked = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${PUBLIC_ID}`,
      headers: bearer(token),
      payload: submission(PUBLIC_ID, NS, { title: "Round 3" }),
    });
    expect(blocked.statusCode).toBe(401);
    const stillThere = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "api_key"), eq(auditLog.subjectId, keyId)));
    expect(stillThere.map((t) => t.action)).toEqual(
      expect.arrayContaining(["create_api_key", "revoke_api_key"]),
    );
  });
});

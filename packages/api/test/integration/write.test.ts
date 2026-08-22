/**
 * The write path: validation layering, provenance, idempotency, both unique violations, and the
 * organisation-directory rule that stops a submitter overwriting a verified publisher's branding.
 *
 * Isolation tag: `M3WRITE` / `m3write:`.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import {
  bearer,
  grantMembership,
  mintApiKeyFor,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3write";
const OTHER_NS = "m3write-other";
const EMAILS = {
  submitter: "m3write-submitter@rfphub.invalid",
  publisher: "m3write-publisher@rfphub.invalid",
  stranger: "m3write-stranger@rfphub.invalid",
  reviewer: "m3write-reviewer@rfphub.invalid",
};

const run = describeWithDb;

run("M3WRITE submissions", () => {
  let app: FastifyInstance;
  let submitterToken: string;
  let publisherToken: string;
  let strangerToken: string;
  let reviewerToken: string;
  let publishKey: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const submitter = await seedIdentity(EMAILS.submitter, { handle: "m3write-submitter" });
    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3write-publisher" });
    const stranger = await seedIdentity(EMAILS.stranger, { handle: "m3write-stranger" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3write-reviewer",
      role: "reviewer",
    });
    userIds.push(submitter.userId, publisher.userId, stranger.userId, reviewer.userId);

    // A VERIFIED organisation carrying real directory metadata — the row a submission must not be
    // able to rewrite.
    const verified = await seedOrganization({ slug: NS, name: "Real Publisher", verified: true });
    await db
      .update(organizations)
      .set({ website: "https://real.example", description: "Curated by its owner." })
      .where(eq(organizations.id, verified.id));
    await grantMembership(publisher.account.id, verified.id, "owner");
    await seedOrganization({ slug: OTHER_NS, verified: false });

    submitterToken = submitter.token;
    publisherToken = publisher.token;
    strangerToken = stranger.token;
    reviewerToken = reviewer.token;
    publishKey = await mintApiKeyFor(publisher.account.id, ["read", "write", "publish"]);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3write",
      organizationSlugs: [NS, OTHER_NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  it("returns a humanized, field-by-field 400 rather than Fastify's generic validation message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: { ...submission(`${OTHER_NS}:bad`, OTHER_NS), title: 42, status: "nonsense" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.join(" ")).toMatch(/title/);
    // Fastify's own message would read "body/title must be string"; the service's does not.
    expect(body.message).not.toMatch(/^body\//);
  });

  it("still publishes an accurate request schema despite the pass-through validator", async () => {
    const doc = (await app.inject({ method: "GET", url: "/v1/docs/json" })).json();
    const requestSchema =
      doc.paths["/v1/opportunities"].post.requestBody.content["application/json"].schema;
    expect(requestSchema.$ref).toBe("#/components/schemas/Opportunity");
    expect(doc.paths["/v1/opportunities/{id}"].put).toBeTruthy();
  });

  it("413s a body over the route limit", async () => {
    const huge = submission(`${OTHER_NS}:huge`, OTHER_NS, {
      description: "x".repeat(300 * 1024),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: huge,
    });
    expect(res.statusCode).toBe(413);
  });

  it("caps oversized fields before anything is persisted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(`${OTHER_NS}:long-title`, OTHER_NS, { title: "t".repeat(300) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.join(" ")).toMatch(/`title` must be at most 256/);
  });

  it("stores an unprivileged submission as pending and keeps it out of every public read", async () => {
    const id = `${OTHER_NS}:pending-1`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(id, OTHER_NS),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewStatus).toBe("pending");

    const detail = await app.inject({ method: "GET", url: `/v1/opportunities/${id}` });
    expect(detail.statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: "/v1/opportunities?ecosystem=M3WRITE" });
    expect(list.json().items.map((i: { id: string }) => i.id)).not.toContain(id);

    // …but its own submitter can see it in full.
    const owned = await app.inject({
      method: "GET",
      url: `/v1/me/opportunities/${id}`,
      headers: bearer(submitterToken),
    });
    expect(owned.statusCode).toBe(200);
    expect(owned.json().id).toBe(id);
  });

  it("overwrites every client-supplied attribution field", async () => {
    const id = `${OTHER_NS}:forged`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(id, OTHER_NS, {
        source: {
          publisher: OTHER_NS,
          submittedBy: "someone-else",
          submittedAt: "1999-01-01T00:00:00.000Z",
          originalId: "forged-key",
          ingestedVia: "outbox",
          verifiedAgainstSource: true,
          verifiedAt: "1999-01-01T00:00:00.000Z",
        },
      }),
    });
    expect(res.statusCode).toBe(201);
    const source = res.json().opportunity.source;
    expect(source.submittedBy).toBe("m3write-submitter");
    expect(source.submittedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(source.ingestedVia).toBe("submission");
    // `originalId` is half of the cross-system unique key, so a submitter who cannot publish here
    // must not be able to write it at all.
    expect(source.originalId).toBeUndefined();
    expect(source.verifiedAgainstSource).toBeNull();
    expect(source.verifiedAt).toBeUndefined();
  });

  it("does not modify an existing verified organisation named by a submission", async () => {
    const before = (
      await db.select().from(organizations).where(eq(organizations.slug, NS)).limit(1)
    )[0];
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(strangerToken),
      payload: submission(`${NS}:hijack`, NS, {
        operatingOrganizations: [
          {
            name: "Hijacked",
            slug: NS,
            website: "https://attacker.example",
            description: "Owned.",
          },
        ],
      }),
    });
    // The submission itself is accepted (pending) — what must not happen is the directory rewrite.
    expect([201, 200]).toContain(res.statusCode);
    const after = (
      await db.select().from(organizations).where(eq(organizations.slug, NS)).limit(1)
    )[0];
    expect(after?.name).toBe(before?.name);
    expect(after?.website).toBe("https://real.example");
    expect(after?.description).toBe("Curated by its owner.");
    expect(after?.verified).toBe(true);
  });

  it("creates a directory stub for an organisation nobody has registered", async () => {
    const slug = "m3write-stub";
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(`${slug}:one`, slug),
    });
    expect(res.statusCode).toBe(201);
    const rows = await db.select().from(organizations).where(eq(organizations.slug, slug));
    expect(rows[0]?.verified).toBe(false);
    await cleanupFixtures({ opportunityPrefix: `${slug}:`, organizationSlugs: [slug] });
  });

  it("returns the original result for an identical repeat and 409s a differing one", async () => {
    const id = `${OTHER_NS}:repeat`;
    const payload = submission(id, OTHER_NS);
    const first = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const repeat = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload,
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().opportunity.id).toBe(id);

    const differing = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: { ...payload, title: "Changed" },
    });
    expect(differing.statusCode).toBe(409);
    expect(differing.json().error).toBe("id_conflict");

    // A different account reaching for a taken id gets the same undifferentiated conflict — never
    // a 403, which would confirm the id exists and who holds it.
    const stranger = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(strangerToken),
      payload,
    });
    expect(stranger.statusCode).toBe(409);
  });

  it("refuses an id whose namespace is not the one the entry is published under", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission("someone-else:mine", OTHER_NS, {
        source: { publisher: OTHER_NS },
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_id");
    expect(res.json().message).toMatch(/must start with the namespace/);
  });

  it("refuses a PUT whose body id differs from the path id", async () => {
    const id = `${OTHER_NS}:immutable`;
    await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(id, OTHER_NS),
    });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(submitterToken),
      payload: submission(`${OTHER_NS}:renamed`, OTHER_NS),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("id_immutable");
  });

  it("409s a collision on the cross-system source key", async () => {
    const one = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publishKey),
      payload: submission(`${NS}:src-a`, NS, { source: { originalId: "shared-key" } }),
    });
    expect(one.statusCode).toBe(201);
    expect(one.json().opportunity.source.originalId).toBe("shared-key");

    const two = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publishKey),
      payload: submission(`${NS}:src-b`, NS, { source: { originalId: "shared-key" } }),
    });
    expect(two.statusCode).toBe(409);
    expect(two.json().error).toBe("source_key_conflict");
  });

  it("lets a verified publisher replace their own entry and publishes it immediately", async () => {
    const id = `${NS}:live`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publisherToken),
      payload: submission(id, NS),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reviewStatus).toBe("approved");

    const publicDetail = await app.inject({ method: "GET", url: `/v1/opportunities/${id}` });
    expect(publicDetail.statusCode).toBe(200);

    const replaced = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(publisherToken),
      payload: submission(id, NS, { title: "Replaced" }),
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().opportunity.title).toBe("Replaced");
    expect(replaced.json().created).toBe(false);
    // The OTHER half of the requeue rule: a writer who could have published this content from
    // scratch keeps it published, so this edit does not bounce back into the queue.
    expect(replaced.json().reviewStatus).toBe("approved");

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    // A publisher write is the "still real" signal the staleness clock reads.
    expect(row?.lastSeenAt).not.toBeNull();
    expect(row?.sourceSystem).toBe(NS);
  });

  it("returns an approved entry to the queue when the writer cannot auto-publish", async () => {
    // The shape that matters: a T1 submitter's entry, approved by a reviewer, then edited by that
    // same submitter. They own it — so the write is allowed — and they cannot publish, so the
    // replacement content has never been reviewed and must not inherit the earlier decision.
    const id = `${OTHER_NS}:requeue`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(id, OTHER_NS),
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().reviewStatus).toBe("pending");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${id}/approve`,
      headers: bearer(reviewerToken),
      payload: { reason: "looks real" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/opportunities/${id}` })).statusCode).toBe(
      200,
    );

    // FIRST, the edit that is not one. Opening the dashboard's edit form and pressing Save without
    // typing anything sends the stored document back verbatim; unpublishing a live entry over that
    // is the opposite mistake from letting a rewrite stay public, and just as visible to a reader.
    const unchanged = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(submitterToken),
      payload: submission(id, OTHER_NS),
    });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json().reviewStatus).toBe("approved");
    expect(unchanged.json().isListed).toBe(true);
    expect((await app.inject({ method: "GET", url: `/v1/opportunities/${id}` })).statusCode).toBe(
      200,
    );

    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(submitterToken),
      payload: submission(id, OTHER_NS, { title: "Rewritten after approval" }),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().reviewStatus).toBe("pending");

    // …and the rewritten content is out of the public read set until somebody looks at it again.
    const publicAgain = await app.inject({ method: "GET", url: `/v1/opportunities/${id}` });
    expect(publicAgain.statusCode).toBe(404);

    // The transition is in the trail, as an `update` naming it — the audit action enum is closed
    // and `update` with a reason says exactly what happened.
    const trail = await app.inject({
      url: `/v1/opportunities/${id}/audit`,
      headers: bearer(submitterToken),
    });
    expect(trail.statusCode).toBe(200);
    const requeue = trail
      .json()
      .entries.find(
        (row: { patch?: { reason?: string } }) =>
          row.patch?.reason === "replaced_without_auto_approval",
      );
    expect(requeue).toBeTruthy();
    expect(requeue.patch.reviewStatus).toEqual({ before: "approved", after: "pending" });
  });

  it("credits an editorial replacement to nobody: the stored attribution survives it", async () => {
    // A reviewer may `PUT` an entry they neither submitted nor publish — correcting a typo is not
    // an action for which the only available tool should be the approval button. What must NOT
    // follow is the entry being reattributed: after the next approval, `source.submittedBy` is what
    // the PUBLIC detail route serves as the credit for the whole submission.
    const id = `${NS}:live`;
    const before = await app.inject({
      url: `/v1/me/opportunities/${id}`,
      headers: bearer(publisherToken),
    });
    expect(before.statusCode, before.body).toBe(200);
    const storedSource = before.json().source;
    expect(storedSource.submittedBy).toBe(NS);

    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(reviewerToken),
      payload: submission(id, NS, { title: "Corrected by a reviewer" }),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().opportunity.title).toBe("Corrected by a reviewer");
    // Every attribution member, byte for byte: publisher, submittedBy, submittedAt, ingestedVia,
    // originalId. None of them is a fact about who last touched the record.
    expect(edited.json().opportunity.source).toEqual(storedSource);
    // A reviewer cannot publish into this namespace, so the corrected content still goes back for
    // review — the two rules are independent and both apply here.
    expect(edited.json().reviewStatus).toBe("pending");

    // The trail is where the editor IS named, which is the point: the entry's credit is unchanged
    // and the history says an editorial role acted.
    const trail = await app.inject({
      url: `/v1/opportunities/${id}/audit`,
      headers: bearer(reviewerToken),
    });
    expect(trail.statusCode).toBe(200);
    const editorial = trail
      .json()
      .entries.find(
        (row: { patch?: { actorRole?: string } }) => row.patch?.actorRole !== undefined,
      );
    expect(editorial?.action).toBe("update");
    expect(editorial?.patch.actorRole).toBe("reviewer");
  });

  it("404s a PUT against an entry that does not exist and 403s one owned by somebody else", async () => {
    const missing = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${OTHER_NS}:nope`,
      headers: bearer(submitterToken),
      payload: submission(`${OTHER_NS}:nope`, OTHER_NS),
    });
    expect(missing.statusCode).toBe(404);

    const id = `${NS}:live`;
    const foreign = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(strangerToken),
      payload: submission(id, NS),
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toBe("not_your_entry");
  });
});

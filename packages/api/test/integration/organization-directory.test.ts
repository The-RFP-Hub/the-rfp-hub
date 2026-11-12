/**
 * Who may write an organization's directory entry, and when.
 *
 * The finding this pins: the first submission to name a slug used to write that organization's
 * website, logo, description, social links and contacts — before review, never revisited,
 * surviving rejection, and published under the verified badge once the slug was verified. Now a
 * pending submission leaves a slug-and-name stub, an approval fills only empty fields of an
 * unverified row, verification is checked against the data the reviewer was shown, a single
 * submission can add only so many organizations, and rows only rejected entries name can be
 * found and removed.
 *
 * Isolation tag: `M3ODIR` / `m3odir`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cleanupRejectedOrganizationStubs } from "../../scripts/cleanup-rejected-org-stubs.js";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { auditLog, opportunities, organizations } from "../../src/db/schema.js";
import { repositories } from "../../src/modules/repositories/index.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { MAX_NEW_ORGANIZATIONS_PER_SUBMISSION } from "../../src/modules/shared/organization-directory.js";
import { bearer, seedIdentity, seedOrganization, testAuth } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3odir";
const EMAILS = {
  submitter: "m3odir-submitter@rfphub.invalid",
  reviewer: "m3odir-reviewer@rfphub.invalid",
  claimant: "m3odir-claimant@rfphub.invalid",
};

/** A slug per case, so cases never see each other's rows. */
const slug = (name: string) => `${NS}-${name}`;
const slugsUsed = new Set<string>();
function org(name: string) {
  const s = slug(name);
  slugsUsed.add(s);
  return s;
}

/** Everything a submitter could say about an organization it names. */
function plantedOrganization(s: string) {
  return {
    name: `Planted ${s}`,
    slug: s,
    website: "https://attacker.example",
    logoUrl: "https://attacker.example/logo.png",
    description: "Not who they say they are.",
    socialLinks: [{ platform: "twitter", url: "https://x.example/attacker" }],
    contacts: [{ name: "Mallory", email: "mallory@attacker.example" }],
  };
}

async function directoryRow(s: string) {
  return (await db.select().from(organizations).where(eq(organizations.slug, s)).limit(1))[0];
}

describeWithDb("M3ODIR the organization directory", () => {
  let app: FastifyInstance;
  let submitterToken: string;
  let reviewerToken: string;
  let claimantToken: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const submitter = await seedIdentity(EMAILS.submitter, { handle: "m3odir-submitter" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3odir-reviewer",
      role: "reviewer",
    });
    const claimant = await seedIdentity(EMAILS.claimant, { handle: "m3odir-claimant" });
    userIds.push(submitter.userId, reviewer.userId, claimant.userId);
    submitterToken = submitter.token;
    reviewerToken = reviewer.token;
    claimantToken = claimant.token;
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: `${NS}-`,
      organizationSlugs: [...slugsUsed],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  }, 60_000);

  const submit = (id: string, namespace: string, over: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(id, namespace, over),
    });
  const decide = (id: string, verb: "approve" | "reject") =>
    app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${encodeURIComponent(id)}/${verb}`,
      headers: bearer(reviewerToken),
      payload: verb === "reject" ? { reason: "spam" } : {},
    });

  it("leaves only the slug and the name behind a pending submission", async () => {
    const s = org("pending");
    const res = await submit(`${s}:one`, s, { operatingOrganizations: [plantedOrganization(s)] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().opportunity.source.publisher ?? s).toBeTruthy();

    const row = await directoryRow(s);
    expect(row).toMatchObject({
      slug: s,
      name: `Planted ${s}`,
      website: null,
      logoUrl: null,
      description: null,
      socialLinks: [],
      contacts: [],
      verified: false,
    });
  });

  it("fills an unverified stub's empty fields on approval, and audits where they came from", async () => {
    const s = org("approve");
    const id = `${s}:one`;
    expect(
      (await submit(id, s, { operatingOrganizations: [plantedOrganization(s)] })).statusCode,
    ).toBe(201);
    expect((await directoryRow(s))?.website).toBeNull();

    const approved = await decide(id, "approve");
    expect(approved.statusCode, approved.body).toBe(200);

    const row = await directoryRow(s);
    expect(row).toMatchObject({
      website: "https://attacker.example",
      logoUrl: "https://attacker.example/logo.png",
      description: "Not who they say they are.",
      contacts: [{ name: "Mallory", email: "mallory@attacker.example" }],
      verified: false,
    });
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "organization"), eq(auditLog.subjectId, row?.id ?? -1)));
    expect(audits.map((a) => (a.patch as Record<string, unknown>).reason)).toContain(
      `filled_from_approved_entry:${id}`,
    );
  });

  it("never overwrites a value, and never touches a verified organization, on approval", async () => {
    const kept = org("kept");
    const verified = org("verified");
    await seedOrganization({ slug: kept, name: "Kept", verified: false });
    await db
      .update(organizations)
      .set({ website: "https://kept.example" })
      .where(eq(organizations.slug, kept));
    await seedOrganization({ slug: verified, name: "Verified", verified: true });

    const id = `${kept}:one`;
    const res = await submit(id, kept, {
      operatingOrganizations: [plantedOrganization(kept)],
      sponsoringOrganizations: [plantedOrganization(verified)],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((await decide(id, "approve")).statusCode).toBe(200);

    const keptRow = await directoryRow(kept);
    expect(keptRow?.website, "a value is never overwritten").toBe("https://kept.example");
    expect(keptRow?.name).toBe("Kept");
    // The empty ones are filled, though.
    expect(keptRow?.logoUrl).toBe("https://attacker.example/logo.png");

    const verifiedRow = await directoryRow(verified);
    expect(verifiedRow).toMatchObject({ name: "Verified", website: null, logoUrl: null });
  });

  it("keeps a rejected submission's details out of the directory, and out of /v1/publishers once the slug is verified", async () => {
    const s = org("rejected");
    const id = `${s}:one`;
    expect(
      (await submit(id, s, { operatingOrganizations: [plantedOrganization(s)] })).statusCode,
    ).toBe(201);
    expect((await decide(id, "reject")).statusCode).toBe(200);

    const verify = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${s}/verify`,
      headers: bearer(reviewerToken),
    });
    expect(verify.statusCode, verify.body).toBe(200);

    const publishers = (
      await app.inject({ method: "GET", url: "/v1/publishers?limit=500" })
    ).json();
    const listed = publishers.items.find((p: { slug: string }) => p.slug === s);
    expect(listed).toMatchObject({ slug: s, website: null, logoUrl: null, description: null });
  });

  it("refuses a submission that would add more than the cap of new organizations, and leaves nothing behind", async () => {
    const fresh = Array.from({ length: MAX_NEW_ORGANIZATIONS_PER_SUBMISSION + 1 }, (_, i) =>
      org(`flood-${i}`),
    );
    const [host, ...rest] = fresh as [string, ...string[]];
    const over = await submit(`${host}:flood`, host, {
      operatingOrganizations: [{ name: host, slug: host }],
      sponsoringOrganizations: rest.map((s) => ({ name: s, slug: s })),
    });
    expect(over.statusCode, over.body).toBe(400);
    expect(over.json().error).toBe("too_many_new_organizations");
    for (const s of fresh) expect(await directoryRow(s), s).toBeUndefined();

    // Exactly the cap is fine, and organizations the directory already knows do not count.
    const known = org("flood-known");
    await seedOrganization({ slug: known, name: "Known", verified: false });
    const atCap = await submit(`${host}:flood-ok`, host, {
      operatingOrganizations: [{ name: host, slug: host }],
      sponsoringOrganizations: [
        ...rest
          .slice(0, MAX_NEW_ORGANIZATIONS_PER_SUBMISSION - 1)
          .map((s) => ({ name: s, slug: s })),
        { name: "Known", slug: known },
      ],
    });
    expect(atCap.statusCode, atCap.body).toBe(201);
  });

  it("verifies only the directory entry the reviewer was shown", async () => {
    const s = org("digest");
    await seedOrganization({ slug: s, name: "Digest", verified: false });

    const listed = (
      await app.inject({
        method: "GET",
        url: `/v1/review/organizations?q=${s}&verified=false`,
        headers: bearer(reviewerToken),
      })
    ).json();
    const shown = listed.items.find((o: { slug: string }) => o.slug === s);
    expect(shown.directory).toMatchObject({
      name: "Digest",
      website: null,
      digest: expect.any(String),
    });

    // The entry moves after it was shown.
    await db
      .update(organizations)
      .set({ website: "https://moved.example" })
      .where(eq(organizations.slug, s));

    const verify = (directoryDigest: string) =>
      app.inject({
        method: "POST",
        url: `/v1/review/organizations/${s}/verify`,
        headers: bearer(reviewerToken),
        payload: { directoryDigest },
      });
    const stale = await verify(shown.directory.digest);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toBe("organization_directory_changed");
    expect((await directoryRow(s))?.verified).toBe(false);

    const reloaded = (
      await app.inject({
        method: "GET",
        url: `/v1/review/organizations?q=${s}&verified=false`,
        headers: bearer(reviewerToken),
      })
    ).json();
    const now = reloaded.items.find((o: { slug: string }) => o.slug === s);
    expect(now.directory.website).toBe("https://moved.example");
    const ok = await verify(now.directory.digest);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().directory.digest).toBe(now.directory.digest);
  });

  it("shows a claim's organization entry to the reviewer and approves only what was shown", async () => {
    const s = org("claim");
    const host = org("claim-host");
    await seedOrganization({ slug: s, name: "Claimed Org", verified: false });
    await seedOrganization({ slug: host, name: "Claim Host", verified: false });
    const id = `${host}:claimable`;
    await new OpportunityService().upsertFromStandard(
      {
        specVersion: "1.0.0",
        id,
        fundingType: "grant",
        title: "Claimable",
        description: "A claimable fixture.",
        status: "open",
        operatingOrganizations: [
          { name: "Claim Host", slug: host },
          { name: "Claimed Org", slug: s },
        ],
        source: { publisher: host, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M3ODIR"],
        fundingDetails: { fundingType: "grant" },
        // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture
      } as any,
      { reviewStatus: "approved", isListed: true, sourceSystem: host },
    );
    const filed = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(claimantToken),
      payload: { organizationSlug: s },
    });
    expect([200, 201, 202]).toContain(filed.statusCode);

    const queue = (
      await app.inject({ method: "GET", url: "/v1/review/claims", headers: bearer(reviewerToken) })
    ).json();
    const item = queue.items.find((c: { organizationSlug: string }) => c.organizationSlug === s);
    expect(item.organizationDirectory).toMatchObject({
      name: "Claimed Org",
      digest: expect.any(String),
    });

    await db
      .update(organizations)
      .set({ logoUrl: "https://moved.example/logo.png" })
      .where(eq(organizations.slug, s));
    const approve = (directoryDigest: string) =>
      app.inject({
        method: "POST",
        url: `/v1/review/claims/${item.id}/approve`,
        headers: bearer(reviewerToken),
        payload: { directoryDigest },
      });
    const stale = await approve(item.organizationDirectory.digest);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toBe("organization_directory_changed");
    expect((await directoryRow(s))?.verified).toBe(false);

    const again = (
      await app.inject({ method: "GET", url: "/v1/review/claims", headers: bearer(reviewerToken) })
    ).json();
    const fresh = again.items.find((c: { id: number }) => c.id === item.id);
    const ok = await approve(fresh.organizationDirectory.digest);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await directoryRow(s))?.verified).toBe(true);
  });

  it("finds organizations only rejected entries name, and deletes them only when told to", async () => {
    const orphan = org("orphan");
    const shared = org("shared");
    const orphanId = `${orphan}:spam`;
    expect(
      (
        await submit(orphanId, orphan, {
          operatingOrganizations: [plantedOrganization(orphan)],
          sponsoringOrganizations: [{ name: shared, slug: shared }],
        })
      ).statusCode,
    ).toBe(201);
    // `shared` is also named by an entry that is still pending, so it must survive.
    expect(
      (
        await submit(`${shared}:live`, shared, {
          operatingOrganizations: [{ name: shared, slug: shared }],
        })
      ).statusCode,
    ).toBe(201);
    expect((await decide(orphanId, "reject")).statusCode).toBe(200);

    const lines: string[] = [];
    const dryRun = await cleanupRejectedOrganizationStubs(repositories(db), {
      apply: false,
      log: (line) => lines.push(line),
      only: (s) => s.startsWith(`${NS}-`),
    });
    expect(dryRun.found).toContain(orphan);
    expect(dryRun.found).not.toContain(shared);
    expect(dryRun.deleted).toEqual([]);
    expect(await directoryRow(orphan), "a dry run deletes nothing").toBeTruthy();

    const applied = await cleanupRejectedOrganizationStubs(repositories(db), {
      apply: true,
      log: (line) => lines.push(line),
      only: (s) => s.startsWith(`${NS}-`),
    });
    expect(applied.deleted).toContain(orphan);
    expect(await directoryRow(orphan)).toBeUndefined();
    expect(await directoryRow(shared)).toBeTruthy();
    // The rejected entry itself is untouched: it keeps its own copy of what it said.
    const entry = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, orphanId))
    )[0];
    expect(entry?.reviewStatus).toBe("rejected");
  });
});

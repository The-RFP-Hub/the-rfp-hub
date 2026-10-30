/**
 * Link-outs vouch only for destinations a person reviewed: who pins a link, what unpins it, and
 * what `/v1/r/:id/{apply,source}` answers in each case.
 *
 * Isolation tag: `M5LINK` / `m5link:`.
 *
 * The rule under test is `modules/shared/link-out.ts`. Every case asserts the whole observable
 * contract at once — the status, the exact `Location`, and that the click was counted — because the
 * failure this change must never introduce is a link-out that stops being a counted `302`. A leaving
 * page instead of the destination is the intended cost; a 404 or an uncounted click is a bug.
 */
import { readFileSync } from "node:fs";
import { and, count, desc, eq, gte, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { type AppConfig, config } from "../../src/config.js";
import { db, pool } from "../../src/db/client.js";
import {
  auditLog,
  opportunities,
  opportunityEvents,
  verificationRuns,
} from "../../src/db/schema.js";
import { analyticsEvents } from "../../src/modules/services/insights/event-buffer.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  SourceFetchError,
  type SourceTransport,
} from "../../src/modules/services/verification/fetcher.service.js";
import { VerificationService } from "../../src/modules/services/verification/verification.service.js";
import type { LeavingReason, LinkKind } from "../../src/modules/shared/link-out.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { fixtureTransport, sourcePage } from "../helpers/verify-transport.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m5link";
const EMAILS = {
  publisher: "m5link-publisher@rfphub.invalid",
  reviewer: "m5link-reviewer@rfphub.invalid",
};

const APPLY_URL = "https://apply.m5link.example/form";
const SITE_URL = "https://programme.m5link.example/";

/** A plausible reader. Not "curl/…" or anything the bot pattern matches. */
const READER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) M5LinkReader/1.0" };

const run = describeWithDb;
const ingest = new OpportunityService();

type ImportOptions = {
  reviewStatus?: "pending" | "approved";
  isListed?: boolean;
  status?: "open" | "closed" | "archived";
  applicationUrl?: string;
  website?: string;
};

/** The curated import path — `OpportunityService.upsertFromStandard`, as the seed loader uses it. */
async function seedImport(publicId: string, options: ImportOptions = {}): Promise<void> {
  await ingest.upsertFromStandard(
    {
      specVersion: "1.0.0",
      id: publicId,
      fundingType: "grant",
      title: `Link-out fixture ${publicId}`,
      description: "A link-out fixture.",
      status: options.status ?? "open",
      operatingOrganizations: [{ name: "Link-out Org", slug: NS }],
      source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
      ecosystems: ["M5LINK"],
      applicationUrl: options.applicationUrl,
      website: options.website,
      fundingDetails: { fundingType: "grant" },
      // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture, not a mapper output
    } as any,
    {
      reviewStatus: options.reviewStatus ?? "approved",
      isListed: options.isListed ?? true,
      sourceSystem: NS,
    },
  );
}

async function rowOf(publicId: string) {
  const [row] = await db.select().from(opportunities).where(eq(opportunities.publicId, publicId));
  if (!row) throw new Error(`no row ${publicId}`);
  return row;
}

/** Today's counted link-outs of one kind for one entry, with the buffer flushed first. */
async function clicks(publicId: string, kind: LinkKind, since: Date): Promise<number> {
  // Twice: a flush already in flight is joined rather than repeated, and an event recorded while it
  // runs is written by the NEXT one.
  await analyticsEvents.flush();
  await analyticsEvents.flush();
  const { id } = await rowOf(publicId);
  const [counted] = await db
    .select({ value: count() })
    .from(opportunityEvents)
    .where(
      and(
        eq(opportunityEvents.opportunityId, id),
        eq(opportunityEvents.eventType, kind === "apply" ? "apply_click" : "source_click"),
        gte(opportunityEvents.occurredAt, since),
      ),
    );
  return counted?.value ?? 0;
}

const leaving = (publicId: string, kind: LinkKind, reason: LeavingReason) =>
  `${config.appBaseUrl}/leaving/${encodeURIComponent(publicId)}?link=${kind}&reason=${reason}`;

/** A transport that never reaches anybody — the transient case. */
const timingOut: SourceTransport = async (url) => {
  throw new SourceFetchError(`${url}: request timed out`, "timeout", url);
};

function verifier(transport: SourceTransport) {
  const cfg: AppConfig = { ...config, verification: { ...config.verification, enabled: true } };
  return new VerificationService(db, { transport, config: cfg });
}

run("M5LINK link-outs vouch only for reviewed destinations", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let reviewerToken: string;
  const userIds: string[] = [];
  const startedAt = new Date();

  /**
   * Follow one link-out and assert the whole contract: a `302`, exactly this `Location`, and one
   * more counted click of that kind than before.
   */
  async function expectLinkOut(publicId: string, kind: LinkKind, location: string): Promise<void> {
    const before = await clicks(publicId, kind, startedAt);
    const res = await app.inject({
      url: `/v1/r/${encodeURIComponent(publicId)}/${kind}`,
      headers: READER,
    });
    expect(res.statusCode, `${kind} link-out of ${publicId}`).toBe(302);
    expect(res.headers.location, `${kind} link-out of ${publicId}`).toBe(location);
    expect(await clicks(publicId, kind, startedAt), `${kind} click on ${publicId} is counted`).toBe(
      before + 1,
    );
  }

  /** A reviewer opens the listing and saves it without touching anything — the re-pin gesture. */
  async function reviewerSaves(publicId: string): Promise<Record<string, unknown>> {
    const stored = await app.inject({
      url: `/v1/review/opportunities/${encodeURIComponent(publicId)}`,
      headers: bearer(reviewerToken),
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const saved = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${encodeURIComponent(publicId)}`,
      headers: bearer(reviewerToken),
      payload: stored.json(),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json();
  }

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m5link-publisher" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m5link-reviewer",
      role: "reviewer",
    });
    userIds.push(publisher.userId, reviewer.userId);
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.account.id, org.id, "owner");
    publisherToken = publisher.token;
    reviewerToken = reviewer.token;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: `${NS}:`,
      organizationSlugs: [NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  it("goes straight through for an imported, approved listing, and re-pins on a re-import", async () => {
    const id = `${NS}:imported`;
    await seedImport(id, { applicationUrl: APPLY_URL, website: SITE_URL });
    const row = await rowOf(id);
    // The curated import is reviewed before it is imported, so storing it approved pins both links.
    expect(row.reviewedApplicationUrl).toBe(APPLY_URL);
    expect(row.reviewedWebsite).toBe(SITE_URL);

    await expectLinkOut(id, "apply", APPLY_URL);
    await expectLinkOut(id, "source", SITE_URL);

    const moved = "https://apply.m5link.example/form-2027";
    await seedImport(id, { applicationUrl: moved, website: SITE_URL });
    await expectLinkOut(id, "apply", moved);
  });

  it("vouches for what the migration's backfill pinned, and treats a never-pinned link as unreviewed", async () => {
    const approved = `${NS}:backfilled`;
    const pending = `${NS}:backfill-pending`;
    await seedImport(approved, { applicationUrl: APPLY_URL, website: SITE_URL });
    await seedImport(pending, { reviewStatus: "pending", applicationUrl: APPLY_URL });
    // The state every row is in before 0017's backfill runs: no pin at all.
    await db
      .update(opportunities)
      .set({ reviewedApplicationUrl: null, reviewedWebsite: null })
      .where(eq(opportunities.publicId, approved));

    await expectLinkOut(approved, "apply", leaving(approved, "apply", "unreviewed"));
    await expectLinkOut(approved, "source", leaving(approved, "source", "unreviewed"));

    // The migration's own backfill statement, narrowed to this suite's rows: a whole-table UPDATE
    // would take row locks under every concurrently running suite, including the ones that hold a
    // lock on purpose and count who is waiting on it.
    const migration = readFileSync(
      new URL("../../src/db/migrations/0017_link_out_reviewed_destinations.sql", import.meta.url),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").at(-1)?.trim() ?? "";
    expect(backfill).toMatch(/^-- BACKFILL[\s\S]*UPDATE "opportunities"[\s\S]*;$/);
    await pool.query(`${backfill.replace(/;$/, "")} AND "public_id" LIKE $1`, [`${NS}:%`]);

    await expectLinkOut(approved, "apply", APPLY_URL);
    await expectLinkOut(approved, "source", SITE_URL);
    // Only approved rows are pinned: a pending one is not public, and its approval pins it.
    expect((await rowOf(pending)).reviewedApplicationUrl).toBeNull();
  });

  it("sends a closed or archived listing to the leaving page, ahead of every other reason", async () => {
    const closed = `${NS}:closed`;
    const archived = `${NS}:archived`;
    await seedImport(closed, { status: "closed", applicationUrl: APPLY_URL, website: SITE_URL });
    await seedImport(archived, { status: "archived", applicationUrl: APPLY_URL });
    // Pinned (the import is approved) — closure outranks a link a reviewer vouched for.
    expect((await rowOf(closed)).reviewedApplicationUrl).toBe(APPLY_URL);
    await expectLinkOut(closed, "apply", leaving(closed, "apply", "closed"));
    await expectLinkOut(closed, "source", leaving(closed, "source", "closed"));
    await expectLinkOut(archived, "apply", leaving(archived, "apply", "closed"));

    // …and outranks `unreviewed` too.
    await db
      .update(opportunities)
      .set({ reviewedApplicationUrl: null, linkLandingChangedAt: new Date() })
      .where(eq(opportunities.publicId, closed));
    await expectLinkOut(closed, "apply", leaving(closed, "apply", "closed"));
  });

  it("starts a verified publisher's new listing unvouched, unvouches its edited link, and a reviewer's save re-vouches it", async () => {
    const id = `${NS}:publisher`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publisherToken),
      payload: submission(id, NS, {
        applicationUrl: APPLY_URL,
        website: SITE_URL,
        ecosystems: ["M5LINK"],
      }),
    });
    expect(created.statusCode, created.body).toBe(201);
    // Auto-approved and public — but nobody at the hub has looked at its links.
    expect(created.json().reviewStatus).toBe("approved");
    await expectLinkOut(id, "apply", leaving(id, "apply", "unreviewed"));
    await expectLinkOut(id, "source", leaving(id, "source", "unreviewed"));

    // A reviewer's unchanged save is the re-vouch, and pins are not content: it keeps the approval.
    const saved = await reviewerSaves(id);
    expect(saved.reviewStatus).toBe("approved");
    await expectLinkOut(id, "apply", APPLY_URL);
    await expectLinkOut(id, "source", SITE_URL);

    // The publisher repoints the application link. Auto-approved again, so still public…
    const document = (
      await app.inject({
        url: `/v1/review/opportunities/${encodeURIComponent(id)}`,
        headers: bearer(reviewerToken),
      })
    ).json();
    const repointed = "https://forms.m5link-elsewhere.example/apply";
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${encodeURIComponent(id)}`,
      headers: bearer(publisherToken),
      payload: { ...document, applicationUrl: repointed },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().reviewStatus).toBe("approved");
    // …but the new link is not the one reviewed. The website did not change, so it stays vouched.
    await expectLinkOut(id, "apply", leaving(id, "apply", "unreviewed"));
    await expectLinkOut(id, "source", SITE_URL);
    expect((await rowOf(id)).reviewedApplicationUrl).toBe(APPLY_URL);

    const resaved = await reviewerSaves(id);
    expect(resaved.reviewStatus, "an unchanged reviewer save never requeues").toBe("approved");
    await expectLinkOut(id, "apply", repointed);
    const row = await rowOf(id);
    expect(row.reviewedApplicationUrl).toBe(repointed);
    // No requeue row either: the save changed nothing a reader would call a change.
    const requeues = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "opportunity"), eq(auditLog.subjectId, row.id)));
    expect(
      requeues.filter((entry) => entry.patch?.reason === "replaced_without_auto_approval"),
    ).toEqual([]);
  });

  it("pins on a reviewer's approval, and not on a publisher approving its own queue", async () => {
    const reviewed = `${NS}:pending-reviewer`;
    const released = `${NS}:pending-namespace`;
    await seedImport(reviewed, { reviewStatus: "pending", applicationUrl: APPLY_URL });
    await seedImport(released, { reviewStatus: "pending", applicationUrl: APPLY_URL });

    // Not public yet: the unchanged 404.
    const hidden = await app.inject({ url: `/v1/r/${encodeURIComponent(reviewed)}/apply` });
    expect(hidden.statusCode).toBe(404);

    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${encodeURIComponent(reviewed)}/approve`,
      headers: bearer(reviewerToken),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await expectLinkOut(reviewed, "apply", APPLY_URL);

    // A verified member releasing its own entry is the publisher vouching for itself — the same
    // trust as an auto-approved write, so the link is public but not vouched for by the hub.
    const own = await app.inject({
      method: "POST",
      url: `/v1/organizations/${NS}/opportunities/${encodeURIComponent(released)}/approve`,
      headers: bearer(publisherToken),
      payload: {},
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().reviewStatus).toBe("approved");
    await expectLinkOut(released, "apply", leaving(released, "apply", "unreviewed"));
  });

  it("flags an apply link that starts landing on another site, ignores transient failures, and clears only on a reviewer's pin", async () => {
    const id = `${NS}:landing`;
    // A vanity link that redirects to wherever the form lives today — the shape a retargeted
    // shortener has.
    const vanity = "https://go.m5link-short.example/apply";
    const firstHost = "https://forms.first-host.example/m5link";
    const secondHost = "https://forms.second-host.example/m5link";
    const page = { body: sourcePage({ title: `Link-out fixture ${id}` }) };
    const landsOn = (destination: string) =>
      fixtureTransport({
        [vanity]: { status: 302, headers: { location: destination } },
        [destination]: page,
      });

    await seedImport(id, { applicationUrl: vanity, website: SITE_URL });
    const { id: rowId } = await rowOf(id);
    const flag = async () => (await rowOf(id)).linkLandingChangedAt;

    await verifier(landsOn(firstHost)).verify(rowId);
    expect(await flag(), "a first check has nothing to compare with").toBeNull();
    await expectLinkOut(id, "apply", vanity);

    // A timeout records a run whose URL is the vanity host. Comparing the next good check against
    // it would report a move from the shortener to the form host that never happened.
    await verifier(timingOut).verify(rowId);
    expect(await flag(), "a transient failure changes nothing").toBeNull();
    await verifier(landsOn(firstHost)).verify(rowId);
    expect(await flag(), "…nor poisons the next comparison").toBeNull();
    await expectLinkOut(id, "apply", vanity);

    await verifier(landsOn(secondHost)).verify(rowId);
    const flaggedAt = await flag();
    expect(flaggedAt, "the same link now lands on another site").not.toBeNull();
    await expectLinkOut(id, "apply", leaving(id, "apply", "landing_changed"));
    // The source check never fetches `website`, so it says nothing about the source link.
    await expectLinkOut(id, "source", SITE_URL);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "opportunity"),
          eq(auditLog.subjectId, rowId),
          eq(auditLog.action, "verify_source"),
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1);
    expect(audit?.patch?.landingSite).toEqual({
      from: "first-host.example",
      to: "second-host.example",
    });

    // Never cleared by a check, and the first sighting is kept: neither moving back nor a timeout
    // retires it — a person has to look.
    await verifier(landsOn(firstHost)).verify(rowId);
    await verifier(timingOut).verify(rowId);
    expect((await flag())?.getTime()).toBe(flaggedAt?.getTime());
    await expectLinkOut(id, "apply", leaving(id, "apply", "landing_changed"));

    const saved = await reviewerSaves(id);
    expect(saved.reviewStatus).toBe("approved");
    expect(await flag(), "a reviewer's save clears the landing flag").toBeNull();
    await expectLinkOut(id, "apply", vanity);
  });

  describe("compares with the last ANSWERED, APPLIED check, never with whatever the run log holds", () => {
    const vanity = "https://go.m5link-short.example/baseline";
    const siteA = "https://forms.site-a.example/m5link";
    const siteB = "https://forms.site-b.example/m5link";
    const page = { body: sourcePage({ title: "Link-out baseline fixture" }) };
    const landsOn = (destination: string) =>
      fixtureTransport({
        [vanity]: { status: 302, headers: { location: destination } },
        [destination]: page,
      });
    /** The entry is saved while its source is being fetched, so the run is recorded but stale. */
    const savedMidFetch =
      (publicId: string, inner: SourceTransport): SourceTransport =>
      async (url, options) => {
        // What an unchanged `PUT` by its verified publisher does to the row the check compares.
        await db
          .update(opportunities)
          .set({ updatedAt: new Date() })
          .where(eq(opportunities.publicId, publicId));
        return inner(url, options);
      };

    async function landingAt(id: string) {
      await seedImport(id, { applicationUrl: vanity, website: SITE_URL });
      const { id: rowId } = await rowOf(id);
      await verifier(landsOn(siteA)).verify(rowId);
      expect((await rowOf(id)).linkLandingFinalUrl).toBe(siteA);
      return rowId;
    }

    it("A, a timeout, then B: flagged", async () => {
      const id = `${NS}:baseline-timeout`;
      const rowId = await landingAt(id);
      await verifier(timingOut).verify(rowId);
      await verifier(landsOn(siteB)).verify(rowId);
      expect((await rowOf(id)).linkLandingChangedAt).not.toBeNull();
      await expectLinkOut(id, "apply", leaving(id, "apply", "landing_changed"));
    });

    it("A, a stale fetch of B, then B: flagged, and the stale run moved nothing", async () => {
      const id = `${NS}:baseline-stale`;
      const rowId = await landingAt(id);
      await verifier(savedMidFetch(id, landsOn(siteB))).verify(rowId);
      const afterStale = await rowOf(id);
      expect(afterStale.linkLandingChangedAt, "a stale run is not a verdict").toBeNull();
      expect(afterStale.linkLandingFinalUrl, "…and does not become the baseline").toBe(siteA);
      await verifier(landsOn(siteB)).verify(rowId);
      expect((await rowOf(id)).linkLandingChangedAt).not.toBeNull();
      await expectLinkOut(id, "apply", leaving(id, "apply", "landing_changed"));
    });

    it("A, then enough timeouts to prune A from the run log, then B: still flagged", async () => {
      const id = `${NS}:baseline-pruned`;
      const rowId = await landingAt(id);
      for (let i = 0; i < config.verification.runsKeep; i++) {
        await verifier(timingOut).verify(rowId);
      }
      const answeredLeft = await db
        .select({ id: verificationRuns.id })
        .from(verificationRuns)
        .where(and(eq(verificationRuns.opportunityId, rowId), isNull(verificationRuns.error)));
      expect(answeredLeft, "the answered check on A has been pruned").toHaveLength(0);
      await verifier(landsOn(siteB)).verify(rowId);
      expect((await rowOf(id)).linkLandingChangedAt).not.toBeNull();
    });

    it("0017's baseline backfill picks the last answered, applied check of the current URL", async () => {
      const id = `${NS}:baseline-backfill`;
      const rowId = await landingAt(id);
      // Two runs after A that must NOT become the baseline: a stale fetch of B, and a timeout.
      await verifier(savedMidFetch(id, landsOn(siteB))).verify(rowId);
      await verifier(timingOut).verify(rowId);
      // The state of every row before 0017 runs: no baseline at all.
      await db
        .update(opportunities)
        .set({ linkLandingRequestedUrl: null, linkLandingFinalUrl: null })
        .where(eq(opportunities.id, rowId));

      const migration = readFileSync(
        new URL("../../src/db/migrations/0017_link_out_reviewed_destinations.sql", import.meta.url),
        "utf8",
      );
      const backfill = migration
        .split("--> statement-breakpoint")
        .find((chunk) => chunk.includes('"link_landing_requested_url" = r."requested_url"'))
        ?.trim();
      expect(backfill).toMatch(/^-- BACKFILL THE LANDING BASELINE[\s\S]*;$/);
      // Narrowed to this row, for the same reason as the pin backfill above.
      await pool.query(`${backfill?.replace(/;$/, "")} AND o."id" = $1`, [rowId]);

      const row = await rowOf(id);
      expect(row.linkLandingRequestedUrl).toBe(vanity);
      expect(row.linkLandingFinalUrl).toBe(siteA);
      await verifier(landsOn(siteB)).verify(rowId);
      expect((await rowOf(id)).linkLandingChangedAt).not.toBeNull();
    });
  });

  it("builds the leaving page from APP_BASE_URL and percent-encodes the id's colon", async () => {
    const id = `${NS}:encoded`;
    await seedImport(id, { status: "closed", applicationUrl: APPLY_URL });
    const original = config.appBaseUrl;
    try {
      config.appBaseUrl = "https://hub.m5link.example";
      const res = await app.inject({
        url: `/v1/r/${encodeURIComponent(id)}/apply`,
        headers: READER,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        "https://hub.m5link.example/leaving/m5link%3Aencoded?link=apply&reason=closed",
      );
    } finally {
      config.appBaseUrl = original;
    }
  });

  it("keeps every 404 a 404, counts none of them, and never shows an unsafe link on the leaving page", async () => {
    const pending = `${NS}:404-pending`;
    const unlisted = `${NS}:404-unlisted`;
    const scripted = `${NS}:404-script`;
    const plaintext = `${NS}:404-plaintext`;
    const closedScript = `${NS}:404-closed-script`;
    await seedImport(pending, { reviewStatus: "pending", applicationUrl: APPLY_URL });
    await seedImport(unlisted, { isListed: false, applicationUrl: APPLY_URL });
    await seedImport(scripted, { applicationUrl: "javascript:alert(1)" });
    await seedImport(plaintext, { applicationUrl: "http://apply.m5link.example/form" });
    // The leaving page offers to continue to the link, so a URL the redirect will not emit is not
    // one to show there either: closed or not, it stays a 404.
    await seedImport(closedScript, { status: "closed", applicationUrl: "javascript:alert(1)" });

    const cases: Array<[string, LinkKind]> = [
      [pending, "apply"],
      [unlisted, "apply"],
      [scripted, "apply"],
      [scripted, "source"], // no website stored at all
      [plaintext, "apply"],
      [closedScript, "apply"],
    ];
    for (const [publicId, kind] of cases) {
      const res = await app.inject({
        url: `/v1/r/${encodeURIComponent(publicId)}/${kind}`,
        headers: READER,
      });
      expect(res.statusCode, `${kind} of ${publicId}`).toBe(404);
      expect(res.headers.location).toBeUndefined();
      expect(await clicks(publicId, kind, startedAt), `${kind} of ${publicId} counts nothing`).toBe(
        0,
      );
    }
    const missing = await app.inject({ url: `/v1/r/${encodeURIComponent(`${NS}:nothere`)}/apply` });
    expect(missing.statusCode).toBe(404);
  });
});

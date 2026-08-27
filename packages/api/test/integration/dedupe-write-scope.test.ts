/**
 * The write path detects at BOTH candidate scopes: one is answered, the other is only recorded.
 *
 * Isolation tag: `M3WSC` / `m3wsc:`.
 *
 * THE FAILURE THIS PINS. `scope` used to narrow the CANDIDATES, which silently narrowed the pair
 * table with them. The write path searched public rows only — correctly, for a response read by
 * whoever posted — and the only all-scope caller was `embedding-backfill`, whose predicate is "this
 * entry has no CURRENT embedding", which the write path had just satisfied. Approval does not
 * re-detect either. So a pair whose sides were BOTH pending could not be recorded by anything, and
 * `/v1/review/duplicates` — the surface built for exactly that decision — never showed it.
 *
 * `scope` now narrows the MATCHES on the way out instead, and both halves of that need a test: the
 * reviewer queue must carry every pair the one search found, and the 201 body must still name only
 * counterparts that are approved and listed. A regression in either direction is a bug — a missing
 * pair is the queue going blind, an extra one in the body is a submission becoming a way to read
 * the review queue's titles and ids.
 *
 * Module-load choreography (`EMBEDDING_PROVIDER` before any config-reaching import) is the same as
 * `duplicates.test.ts`, for the reason spelled out there: `config.ts` reads the environment once at
 * module load and the submissions controller builds its `DedupeService` from it at module scope.
 *
 * The bodies are this suite's OWN cluster and not the shared `ALPHA_BODY` one — see the rule at the
 * top of `helpers/dedupe-text.ts`, which is what keeps two parallel suites from competing for each
 * other's `DEDUPE_MAX_MATCHES` slots.
 */
process.env.EMBEDDING_PROVIDER = "lexical";

import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ARCHIVE_BODY, COMPOST_BODY, reword } from "../helpers/dedupe-text.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const { buildApp } = await import("../../src/app.js");
const { db, pool } = await import("../../src/db/client.js");
const { opportunities, opportunityDuplicates } = await import("../../src/db/schema.js");
const { bearer, grantMembership, seedIdentity, seedOrganization, testAuth } = await import(
  "../helpers/auth.js"
);
const { cleanupFixtures } = await import("../helpers/cleanup.js");
const { DedupeService } = await import("../../src/modules/services/dedupe/dedupe.service.js");

const NS = "m3wsc";
const OTHER_NS = "m3wsc-other";
const EMAILS = {
  publisher: "m3wsc-publisher@rfphub.invalid",
  stranger: "m3wsc-stranger@rfphub.invalid",
  reviewer: "m3wsc-reviewer@rfphub.invalid",
};

const run = describeWithDb;

/** A submission carrying a real body, so the bag-of-words provider has something to work with. */
function entry(id: string, title: string, body: string, namespace: string) {
  return submission(id, namespace, {
    title,
    description: body,
    ecosystems: ["M3WSC"],
  } as Record<string, unknown>);
}

/**
 * One vector in this deployment's own live space before the first request.
 *
 * The integration files share a database and deliberately boot different providers; without a
 * sentinel of our own, their rows can make the corpus non-empty while this app has zero compatible
 * vectors — correctly tripping the production provider-switch guard for what is only harness
 * overlap. `duplicates.test.ts` does the same thing for the same reason.
 */
async function seedCompatibleCorpus(): Promise<void> {
  const rows = await db
    .insert(opportunities)
    .values({
      publicId: `${NS}coverage:sentinel`,
      fundingType: "accelerator",
      status: "open",
      title: "Alpine glaciology instrumentation residency",
      description:
        "Field glaciologists install ablation stakes and automatic weather stations on a retreating valley glacier and publish the resulting mass-balance series openly.",
      operatingOrganizations: [{ name: "M3WSC coverage fixture", slug: `${NS}coverage` }],
      reviewStatus: "approved",
      isListed: true,
    })
    .returning({ id: opportunities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("failed to seed the lexical corpus sentinel");
  await new DedupeService().embedAndDetect(id, "public");
}

run("M3WSC one detection, and the scope filters the answer", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let strangerToken: string;
  let reviewerToken: string;
  const userIds: string[] = [];

  const post = async (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/opportunities", headers: bearer(token), payload });

  const rowIdOf = async (publicId: string): Promise<number> => {
    const rows = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`no row for ${publicId}`);
    return id;
  };

  /** Every stored row naming both entries — a list, because "exactly one" is an assertion here. */
  const pairsBetween = async (left: string, right: string) => {
    const [a, b] = [await rowIdOf(left), await rowIdOf(right)];
    return db
      .select()
      .from(opportunityDuplicates)
      .where(
        or(
          and(
            eq(opportunityDuplicates.opportunityId, a),
            eq(opportunityDuplicates.duplicateOfId, b),
          ),
          and(
            eq(opportunityDuplicates.opportunityId, b),
            eq(opportunityDuplicates.duplicateOfId, a),
          ),
        ),
      );
  };

  /** Both sides of every suspected pair the reviewer queue is currently serving. */
  const reviewerQueueSides = async (): Promise<string[]> => {
    const res = await app.inject({
      url: "/v1/review/duplicates?status=suspected&limit=200",
      headers: bearer(reviewerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res
      .json()
      .items.flatMap((pair: { left: { id: string }; right: { id: string } }) => [
        pair.left.id,
        pair.right.id,
      ]);
  };

  /** This suite's own ids among a submission response's disclosed matches. */
  const disclosed = (response: { json(): { duplicates: { id: string }[] } }): string[] =>
    response
      .json()
      .duplicates.map((duplicate) => duplicate.id)
      .filter((id) => id.startsWith("m3wsc"));

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3wsc-publisher" });
    const stranger = await seedIdentity(EMAILS.stranger, { handle: "m3wsc-stranger" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3wsc-reviewer",
      role: "reviewer",
    });
    const org = await seedOrganization({ slug: NS, verified: true });
    await seedOrganization({ slug: OTHER_NS, verified: false });
    await grantMembership(publisher.account.id, org.id, "owner");
    await seedCompatibleCorpus();
    userIds.push(publisher.userId, stranger.userId, reviewer.userId);

    publisherToken = publisher.token;
    strangerToken = stranger.token;
    reviewerToken = reviewer.token;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS, OTHER_NS, `${NS}coverage`],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  // ── the pair that could not exist ─────────────────────────────────────────────
  it("pairs two PENDING submissions for the reviewer without naming either in the response", async () => {
    // A stranger's submissions into a namespace they do not publish for land PENDING, so neither
    // side is ever in the public candidate set. Before the reviewer-scope pass, that made this
    // pair unreachable: not by the submit-time check, which searches public rows only, and not by
    // the backfill, whose predicate the submit-time embedding has already retired.
    const first = await post(
      strangerToken,
      entry(
        `${OTHER_NS}:queued-one`,
        "Municipal Composting Cooperative Fund",
        COMPOST_BODY,
        OTHER_NS,
      ),
    );
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().reviewStatus).toBe("pending");
    expect(first.json().duplicateCheck).toBe("ok");

    const second = await post(
      strangerToken,
      entry(
        `${OTHER_NS}:queued-two`,
        "Municipal Composting Cooperative Fund | Mirror",
        reword(COMPOST_BODY),
        OTHER_NS,
      ),
    );
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().reviewStatus).toBe("pending");

    // THE RESPONSE IS STILL PUBLIC-ONLY. Detection found the counterpart — the pair below proves
    // it — and the filter on the way out is what keeps it out of the body. Nothing pending is
    // named, the submitter's own counterpart included: the rule that stops the 201 enumerating the
    // review queue cannot have an exception for the easy case.
    expect(second.json().duplicateCheck).toBe("ok");
    expect(disclosed(second)).toEqual([]);

    // …but the pair exists, suspected, and the reviewer queue serves it.
    const pairs = await pairsBetween(`${OTHER_NS}:queued-one`, `${OTHER_NS}:queued-two`);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.status).toBe("suspected");

    const sides = await reviewerQueueSides();
    expect(sides).toContain(`${OTHER_NS}:queued-one`);
    expect(sides).toContain(`${OTHER_NS}:queued-two`);

    // The owner is told, without being told WHAT: both sides are theirs, but neither is public,
    // and the payload names a counterpart only while it is approved and listed.
    const inbox = await app.inject({
      url: "/v1/me/notifications?limit=100",
      headers: bearer(strangerToken),
    });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const suspected = inbox
      .json()
      .items.filter(
        (item: { kind: string; payload: { pairId: number } }) =>
          item.kind === "duplicate_suspected" && item.payload.pairId === pairs[0]?.id,
      );
    expect(suspected).toHaveLength(1);
    expect(suspected[0].payload.otherListing).toBeUndefined();
  });

  // ── the mixed pair, from the pending side ─────────────────────────────────────
  it("pairs a PENDING entry with a public one and still discloses only the public side", async () => {
    const anchor = await post(
      publisherToken,
      entry(`${NS}:public-anchor`, "Endangered Paper Archive Digitisation Fund", ARCHIVE_BODY, NS),
    );
    expect(anchor.statusCode, anchor.body).toBe(201);
    expect(anchor.json().reviewStatus).toBe("approved");
    expect(anchor.json().isListed).toBe(true);

    const pending = await post(
      strangerToken,
      entry(
        `${OTHER_NS}:pending-copy`,
        "Endangered Paper Archive Digitisation Fund | Mirror",
        reword(ARCHIVE_BODY),
        OTHER_NS,
      ),
    );
    expect(pending.statusCode, pending.body).toBe(201);
    expect(pending.json().reviewStatus).toBe("pending");

    // A public counterpart is exactly what this caller IS entitled to, so the filter keeps it.
    expect(pending.json().duplicateCheck).toBe("ok");
    expect(disclosed(pending)).toEqual([`${NS}:public-anchor`]);

    const pairs = await pairsBetween(`${NS}:public-anchor`, `${OTHER_NS}:pending-copy`);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.status).toBe("suspected");
    expect(await reviewerQueueSides()).toEqual(
      expect.arrayContaining([`${NS}:public-anchor`, `${OTHER_NS}:pending-copy`]),
    );

    // The privacy filter runs per RECIPIENT, not per pair: the pending entry's owner is told which
    // public listing they collided with, and the public listing's owner is not told whose queued
    // draft collided with them.
    const pairId = pairs[0]?.id;
    const payloadFor = async (token: string) => {
      const inbox = await app.inject({
        url: "/v1/me/notifications?limit=100",
        headers: bearer(token),
      });
      expect(inbox.statusCode, inbox.body).toBe(200);
      const items = inbox
        .json()
        .items.filter(
          (item: { kind: string; payload: { pairId: number } }) =>
            item.kind === "duplicate_suspected" && item.payload.pairId === pairId,
        );
      expect(items).toHaveLength(1);
      return items[0].payload;
    };

    expect((await payloadFor(strangerToken)).otherListing).toEqual({
      id: `${NS}:public-anchor`,
      title: "Endangered Paper Archive Digitisation Fund",
    });
    expect((await payloadFor(publisherToken)).otherListing).toBeUndefined();
  });

  // ── re-detection is a refresh, not a duplicator ───────────────────────────────
  it("records the same pair once however many times detection re-runs", async () => {
    const before = await pairsBetween(`${OTHER_NS}:queued-one`, `${OTHER_NS}:queued-two`);
    expect(before).toHaveLength(1);

    // Re-checked from BOTH sides and at BOTH scopes, which is every way the pair can be reached.
    // `ux_dup_pair` is unique on `(least, greatest)`, so the mirrored ordering is the same key
    // rather than a second row with its own status — and `returning()` keeps the re-detections
    // from emitting a second event.
    const dedupe = new DedupeService();
    await dedupe.check(await rowIdOf(`${OTHER_NS}:queued-two`), "public");
    await dedupe.check(await rowIdOf(`${OTHER_NS}:queued-one`), "all");

    const after = await pairsBetween(`${OTHER_NS}:queued-one`, `${OTHER_NS}:queued-two`);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.status).toBe("suspected");

    const inbox = await app.inject({
      url: "/v1/me/notifications?limit=100",
      headers: bearer(strangerToken),
    });
    expect(
      inbox
        .json()
        .items.filter(
          (item: { kind: string; payload: { pairId: number } }) =>
            item.kind === "duplicate_suspected" && item.payload.pairId === before[0]?.id,
        ),
    ).toHaveLength(1);
  });
});

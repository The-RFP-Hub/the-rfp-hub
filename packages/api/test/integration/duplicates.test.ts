/**
 * Duplicate detection end to end: the submit-time check, the leak rule, pair hygiene, and the merge.
 *
 * Isolation tag: `M3DUP` / `m3dup:`.
 *
 * WHY THIS FILE SETS ITS OWN `EMBEDDING_PROVIDER` AND IMPORTS DYNAMICALLY. `config.ts` reads the
 * environment once, at module load, and the submissions controller builds its `DedupeService` at
 * module scope from that. A static `import` is hoisted above every statement in the file, so setting
 * the variable in the body would happen after the config had already been frozen. Vitest gives each
 * test FILE its own module registry, so setting it here and importing after is both correct and
 * contained. CI sets the same variable globally (`.github/workflows/ci.yml`); this makes the suite
 * self-sufficient rather than dependent on that, which matters when somebody runs one file by hand.
 */
process.env.EMBEDDING_PROVIDER = "lexical";

import { and, eq, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../src/modules/services/dedupe/embedding-provider.js";
import { ALPHA_BODY, UNRELATED_BODY, reword } from "../helpers/dedupe-text.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

// EVERY import that can reach `config.ts` is dynamic, and that includes the test helpers: they
// import the db client, which imports the config, which reads the environment exactly once. A
// static import of any of them would be evaluated before the assignment above. (`EmbeddingProvider`
// above is `import type` only, erased before any of this ever runs.)
const { buildApp } = await import("../../src/app.js");
const { db, pool } = await import("../../src/db/client.js");
const { auditLog, opportunities, opportunityDuplicates, opportunityEmbeddings } = await import(
  "../../src/db/schema.js"
);
const { contentHash, embeddingText } = await import("../../src/modules/shared/embedding-text.js");
const { LexicalEmbeddingProvider } = await import(
  "../../src/modules/services/dedupe/embedding-provider.js"
);
const { bearer, grantMembership, seedIdentity, seedOrganization, testAuth } = await import(
  "../helpers/auth.js"
);
const { cleanupFixtures } = await import("../helpers/cleanup.js");
const { DedupeService } = await import("../../src/modules/services/dedupe/dedupe.service.js");

const NS = "m3dup";
const OTHER_NS = "m3dup-other";
const EMAILS = {
  publisher: "m3dup-publisher@rfphub.invalid",
  stranger: "m3dup-stranger@rfphub.invalid",
  reviewer: "m3dup-reviewer@rfphub.invalid",
};

const run = describeWithDb;

/**
 * Only the ids this suite created.
 *
 * The integration suites share one database and run concurrently, so a search over every stored
 * vector legitimately sees other suites' fixtures. What this suite is entitled to assert is what it
 * put there itself; filtering by its own namespace is the same isolation every other suite here gets
 * from its `ecosystem` tag.
 */
const ours = (response: { json(): { duplicates: { id: string }[] } }): string[] =>
  response
    .json()
    .duplicates.map((duplicate) => duplicate.id)
    .filter((id) => id.startsWith(`${NS}:`));

/** A submission carrying a real body, so the bag-of-words provider has something to work with. */
function entry(id: string, title: string, body: string, namespace = NS) {
  return submission(id, namespace, {
    title,
    // The body goes in `description` only: the Standard caps `summary` at 500 characters, and
    // `embeddingText` falls back to a truncated description when there is no summary — which is
    // the path a real long-form entry takes anyway.
    description: body,
    ecosystems: ["M3DUP"],
  } as Record<string, unknown>);
}

run("M3DUP duplicate detection", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let strangerToken: string;
  let reviewerToken: string;
  let reviewerAccountId: number;

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

  /** The stored pair naming both entries, whichever way round it was written. */
  const pairBetween = async (left: string, right: string) => {
    const [a, b] = [await rowIdOf(left), await rowIdOf(right)];
    const rows = await db
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
    return rows[0];
  };

  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3dup-publisher" });
    const stranger = await seedIdentity(EMAILS.stranger, { handle: "m3dup-stranger" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3dup-reviewer",
      role: "reviewer",
    });
    const org = await seedOrganization({ slug: NS, verified: true });
    await seedOrganization({ slug: OTHER_NS, verified: false });
    await grantMembership(publisher.account.id, org.id, "owner");
    userIds.push(publisher.userId, stranger.userId, reviewer.userId);

    publisherToken = publisher.token;
    strangerToken = stranger.token;
    reviewerToken = reviewer.token;
    reviewerAccountId = reviewer.account.id;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS, OTHER_NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  // ── T-DUP-1 ───────────────────────────────────────────────────────────────────
  it("surfaces a reworded near-copy in the submission response and persists the pair", async () => {
    const first = await post(
      publisherToken,
      entry(`${NS}:alpha`, "Superchain Builders Fund", ALPHA_BODY),
    );
    expect(first.statusCode, first.body).toBe(201);
    // Nothing to match against yet — and "checked, found nothing" is a different answer from
    // "not checked", which is exactly what `duplicateCheck` exists to distinguish.
    expect(first.json().duplicateCheck).toBe("ok");
    expect(ours(first)).toEqual([]);

    const second = await post(
      publisherToken,
      entry(`${NS}:alpha-copy`, "Superchain Builders Fund | Grants Directory", reword(ALPHA_BODY)),
    );
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().duplicateCheck).toBe("ok");
    expect(ours(second)).toContain(`${NS}:alpha`);
    const submissionMatch = second
      .json()
      .duplicates.find((d: { id: string }) => d.id === `${NS}:alpha`);
    expect(submissionMatch.similarity).toBeGreaterThan(0.74);
    expect(submissionMatch.isPublic).toBe(true);

    const pair = await pairBetween(`${NS}:alpha`, `${NS}:alpha-copy`);
    expect(pair?.status).toBe("suspected");
    if (!pair) throw new Error("missing alpha pair");

    // …and the same pair is what the owner's queue, notification inbox, and the entry's
    // sub-resource serve.
    const mine = await app.inject({ url: "/v1/me/duplicates", headers: bearer(publisherToken) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.length).toBeGreaterThan(0);
    expect(mine.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${NS}:alpha-copy`,
          yourListing: { id: `${NS}:alpha`, title: "Superchain Builders Fund" },
        }),
      ]),
    );
    for (const item of mine.json().items) {
      expect(item.yourListing).toEqual({
        id: expect.any(String),
        title: expect.any(String),
      });
    }

    const inbox = await app.inject({
      url: "/v1/me/notifications?limit=100",
      headers: bearer(publisherToken),
    });
    expect(inbox.statusCode, inbox.body).toBe(200);
    expect(inbox.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "duplicate_suspected",
          subjectId: pair.id,
          payload: expect.objectContaining({
            pairId: pair.id,
            yourListing: {
              id: `${NS}:alpha`,
              title: "Superchain Builders Fund",
            },
          }),
        }),
      ]),
    );

    const sub = await app.inject({ url: `/v1/opportunities/${NS}:alpha-copy/duplicates` });
    expect(sub.statusCode).toBe(200);
    const publicCounterpart = sub.json().items.find((d: { id: string }) => d.id === `${NS}:alpha`);
    expect(publicCounterpart).toEqual(expect.objectContaining({ isPublic: true }));
  });

  // ── T-DUP-2 ───────────────────────────────────────────────────────────────────
  it("finds nothing for an unrelated programme", async () => {
    const res = await post(
      publisherToken,
      entry(`${NS}:unrelated`, "Perpetuals Settlement Bounty", UNRELATED_BODY),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().duplicateCheck).toBe("ok");
    expect(ours(res)).toEqual([]);
  });

  // ── T-DUP-8 ───────────────────────────────────────────────────────────────────
  it("never discloses a pending entry to a submitter's duplicate check", async () => {
    // A stranger's submission into a namespace they do not publish for lands PENDING, so it is
    // invisible to the public reads — and must be invisible here too, or a submission becomes a
    // way to read the review queue's titles and ids.
    //
    // It is filed under OTHER_NS deliberately. A pending entry in the PUBLISHER's own namespace is
    // the publisher's by namespace ownership, so hiding it from them would prove nothing about
    // disclosure and would be wrong besides; the entry a stranger must not learn about is one
    // nobody has given them any relationship to.
    const hidden = await post(
      strangerToken,
      entry(`${OTHER_NS}:hidden`, "Superchain Builders Fund (mirror)", ALPHA_BODY, OTHER_NS),
    );
    expect(hidden.statusCode, hidden.body).toBe(201);
    expect(hidden.json().reviewStatus).toBe("pending");

    const probe = await post(
      publisherToken,
      entry(`${NS}:probe`, "Superchain Builders Fund | Mirror", reword(ALPHA_BODY)),
    );
    expect(probe.statusCode, probe.body).toBe(201);
    expect(ours(probe)).toContain(`${NS}:alpha`);
    expect(probe.json().duplicates.map((match: { id: string }) => match.id)).not.toContain(
      `${OTHER_NS}:hidden`,
    );
  });

  // ── the OTHER direction of the same rule ──────────────────────────────────────
  it("never discloses a pending counterpart to the owner of the entry it was matched against", async () => {
    // The pending submission above recorded a pair with `alpha`, which the PUBLISHER owns. Owning
    // one side of a pair is not entitlement to the other side: `alpha`'s owner is not `hidden`'s
    // owner, and both of the owner-facing routes would otherwise read back a stranger's
    // review-queue title and id.
    const pending = await pairBetween(`${NS}:alpha`, `${OTHER_NS}:hidden`);
    expect(pending, "the fixture only proves anything if the pair exists").toBeTruthy();

    const queue = await app.inject({ url: "/v1/me/duplicates", headers: bearer(publisherToken) });
    expect(queue.statusCode).toBe(200);
    const queued = queue.json().items.map((item: { id: string }) => item.id);
    expect(queued).not.toContain(`${OTHER_NS}:hidden`);

    const sub = await app.inject({
      url: `/v1/opportunities/${NS}:alpha/duplicates`,
      headers: bearer(publisherToken),
    });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().items.map((item: { id: string }) => item.id)).not.toContain(
      `${OTHER_NS}:hidden`,
    );

    // A reviewer, and only a reviewer, sees it — deciding between two entries is what they are for.
    const review = await app.inject({
      url: "/v1/review/duplicates",
      headers: bearer(reviewerToken),
    });
    expect(review.statusCode).toBe(200);
    const sides = review
      .json()
      .items.flatMap((pair: { left: { id: string }; right: { id: string } }) => [
        pair.left.id,
        pair.right.id,
      ]);
    expect(sides).toContain(`${OTHER_NS}:hidden`);

    // Reviewer visibility is not ownership: their account-scoped queue remains empty because none
    // of these pairs touches a listing they submitted or publish by namespace.
    const reviewerMine = await app.inject({
      url: "/v1/me/duplicates",
      headers: bearer(reviewerToken),
    });
    expect(reviewerMine.statusCode).toBe(200);
    expect(reviewerMine.json().items).toEqual([]);
  });

  it("still shows an owner a pair of their OWN entries when neither side is public", async () => {
    // ENTITLEMENT, NOT PUBLICITY, is the question the filter above has to ask. A public-only rule
    // closes the leak and then hides the caller's own work from them: the reviewer-scope pass pairs
    // pending entries with each other, so two of one account's queued submissions are a pair
    // neither side of which is public — and that is exactly the pair this queue exists to surface.
    const twin = await post(
      strangerToken,
      entry(
        `${OTHER_NS}:hidden-twin`,
        "Superchain Builders Fund (mirror copy)",
        reword(ALPHA_BODY),
        OTHER_NS,
      ),
    );
    expect(twin.statusCode, twin.body).toBe(201);
    expect(twin.json().reviewStatus).toBe("pending");

    // The submit-time check searches PUBLIC rows only, so the pair between the two pending entries
    // is not one it can find. The all-scope pass — what the backfill job runs — is.
    await new DedupeService().embedAndDetect(await rowIdOf(`${OTHER_NS}:hidden-twin`), "all");
    expect(await pairBetween(`${OTHER_NS}:hidden`, `${OTHER_NS}:hidden-twin`)).toBeTruthy();
    expect(await pairBetween(`${NS}:alpha`, `${OTHER_NS}:hidden-twin`)).toBeTruthy();

    const mine = await app.inject({ url: "/v1/me/duplicates", headers: bearer(strangerToken) });
    expect(mine.statusCode).toBe(200);
    const items = mine.json().items as Array<{
      id: string;
      isPublic: boolean;
      yourListing: { id: string; title: string };
    }>;

    // The all-owned pair is one stored pair and therefore one row. Its canonical left side is the
    // account side, even though both sides qualify as owned.
    const pendingPair = items.filter(
      (item) =>
        new Set([item.yourListing.id, item.id]).size === 2 &&
        [item.yourListing.id, item.id].every((id) =>
          [`${OTHER_NS}:hidden`, `${OTHER_NS}:hidden-twin`].includes(id),
        ),
    );
    expect(pendingPair).toEqual([
      expect.objectContaining({
        id: `${OTHER_NS}:hidden-twin`,
        isPublic: false,
        yourListing: expect.objectContaining({ id: `${OTHER_NS}:hidden` }),
      }),
    ]);

    // Two owned submissions can match the same public listing. `yourListing` keeps those rows
    // distinct instead of leaving two indistinguishable copies of the public counterpart.
    const againstAlpha = items.filter((item) => item.id === `${NS}:alpha`);
    expect(againstAlpha).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isPublic: true,
          yourListing: expect.objectContaining({ id: `${OTHER_NS}:hidden` }),
        }),
        expect.objectContaining({
          isPublic: true,
          yourListing: expect.objectContaining({ id: `${OTHER_NS}:hidden-twin` }),
        }),
      ]),
    );

    // …and the sub-resource agrees, from either side of the same pair.
    const sub = await app.inject({
      url: `/v1/opportunities/${OTHER_NS}:hidden-twin/duplicates`,
      headers: bearer(strangerToken),
    });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${OTHER_NS}:hidden`, isPublic: false }),
      ]),
    );

    // The leak stays closed: neither pending entry has become visible to the publisher, who owns
    // the public entry they were both matched against.
    const theirs = await app.inject({
      url: "/v1/me/duplicates",
      headers: bearer(publisherToken),
    });
    const queued = theirs.json().items.map((item: { id: string }) => item.id);
    expect(queued).not.toContain(`${OTHER_NS}:hidden`);
    expect(queued).not.toContain(`${OTHER_NS}:hidden-twin`);
  });

  it("re-selects an entry whose stored vector no longer matches its content", async () => {
    // THE FAILURE THIS REPAIRS. An edit lands, the submit-time check fails (a provider timeout, a
    // 429, a missing key) and the entry keeps its OLD vector — same model, same provider. A
    // predicate that only looked for a MISSING embedding row would consider that current forever,
    // and the entry would be searched, matched and pruned against text it no longer has.
    const dedupe = new DedupeService();
    const created = await post(
      publisherToken,
      entry(`${NS}:stale-vector`, "Settlement Layer Bounty", UNRELATED_BODY),
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().duplicateCheck).toBe("ok");

    const rowId = await rowIdOf(`${NS}:stale-vector`);
    expect(await dedupe.pendingEmbeddingIds(10_000)).not.toContain(rowId);

    // The edit, without the embedding update that should have accompanied it.
    await db
      .update(opportunities)
      .set({ description: `${UNRELATED_BODY} — and an entirely rewritten second half.` })
      .where(eq(opportunities.id, rowId));

    expect(await dedupe.pendingEmbeddingIds(10_000)).toContain(rowId);
  });

  it("does not let an OLDER embedding call overwrite a NEWER edit's vector and content hash", async () => {
    // THE RACE. `provider.embed()` is a network round trip taken OUTSIDE any transaction. If the
    // entry is edited — and independently re-embedded — WHILE an earlier request's own `embed()`
    // call is still in flight, and that earlier request's write then lands AFTER the newer one's,
    // an unconditional upsert would silently revert the fresh vector and content hash to the
    // stale ones. Modelled here without real concurrency: the fake provider's embed() call, which
    // stands in for the OLDER request's in-flight network round trip, performs the newer edit AND
    // its own already-finished embedding as a side effect before returning the older, now-stale
    // vector.
    const created = await post(
      publisherToken,
      entry(`${NS}:racing-embed`, "Superchain Builders Fund (racing)", UNRELATED_BODY),
    );
    expect(created.statusCode, created.body).toBe(201);
    const rowId = await rowIdOf(`${NS}:racing-embed`);

    const real = new LexicalEmbeddingProvider();
    const project = (row: {
      title: string;
      summary: string | null;
      description: string;
      fundingType: string;
      ecosystems: string[];
      categories: string[];
      operatingOrganizations: unknown;
      // biome-ignore lint/suspicious/noExplicitAny: mirrors `embeddingTextFor`'s own field set
    }) => embeddingText(row as any);

    let calls = 0;
    const racing: EmbeddingProvider = {
      id: real.id,
      model: real.model,
      dimensions: real.dimensions,
      async embed(text: string) {
        calls++;
        if (calls === 1) {
          await db
            .update(opportunities)
            .set({ description: `${UNRELATED_BODY} — and a second, later edit's content.` })
            .where(eq(opportunities.id, rowId));
          const newer = (
            await db.select().from(opportunities).where(eq(opportunities.id, rowId)).limit(1)
          )[0];
          if (!newer) throw new Error("row vanished mid-race");
          const newerHash = contentHash(project(newer), real.model, real.id);
          await db
            .insert(opportunityEmbeddings)
            .values({
              opportunityId: rowId,
              model: real.model,
              providerId: real.id,
              embedding: real.embedSync(project(newer)),
              contentHash: newerHash,
            })
            .onConflictDoUpdate({
              target: opportunityEmbeddings.opportunityId,
              set: {
                model: real.model,
                providerId: real.id,
                embedding: real.embedSync(project(newer)),
                contentHash: newerHash,
              },
            });
        }
        return real.embed(text);
      },
    };

    await new DedupeService(db, { provider: racing }).embedAndDetect(rowId, "all");

    const stored = (
      await db
        .select()
        .from(opportunityEmbeddings)
        .where(eq(opportunityEmbeddings.opportunityId, rowId))
        .limit(1)
    )[0];
    const finalRow = (
      await db.select().from(opportunities).where(eq(opportunities.id, rowId)).limit(1)
    )[0];
    if (!finalRow) throw new Error("row vanished");
    const expectedHash = contentHash(project(finalRow), real.model, real.id);

    // The NEWER edit's hash survives — the older, in-flight call's stale result never landed.
    expect(stored?.contentHash).toBe(expectedHash);
  });

  // ── T-DUP-6 ───────────────────────────────────────────────────────────────────
  it("deletes a suspected pair when an update removes the similarity", async () => {
    const before = await pairBetween(`${NS}:alpha`, `${NS}:alpha-copy`);
    expect(before?.status).toBe("suspected");

    const res = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${NS}:alpha-copy`,
      headers: bearer(publisherToken),
      payload: entry(`${NS}:alpha-copy`, "Perpetuals Settlement Bounty", UNRELATED_BODY),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await pairBetween(`${NS}:alpha`, `${NS}:alpha-copy`)).toBeUndefined();
  });

  // ── T-DUP-5 ───────────────────────────────────────────────────────────────────
  it("reopens only dismissed pairs, returns them to review, and audits the transition once", async () => {
    const original = await post(
      publisherToken,
      entry(`${NS}:reopen`, "Superchain Reopen Fund", ALPHA_BODY),
    );
    expect(original.statusCode, original.body).toBe(201);
    const copy = await post(
      publisherToken,
      entry(`${NS}:reopen-copy`, "Superchain Reopen Fund | Directory", reword(ALPHA_BODY)),
    );
    expect(copy.statusCode, copy.body).toBe(201);

    const pair = await pairBetween(`${NS}:reopen`, `${NS}:reopen-copy`);
    expect(pair, "reopen fixtures should be suspected duplicates").toBeTruthy();
    if (!pair) throw new Error("missing reopen pair");

    // A retry that arrives before the dismissal is already in the requested state: success, with
    // neither a timestamp rewrite nor a fictional transition in the append-only audit trail.
    const alreadySuspected = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair.id}/reopen`,
      headers: bearer(reviewerToken),
    });
    expect(alreadySuspected.statusCode, alreadySuspected.body).toBe(200);
    expect(alreadySuspected.json().status).toBe("suspected");

    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair.id}/confirm`,
      headers: bearer(reviewerToken),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().status).toBe("confirmed");

    const confirmedReopen = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair.id}/reopen`,
      headers: bearer(reviewerToken),
    });
    expect(confirmedReopen.statusCode, confirmedReopen.body).toBe(409);
    expect(confirmedReopen.json()).toEqual(
      expect.objectContaining({
        error: "duplicate_not_dismissed",
        message: expect.stringContaining("confirmed, not dismissed"),
      }),
    );

    // Confirmed ↔ dismissed remains an ordinary decision; reopen starts only after that dismissal.
    const dismissed = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair.id}/dismiss`,
      headers: bearer(reviewerToken),
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json().status).toBe("dismissed");
    expect(
      (await new DedupeService().listForReview("suspected", 200)).some(
        (candidate) => candidate.id === pair.id,
      ),
    ).toBe(false);

    const reopened = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair.id}/reopen`,
      headers: bearer(reviewerToken),
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json()).toEqual(
      expect.objectContaining({ id: pair.id, status: "suspected", reviewedAt: expect.any(String) }),
    );
    expect(
      (await new DedupeService().listForReview("suspected", 200)).map((candidate) => candidate.id),
    ).toContain(pair.id);

    const stored = await pairBetween(`${NS}:reopen`, `${NS}:reopen-copy`);
    expect(stored).toEqual(
      expect.objectContaining({
        status: "suspected",
        reviewedBy: reviewerAccountId,
        reviewedAt: expect.any(Date),
      }),
    );
    const reopenAudits = await db
      .select({
        subjectKind: auditLog.subjectKind,
        subjectId: auditLog.subjectId,
        actorKind: auditLog.actorKind,
        actorAccountId: auditLog.actorAccountId,
        action: auditLog.action,
        patch: auditLog.patch,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "duplicate"),
          eq(auditLog.subjectId, pair.id),
          eq(auditLog.action, "reopen"),
        ),
      );
    expect(reopenAudits).toEqual([
      {
        subjectKind: "duplicate",
        subjectId: pair.id,
        actorKind: "user",
        actorAccountId: reviewerAccountId,
        action: "reopen",
        patch: { status: { before: "dismissed", after: "suspected" } },
      },
    ]);

    const repeated = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair.id}/reopen`,
      headers: bearer(reviewerToken),
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toEqual(reopened.json());
    const auditCount = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "duplicate"),
          eq(auditLog.subjectId, pair.id),
          eq(auditLog.action, "reopen"),
        ),
      );
    expect(auditCount).toHaveLength(1);

    // These deliberately near-identical fixtures have finished their job. Remove them before the
    // later ANN tests so they do not consume slots in the detector's fixed top-20 candidate window.
    await db
      .delete(opportunities)
      .where(inArray(opportunities.publicId, [`${NS}:reopen`, `${NS}:reopen-copy`]));
  });

  it("never resurrects a dismissed pair", async () => {
    const pair = await pairBetween(`${NS}:alpha`, `${NS}:probe`);
    expect(pair).toBeTruthy();

    const dismissed = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair?.id}/dismiss`,
      headers: bearer(reviewerToken),
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json().status).toBe("dismissed");

    // Re-submitting the identical content re-runs detection over the same neighbours.
    const again = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${NS}:probe`,
      headers: bearer(publisherToken),
      payload: entry(`${NS}:probe`, "Superchain Builders Fund | Mirror", reword(ALPHA_BODY)),
    });
    expect(again.statusCode, again.body).toBe(200);
    expect((await pairBetween(`${NS}:alpha`, `${NS}:probe`))?.status).toBe("dismissed");
  });

  // ── T-DUP-4 and T-DUP-7 ───────────────────────────────────────────────────────
  it("merges a pair, retires the loser, and refuses a survivor that was itself merged", async () => {
    const beta = await post(
      publisherToken,
      entry(`${NS}:beta`, "Superchain Builders Fund Cohort", ALPHA_BODY),
    );
    expect(beta.statusCode, beta.body).toBe(201);
    const betaCopy = await post(
      publisherToken,
      entry(`${NS}:beta-copy`, "Superchain Builders Fund Cohort | Directory", reword(ALPHA_BODY)),
    );
    expect(betaCopy.statusCode, betaCopy.body).toBe(201);

    const pair = await pairBetween(`${NS}:beta`, `${NS}:beta-copy`);
    expect(pair, "beta and its copy should be suspected duplicates").toBeTruthy();

    const merged = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair?.id}/merge`,
      headers: bearer(reviewerToken),
      payload: { survivorId: `${NS}:beta` },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().survivorId).toBe(`${NS}:beta`);
    expect(merged.json().mergedId).toBe(`${NS}:beta-copy`);
    expect(merged.json().copiedFields).toEqual([]);

    const reopened = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair?.id}/reopen`,
      headers: bearer(reviewerToken),
    });
    expect(reopened.statusCode, reopened.body).toBe(409);
    expect(reopened.json().error).toBe("already_merged");

    // The loser's old public id remains a 404, enriched only with its currently-public survivor.
    const formerPublic = await app.inject({ url: `/v1/opportunities/${NS}:beta-copy` });
    expect(formerPublic.statusCode).toBe(404);
    expect(formerPublic.json()).toEqual({
      error: "opportunity_merged",
      mergedInto: {
        id: `${NS}:beta`,
        title: "Superchain Builders Fund Cohort",
      },
    });
    expect((await app.inject({ url: `/v1/opportunities/${NS}:beta` })).statusCode).toBe(200);
    const loser = (
      await db
        .select()
        .from(opportunities)
        .where(eq(opportunities.publicId, `${NS}:beta-copy`))
        .limit(1)
    )[0];
    expect(loser?.reviewStatus).toBe("rejected");
    expect(loser?.isListed).toBe(false);
    expect(loser?.status).toBe("archived");
    expect(loser?.mergedIntoId).toBe(await rowIdOf(`${NS}:beta`));
    expect(loser?.mergedFromPublic).toBe(true);

    const mine = await app.inject({
      url: `/v1/me/opportunities?id=${encodeURIComponent(`${NS}:beta-copy`)}`,
      headers: bearer(publisherToken),
    });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().items).toEqual([
      expect.objectContaining({
        id: `${NS}:beta-copy`,
        mergedInto: {
          id: `${NS}:beta`,
          title: "Superchain Builders Fund Cohort",
        },
      }),
    ]);

    // The owner remains entitled to the survivor id through the merge audit, but unlisting the
    // survivor makes its current title private and removes the public destination the UI could
    // safely link to.
    const unlisted = await app.inject({
      method: "PATCH",
      url: `/v1/review/opportunities/${NS}:beta`,
      headers: bearer(reviewerToken),
      payload: { isListed: false },
    });
    expect(unlisted.statusCode, unlisted.body).toBe(200);
    const mineWithHiddenSurvivor = await app.inject({
      url: `/v1/me/opportunities?id=${encodeURIComponent(`${NS}:beta-copy`)}`,
      headers: bearer(publisherToken),
    });
    expect(mineWithHiddenSurvivor.statusCode, mineWithHiddenSurvivor.body).toBe(200);
    expect(mineWithHiddenSurvivor.json().items).toEqual([
      expect.objectContaining({
        id: `${NS}:beta-copy`,
        mergedInto: { id: `${NS}:beta`, title: null },
      }),
    ]);
    const relisted = await app.inject({
      method: "PATCH",
      url: `/v1/review/opportunities/${NS}:beta`,
      headers: bearer(reviewerToken),
      payload: { isListed: true },
    });
    expect(relisted.statusCode, relisted.body).toBe(200);

    // A merge is terminal at the services that own every revival path: create/replace, both
    // approval authorities, and the listing decision route all return the same stable conflict.
    const loserDocument = entry(
      `${NS}:beta-copy`,
      "Superchain Builders Fund Cohort | Directory",
      reword(ALPHA_BODY),
    );
    const revivalAttempts = [
      await app.inject({
        method: "PUT",
        url: `/v1/opportunities/${NS}:beta-copy`,
        headers: bearer(publisherToken),
        payload: loserDocument,
      }),
      await app.inject({
        method: "POST",
        url: "/v1/opportunities",
        headers: bearer(publisherToken),
        payload: loserDocument,
      }),
      await app.inject({
        method: "POST",
        url: `/v1/review/opportunities/${NS}:beta-copy/approve`,
        headers: bearer(reviewerToken),
        payload: {},
      }),
      await app.inject({
        method: "POST",
        url: `/v1/organizations/${NS}/opportunities/${NS}:beta-copy/approve`,
        headers: bearer(publisherToken),
      }),
      await app.inject({
        method: "PATCH",
        url: `/v1/review/opportunities/${NS}:beta-copy`,
        headers: bearer(reviewerToken),
        payload: { isListed: true },
      }),
    ];
    for (const attempt of revivalAttempts) {
      expect(attempt.statusCode, attempt.body).toBe(409);
      expect(attempt.json().error).toBe("opportunity_merged");
    }

    // One audit row on EACH entry: "this absorbed that" and "this was absorbed" are different facts.
    for (const publicId of [`${NS}:beta`, `${NS}:beta-copy`]) {
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.subjectKind, "opportunity"),
            eq(auditLog.subjectId, await rowIdOf(publicId)),
            eq(auditLog.action, "merge"),
          ),
        );
      expect(rows.length, `merge audit row for ${publicId}`).toBe(1);
    }

    // T-DUP-7: the loser is now a merge TARGET nobody may name — that check is what stops chains,
    // and transitively cycles.
    const gamma = await post(
      publisherToken,
      entry(`${NS}:gamma`, "Superchain Builders Fund Cohort Two", ALPHA_BODY),
    );
    expect(gamma.statusCode, gamma.body).toBe(201);
    const chained = await pairBetween(`${NS}:gamma`, `${NS}:beta-copy`);
    if (chained) {
      const refused = await app.inject({
        method: "POST",
        url: `/v1/review/duplicates/${chained.id}/merge`,
        headers: bearer(reviewerToken),
        payload: { survivorId: `${NS}:beta-copy` },
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(["survivor_already_merged", "survivor_not_public"]).toContain(refused.json().error);
    }
  });

  it("refuses to merge a LOSER that is already the survivor of an earlier merge — the other chain", async () => {
    // The check above (`survivor_already_merged`) refuses a SURVIVOR that already points elsewhere.
    // That alone does not stop A → B → C: nothing stopped B, having already absorbed A, from being
    // chosen as the LOSER of a later B/C pair — B still shows `mergedIntoId: null` right up until
    // that second merge would set it. Three mutually similar entries reproduce it: A merges into B
    // (B now has a dependent), then a genuinely pre-existing B/C pair attempts C as survivor and B
    // as loser.
    const a = await post(
      publisherToken,
      entry(`${NS}:chain-a`, "Superchain Chain Fund", ALPHA_BODY),
    );
    expect(a.statusCode, a.body).toBe(201);
    const b = await post(
      publisherToken,
      entry(`${NS}:chain-b`, "Superchain Chain Fund | Mirror", reword(ALPHA_BODY)),
    );
    expect(b.statusCode, b.body).toBe(201);
    const c = await post(
      publisherToken,
      entry(`${NS}:chain-c`, "Superchain Chain Fund | Directory", ALPHA_BODY),
    );
    expect(c.statusCode, c.body).toBe(201);

    const abPair = await pairBetween(`${NS}:chain-a`, `${NS}:chain-b`);
    expect(abPair, "chain-a and chain-b should be suspected duplicates").toBeTruthy();
    const bcPair = await pairBetween(`${NS}:chain-b`, `${NS}:chain-c`);
    expect(bcPair, "chain-b and chain-c should be suspected duplicates").toBeTruthy();

    // A → B. B now has a dependent.
    const firstMerge = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${abPair?.id}/merge`,
      headers: bearer(reviewerToken),
      payload: { survivorId: `${NS}:chain-b` },
    });
    expect(firstMerge.statusCode, firstMerge.body).toBe(200);

    // B → C would chain A through B. Refused, even though B itself carries no `mergedIntoId` yet.
    const secondMerge = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${bcPair?.id}/merge`,
      headers: bearer(reviewerToken),
      payload: { survivorId: `${NS}:chain-c` },
    });
    expect(secondMerge.statusCode, secondMerge.body).toBe(409);
    expect(secondMerge.json().error).toBe("loser_has_dependents");

    // No chain: B is untouched by the refused attempt, and A still names B directly.
    const bRow = (
      await db
        .select()
        .from(opportunities)
        .where(eq(opportunities.publicId, `${NS}:chain-b`))
        .limit(1)
    )[0];
    expect(bRow?.mergedIntoId).toBeNull();
    const aRow = (
      await db
        .select()
        .from(opportunities)
        .where(eq(opportunities.publicId, `${NS}:chain-a`))
        .limit(1)
    )[0];
    expect(aRow?.mergedIntoId).toBe(bRow?.id);
  });

  it("shows a reviewer both sides of a pair, including one that is not public", async () => {
    const res = await app.inject({
      url: "/v1/review/duplicates?status=suspected",
      headers: bearer(reviewerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items;
    expect(Array.isArray(items)).toBe(true);
    for (const item of items) {
      expect(item.left.id).toBeTruthy();
      expect(item.right.id).toBeTruthy();
      expect(item.id).toBeTypeOf("number");
    }
  });

  it("refuses the duplicate queue to a submitter", async () => {
    const res = await app.inject({
      url: "/v1/review/duplicates",
      headers: bearer(publisherToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

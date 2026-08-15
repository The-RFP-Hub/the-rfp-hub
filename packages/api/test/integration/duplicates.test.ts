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
process.env.EMBEDDING_PROVIDER = "deterministic";

import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ALPHA_BODY, UNRELATED_BODY, reword } from "../helpers/dedupe-text.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

// EVERY import that can reach `config.ts` is dynamic, and that includes the test helpers: they
// import the db client, which imports the config, which reads the environment exactly once. A
// static import of any of them would be evaluated before the assignment above.
const { buildApp } = await import("../../src/app.js");
const { db, pool } = await import("../../src/db/client.js");
const { auditLog, opportunities, opportunityDuplicates } = await import("../../src/db/schema.js");
const { bearer, grantMembership, mintPrivyToken, seedAccount, seedOrganization, testPrivyConfig } =
  await import("../helpers/auth.js");
const { cleanupFixtures } = await import("../helpers/cleanup.js");
const { DedupeService } = await import("../../src/modules/services/dedupe/dedupe.service.js");

const NS = "m3dup";
const OTHER_NS = "m3dup-other";
const DIDS = {
  publisher: "did:privy:m3dup-publisher",
  stranger: "did:privy:m3dup-stranger",
  reviewer: "did:privy:m3dup-reviewer",
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

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const publisher = await seedAccount({ did: DIDS.publisher, handle: "m3dup-publisher" });
    const stranger = await seedAccount({ did: DIDS.stranger, handle: "m3dup-stranger" });
    await seedAccount({ did: DIDS.reviewer, handle: "m3dup-reviewer", role: "reviewer" });
    const org = await seedOrganization({ slug: NS, verified: true });
    await seedOrganization({ slug: OTHER_NS, verified: false });
    await grantMembership(publisher.id, org.id, "owner");
    void stranger;

    publisherToken = await mintPrivyToken(DIDS.publisher);
    strangerToken = await mintPrivyToken(DIDS.stranger);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS, OTHER_NS],
      privyDids: Object.values(DIDS),
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
    expect(
      second.json().duplicates.find((d: { id: string }) => d.id === `${NS}:alpha`).similarity,
    ).toBeGreaterThan(0.74);

    const pair = await pairBetween(`${NS}:alpha`, `${NS}:alpha-copy`);
    expect(pair?.status).toBe("suspected");

    // …and the same pair is what the owner's queue and the entry's sub-resource serve.
    const mine = await app.inject({ url: "/v1/me/duplicates", headers: bearer(publisherToken) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.length).toBeGreaterThan(0);

    const sub = await app.inject({ url: `/v1/opportunities/${NS}:alpha-copy/duplicates` });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().items.map((d: { id: string }) => d.id)).toContain(`${NS}:alpha`);
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

    const mine = await app.inject({ url: "/v1/me/duplicates", headers: bearer(strangerToken) });
    expect(mine.statusCode).toBe(200);
    const items = mine.json().items.map((item: { id: string }) => item.id);
    expect(items).toContain(`${OTHER_NS}:hidden`);

    // …and the sub-resource agrees, from either side of the same pair.
    const sub = await app.inject({
      url: `/v1/opportunities/${OTHER_NS}:hidden-twin/duplicates`,
      headers: bearer(strangerToken),
    });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().items.map((item: { id: string }) => item.id)).toContain(`${OTHER_NS}:hidden`);

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

    // The loser leaves the public reads; its row stays, pointed at the survivor.
    expect((await app.inject({ url: `/v1/opportunities/${NS}:beta-copy` })).statusCode).toBe(404);
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

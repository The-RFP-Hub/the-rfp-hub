/**
 * M3-3 — duplicate detection, and what a reviewer can do about it.
 *
 * Determinism first: the stack runs `EMBEDDING_PROVIDER=lexical`, the same in-process featurizer
 * production runs, so a pair either crosses the similarity threshold or it does not, every time —
 * there is no "real provider" variant because the lexical detector IS the real provider.
 * If a fixture pair sits under the threshold, the fixture TEXT is what changes — never the threshold.
 *
 * One thing in this area is recorded rather than tested: "the submitter is notified" is the
 * SYNCHRONOUS response payload and nothing else. No asynchronous notification exists, so there is
 * nothing to wait for and nothing to assert beyond the response — which is asserted below.
 */
import { expect, skipUnlessActor, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

/**
 * Two descriptions of the same programme, worded differently — the pair the detector must catch.
 *
 * PARAMETERISED BY A LABEL, and that is not cosmetic. The embedding text is built from the title,
 * description, funding type, ecosystems and organisations; the public id is NOT part of it. Two
 * fixtures with identical prose therefore produce identical vectors, so every "original" in this
 * file would be an exact duplicate of every other one. Candidate matches are capped
 * (`DEDUPE_MAX_MATCHES`, default 5) and ordered by distance with ties broken arbitrarily, so as the
 * file's fixtures accumulate, an intended counterpart can be crowded out by its own siblings and the
 * pair simply never gets recorded. A distinct subject per test keeps each pair's nearest neighbour
 * its own partner.
 */
function original(label: string) {
  return {
    title: `Protocol Research Grants for ${label} Infrastructure`,
    description: `A grants programme funding open-source ${label} protocol research and public ${label} infrastructure. Awards between five and fifty thousand, rolling applications, focused on ${label} developer tooling, client diversity and formal verification of consensus components.`,
  };
}

function paraphrase(label: string) {
  return {
    title: `${label} Infrastructure Protocol Research Grant Programme`,
    description: `Grant funding for open-source ${label} protocol research and public ${label} infrastructure. Rolling applications with awards from five thousand to fifty thousand, concentrating on ${label} developer tooling, client diversity and the formal verification of consensus components.`,
  };
}

test.describe("@dedupe M3-3 detection", () => {
  test.beforeEach(async ({ stack, pendingHeadroom }) => {
    skipUnlessActor(stack, "publisher", "submitter", "reviewer");
    // EVERY TEST HERE MANUFACTURES A PENDING ROW AS THE SUBMITTER, and an account with no verified
    // membership may have only so many waiting at once (`PENDING_SUBMISSION_LIMIT`). That cap is a
    // real rule this suite is a heavy user of, and it is asserted deliberately in `m3-1`; here it
    // is only in the way, so the slots are freed the way the product frees them — by a reviewer
    // deciding the oldest ones — rather than by pretending the rule is not there.
    await pendingHeadroom("submitter", 2);
  });

  test("an equivalent submission is reported as a duplicate and the pair is persisted", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const stamp = Date.now();
    const originalDoc = opportunityFixture(
      stack.namespaces.publisher,
      `dup-original-${stamp}`,
      original("detection"),
    );
    const originalId = originalDoc.id as string;
    expect((await publisher.post("/v1/opportunities", originalDoc)).status).toBe(201);

    const submitter = await api("submitter");
    const copyDoc = opportunityFixture(
      stack.namespaces.publisher,
      `dup-copy-${stamp}`,
      paraphrase("detection"),
    );
    const copyId = copyDoc.id as string;
    const copy = await submitter.post<{
      duplicateCheck: string;
      duplicates: Array<{ id: string; similarity: number }>;
    }>("/v1/opportunities", copyDoc);

    expect(copy.status).toBe(201);
    expect(copy.body.duplicateCheck, "the detector ran").toBe("ok");
    // The response payload IS the notification: the submitter is told, in the answer to their own
    // request, that this looks like something already published, and which entry it looks like.
    expect(copy.body.duplicates.map((match) => match.id)).toContain(originalId);

    const pair = await db.query(
      `SELECT d.id, d.status FROM opportunity_duplicates d
         JOIN opportunities a ON a.id = d.opportunity_id
         JOIN opportunities b ON b.id = d.duplicate_of_id
        WHERE (a.public_id = $1 AND b.public_id = $2) OR (a.public_id = $2 AND b.public_id = $1)`,
      [originalId, copyId],
    );
    // Stored once, whichever way round. The unique index is on the canonical (least, greatest)
    // ordering precisely so the mirrored pair cannot become a second, independently-reviewable row.
    expect(pair.rowCount, "the pair is recorded exactly once").toBe(1);
    expect(pair.rows[0].status).toBe("suspected");
  });

  test("a pending entry is never disclosed through another entry's duplicate list", async ({
    stack,
    api,
    anonApi,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const stamp = Date.now();
    const publicDoc = opportunityFixture(
      stack.namespaces.publisher,
      `leak-public-${stamp}`,
      original("disclosure"),
    );
    const publicId = publicDoc.id as string;
    expect((await publisher.post("/v1/opportunities", publicDoc)).status).toBe(201);

    const submitter = await api("submitter");
    const hiddenDoc = opportunityFixture(
      stack.namespaces.publisher,
      `leak-pending-${stamp}`,
      paraphrase("disclosure"),
    );
    const hiddenId = hiddenDoc.id as string;
    expect((await submitter.post("/v1/opportunities", hiddenDoc)).status).toBe(201);

    const seen = await anonApi.get<{ items: Array<{ id: string }> }>(
      `/v1/opportunities/${encodeURIComponent(publicId)}/duplicates`,
    );
    expect(seen.status).toBe(200);
    // Otherwise the duplicate list becomes a side channel that publishes the review queue: submit
    // something similar to a public entry, then read that entry's duplicates to see everyone else's
    // unpublished drafts.
    expect(seen.body.items.map((item) => item.id)).not.toContain(hiddenId);

    const toItsAuthor = await submitter.get<{ items: Array<{ id: string }> }>("/v1/me/duplicates");
    expect(toItsAuthor.status).toBe(200);
  });
});

test.describe("@dedupe M3-3 what a reviewer does with a pair", () => {
  test.beforeEach(async ({ stack, pendingHeadroom }) => {
    skipUnlessActor(stack, "publisher", "submitter", "reviewer");
    // EVERY TEST HERE MANUFACTURES A PENDING ROW AS THE SUBMITTER, and an account with no verified
    // membership may have only so many waiting at once (`PENDING_SUBMISSION_LIMIT`). That cap is a
    // real rule this suite is a heavy user of, and it is asserted deliberately in `m3-1`; here it
    // is only in the way, so the slots are freed the way the product frees them — by a reviewer
    // deciding the oldest ones — rather than by pretending the rule is not there.
    await pendingHeadroom("submitter", 2);
  });

  /** Publishes a pair and returns the reviewable pair id. */
  async function seedPair(
    stack: { namespaces: { publisher: string } },
    publisherPost: (doc: Record<string, unknown>) => Promise<number>,
    submitterPost: (doc: Record<string, unknown>) => Promise<number>,
    fixture: (
      namespace: string,
      suffix: string,
      over?: Record<string, unknown>,
    ) => Record<string, unknown>,
    label: string,
  ): Promise<{ leftId: string; rightId: string }> {
    const stamp = `${label}-${Date.now()}`;
    const left = fixture(stack.namespaces.publisher, `${stamp}-a`, original(label));
    const right = fixture(stack.namespaces.publisher, `${stamp}-b`, paraphrase(label));
    expect(await publisherPost(left)).toBe(201);
    expect(await submitterPost(right)).toBe(201);
    return { leftId: left.id as string, rightId: right.id as string };
  }

  test("a reviewer dismisses a pair, and it does not come back", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const submitter = await api("submitter");
    const reviewer = await api("reviewer");

    const { leftId, rightId } = await seedPair(
      stack,
      async (doc) => (await publisher.post("/v1/opportunities", doc)).status,
      async (doc) => (await submitter.post("/v1/opportunities", doc)).status,
      opportunityFixture,
      "dismiss",
    );

    const pairId = await pairIdFor(db, leftId, rightId);
    const dismissed = await reviewer.post<{ status: string }>(
      `/v1/review/duplicates/${pairId}/dismiss`,
    );
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe("dismissed");

    // Re-running detection must not resurrect a decision a human already made. A detector that
    // re-suspects everything it has been told to ignore trains reviewers to ignore it back.
    //
    // The backfill alone would prove little — every entry already carries a current embedding, so
    // it processes nothing. What gives this teeth is SUBMITTING AN EQUIVALENT AGAIN afterwards: that
    // runs detection for real, against the same pair of texts the reviewer already ruled on.
    const backfill = await (await api("admin")).post("/v1/admin/jobs/embedding-backfill/run", {});
    expect(backfill.status).toBe(200);

    const resubmission = opportunityFixture(
      stack.namespaces.publisher,
      `dismiss-again-${Date.now()}`,
      paraphrase("dismiss"),
    );
    expect((await submitter.post("/v1/opportunities", resubmission)).status).toBe(201);

    const stillDismissed = await db.query<{ status: string }>(
      "SELECT d.status FROM opportunity_duplicates d WHERE d.id = $1",
      [pairId],
    );
    expect(
      stillDismissed.rows[0]?.status,
      "a dismissed pair stays dismissed, however often detection runs again",
    ).toBe("dismissed");
  });

  test("a reviewer merges a pair once, and a second merge is refused", async ({
    stack,
    api,
    db,
    anonApi,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const submitter = await api("submitter");
    const reviewer = await api("reviewer");

    const { leftId, rightId } = await seedPair(
      stack,
      async (doc) => (await publisher.post("/v1/opportunities", doc)).status,
      async (doc) => (await submitter.post("/v1/opportunities", doc)).status,
      opportunityFixture,
      "merge",
    );
    const pairId = await pairIdFor(db, leftId, rightId);

    const merged = await reviewer.post<{ survivorId: string; mergedId: string }>(
      `/v1/review/duplicates/${pairId}/merge`,
      { survivorId: leftId },
    );
    expect(merged.status).toBe(200);
    expect(merged.body.survivorId).toBe(leftId);

    const survivor = await anonApi.get(`/v1/opportunities/${encodeURIComponent(leftId)}`);
    expect(survivor.status, "the survivor stays public").toBe(200);

    const mergedRow = await db.query<{ merged_into_id: number | null }>(
      "SELECT merged_into_id FROM opportunities WHERE public_id = $1",
      [rightId],
    );
    expect(
      mergedRow.rows[0]?.merged_into_id,
      "the absorbed entry points at its survivor",
    ).not.toBeNull();

    // Merging is destructive and not idempotent in the way a retry would need. Answering 409 with a
    // specific code is what lets a client tell "already done" apart from "not allowed".
    const again = await reviewer.post<{ error: string }>(`/v1/review/duplicates/${pairId}/merge`, {
      survivorId: leftId,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_merged");
  });

  test("no ordinary account can reach the duplicate review surface", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const submitter = await api("submitter");

    const { leftId, rightId } = await seedPair(
      stack,
      async (doc) => (await publisher.post("/v1/opportunities", doc)).status,
      async (doc) => (await submitter.post("/v1/opportunities", doc)).status,
      opportunityFixture,
      "forbidden",
    );
    const pairId = await pairIdFor(db, leftId, rightId);

    for (const [name, client] of [
      ["publisher", publisher],
      ["submitter", submitter],
    ] as const) {
      const listing = await client.get<{ error: string }>("/v1/review/duplicates");
      expect(listing.status, `${name} must not read the queue`).toBe(403);

      const dismiss = await client.post<{ error: string }>(
        `/v1/review/duplicates/${pairId}/dismiss`,
      );
      expect(dismiss.status, `${name} must not decide a pair`).toBe(403);
    }
  });
});

/** The numeric pair id, which is what every `/v1/review/duplicates/:id/*` route takes. */
async function pairIdFor(db: import("pg").Pool, a: string, b: string): Promise<number> {
  const found = await db.query<{ id: number }>(
    `SELECT d.id FROM opportunity_duplicates d
       JOIN opportunities x ON x.id = d.opportunity_id
       JOIN opportunities y ON y.id = d.duplicate_of_id
      WHERE (x.public_id = $1 AND y.public_id = $2) OR (x.public_id = $2 AND y.public_id = $1)
      LIMIT 1`,
    [a, b],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) {
    throw new Error(
      `no duplicate pair was detected for ${a} / ${b}. With EMBEDDING_PROVIDER=lexical this is a fixture problem, not a flake: tune the fixture TEXT so the pair crosses the similarity threshold — never lower the threshold to make a test pass.`,
    );
  }
  return Number(id);
}

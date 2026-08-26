/**
 * Semantic duplicate detection: embed an entry, find its neighbours, record the pairs, and give a
 * reviewer somewhere to decide.
 *
 * SIX THINGS HERE ARE LOAD-BEARING AND NONE OF THEM IS THE VECTOR SEARCH.
 *
 * 1. **The candidate scope is credential-dependent.** A submitter's check runs over `approved AND
 *    is_listed` rows only. Searching everything would turn a submission into a way to enumerate the
 *    review queue: post something, read back the titles and ids of whatever it resembles. Reviewers
 *    searching from `/v1/review/duplicates` see all rows, which is what a reviewer is for.
 * 2. **A pair is unordered, so it is written ordered.** `ux_dup_pair` is unique on
 *    `(least, greatest)`, so (A,B) and (B,A) are the same key and a dismissal cannot be undone by
 *    the mirrored row staying suspected.
 * 3. **Detection never resurrects a decision.** Re-embedding only ever touches `suspected` rows;
 *    `dismissed`, `confirmed` and `merged` are somebody's judgement and this pass has no new
 *    information about them. A reviewer explicitly reopening a dismissal is a separate audited
 *    transition.
 * 4. **Stale pairs are removed exactly, not approximately.** An update that makes two entries
 *    unalike must delete the suspected pair — but "it fell out of the top 20" is not the same fact
 *    as "it is below the threshold". So the cleanup recomputes the similarity of each existing
 *    suspected pair directly against the counterpart's stored vector, and deletes on that.
 * 5. **Failure never blocks a write.** The whole check is wrapped: a missing key, a timeout, a
 *    provider outage all resolve to `unavailable` with no embedding row, which is precisely the
 *    predicate the backfill job selects on. A submission that was accepted stays accepted.
 * 6. **A newly inserted pair emits in the same transaction.** `returning()` distinguishes a real
 *    creation from a re-detection, and the notification unique key is the final backstop. Decisions,
 *    merges and reopens likewise record owner notifications beside their mutations and audit rows.
 */

import { type SQL, and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { validateOpportunity } from "rfphub-validate";
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, type Tx, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityRow,
  opportunities,
  opportunityDuplicates,
  opportunityEmbeddings,
} from "../../../db/schema.js";
import { toStandard } from "../../mappers/opportunity.mapper.js";
import type {
  DuplicateCheckStatus,
  DuplicateMatchView,
  DuplicatePairView,
  DuplicateSideView,
  MergeResultView,
} from "../../shared/api-views.js";
import { nextDeadlineAt } from "../../shared/deadlines.js";
import { contentHash, embeddingText } from "../../shared/embedding-text.js";
import { conflict, notFound } from "../../shared/http-error.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { duplicateReopenTransition } from "./duplicate-reopen.js";
import {
  type EmbeddingProvider,
  createEmbeddingProvider,
  toVectorLiteral,
} from "./embedding-provider.js";

/** How many neighbours the ANN index returns before the threshold is applied. */
const ANN_CANDIDATES = 20;

/** Rows read per pass while walking the corpus for entries whose embedding is not current. */
const SCAN_PAGE = 500;

/**
 * The fields a merge may carry from the loser to the survivor.
 *
 * Content only. Nothing here is an identity, a provenance attribution or an editorial state: those
 * are what the survivor IS, and copying one would make a merge a way to rewrite whose entry it is.
 * `deadlines` is on the list and forces `next_deadline_at` to be recomputed, which is why the copy
 * is not a blind column assignment.
 */
export const MERGEABLE_FIELDS = [
  "summary",
  "description",
  "applicationUrl",
  "website",
  "logoUrl",
  "bannerUrl",
  "socialLinks",
  "ecosystems",
  "categories",
  "eligibility",
  "prerequisites",
  "additionalReferences",
  "serviceAgreement",
  "currency",
  "minAward",
  "maxAward",
  "budget",
  "allocated",
  "milestones",
  "deadlines",
  "opensAt",
  "postedAt",
] as const;

export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

export interface DuplicateCheckResult {
  status: DuplicateCheckStatus;
  duplicates: DuplicateMatchView[];
}

export interface DedupeOptions {
  /** Injected by the tests; a deployment takes the configured provider. */
  provider?: EmbeddingProvider;
  config?: AppConfig;
}

/** What a search may see. `all` is the reviewer scope; `public` is everyone else's. */
export type CandidateScope = "public" | "all";

export class DedupeService {
  private readonly provider: EmbeddingProvider | undefined;
  private readonly config: AppConfig;
  private readonly audit: AuditService;
  private readonly notifications: NotificationService;

  constructor(
    private readonly db: DB = defaultDb,
    options: DedupeOptions = {},
  ) {
    this.config = options.config ?? defaultConfig;
    this.provider = options.provider ?? createEmbeddingProvider(this.config.embedding);
    this.audit = new AuditService(db);
    this.notifications = new NotificationService();
  }

  /** Whether this deployment can detect duplicates at all. */
  get enabled(): boolean {
    return this.provider !== undefined;
  }

  // ── the write path's after-commit call ─────────────────────────────────────────
  /**
   * Embed one entry, record its suspected pairs, and report what the submitter may see.
   *
   * NEVER THROWS for a provider failure. The row is already committed; a duplicate check that could
   * turn a stored submission into a 500 would be strictly worse than no duplicate check.
   */
  async check(
    opportunityId: number,
    scope: CandidateScope = "public",
  ): Promise<DuplicateCheckResult> {
    if (!this.provider) return { status: "disabled", duplicates: [] };
    try {
      const matches = await this.embedAndDetect(opportunityId, scope);
      return { status: "ok", duplicates: matches };
    } catch {
      // Deliberately swallowed and reported as a status. `embedding-backfill` selects exactly the
      // rows this leaves without a current embedding row.
      return { status: "unavailable", duplicates: [] };
    }
  }

  /**
   * The whole detection pass for one entry: embed (or skip), search, record, clean up.
   *
   * Throws on failure — `check()` is the tolerant wrapper, and the backfill job wants the error.
   */
  async embedAndDetect(
    opportunityId: number,
    scope: CandidateScope = "public",
  ): Promise<DuplicateMatchView[]> {
    const provider = this.provider;
    if (!provider) throw new Error("no embedding provider is configured");

    const row = await this.loadRow(opportunityId);
    const vector = await this.ensureEmbedding(row, provider);

    const neighbours = await this.search(vector, { exclude: row.id, scope });
    const threshold = this.config.dedupe.similarityThreshold;
    const above = neighbours.filter((n) => n.similarity >= threshold);
    const kept = above.slice(0, this.config.dedupe.maxMatches);

    await this.recordPairs(row.id, kept);
    await this.pruneStalePairs(row.id, vector, threshold);

    return kept.map((match) => ({
      id: match.publicId,
      title: match.title,
      isPublic: match.isPublic,
      similarity: round(match.similarity),
      status: "suspected" as const,
      detectedAt: new Date().toISOString(),
    }));
  }

  /**
   * The stored vector, recomputed only when the content it was made from changed.
   *
   * `content_hash` is over the text AND the model AND the provider, so a provider switch invalidates
   * every row rather than leaving vectors from two incomparable spaces in one index.
   */
  private async ensureEmbedding(
    row: OpportunityRow,
    provider: EmbeddingProvider,
    depth = 0,
  ): Promise<number[]> {
    const text = embeddingTextFor(row);
    const hash = contentHash(text, provider.model, provider.id);

    const stored = await this.db
      .select()
      .from(opportunityEmbeddings)
      .where(eq(opportunityEmbeddings.opportunityId, row.id))
      .limit(1);
    const current = stored[0];
    if (current && current.contentHash === hash) return current.embedding;

    const vector = await provider.embed(text);

    // COMPARE-AND-SET AGAINST THE ENTRY'S CURRENT CONTENT, not the snapshot this vector was
    // computed from — and NOT dead now that the featurizer is local. The awaits on either side of
    // this block are database round trips, and two concurrent requests in one process can still
    // interleave: an OLDER pass finishing after a NEWER one would overwrite the fresh vector and
    // content hash with stale ones, and duplicate search / pair pruning would then run against
    // content the entry no longer has, until the next backfill pass repairs it. The depth cap
    // keeps a pathological edit-storm from recursing forever; past it the row is written anyway —
    // the next `check()` or the backfill cursor corrects it.
    if (depth < 3) {
      const fresh = await this.loadRow(row.id);
      const freshHash = contentHash(embeddingTextFor(fresh), provider.model, provider.id);
      if (freshHash !== hash) return this.ensureEmbedding(fresh, provider, depth + 1);
    }

    await this.db
      .insert(opportunityEmbeddings)
      .values({
        opportunityId: row.id,
        model: provider.model,
        providerId: provider.id,
        embedding: vector,
        contentHash: hash,
      })
      .onConflictDoUpdate({
        target: opportunityEmbeddings.opportunityId,
        set: {
          model: provider.model,
          providerId: provider.id,
          embedding: vector,
          contentHash: hash,
          createdAt: new Date(),
        },
      });
    return vector;
  }

  /**
   * The nearest stored vectors, by cosine distance, through the HNSW index.
   *
   * Restricted to the SAME model and provider — a vector from another space is not a neighbour, it
   * is a coordinate coincidence — and never to a merge loser, whose survivor is the real entry.
   */
  private async search(
    vector: number[],
    options: { exclude: number; scope: CandidateScope },
  ): Promise<
    { id: number; publicId: string; title: string; isPublic: boolean; similarity: number }[]
  > {
    const provider = this.provider;
    if (!provider) return [];
    // pgvector's cosine-distance operator, written out rather than through Drizzle's
    // `cosineDistance` helper: the helper binds an array, and this needs the vector as a single
    // cast parameter so the planner still reaches the HNSW index.
    const distance = cosineDistanceTo(vector);

    const where: (SQL | undefined)[] = [
      sql`${opportunityEmbeddings.opportunityId} <> ${options.exclude}`,
      eq(opportunityEmbeddings.model, provider.model),
      eq(opportunityEmbeddings.providerId, provider.id),
      isNull(opportunities.mergedIntoId),
    ];
    if (options.scope === "public") {
      where.push(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true));
    }

    const rows = await this.db
      .select({
        id: opportunities.id,
        publicId: opportunities.publicId,
        title: opportunities.title,
        reviewStatus: opportunities.reviewStatus,
        isListed: opportunities.isListed,
        similarity: sql<number>`1 - (${distance})`,
      })
      .from(opportunityEmbeddings)
      .innerJoin(opportunities, eq(opportunities.id, opportunityEmbeddings.opportunityId))
      .where(and(...where))
      .orderBy(asc(distance))
      .limit(ANN_CANDIDATES);

    return rows.map(({ reviewStatus, isListed, ...row }) => ({
      ...row,
      isPublic: reviewStatus === "approved" && isListed,
      similarity: Number(row.similarity),
    }));
  }

  /** Insert the pairs that are new; refresh the similarity of the ones already suspected. */
  private async recordPairs(
    opportunityId: number,
    matches: { id: number; similarity: number }[],
  ): Promise<void> {
    if (matches.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const match of matches) {
        // Canonical ordering, matching `ux_dup_pair`'s (least, greatest) expression index, so the
        // mirrored pair is the same key rather than a second row with its own status.
        const [low, high] =
          opportunityId < match.id ? [opportunityId, match.id] : [match.id, opportunityId];
        const similarity = round(match.similarity).toString();
        const inserted = await tx
          .insert(opportunityDuplicates)
          .values({ opportunityId: low, duplicateOfId: high, similarity, status: "suspected" })
          .onConflictDoNothing()
          .returning();
        // Only a suspected pair is refreshed. A dismissal is a judgement, and a re-run of the
        // detector is not new information about it.
        await tx
          .update(opportunityDuplicates)
          .set({ similarity })
          .where(
            and(
              eq(opportunityDuplicates.opportunityId, low),
              eq(opportunityDuplicates.duplicateOfId, high),
              eq(opportunityDuplicates.status, "suspected"),
            ),
          );

        // `returning()` is the intent guard: an existing pair is a refresh, not a new event.
        const pair = inserted[0];
        if (pair) {
          const [left, right] = await Promise.all([
            loadRowById(tx, pair.opportunityId),
            loadRowById(tx, pair.duplicateOfId),
          ]);
          await this.notifications.recordDuplicate(tx, {
            pair,
            left,
            right,
            events: [
              { kind: "duplicate_suspected", ownerOpportunityId: left.id },
              { kind: "duplicate_suspected", ownerOpportunityId: right.id },
            ],
          });
        }
      }
    });
  }

  /**
   * Delete the suspected pairs this entry no longer resembles.
   *
   * Recomputed EXACTLY against each counterpart's stored vector rather than inferred from the top-K
   * result: a pair can leave the top 20 while still being over the threshold, and deleting it then
   * would silently drop a real match. A counterpart with no stored vector is left alone — there is
   * nothing to compare it to, which is not the same as being dissimilar.
   *
   * "No stored vector" MEANS no vector in this provider's space. The join carries the same
   * model-and-provider predicate as `search()`, because during a provider switch a counterpart's
   * row may still hold the OLD space's coordinates: a cosine across spaces is a meaningless number
   * that typically lands below any threshold, and without the predicate this method read it as
   * "dissimilar" and deleted a pair that was never re-measured. The backfill re-embeds the
   * counterpart eventually; until then its pairs are left exactly as the comment above promises.
   */
  private async pruneStalePairs(
    opportunityId: number,
    vector: number[],
    threshold: number,
  ): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    const counterpart = sql`case when ${opportunityDuplicates.opportunityId} = ${opportunityId} then ${opportunityDuplicates.duplicateOfId} else ${opportunityDuplicates.opportunityId} end`;

    const rows = await this.db
      .select({
        id: opportunityDuplicates.id,
        similarity: sql<number>`1 - (${cosineDistanceTo(vector)})`,
      })
      .from(opportunityDuplicates)
      .innerJoin(
        opportunityEmbeddings,
        and(
          sql`${opportunityEmbeddings.opportunityId} = ${counterpart}`,
          eq(opportunityEmbeddings.model, provider.model),
          eq(opportunityEmbeddings.providerId, provider.id),
        ),
      )
      .where(
        and(
          eq(opportunityDuplicates.status, "suspected"),
          or(
            eq(opportunityDuplicates.opportunityId, opportunityId),
            eq(opportunityDuplicates.duplicateOfId, opportunityId),
          ),
        ),
      );

    const stale = rows.filter((row) => Number(row.similarity) < threshold).map((row) => row.id);
    if (stale.length === 0) return;
    await this.db.delete(opportunityDuplicates).where(inArray(opportunityDuplicates.id, stale));
  }

  // ── the backfill job's entry point ─────────────────────────────────────────────
  /**
   * Embed every entry whose vector is missing or stale, up to `limit`.
   *
   * A CURSOR job in the sense of docs/jobs.md: the run retires the rows it selects, so `remaining`
   * decreases and the runner may loop to zero. The predicate is "this entry has no CURRENT
   * embedding" — see `pendingEmbeddingIds` for what current means and why the missing-row test
   * alone was not enough.
   */
  async runBatch(options: { limit?: number } = {}): Promise<{
    processed: number;
    remaining: number;
    skipped?: string;
  }> {
    const provider = this.provider;
    if (!provider) return { processed: 0, remaining: 0, skipped: "no embedding provider" };
    const limit = options.limit ?? 50;

    const pending = await this.pendingEmbeddingIds(limit);
    let processed = 0;
    for (const id of pending) {
      try {
        await this.embedAndDetect(id, "all");
        processed++;
      } catch {
        // One unembeddable row must not end the batch — it stays in the predicate for the next run.
      }
    }
    const remaining = (await this.pendingEmbeddingIds(limit + 1)).length;
    return { processed, remaining };
  }

  /**
   * Entries with no CURRENT embedding: no row at all, a row from another model or provider, **or a
   * row whose `content_hash` no longer matches the entry's text**.
   *
   * THE HASH ARM IS THE ONE THAT WAS MISSING, and without it the backfill could never repair the
   * exact failure it exists to repair. An edit changes the text; if the submit-time check then
   * fails (a provider timeout, a missing key, a 429), the row keeps its OLD vector — same model,
   * same provider, so a missing-row test considers it current and never selects it again. The
   * entry is then searched, and matched against, using a vector of text that no longer exists,
   * and its stale `suspected` pairs never get pruned. "Has an embedding" is not the question;
   * "has an embedding OF THIS CONTENT" is, and `content_hash` is what answers it.
   *
   * The hash cannot be computed in SQL — `embeddingText` is a pure TypeScript composition and
   * having a second, SQL-shaped copy of it is precisely how the two derivations drift apart — so
   * the scan is a paged walk that stops as soon as `limit` candidates are found.
   *
   * Public, like `VerificationService.pendingIds`: the cursor IS the queue, so being able to ask
   * "what does this predicate select" without running the job is how it stays testable.
   */
  async pendingEmbeddingIds(limit: number): Promise<number[]> {
    const provider = this.provider;
    if (!provider) return [];
    const picked: number[] = [];
    let afterId = 0;

    while (picked.length < limit) {
      const page = await this.db
        .select({
          row: opportunities,
          model: opportunityEmbeddings.model,
          providerId: opportunityEmbeddings.providerId,
          contentHash: opportunityEmbeddings.contentHash,
        })
        .from(opportunities)
        .leftJoin(opportunityEmbeddings, eq(opportunityEmbeddings.opportunityId, opportunities.id))
        .where(and(isNull(opportunities.mergedIntoId), gt(opportunities.id, afterId)))
        .orderBy(asc(opportunities.id))
        .limit(SCAN_PAGE);
      if (page.length === 0) break;

      for (const entry of page) {
        afterId = entry.row.id;
        if (
          entry.contentHash === null ||
          entry.model !== provider.model ||
          entry.providerId !== provider.id ||
          entry.contentHash !==
            contentHash(embeddingTextFor(entry.row), provider.model, provider.id)
        ) {
          picked.push(entry.row.id);
          if (picked.length >= limit) break;
        }
      }
      if (page.length < SCAN_PAGE) break;
    }
    return picked;
  }

  // ── the reviewer surface ───────────────────────────────────────────────────────
  /** The pair queue, newest first. Reviewers see every pair, whatever either side's status. */
  async listForReview(
    status: "suspected" | "confirmed" | "dismissed" | "merged" | undefined,
    limit = 50,
  ): Promise<DuplicatePairView[]> {
    // Two distinct references to the same table: a pair names two entries, and Drizzle cannot join
    // one table twice without an alias.
    const left = alias(opportunities, "dup_left");
    const right = alias(opportunities, "dup_right");
    const rows = await this.db
      .select({ pair: opportunityDuplicates, left, right })
      .from(opportunityDuplicates)
      .innerJoin(left, eq(left.id, opportunityDuplicates.opportunityId))
      .innerJoin(right, eq(right.id, opportunityDuplicates.duplicateOfId))
      .where(status === undefined ? undefined : eq(opportunityDuplicates.status, status))
      .orderBy(desc(opportunityDuplicates.detectedAt), desc(opportunityDuplicates.id))
      .limit(limit);

    const survivors = await this.survivorIds(
      rows.flatMap(({ left: l, right: r }) => [l.mergedIntoId, r.mergedIntoId]),
    );
    return rows.map(({ pair, left: l, right: r }) => toPairView(pair, l, r, survivors));
  }

  /** Confirm or dismiss one pair. Neither touches either entry — only the pair's own status. */
  async decide(
    reviewerId: number,
    pairId: number,
    decision: "confirm" | "dismiss",
  ): Promise<DuplicatePairView> {
    const status = decision === "confirm" ? "confirmed" : "dismissed";
    return this.db.transaction(async (tx) => {
      const pair = await lockPair(tx, pairId);
      if (pair.status === "merged") {
        throw conflict(
          "already_merged",
          "that pair has already been merged; a merge is not something a later decision reverses.",
        );
      }
      const now = new Date();
      const updated = await tx
        .update(opportunityDuplicates)
        .set({ status, reviewedBy: reviewerId, reviewedAt: now })
        .where(eq(opportunityDuplicates.id, pairId))
        .returning();
      const next = updated[0] ?? pair;
      await this.audit.record(tx, {
        subjectKind: "duplicate",
        subjectId: pairId,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: decision === "confirm" ? "confirm_duplicate" : "dismiss_duplicate",
        patch: { status: { before: pair.status, after: status } },
      });
      const [left, right] = await Promise.all([
        loadRowById(tx, next.opportunityId),
        loadRowById(tx, next.duplicateOfId),
      ]);
      await this.notifications.recordDuplicate(tx, {
        pair: next,
        left,
        right,
        events: [
          { kind: `duplicate_${status}`, ownerOpportunityId: left.id },
          { kind: `duplicate_${status}`, ownerOpportunityId: right.id },
        ],
        decidedBy: "reviewer",
      });
      const survivors = await this.survivorIds([left.mergedIntoId, right.mergedIntoId]);
      return toPairView(next, left, right, survivors);
    });
  }

  /** Undo a dismissal by returning the pair to the suspected queue. */
  async reopen(reviewerId: number, pairId: number): Promise<DuplicatePairView> {
    return this.db.transaction(async (tx) => {
      const pair = await lockPair(tx, pairId);
      const transition = duplicateReopenTransition(pair.status);
      let next = pair;

      if (transition === "reopen") {
        const now = new Date();
        const updated = await tx
          .update(opportunityDuplicates)
          .set({ status: "suspected", reviewedBy: reviewerId, reviewedAt: now })
          .where(eq(opportunityDuplicates.id, pairId))
          .returning();
        next = updated[0] ?? pair;
        await this.audit.record(tx, {
          subjectKind: "duplicate",
          subjectId: pairId,
          actorKind: "user",
          actorAccountId: reviewerId,
          action: "reopen",
          patch: { status: { before: pair.status, after: "suspected" } },
        });
      }

      const [left, right] = await Promise.all([
        loadRowById(tx, next.opportunityId),
        loadRowById(tx, next.duplicateOfId),
      ]);
      if (transition === "reopen") {
        await this.notifications.recordDuplicate(tx, {
          pair: next,
          left,
          right,
          events: [
            { kind: "duplicate_reopened", ownerOpportunityId: left.id },
            { kind: "duplicate_reopened", ownerOpportunityId: right.id },
          ],
          decidedBy: "reviewer",
        });
      }
      const survivors = await this.survivorIds([left.mergedIntoId, right.mergedIntoId]);
      return toPairView(next, left, right, survivors);
    });
  }

  /**
   * Merge one pair: the loser is rejected, unlisted, archived and pointed at the survivor.
   *
   * The loser's row is KEPT rather than deleted — its public id may be in an export, a feed or
   * somebody's bookmarks, and `merged_into_id` is what lets a public read return a 404 that names
   * the survivor without ever serving the loser's terminal row.
   *
   * THE SURVIVOR IS VALIDATED TWICE OVER. It must be publicly visible (merging into a pending entry
   * would take the public one away and leave nothing in its place), and it must not itself carry
   * `merged_into_id` — that check is what prevents chains and, transitively, cycles. When fields are
   * copied, the result is re-validated against the Standard INSIDE the transaction and the whole
   * merge rolls back if the survivor would no longer be conformant.
   */
  async merge(
    reviewerId: number,
    pairId: number,
    options: { survivorId: string; fields?: string[] },
  ): Promise<MergeResultView> {
    const fields = normalizeFields(options.fields);
    return this.db.transaction(async (tx) => {
      const pair = await lockPair(tx, pairId);
      if (pair.status === "merged") {
        throw conflict("already_merged", "that pair has already been merged.");
      }
      // Locked in id order, always, so two reviewers merging overlapping pairs cannot deadlock.
      const ids = [pair.opportunityId, pair.duplicateOfId].sort((a, b) => a - b);
      const locked = new Map<number, OpportunityRow>();
      for (const id of ids) locked.set(id, await lockOpportunityById(tx, id));

      const survivor = [...locked.values()].find((row) => row.publicId === options.survivorId);
      if (!survivor) {
        throw notFound(
          `${JSON.stringify(options.survivorId)} is not one of the two entries in that pair.`,
        );
      }
      const loser = [...locked.values()].find((row) => row.id !== survivor.id);
      if (!loser) throw conflict("invalid_pair", "a pair must name two distinct entries.");

      // THE OTHER HALF OF THE NO-CHAIN INVARIANT. The check below this one refuses a SURVIVOR that
      // already points elsewhere; this refuses a LOSER that something else already points AT. Without
      // it, merging an existing B/C pair with C as survivor and B (already the survivor of an earlier
      // A/B merge) as loser would create A → B → C: A's `mergedIntoId` still names B, and B is no
      // longer the immediate — or even the eventual, from a single hop — survivor. `loser` is already
      // locked above (it is one of `ids`), so nothing else can be mid-way through attaching a NEW
      // dependent to it: doing that requires locking THIS SAME ROW first, which blocks until this
      // transaction commits or rolls back.
      const dependents = await tx
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.mergedIntoId, loser.id))
        .limit(1);
      if (dependents.length > 0) {
        throw conflict(
          "loser_has_dependents",
          `${JSON.stringify(loser.publicId)} is itself the survivor of an earlier merge; merging it away would chain that earlier loser through it. Merge the earlier loser directly into ${JSON.stringify(survivor.publicId)} instead.`,
        );
      }

      if (survivor.mergedIntoId !== null) {
        const real = await loadRowById(tx, survivor.mergedIntoId);
        throw conflict(
          "survivor_already_merged",
          `${JSON.stringify(survivor.publicId)} was itself merged into ${JSON.stringify(real.publicId)}; merge into that entry instead.`,
          { survivorId: real.publicId },
        );
      }
      if (survivor.reviewStatus !== "approved" || !survivor.isListed) {
        throw conflict(
          "survivor_not_public",
          `${JSON.stringify(survivor.publicId)} is not approved and listed, so merging into it would remove the public entry without replacing it.`,
        );
      }

      const now = new Date();
      const copied = copyFields(survivor, loser, fields);
      if (Object.keys(copied.set).length > 0) {
        const updated = await tx
          .update(opportunities)
          .set({ ...copied.set, updatedAt: now })
          .where(eq(opportunities.id, survivor.id))
          .returning();
        // Inside the transaction, so a merge that would leave the survivor non-conformant does not
        // happen at all rather than happening and being noticed later.
        const { valid, errors } = validateOpportunity(toStandard(updated[0] ?? survivor));
        if (!valid) {
          throw conflict(
            "merge_would_invalidate_survivor",
            `copying ${copied.fields.join(", ")} would leave ${JSON.stringify(survivor.publicId)} invalid against the Standard (${errors.length} violation(s)); the merge was rolled back.`,
          );
        }
      }

      await tx
        .update(opportunities)
        .set({
          reviewStatus: "rejected",
          isListed: false,
          status: "archived",
          mergedIntoId: survivor.id,
          mergedFromPublic: loser.reviewStatus === "approved" && loser.isListed,
          updatedAt: now,
        })
        .where(eq(opportunities.id, loser.id));

      const updatedPair = await tx
        .update(opportunityDuplicates)
        .set({ status: "merged", reviewedBy: reviewerId, reviewedAt: now })
        .where(eq(opportunityDuplicates.id, pairId))
        .returning();

      // One row on EACH entry. "This absorbed that" and "this was absorbed into that" are different
      // facts, and each trail is read on its own entry's page.
      for (const [subject, patch] of [
        [survivor.id, { merged: loser.publicId, copiedFields: copied.fields }],
        [
          loser.id,
          {
            mergedInto: survivor.publicId,
            reviewStatus: { before: loser.reviewStatus, after: "rejected" },
            isListed: { before: loser.isListed, after: false },
            status: { before: loser.status, after: "archived" },
          },
        ],
      ] as const) {
        await this.audit.record(tx, {
          subjectKind: "opportunity",
          subjectId: subject,
          actorKind: "user",
          actorAccountId: reviewerId,
          action: "merge",
          patch,
        });
      }

      const pairRow = updatedPair[0] ?? pair;
      // Re-read both sides rather than reconstructing them: the loser's row was just rewritten, and
      // a view assembled from the pre-update copy would report the state the merge replaced.
      const [left, right] = await Promise.all([
        loadRowById(tx, pairRow.opportunityId),
        loadRowById(tx, pairRow.duplicateOfId),
      ]);
      await this.notifications.recordDuplicate(tx, {
        pair: pairRow,
        left,
        right,
        events: [
          { kind: "duplicate_merged_away", ownerOpportunityId: loser.id },
          { kind: "duplicate_absorbed", ownerOpportunityId: survivor.id },
        ],
        decidedBy: "reviewer",
      });
      const survivors = new Map([[survivor.id, survivor.publicId]]);
      return {
        pair: toPairView(pairRow, left, right, survivors),
        survivorId: survivor.publicId,
        mergedId: loser.publicId,
        copiedFields: copied.fields,
      };
    });
  }

  private async loadRow(opportunityId: number): Promise<OpportunityRow> {
    return loadRowById(this.db, opportunityId);
  }

  /** Public ids for a set of `merged_into_id` values, so a side can name its survivor. */
  private async survivorIds(ids: (number | null)[]): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.db
      .select({ id: opportunities.id, publicId: opportunities.publicId })
      .from(opportunities)
      .where(inArray(opportunities.id, wanted));
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────
type DbLike = DB | Tx;

async function loadRowById(db: DbLike, id: number): Promise<OpportunityRow> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no opportunity ${id}.`);
  return row;
}

async function lockOpportunityById(tx: Tx, id: number): Promise<OpportunityRow> {
  const rows = await tx
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no opportunity ${id}.`);
  return row;
}

async function lockPair(tx: Tx, pairId: number) {
  const rows = await tx
    .select()
    .from(opportunityDuplicates)
    .where(eq(opportunityDuplicates.id, pairId))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no duplicate pair ${pairId}.`);
  return row;
}

/**
 * `embedding <=> $vector::vector` — pgvector's cosine distance, which the HNSW index answers.
 *
 * The vector is bound as ONE text parameter and cast, never interpolated: 1 536 inlined floats
 * would be a query the planner has to re-parse every time, and a bound parameter is what keeps the
 * index scan available.
 */
function cosineDistanceTo(vector: number[]): SQL<number> {
  return sql<number>`${opportunityEmbeddings.embedding} <=> ${toVectorLiteral(vector)}::vector`;
}

/** Three decimals. A similarity is read by a human and compared to a threshold, not accumulated. */
/**
 * The text one entry embeds as, in ONE place.
 *
 * Both callers need it — `ensureEmbedding` to decide whether to re-embed, and the backfill cursor
 * to decide whether a stored hash is still the entry's — and two copies of this projection is two
 * derivations that eventually disagree about what an entry's content hash should be.
 */
function embeddingTextFor(row: OpportunityRow): string {
  return embeddingText({
    title: row.title,
    summary: row.summary,
    description: row.description,
    fundingType: row.fundingType,
    ecosystems: row.ecosystems,
    categories: row.categories,
    operatingOrganizations: row.operatingOrganizations,
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeFields(fields: string[] | undefined): MergeableField[] {
  if (!fields || fields.length === 0) return [];
  const allowed = new Set<string>(MERGEABLE_FIELDS);
  const unknown = fields.filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw conflict(
      "unmergeable_field",
      `a merge may only copy ${MERGEABLE_FIELDS.join(", ")}; refused ${unknown.join(", ")}.`,
    );
  }
  return fields as MergeableField[];
}

/**
 * The columns a merge writes onto the survivor, plus which fields they came from.
 *
 * Copying `deadlines` recomputes `next_deadline_at`, because that column is derived and an
 * un-recomputed one would silently keep sorting the survivor by the deadline it no longer has.
 */
function copyFields(
  survivor: OpportunityRow,
  loser: OpportunityRow,
  fields: MergeableField[],
): { set: Partial<OpportunityRow>; fields: string[] } {
  const set: Record<string, unknown> = {};
  const applied: string[] = [];
  for (const field of fields) {
    const value = loser[field];
    if (value === survivor[field]) continue;
    set[field] = value;
    applied.push(field);
    if (field === "deadlines") set.nextDeadlineAt = nextDeadlineAt(loser.deadlines);
  }
  return { set: set as Partial<OpportunityRow>, fields: applied };
}

function toSideView(row: OpportunityRow, survivors: Map<number, string>): DuplicateSideView {
  return {
    id: row.publicId,
    title: row.title,
    reviewStatus: row.reviewStatus,
    isListed: row.isListed,
    namespace: row.sourcePublisher,
    mergedInto: row.mergedIntoId === null ? null : (survivors.get(row.mergedIntoId) ?? null),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPairView(
  pair: {
    id: number;
    status: "suspected" | "confirmed" | "dismissed" | "merged";
    similarity: string | null;
    detectedAt: Date;
    reviewedAt: Date | null;
  },
  left: OpportunityRow,
  right: OpportunityRow,
  survivors: Map<number, string>,
): DuplicatePairView {
  return {
    id: pair.id,
    status: pair.status,
    similarity: pair.similarity === null ? null : Number(pair.similarity),
    detectedAt: pair.detectedAt.toISOString(),
    reviewedAt: pair.reviewedAt?.toISOString() ?? null,
    left: toSideView(left, survivors),
    right: toSideView(right, survivors),
  };
}

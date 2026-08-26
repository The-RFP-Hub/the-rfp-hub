/**
 * Semantic duplicate detection: embed an entry, find its neighbours, record the pairs, and give a
 * reviewer somewhere to decide.
 *
 * SEVEN THINGS HERE ARE LOAD-BEARING AND NONE OF THEM IS THE VECTOR SEARCH.
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
 *    suspected pair directly against the counterpart's stored vector, and deletes on that. Since
 *    the rule has two arms, "below the threshold" now means BELOW BOTH — the cleanup asks
 *    `shouldPrune`, which is the detection rule read from the other side and is deliberately not
 *    its negation (see `duplicate-signal.ts`).
 * 5. **Failure never blocks a write.** The whole check is wrapped: a missing key, a timeout, a
 *    provider outage all resolve to `unavailable` with no embedding row, which is precisely the
 *    predicate the backfill job selects on. A submission that was accepted stays accepted.
 * 6. **A newly inserted pair emits in the same transaction.** `returning()` distinguishes a real
 *    creation from a re-detection, and the notification unique key is the final backstop. Decisions,
 *    merges and reopens likewise record owner notifications beside their mutations and audit rows.
 * 7. **Detection and pruning apply the SAME combined rule, and a pair records the rule version that
 *    produced it.** One predicate lives in `duplicate-signal.ts` and both paths call it, because an
 *    arm added to detection but not to pruning deletes its own output on the next nightly run. The
 *    `rules_key` stamp is what makes a threshold move — or `DEDUPE_OVERLAP_ENABLED=false` — an
 *    actual rollback: `runBatch`'s resweep arm selects every suspected pair the current rule did
 *    not write and re-judges it. The key is DERIVED from the effective configuration, not a
 *    hand-bumped version, because the moment it has to change is the moment an operator moves a
 *    knob — and a rollback that waits for somebody to remember a constant is not one. Without the
 *    stamp, turning an arm off strands every row it wrote, because pruning only ever runs for
 *    entries the backfill selects and a drained backfill selects nothing. That was already true of
 *    `DEDUPE_SIMILARITY_THRESHOLD` before this arm existed.
 */

import { validateOpportunity } from "rfphub-validate";
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityDuplicateRow, OpportunityRow } from "../../../db/schema.js";
import { toStandard } from "../../mappers/opportunity.mapper.js";
import type { ResweptPair } from "../../repositories/opportunities/duplicate-pair.repository.js";
import {
  type Repositories,
  repositories,
  withTransaction,
} from "../../repositories/unit-of-work.js";
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
import {
  type NotificationDispatchEnqueuer,
  notificationDispatchQueue,
} from "../notifications/notification-dispatch.queue.js";
import {
  type RecordDuplicateNotificationsInput,
  duplicateNotificationInserts,
} from "../notifications/notification.service.js";
import { matchReasons } from "./duplicate-reasons.js";
import { duplicateReopenTransition } from "./duplicate-reopen.js";
import {
  type DuplicateRuleConfig,
  type DuplicateSignalRecord,
  decidePair,
  rulesKey,
  shouldPrune,
} from "./duplicate-signal.js";
import { type EmbeddingProvider, createEmbeddingProvider } from "./embedding-provider.js";

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

/** The structured subset needed for the one deployment-level corpus alarm. */
export interface DedupeLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

const consoleLogger: DedupeLogger = {
  warn(payload, message) {
    console.warn(message, payload);
  },
};

export interface DedupeOptions {
  /** Injected by the tests; a deployment takes the configured provider. */
  provider?: EmbeddingProvider;
  config?: AppConfig;
  logger?: DedupeLogger;
  /** Post-commit immediate email seam. Production uses the process-wide bounded queue. */
  notificationQueue?: NotificationDispatchEnqueuer;
}

/** What a search may see. `all` is the reviewer scope; `public` is everyone else's. */
export type CandidateScope = "public" | "all";

export class DedupeService {
  private readonly provider: EmbeddingProvider | undefined;
  private readonly config: AppConfig;
  private readonly repos: Repositories;
  private readonly notificationQueue: NotificationDispatchEnqueuer;
  private readonly logger: DedupeLogger;
  /** One provider/corpus mismatch is one operator incident, not one warning per submission. */
  private corpusMismatchWarned = false;

  constructor(
    private readonly db: DB = defaultDb,
    options: DedupeOptions = {},
  ) {
    this.config = options.config ?? defaultConfig;
    this.provider = options.provider ?? createEmbeddingProvider(this.config.embedding);
    this.repos = repositories(db);
    this.notificationQueue = options.notificationQueue ?? notificationDispatchQueue;
    this.logger = options.logger ?? consoleLogger;
  }

  /** Whether this deployment can detect duplicates at all. */
  get enabled(): boolean {
    return this.provider !== undefined;
  }

  /**
   * The combined rule's configuration, assembled in ONE place.
   *
   * The provider's `suppliesNorm` capability is folded in here rather than checked at each call
   * site: a provider that cannot report a norm must make the overlap arm inert everywhere at once
   * — detection, pruning and the backfill predicate — and three independent checks are three
   * chances for one of them to be forgotten.
   */
  private ruleConfig(provider: EmbeddingProvider): DuplicateRuleConfig {
    const dedupe = this.config.dedupe;
    return {
      similarityThreshold: dedupe.similarityThreshold,
      overlapEnabled: dedupe.overlapEnabled,
      overlapThreshold: dedupe.overlapThreshold,
      overlapMinTokens: dedupe.overlapMinTokens,
      overlapMinSimilarity: dedupe.overlapMinSimilarity,
      suppliesNorm: provider.suppliesNorm,
    };
  }

  /**
   * The identity of the rule THIS service instance is running, as one opaque key.
   *
   * Derived from the same object the predicate is evaluated against, so the key and the behaviour
   * cannot disagree: a deployment that changes a threshold gets a different key on its next write,
   * and the resweep arm retires whatever the old one left behind without anybody bumping anything.
   */
  private rulesKeyFor(provider: EmbeddingProvider): string {
    return rulesKey(this.ruleConfig(provider), {
      providerId: provider.id,
      model: provider.model,
    });
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
      if (!(await this.hasSearchableCorpus(opportunityId, scope))) {
        return { status: "unavailable", duplicates: [] };
      }
      const matches = await this.embedAndDetect(opportunityId, scope);
      return { status: "ok", duplicates: matches };
    } catch {
      // Deliberately swallowed and reported as a status. `embedding-backfill` selects exactly the
      // rows this leaves without a current embedding row.
      return { status: "unavailable", duplicates: [] };
    }
  }

  /**
   * Refuse to call an empty provider-specific slice of a non-empty corpus a successful search.
   *
   * Exact zero is deliberately the heuristic. A partial backfill can search the rows it has reached
   * and honestly return that result; choosing an arbitrary percentage would only turn availability
   * on and off around a threshold with no semantic basis. Zero is different: when eligible entries
   * exist but not one vector belongs to the live model/provider, `search()` is guaranteed to return
   * nothing before similarity is even considered. That is an unavailable check, not "no matches".
   *
   * This guard belongs in `check()`, not `embedAndDetect()`: the latter is what the
   * `embedding-backfill` job calls to repair this exact state and must never block its own remedy.
   */
  private async hasSearchableCorpus(
    opportunityId: number,
    scope: CandidateScope,
  ): Promise<boolean> {
    const provider = this.provider;
    if (!provider) return false;

    const { eligibleOpportunityCount, compatibleEmbeddingCount, searchable } =
      await this.repos.embeddings.corpusAvailability(opportunityId, scope, {
        model: provider.model,
        providerId: provider.id,
      });
    if (searchable) return true;

    if (!this.corpusMismatchWarned) {
      this.corpusMismatchWarned = true;
      this.logger.warn(
        {
          providerId: provider.id,
          model: provider.model,
          scope,
          eligibleOpportunityCount,
          compatibleEmbeddingCount,
          remedy: "run the embedding-backfill job",
        },
        "DUPLICATE CHECK UNAVAILABLE: the live embedding model/provider has zero compatible rows in a non-empty opportunity corpus; run the embedding-backfill job",
      );
    }
    return false;
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
    const subject = await this.ensureEmbedding(row, provider);
    const rule = this.ruleConfig(provider);

    const neighbours = await this.search(subject.vector, { exclude: row.id, scope });
    // Neighbours arrive in descending cosine order and STAY in it. `maxMatches` truncates, so the
    // order decides which five a submitter sees: sorting by anything else — or letting arm-B pairs
    // interleave by overlap — would let a length-corrected match crowd out a stronger lexical one.
    const accepted: { match: (typeof neighbours)[number]; signal: DuplicateSignalRecord }[] = [];
    for (const match of neighbours) {
      const decision = decidePair(
        {
          similarity: match.similarity,
          left: { norm: subject.norm, tokenCount: subject.tokenCount },
          right: { norm: match.norm, tokenCount: match.tokenCount },
        },
        rule,
      );
      if (decision.accepted && decision.signal) accepted.push({ match, signal: decision.signal });
    }
    const kept = accepted.slice(0, this.config.dedupe.maxMatches);

    await this.recordPairs(row.id, kept, this.rulesKeyFor(provider));
    await this.pruneStalePairs(row.id, subject, rule);

    // Structural labels come from the counterpart's LIVE row, which is why they are loaded here
    // rather than projected through the ANN query: a stored label goes stale on the next edit, and
    // widening the vector search's projection to carry columns it does not order on is how an ANN
    // query slowly stops being one. At most `maxMatches` rows.
    const counterparts = await Promise.all(kept.map(({ match }) => this.loadRow(match.id)));
    const detectedAt = new Date().toISOString();
    return kept.map(({ match, signal }, index) => ({
      id: match.publicId,
      title: match.title,
      isPublic: match.isPublic,
      similarity: round(match.similarity),
      matchedOn: matchReasons(signal as unknown as Record<string, unknown>, row, {
        applicationUrl: counterparts[index]?.applicationUrl ?? null,
        operatingOrganizations: counterparts[index]?.operatingOrganizations ?? null,
      }),
      status: "suspected" as const,
      detectedAt,
    }));
  }

  /**
   * The stored vector and its two scalars, recomputed only when the content changed OR the scalars
   * are missing.
   *
   * `content_hash` is over the text AND the model AND the provider, so a provider switch invalidates
   * every row rather than leaving vectors from two incomparable spaces in one index.
   *
   * THE SHORT-CIRCUIT'S SECOND CLAUSE IS THE HIGHEST-RISK LINE OF THIS CHANGE. `norm` and
   * `token_count` arrived as nullable columns on rows whose text did not change, so after the
   * migration EVERY existing row matches its content hash with a null norm. A short-circuit on the
   * hash alone would return early, never write the scalars, and leave the row selected by the
   * backfill's pending predicate forever — a cursor job that never retires its rows, which
   * `docs/jobs.md` forbids and which would present as a nightly job reporting the same `remaining`
   * for ever. The extra clause is gated on `suppliesNorm`, so a provider that cannot supply the
   * scalars never re-embeds chasing values it will never produce.
   */
  private async ensureEmbedding(
    row: OpportunityRow,
    provider: EmbeddingProvider,
    depth = 0,
  ): Promise<{ vector: number[]; norm: number | null; tokenCount: number | null }> {
    const text = embeddingTextFor(row);
    const hash = contentHash(text, provider.model, provider.id);

    const current = await this.repos.embeddings.findByOpportunityId(row.id);
    if (
      current &&
      current.contentHash === hash &&
      (!provider.suppliesNorm || (current.norm !== null && current.tokenCount !== null))
    ) {
      return {
        vector: current.embedding,
        norm: current.norm,
        tokenCount: current.tokenCount,
      };
    }

    const detail = await provider.embedDetailed(text);

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

    await this.repos.embeddings.upsert({
      opportunityId: row.id,
      model: provider.model,
      providerId: provider.id,
      embedding: detail.vector,
      contentHash: hash,
      norm: detail.norm,
      tokenCount: detail.tokens,
    });
    // Returned rather than re-read: the caller needs the subject's own norm and token count for
    // every candidate comparison, and a second SELECT for numbers we just computed is a round trip
    // that can also disagree with what was written.
    return { vector: detail.vector, norm: detail.norm, tokenCount: detail.tokens };
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
    {
      id: number;
      publicId: string;
      title: string;
      isPublic: boolean;
      similarity: number;
      norm: number | null;
      tokenCount: number | null;
    }[]
  > {
    const provider = this.provider;
    if (!provider) return [];
    return this.repos.embeddings.searchNearest(vector, {
      ...options,
      identity: { model: provider.model, providerId: provider.id },
    });
  }

  /**
   * Insert the pairs that are new; refresh the similarity of the ones already suspected.
   *
   * `similarity` REMAINS THE LEXICAL COSINE, with the same rounding it has always had — an arm-B
   * pair simply carries one below the lexical threshold. Every published number, every stored row
   * and every client that reads `similarity` keeps its meaning; the arm that decided is a separate
   * field, so arm-B volume is filterable from day one rather than hidden inside an average.
   */
  private async recordPairs(
    opportunityId: number,
    matches: { match: { id: number; similarity: number }; signal: DuplicateSignalRecord }[],
    ruleKey: string,
  ): Promise<void> {
    if (matches.length === 0) return;
    const notificationIds = await withTransaction(this.db, async (repos) => {
      const insertedNotificationIds: number[] = [];
      for (const { match, signal } of matches) {
        // Canonical ordering, matching `ux_dup_pair`'s (least, greatest) expression index, so the
        // mirrored pair is the same key rather than a second row with its own status.
        const [low, high] =
          opportunityId < match.id ? [opportunityId, match.id] : [match.id, opportunityId];
        const similarity = round(match.similarity).toString();
        const evidence = {
          signal: signal as unknown as Record<string, unknown>,
          rulesKey: ruleKey,
        };
        const inserted = await repos.duplicatePairs.insertSuspected(
          low,
          high,
          similarity,
          evidence,
        );
        // Only a suspected pair is refreshed. A dismissal is a judgement, and a re-run of the
        // detector is not new information about it.
        await repos.duplicatePairs.refreshSuspected(low, high, similarity, evidence);

        // `returning()` is the intent guard: an existing pair is a refresh, not a new event.
        const pair = inserted;
        if (pair) {
          const [left, right] = await Promise.all([
            loadRowById(repos, pair.opportunityId),
            loadRowById(repos, pair.duplicateOfId),
          ]);
          insertedNotificationIds.push(
            ...(await recordDuplicateNotifications(repos, {
              pair,
              left,
              right,
              events: [
                { kind: "duplicate_suspected", ownerOpportunityId: left.id },
                { kind: "duplicate_suspected", ownerOpportunityId: right.id },
              ],
            })),
          );
        }
      }
      return insertedNotificationIds;
    });
    this.enqueueNotifications(notificationIds);
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
   *
   * WHAT "BELOW THE THRESHOLD" MEANS SINCE THE RULE GREW A SECOND ARM. The paragraphs above argue
   * at length about measuring exactly, and would otherwise read as complete while being wrong: a
   * pair the overlap arm accepts has a cosine BELOW the lexical threshold by construction, so a
   * cosine-only cleanup would delete every arm-B pair on the first pass and detection would put it
   * straight back on the next — an oscillation that re-notifies both owners each time round. The
   * decision therefore goes through `shouldPrune`, which is the detection rule read from the other
   * side and, deliberately, NOT its negation: a counterpart whose norm or token count is unknown is
   * left alone, exactly as a counterpart with no comparable vector always has been.
   */
  private async pruneStalePairs(
    opportunityId: number,
    subject: { vector: number[]; norm: number | null; tokenCount: number | null },
    rule: DuplicateRuleConfig,
  ): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    const rows = await this.repos.embeddings.pairSimilarities(opportunityId, subject.vector, {
      model: provider.model,
      providerId: provider.id,
    });

    const stale = rows
      .filter((row) =>
        shouldPrune(
          {
            similarity: Number(row.similarity),
            left: { norm: subject.norm, tokenCount: subject.tokenCount },
            right: { norm: row.norm, tokenCount: row.tokenCount },
          },
          rule,
        ),
      )
      .map((row) => row.id);
    await this.repos.duplicatePairs.deleteByIds(stale);
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

    // THE SECOND ARM, and it only runs once the embedding cursor has drained. Re-judging pairs
    // against vectors that are themselves about to be replaced would spend the budget twice and
    // could delete a pair the very next embedding pass re-creates.
    const resweptPairs = pending.length === 0 ? await this.resweepStaleRules(limit) : 0;

    const remaining =
      (await this.pendingEmbeddingIds(limit + 1)).length +
      (await this.staleRulesPairCount(limit + 1));
    return { processed: processed + resweptPairs, remaining };
  }

  /**
   * Re-judge suspected pairs that a previous rule wrote, and retire them either way.
   *
   * A CURSOR ARM in the `docs/jobs.md` sense: every row it selects leaves the predicate on this
   * pass — deleted if the current rule no longer accepts it, re-stamped if it does — so `remaining`
   * decreases monotonically and the runner may loop it to zero. That is what makes
   * `DEDUPE_OVERLAP_ENABLED=false` an actual rollback rather than a switch that strands the rows it
   * already wrote, and it fixes the same latent bug for `DEDUPE_SIMILARITY_THRESHOLD`, which has
   * always stranded pairs the same way.
   *
   * `shouldPrune` — not `!decidePair` — for the reason spelled out in `duplicate-signal.ts`.
   *
   * PUBLIC for the same reason `pendingEmbeddingIds` is: the cursor IS the queue, and being able to
   * ask what one arm does without driving the whole job through a shared database is how the
   * rollback stays testable rather than merely asserted.
   */
  async resweepStaleRules(limit: number): Promise<number> {
    const provider = this.provider;
    if (!provider) return 0;
    const rule = this.ruleConfig(provider);
    const ruleKey = this.rulesKeyFor(provider);
    const pairs = await this.repos.embeddings.staleRulesPairs(
      ruleKey,
      { model: provider.model, providerId: provider.id },
      limit,
    );
    if (pairs.length === 0) return 0;

    const doomed: number[] = [];
    const kept: ResweptPair[] = [];
    for (const pair of pairs) {
      const inputs = {
        similarity: pair.similarity,
        left: { norm: pair.leftNorm, tokenCount: pair.leftTokenCount },
        right: { norm: pair.rightNorm, tokenCount: pair.rightTokenCount },
      };
      if (shouldPrune(inputs, rule)) {
        doomed.push(pair.id);
        continue;
      }
      const decision = decidePair(inputs, rule);
      if (decision.accepted && decision.signal) {
        // The re-judgement in full: the similarity recomputed from the two stored vectors, the
        // signal the CURRENT rule produced, and the key naming that rule. Writing the key alone
        // would leave a row claiming this rule accepted it on numbers this rule never saw.
        kept.push({
          id: pair.id,
          similarity: round(pair.similarity).toString(),
          signal: decision.signal as unknown as Record<string, unknown>,
          rulesKey: ruleKey,
        });
      }
      // Neither pruned nor re-judged: a counterpart whose scalars are unknown, which `shouldPrune`
      // deliberately leaves alone. It is left un-stamped too, because stamping it would attribute a
      // judgement nobody made. It cannot linger: an entry with unknown scalars is selected by the
      // EMBEDDING arm, and the resweep only runs at all once that arm has drained.
    }
    await this.repos.duplicatePairs.deleteByIds(doomed);
    await this.repos.duplicatePairs.recordResweep(kept);
    return doomed.length + kept.length;
  }

  /** How much resweep work is left, for the same `remaining` contract the embedding arm has. */
  private async staleRulesPairCount(limit: number): Promise<number> {
    const provider = this.provider;
    if (!provider) return 0;
    const pairs = await this.repos.embeddings.staleRulesPairs(
      this.rulesKeyFor(provider),
      { model: provider.model, providerId: provider.id },
      limit,
    );
    return pairs.length;
  }

  /**
   * Entries with no CURRENT embedding: no row at all, a row from another model or provider, a row
   * whose `content_hash` no longer matches the entry's text, **or a row missing the norm and token
   * count the overlap arm decides on**.
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
      const page = await this.repos.embeddings.pendingPage(afterId);
      if (page.rows.length === 0) break;

      for (const entry of page.rows) {
        afterId = entry.row.id;
        // THE NORM ARM IS GATED ON THE PROVIDER'S DECLARED CAPABILITY. A provider that cannot
        // supply a norm would otherwise select every row on every run and never fix one of them:
        // a cursor that can never retire, reporting the whole table as `remaining` for ever. With
        // the gate, such a provider simply never has this arm, and the overlap rule is inert for
        // it end to end.
        const missingScalars =
          provider.suppliesNorm && (entry.norm === null || entry.tokenCount === null);
        if (
          entry.contentHash === null ||
          entry.model !== provider.model ||
          entry.providerId !== provider.id ||
          missingScalars ||
          entry.contentHash !==
            contentHash(embeddingTextFor(entry.row), provider.model, provider.id)
        ) {
          picked.push(entry.row.id);
          if (picked.length >= limit) break;
        }
      }
      if (!page.hasMore) break;
    }
    return picked;
  }

  // ── the reviewer surface ───────────────────────────────────────────────────────
  /** The pair queue, newest first. Reviewers see every pair, whatever either side's status. */
  async listForReview(
    status: "suspected" | "confirmed" | "dismissed" | "merged" | undefined,
    limit = 50,
  ): Promise<DuplicatePairView[]> {
    const rows = await this.repos.duplicatePairs.listForReview(status, limit);

    const survivors = await this.survivorIds(
      this.repos,
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
    const committed = await withTransaction(this.db, async (repos) => {
      const pair = await lockPair(repos, pairId);
      if (pair.status === "merged") {
        throw conflict(
          "already_merged",
          "that pair has already been merged; a merge is not something a later decision reverses.",
        );
      }
      const now = new Date();
      const next =
        (await repos.duplicatePairs.updateReview(pairId, {
          status,
          reviewedBy: reviewerId,
          reviewedAt: now,
        })) ?? pair;
      await repos.audit.record({
        subjectKind: "duplicate",
        subjectId: pairId,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: decision === "confirm" ? "confirm_duplicate" : "dismiss_duplicate",
        patch: { status: { before: pair.status, after: status } },
      });
      const [left, right] = await Promise.all([
        loadRowById(repos, next.opportunityId),
        loadRowById(repos, next.duplicateOfId),
      ]);
      const notificationIds = await recordDuplicateNotifications(repos, {
        pair: next,
        left,
        right,
        events: [
          { kind: `duplicate_${status}`, ownerOpportunityId: left.id },
          { kind: `duplicate_${status}`, ownerOpportunityId: right.id },
        ],
        decidedBy: "reviewer",
      });
      const survivors = await this.survivorIds(repos, [left.mergedIntoId, right.mergedIntoId]);
      return { result: toPairView(next, left, right, survivors), notificationIds };
    });
    this.enqueueNotifications(committed.notificationIds);
    return committed.result;
  }

  /** Undo a dismissal by returning the pair to the suspected queue. */
  async reopen(reviewerId: number, pairId: number): Promise<DuplicatePairView> {
    const committed = await withTransaction(this.db, async (repos) => {
      const pair = await lockPair(repos, pairId);
      const transition = duplicateReopenTransition(pair.status);
      let next = pair;

      if (transition === "reopen") {
        const now = new Date();
        next =
          (await repos.duplicatePairs.updateReview(pairId, {
            status: "suspected",
            reviewedBy: reviewerId,
            reviewedAt: now,
          })) ?? pair;
        await repos.audit.record({
          subjectKind: "duplicate",
          subjectId: pairId,
          actorKind: "user",
          actorAccountId: reviewerId,
          action: "reopen",
          patch: { status: { before: pair.status, after: "suspected" } },
        });
      }

      const [left, right] = await Promise.all([
        loadRowById(repos, next.opportunityId),
        loadRowById(repos, next.duplicateOfId),
      ]);
      const notificationIds =
        transition === "reopen"
          ? await recordDuplicateNotifications(repos, {
              pair: next,
              left,
              right,
              events: [
                { kind: "duplicate_reopened", ownerOpportunityId: left.id },
                { kind: "duplicate_reopened", ownerOpportunityId: right.id },
              ],
              decidedBy: "reviewer",
            })
          : [];
      const survivors = await this.survivorIds(repos, [left.mergedIntoId, right.mergedIntoId]);
      return { result: toPairView(next, left, right, survivors), notificationIds };
    });
    this.enqueueNotifications(committed.notificationIds);
    return committed.result;
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
    const committed = await withTransaction(this.db, async (repos) => {
      const pair = await lockPair(repos, pairId);
      if (pair.status === "merged") {
        throw conflict("already_merged", "that pair has already been merged.");
      }
      // Locked in id order, always, so two reviewers merging overlapping pairs cannot deadlock.
      const ids = [pair.opportunityId, pair.duplicateOfId].sort((a, b) => a - b);
      const locked = new Map<number, OpportunityRow>();
      for (const id of ids) locked.set(id, await lockOpportunityById(repos, id));

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
      if (await repos.duplicatePairs.hasMergeDependent(loser.id)) {
        throw conflict(
          "loser_has_dependents",
          `${JSON.stringify(loser.publicId)} is itself the survivor of an earlier merge; merging it away would chain that earlier loser through it. Merge the earlier loser directly into ${JSON.stringify(survivor.publicId)} instead.`,
        );
      }

      if (survivor.mergedIntoId !== null) {
        const real = await loadRowById(repos, survivor.mergedIntoId);
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
        const updated = await repos.duplicatePairs.updateOpportunity(survivor.id, {
          ...copied.set,
          updatedAt: now,
        });
        // Inside the transaction, so a merge that would leave the survivor non-conformant does not
        // happen at all rather than happening and being noticed later.
        const { valid, errors } = validateOpportunity(toStandard(updated ?? survivor));
        if (!valid) {
          throw conflict(
            "merge_would_invalidate_survivor",
            `copying ${copied.fields.join(", ")} would leave ${JSON.stringify(survivor.publicId)} invalid against the Standard (${errors.length} violation(s)); the merge was rolled back.`,
          );
        }
      }

      await repos.duplicatePairs.markMergedAway(loser.id, {
        survivorId: survivor.id,
        mergedFromPublic: loser.reviewStatus === "approved" && loser.isListed,
        updatedAt: now,
      });

      const pairRow =
        (await repos.duplicatePairs.updateReview(pairId, {
          status: "merged",
          reviewedBy: reviewerId,
          reviewedAt: now,
        })) ?? pair;

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
        await repos.audit.record({
          subjectKind: "opportunity",
          subjectId: subject,
          actorKind: "user",
          actorAccountId: reviewerId,
          action: "merge",
          patch,
        });
      }

      // Re-read both sides rather than reconstructing them: the loser's row was just rewritten, and
      // a view assembled from the pre-update copy would report the state the merge replaced.
      const [left, right] = await Promise.all([
        loadRowById(repos, pairRow.opportunityId),
        loadRowById(repos, pairRow.duplicateOfId),
      ]);
      const notificationIds = await recordDuplicateNotifications(repos, {
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
        result: {
          pair: toPairView(pairRow, left, right, survivors),
          survivorId: survivor.publicId,
          mergedId: loser.publicId,
          copiedFields: copied.fields,
        },
        notificationIds,
      };
    });
    this.enqueueNotifications(committed.notificationIds);
    return committed.result;
  }

  /** The transaction is committed before this is called; queue failures cannot change its answer. */
  private enqueueNotifications(notificationIds: readonly number[]): void {
    try {
      this.notificationQueue.enqueue(notificationIds);
    } catch {
      // A custom/test adapter gets the same best-effort contract as the production queue.
    }
  }

  private async loadRow(opportunityId: number): Promise<OpportunityRow> {
    return loadRowById(this.repos, opportunityId);
  }

  /** Public ids for a set of `merged_into_id` values, so a side can name its survivor. */
  private async survivorIds(
    repos: Repositories,
    ids: (number | null)[],
  ): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
    if (wanted.length === 0) return new Map();
    return repos.duplicatePairs.survivorPublicIds(wanted);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────
async function recordDuplicateNotifications(
  repos: Repositories,
  input: RecordDuplicateNotificationsInput,
): Promise<number[]> {
  const values = await duplicateNotificationInserts(repos, input);
  return repos.notifications.recordDuplicate(values);
}

async function loadRowById(repos: Repositories, id: number): Promise<OpportunityRow> {
  const row = await repos.opportunities.findById(id);
  if (!row) throw notFound(`no opportunity ${id}.`);
  return row;
}

async function lockOpportunityById(repos: Repositories, id: number): Promise<OpportunityRow> {
  const row = await repos.opportunities.lockById(id);
  if (!row) throw notFound(`no opportunity ${id}.`);
  return row;
}

async function lockPair(repos: Repositories, pairId: number): Promise<OpportunityDuplicateRow> {
  const row = await repos.duplicatePairs.lockById(pairId);
  if (!row) throw notFound(`no duplicate pair ${pairId}.`);
  return row;
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
    signal?: Record<string, unknown> | null;
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
    // The decision inputs verbatim, for the reviewer queue. `null` on every pair written before
    // this column existed, which the queue renders as "no signal recorded".
    signal: pair.signal ?? null,
    matchedOn: matchReasons(pair.signal ?? null, left, right),
    detectedAt: pair.detectedAt.toISOString(),
    reviewedAt: pair.reviewedAt?.toISOString() ?? null,
    left: toSideView(left, survivors),
    right: toSideView(right, survivors),
  };
}

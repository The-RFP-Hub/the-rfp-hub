import { and, desc, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbLike } from "../../../db/client.js";
import {
  type OpportunityDuplicateRow,
  type OpportunityRow,
  opportunities,
  opportunityDuplicates,
} from "../../../db/schema.js";
import type { Principal } from "../../shared/capabilities.js";
import { ownedOpportunityPredicate } from "./opportunity.repository.js";

export interface DuplicatePairSidesRow {
  pair: OpportunityDuplicateRow;
  left: OpportunityRow;
  right: OpportunityRow;
}

export interface DuplicatePairOtherRow {
  pair: OpportunityDuplicateRow;
  other: OpportunityRow;
}

/**
 * What a detection pass records ALONGSIDE the similarity: the numeric decision inputs, and the
 * identity of the rule that made the decision.
 *
 * Passed as one object rather than two positional arguments because they are one fact — a signal
 * without its rule version cannot be interpreted once the thresholds move.
 */
export interface DuplicatePairEvidence {
  signal: Record<string, unknown> | null;
  rulesKey: string;
}

/** One pair the resweep arm re-judged and kept, with everything the new judgement produced. */
export interface ResweptPair extends DuplicatePairEvidence {
  id: number;
  /** The recomputed lexical cosine, in the same string form the column has always stored. */
  similarity: string;
}

export interface DuplicatePairReviewUpdate {
  status: OpportunityDuplicateRow["status"];
  reviewedBy: number;
  reviewedAt: Date;
}

/** Persistence for unordered duplicate pairs and the opportunity reads/writes they coordinate. */
export class DuplicatePairRepository {
  constructor(private readonly exec: DbLike) {}

  /** `returning()` distinguishes a new pair from a refresh of an existing suspected pair. */
  async insertSuspected(
    opportunityId: number,
    duplicateOfId: number,
    similarity: string,
    evidence: DuplicatePairEvidence,
  ): Promise<OpportunityDuplicateRow | undefined> {
    const rows = await this.exec
      .insert(opportunityDuplicates)
      .values({
        opportunityId,
        duplicateOfId,
        similarity,
        signal: evidence.signal,
        rulesKey: evidence.rulesKey,
        status: "suspected",
      })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  /**
   * Detection may refresh only an undecided pair; it never resurrects a review decision.
   *
   * The rule version is rewritten alongside the similarity, which is what keeps a re-detected pair
   * out of the resweep arm's cursor on the very next pass.
   */
  async refreshSuspected(
    opportunityId: number,
    duplicateOfId: number,
    similarity: string,
    evidence: DuplicatePairEvidence,
  ): Promise<void> {
    await this.exec
      .update(opportunityDuplicates)
      .set({ similarity, signal: evidence.signal, rulesKey: evidence.rulesKey })
      .where(
        and(
          eq(opportunityDuplicates.opportunityId, opportunityId),
          eq(opportunityDuplicates.duplicateOfId, duplicateOfId),
          eq(opportunityDuplicates.status, "suspected"),
        ),
      );
  }

  /**
   * Record the resweep arm's re-judgement of the pairs it kept.
   *
   * ALL THREE FIELDS MOVE TOGETHER, and that is the same invariant the service header states about
   * detection: a signal and the rule identity beside it are ONE fact. Stamping the new key while
   * leaving the old `similarity` and `signal` would produce a row claiming the current rule
   * accepted it on numbers the current rule never saw — and those numbers are what a reviewer reads
   * to understand why a pair below the cosine threshold is in their queue at all.
   *
   * Retiring the rows from the cursor is the other half of the point: a resweep that deleted the
   * pairs it rejected but left the accepted ones carrying the old key would select the same rows on
   * every run for ever, which is precisely the non-retiring cursor `docs/jobs.md` forbids.
   *
   * One statement per row rather than a bulk `UPDATE`: each row carries its OWN recomputed
   * similarity and signal, so there is nothing to batch. The caller bounds the count.
   */
  async recordResweep(pairs: ResweptPair[]): Promise<void> {
    for (const pair of pairs) {
      await this.exec
        .update(opportunityDuplicates)
        .set({ similarity: pair.similarity, signal: pair.signal, rulesKey: pair.rulesKey })
        .where(eq(opportunityDuplicates.id, pair.id));
    }
  }

  async deleteByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.exec.delete(opportunityDuplicates).where(inArray(opportunityDuplicates.id, ids));
  }

  async lockById(pairId: number): Promise<OpportunityDuplicateRow | undefined> {
    const rows = await this.exec
      .select()
      .from(opportunityDuplicates)
      .where(eq(opportunityDuplicates.id, pairId))
      .for("update")
      .limit(1);
    return rows[0];
  }

  async updateReview(
    pairId: number,
    values: DuplicatePairReviewUpdate,
  ): Promise<OpportunityDuplicateRow | undefined> {
    const rows = await this.exec
      .update(opportunityDuplicates)
      .set(values)
      .where(eq(opportunityDuplicates.id, pairId))
      .returning();
    return rows[0];
  }

  /** Two aliases are mandatory: a pair names two distinct rows from the same table. */
  async listForReview(
    status: OpportunityDuplicateRow["status"] | undefined,
    limit: number,
  ): Promise<DuplicatePairSidesRow[]> {
    const left = alias(opportunities, "dup_left");
    const right = alias(opportunities, "dup_right");
    return this.exec
      .select({ pair: opportunityDuplicates, left, right })
      .from(opportunityDuplicates)
      .innerJoin(left, eq(left.id, opportunityDuplicates.opportunityId))
      .innerJoin(right, eq(right.id, opportunityDuplicates.duplicateOfId))
      .where(status === undefined ? undefined : eq(opportunityDuplicates.status, status))
      .orderBy(desc(opportunityDuplicates.detectedAt), desc(opportunityDuplicates.id))
      .limit(limit);
  }

  /** Both pair columns are searched; the joined row is always the counterpart. */
  async listForOpportunity(opportunityId: number): Promise<DuplicatePairOtherRow[]> {
    const other = alias(opportunities, "duplicate_counterpart");
    return this.exec
      .select({ pair: opportunityDuplicates, other })
      .from(opportunityDuplicates)
      .innerJoin(
        other,
        or(
          and(
            eq(opportunityDuplicates.opportunityId, opportunityId),
            eq(other.id, opportunityDuplicates.duplicateOfId),
          ),
          and(
            eq(opportunityDuplicates.duplicateOfId, opportunityId),
            eq(other.id, opportunityDuplicates.opportunityId),
          ),
        ),
      )
      .orderBy(desc(opportunityDuplicates.detectedAt));
  }

  /** Account ownership is applied to either side before the service enforces counterpart visibility. */
  async listForOwner(principal: Principal, limit: number): Promise<DuplicatePairSidesRow[]> {
    const left = alias(opportunities, "owned_dup_left");
    const right = alias(opportunities, "owned_dup_right");
    const mineOnLeft = ownedOpportunityPredicate(left, principal);
    const mineOnRight = ownedOpportunityPredicate(right, principal);

    return this.exec
      .select({ pair: opportunityDuplicates, left, right })
      .from(opportunityDuplicates)
      .innerJoin(left, eq(left.id, opportunityDuplicates.opportunityId))
      .innerJoin(right, eq(right.id, opportunityDuplicates.duplicateOfId))
      .where(or(mineOnLeft, mineOnRight))
      .orderBy(desc(opportunityDuplicates.detectedAt))
      .limit(limit);
  }

  async hasMergeDependent(opportunityId: number): Promise<boolean> {
    const rows = await this.exec
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.mergedIntoId, opportunityId))
      .limit(1);
    return rows.length > 0;
  }

  async updateOpportunity(
    opportunityId: number,
    values: Partial<OpportunityRow>,
  ): Promise<OpportunityRow | undefined> {
    const rows = await this.exec
      .update(opportunities)
      .set(values)
      .where(eq(opportunities.id, opportunityId))
      .returning();
    return rows[0];
  }

  async markMergedAway(
    opportunityId: number,
    values: {
      survivorId: number;
      mergedFromPublic: boolean;
      updatedAt: Date;
    },
  ): Promise<void> {
    await this.exec
      .update(opportunities)
      .set({
        reviewStatus: "rejected",
        isListed: false,
        status: "archived",
        mergedIntoId: values.survivorId,
        mergedFromPublic: values.mergedFromPublic,
        updatedAt: values.updatedAt,
      })
      .where(eq(opportunities.id, opportunityId));
  }

  /** Public ids for `merged_into_id` values, fetched in one query for pair projection. */
  async survivorPublicIds(ids: number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.exec
      .select({ id: opportunities.id, publicId: opportunities.publicId })
      .from(opportunities)
      .where(inArray(opportunities.id, ids));
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }
}

import { and, desc, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbLike } from "../../../db/client.js";
import {
  type OpportunityDuplicateRow,
  type OpportunityRow,
  type VerificationRunRow,
  opportunities,
  opportunityDuplicates,
  verificationRuns,
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
  ): Promise<OpportunityDuplicateRow | undefined> {
    const rows = await this.exec
      .insert(opportunityDuplicates)
      .values({ opportunityId, duplicateOfId, similarity, status: "suspected" })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  /** Detection may refresh only an undecided pair; it never resurrects a review decision. */
  async refreshSuspected(
    opportunityId: number,
    duplicateOfId: number,
    similarity: string,
  ): Promise<void> {
    await this.exec
      .update(opportunityDuplicates)
      .set({ similarity })
      .where(
        and(
          eq(opportunityDuplicates.opportunityId, opportunityId),
          eq(opportunityDuplicates.duplicateOfId, duplicateOfId),
          eq(opportunityDuplicates.status, "suspected"),
        ),
      );
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

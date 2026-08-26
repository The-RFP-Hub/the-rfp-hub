import { type SQL, and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbLike } from "../../../db/client.js";
import {
  type OpportunityEmbeddingRow,
  type OpportunityRow,
  opportunities,
  opportunityDuplicates,
  opportunityEmbeddings,
} from "../../../db/schema.js";

/** How many neighbours the HNSW index returns before the threshold is applied. */
const ANN_CANDIDATES = 20;

/** Rows read per pass while walking the corpus for entries whose embedding is not current. */
const SCAN_PAGE = 500;

export type EmbeddingCandidateScope = "public" | "all";

export interface EmbeddingIdentity {
  providerId: string;
  model: string;
}

export interface CorpusAvailability {
  eligibleOpportunityCount: number;
  compatibleEmbeddingCount: number;
  searchable: boolean;
}

export interface EmbeddingSearchMatch {
  id: number;
  publicId: string;
  title: string;
  isPublic: boolean;
  similarity: number;
  /**
   * The counterpart's stored magnitude and vocabulary size — null on a row the backfill has not
   * yet repaired. The overlap arm needs both, and unknown degrades that arm to "not evaluated"
   * rather than to any assumption about the pair.
   */
  norm: number | null;
  tokenCount: number | null;
}

export interface PendingEmbeddingRow {
  row: OpportunityRow;
  model: string | null;
  providerId: string | null;
  contentHash: string | null;
  norm: number | null;
  tokenCount: number | null;
}

/** One suspected pair carrying a stale rule key, with both sides' decision inputs. */
export interface StaleRulesPair {
  id: number;
  similarity: number;
  leftNorm: number | null;
  rightNorm: number | null;
  leftTokenCount: number | null;
  rightTokenCount: number | null;
}

/** Persistence and pgvector queries for semantic duplicate detection. */
export class EmbeddingRepository {
  constructor(private readonly exec: DbLike) {}

  /**
   * Whether an eligible corpus exists but its live provider/model slice is exactly empty.
   * A partial backfill remains searchable; zero compatible vectors in a non-empty corpus does not.
   */
  async corpusAvailability(
    opportunityId: number,
    scope: EmbeddingCandidateScope,
    identity: EmbeddingIdentity,
  ): Promise<CorpusAvailability> {
    const where: SQL[] = [
      sql`${opportunities.id} <> ${opportunityId}`,
      isNull(opportunities.mergedIntoId),
    ];
    if (scope === "public") {
      where.push(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true));
    }

    const rows = await this.exec
      .select({
        eligibleOpportunityCount: sql<number>`count(*)::int`,
        compatibleEmbeddingCount: sql<number>`count(${opportunityEmbeddings.opportunityId}) filter (
          where ${opportunityEmbeddings.model} = ${identity.model}
            and ${opportunityEmbeddings.providerId} = ${identity.providerId}
        )::int`,
      })
      .from(opportunities)
      .leftJoin(opportunityEmbeddings, eq(opportunities.id, opportunityEmbeddings.opportunityId))
      .where(and(...where));

    const eligibleOpportunityCount = Number(rows[0]?.eligibleOpportunityCount ?? 0);
    const compatibleEmbeddingCount = Number(rows[0]?.compatibleEmbeddingCount ?? 0);
    return {
      eligibleOpportunityCount,
      compatibleEmbeddingCount,
      searchable: eligibleOpportunityCount === 0 || compatibleEmbeddingCount > 0,
    };
  }

  async findByOpportunityId(opportunityId: number): Promise<OpportunityEmbeddingRow | undefined> {
    const rows = await this.exec
      .select()
      .from(opportunityEmbeddings)
      .where(eq(opportunityEmbeddings.opportunityId, opportunityId))
      .limit(1);
    return rows[0];
  }

  /**
   * Write one embedding row.
   *
   * `norm` and `tokenCount` are in the `onConflictDoUpdate` SET as well as in the insert values,
   * and that is not boilerplate. The rows this repair exists for ALREADY EXIST, with a matching
   * content hash and a null norm, so every one of them takes the conflict branch. Leaving the two
   * columns out of the SET would make the backfill a silent no-op on exactly the rows it was
   * written to fix, and the cursor would never retire them.
   */
  async upsert(values: {
    opportunityId: number;
    model: string;
    providerId: string;
    embedding: number[];
    contentHash: string;
    norm: number | null;
    tokenCount: number | null;
  }): Promise<void> {
    await this.exec
      .insert(opportunityEmbeddings)
      .values(values)
      .onConflictDoUpdate({
        target: opportunityEmbeddings.opportunityId,
        set: {
          model: values.model,
          providerId: values.providerId,
          embedding: values.embedding,
          contentHash: values.contentHash,
          norm: values.norm,
          tokenCount: values.tokenCount,
          createdAt: new Date(),
        },
      });
  }

  /**
   * The ANN lookup stays in its original pgvector form so the vector remains one bound/cast
   * parameter and the planner can reach the HNSW cosine-distance index.
   */
  async searchNearest(
    vector: number[],
    options: {
      exclude: number;
      scope: EmbeddingCandidateScope;
      identity: EmbeddingIdentity;
    },
  ): Promise<EmbeddingSearchMatch[]> {
    const distance = cosineDistanceTo(vector);
    const where: (SQL | undefined)[] = [
      sql`${opportunityEmbeddings.opportunityId} <> ${options.exclude}`,
      eq(opportunityEmbeddings.model, options.identity.model),
      eq(opportunityEmbeddings.providerId, options.identity.providerId),
      isNull(opportunities.mergedIntoId),
    ];
    if (options.scope === "public") {
      where.push(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true));
    }

    const rows = await this.exec
      .select({
        id: opportunities.id,
        publicId: opportunities.publicId,
        title: opportunities.title,
        reviewStatus: opportunities.reviewStatus,
        isListed: opportunities.isListed,
        similarity: sql<number>`1 - (${distance})`,
        // Projected, never ordered on: the ANN ordering must stay pure cosine distance or the
        // planner loses the HNSW index and the search degrades to a sequential scan.
        norm: opportunityEmbeddings.norm,
        tokenCount: opportunityEmbeddings.tokenCount,
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
      norm: row.norm === null ? null : Number(row.norm),
      tokenCount: row.tokenCount === null ? null : Number(row.tokenCount),
    }));
  }

  /**
   * Exact similarity for every suspected pair touching one entry in the live vector space, plus
   * the COUNTERPART's norm and token count.
   *
   * THE NULLS COME BACK. There is deliberately no `WHERE norm IS NOT NULL` here: filtering in SQL
   * would hide the unknown-counterpart case from `shouldPrune`, which is the one place it is
   * handled correctly, and would hide it from the unit test that pins the handling.
   */
  async pairSimilarities(
    opportunityId: number,
    vector: number[],
    identity: EmbeddingIdentity,
  ): Promise<{ id: number; similarity: number; norm: number | null; tokenCount: number | null }[]> {
    const counterpart = sql`case when ${opportunityDuplicates.opportunityId} = ${opportunityId} then ${opportunityDuplicates.duplicateOfId} else ${opportunityDuplicates.opportunityId} end`;
    const rows = await this.exec
      .select({
        id: opportunityDuplicates.id,
        similarity: sql<number>`1 - (${cosineDistanceTo(vector)})`,
        norm: opportunityEmbeddings.norm,
        tokenCount: opportunityEmbeddings.tokenCount,
      })
      .from(opportunityDuplicates)
      .innerJoin(
        opportunityEmbeddings,
        and(
          sql`${opportunityEmbeddings.opportunityId} = ${counterpart}`,
          eq(opportunityEmbeddings.model, identity.model),
          eq(opportunityEmbeddings.providerId, identity.providerId),
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
    return rows.map((row) => ({
      ...row,
      similarity: Number(row.similarity),
      norm: row.norm === null ? null : Number(row.norm),
      tokenCount: row.tokenCount === null ? null : Number(row.tokenCount),
    }));
  }

  /** One page of opportunities and their possibly absent embedding metadata. */
  async pendingPage(afterId: number): Promise<{ rows: PendingEmbeddingRow[]; hasMore: boolean }> {
    const rows = await this.exec
      .select({
        row: opportunities,
        model: opportunityEmbeddings.model,
        providerId: opportunityEmbeddings.providerId,
        contentHash: opportunityEmbeddings.contentHash,
        norm: opportunityEmbeddings.norm,
        tokenCount: opportunityEmbeddings.tokenCount,
      })
      .from(opportunities)
      .leftJoin(opportunityEmbeddings, eq(opportunityEmbeddings.opportunityId, opportunities.id))
      .where(and(isNull(opportunities.mergedIntoId), gt(opportunities.id, afterId)))
      .orderBy(asc(opportunities.id))
      .limit(SCAN_PAGE);
    return { rows, hasMore: rows.length === SCAN_PAGE };
  }

  /**
   * Suspected pairs written by a rule that is no longer the current one, with the decision inputs
   * needed to re-judge them — the `embedding-backfill` job's resweep arm.
   *
   * BOTH SIDES ARE INNER-JOINED on a CURRENT-space embedding, and that is what makes this a cursor
   * arm rather than a queue that never drains. A pair whose side has no compatible vector cannot be
   * re-judged here, so it is not selected here; it is retired by the job's FIRST arm instead, which
   * re-embeds that side and re-records the pair with the current rule version. Every stale pair is
   * therefore reachable by exactly one arm, and both arms retire what they select.
   *
   * `IS DISTINCT FROM` rather than `<>` so the NULL rule key every pre-versioning pair carries is
   * selected too — those are precisely the rows a threshold change used to strand.
   */
  async staleRulesPairs(
    rulesKey: string,
    identity: EmbeddingIdentity,
    limit: number,
  ): Promise<StaleRulesPair[]> {
    const left = alias(opportunityEmbeddings, "dup_left_embedding");
    const right = alias(opportunityEmbeddings, "dup_right_embedding");
    const leftOpp = alias(opportunities, "dup_left_opportunity");
    const rightOpp = alias(opportunities, "dup_right_opportunity");
    const rows = await this.exec
      .select({
        id: opportunityDuplicates.id,
        similarity: sql<number>`1 - (${left.embedding} <=> ${right.embedding})`,
        leftNorm: left.norm,
        rightNorm: right.norm,
        leftTokenCount: left.tokenCount,
        rightTokenCount: right.tokenCount,
      })
      .from(opportunityDuplicates)
      .innerJoin(
        left,
        and(
          eq(left.opportunityId, opportunityDuplicates.opportunityId),
          eq(left.model, identity.model),
          eq(left.providerId, identity.providerId),
        ),
      )
      .innerJoin(
        right,
        and(
          eq(right.opportunityId, opportunityDuplicates.duplicateOfId),
          eq(right.model, identity.model),
          eq(right.providerId, identity.providerId),
        ),
      )
      .innerJoin(leftOpp, eq(leftOpp.id, opportunityDuplicates.opportunityId))
      .innerJoin(rightOpp, eq(rightOpp.id, opportunityDuplicates.duplicateOfId))
      .where(
        and(
          eq(opportunityDuplicates.status, "suspected"),
          sql`${opportunityDuplicates.rulesKey} is distinct from ${rulesKey}`,
          // MIRRORS `pendingPage`. A merged-away entry is never re-embedded by the first arm, so a
          // pair on one whose scalars are unknown could be neither pruned, nor re-judged, nor
          // repaired — selected every night and retired by nobody, and at the head of the id order
          // it would eventually crowd every later stale pair out of the LIMIT. Such a pair is out
          // of the resweep's reach by construction, so it is out of its predicate too.
          isNull(leftOpp.mergedIntoId),
          isNull(rightOpp.mergedIntoId),
        ),
      )
      .orderBy(asc(opportunityDuplicates.id))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      similarity: Number(row.similarity),
      leftNorm: row.leftNorm === null ? null : Number(row.leftNorm),
      rightNorm: row.rightNorm === null ? null : Number(row.rightNorm),
      leftTokenCount: row.leftTokenCount === null ? null : Number(row.leftTokenCount),
      rightTokenCount: row.rightTokenCount === null ? null : Number(row.rightTokenCount),
    }));
  }
}

/**
 * `embedding <=> $vector::vector` — pgvector cosine distance through one bound/cast parameter.
 */
function cosineDistanceTo(vector: number[]): SQL<number> {
  return sql<number>`${opportunityEmbeddings.embedding} <=> ${toVectorLiteral(vector)}::vector`;
}

/** `[0.1,-0.2,...]`, the text form pgvector parses. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

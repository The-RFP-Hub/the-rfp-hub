import { type SQL, and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
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
}

export interface PendingEmbeddingRow {
  row: OpportunityRow;
  model: string | null;
  providerId: string | null;
  contentHash: string | null;
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

  async upsert(values: {
    opportunityId: number;
    model: string;
    providerId: string;
    embedding: number[];
    contentHash: string;
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

  /** Exact similarity for every suspected pair touching one entry in the live vector space. */
  async pairSimilarities(
    opportunityId: number,
    vector: number[],
    identity: EmbeddingIdentity,
  ): Promise<{ id: number; similarity: number }[]> {
    const counterpart = sql`case when ${opportunityDuplicates.opportunityId} = ${opportunityId} then ${opportunityDuplicates.duplicateOfId} else ${opportunityDuplicates.opportunityId} end`;
    const rows = await this.exec
      .select({
        id: opportunityDuplicates.id,
        similarity: sql<number>`1 - (${cosineDistanceTo(vector)})`,
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
    return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
  }

  /** One page of opportunities and their possibly absent embedding metadata. */
  async pendingPage(afterId: number): Promise<{ rows: PendingEmbeddingRow[]; hasMore: boolean }> {
    const rows = await this.exec
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
    return { rows, hasMore: rows.length === SCAN_PAGE };
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

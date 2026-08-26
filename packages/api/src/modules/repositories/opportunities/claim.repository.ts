import { and, eq } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import {
  type OpportunityClaimRow,
  accounts,
  opportunities,
  opportunityClaims,
  organizations,
} from "../../../db/schema.js";

export interface ClaimInsert {
  opportunityId: number;
  organizationId: number;
  accountId: number;
  note: string | null;
}

export class ClaimRepository {
  constructor(private readonly exec: DbLike) {}

  async findPending(
    opportunityId: number,
    organizationId: number,
  ): Promise<OpportunityClaimRow | undefined> {
    const rows = await this.exec
      .select()
      .from(opportunityClaims)
      .where(
        and(
          eq(opportunityClaims.opportunityId, opportunityId),
          eq(opportunityClaims.organizationId, organizationId),
          eq(opportunityClaims.status, "pending"),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async insert(values: ClaimInsert): Promise<OpportunityClaimRow | undefined> {
    const rows = await this.exec.insert(opportunityClaims).values(values).returning();
    return rows[0];
  }

  async settlePendingForGrant(
    opportunityId: number,
    organizationId: number,
    decidedBy: number,
    decidedAt: Date,
  ): Promise<number[]> {
    const rows = await this.exec
      .update(opportunityClaims)
      .set({ status: "approved", decidedBy, decidedAt })
      .where(
        and(
          eq(opportunityClaims.opportunityId, opportunityId),
          eq(opportunityClaims.organizationId, organizationId),
          eq(opportunityClaims.status, "pending"),
        ),
      )
      .returning({ id: opportunityClaims.id });
    return rows.map((row) => row.id);
  }

  async listForReview(status: OpportunityClaimRow["status"]) {
    return this.exec
      .select({
        claim: opportunityClaims,
        opportunity: opportunities,
        organization: organizations,
        handle: accounts.handle,
      })
      .from(opportunityClaims)
      .innerJoin(opportunities, eq(opportunities.id, opportunityClaims.opportunityId))
      .innerJoin(organizations, eq(organizations.id, opportunityClaims.organizationId))
      .leftJoin(accounts, eq(accounts.id, opportunityClaims.accountId))
      .where(eq(opportunityClaims.status, status))
      .orderBy(opportunityClaims.createdAt);
  }

  async findOpportunityId(claimId: number): Promise<number | undefined> {
    const rows = await this.exec
      .select({ opportunityId: opportunityClaims.opportunityId })
      .from(opportunityClaims)
      .where(eq(opportunityClaims.id, claimId))
      .limit(1);
    return rows[0]?.opportunityId;
  }

  async lockWithOrganization(claimId: number) {
    const rows = await this.exec
      .select({ claim: opportunityClaims, organization: organizations })
      .from(opportunityClaims)
      .innerJoin(organizations, eq(organizations.id, opportunityClaims.organizationId))
      .where(eq(opportunityClaims.id, claimId))
      .for("update")
      .limit(1);
    return rows[0];
  }

  async decide(
    claimId: number,
    status: "approved" | "rejected",
    decidedBy: number,
    decidedAt: Date,
  ): Promise<void> {
    await this.exec
      .update(opportunityClaims)
      .set({ status, decidedBy, decidedAt })
      .where(eq(opportunityClaims.id, claimId));
  }
}

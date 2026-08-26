import { count, eq } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import {
  type OrganizationInsert,
  type OrganizationRow,
  organizations,
} from "../../../db/schema.js";

export class OrganizationRepository {
  constructor(private readonly exec: DbLike) {}

  async findBySlug(slug: string): Promise<OrganizationRow | undefined> {
    const rows = await this.exec
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return rows[0];
  }

  async lockByIdForClaim(id: number): Promise<OrganizationRow | undefined> {
    const rows = await this.exec
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .for("share")
      .limit(1);
    return rows[0];
  }

  async verifiedBySlug(slug: string): Promise<boolean | undefined> {
    const rows = await this.exec
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return rows[0]?.verified;
  }

  async verifyForClaim(id: number, now: Date): Promise<void> {
    await this.exec
      .update(organizations)
      .set({ verified: true, verifiedAt: now, updatedAt: now })
      .where(eq(organizations.id, id));
  }

  async listVerified(): Promise<OrganizationRow[]> {
    return this.exec
      .select()
      .from(organizations)
      .where(eq(organizations.verified, true))
      .orderBy(organizations.slug);
  }

  async countVerified(): Promise<number> {
    const counted = await this.exec
      .select({ value: count() })
      .from(organizations)
      .where(eq(organizations.verified, true));
    return counted[0]?.value ?? 0;
  }

  async insertStubs(values: OrganizationInsert[]): Promise<void> {
    if (values.length === 0) return;
    await this.exec
      .insert(organizations)
      .values(values)
      .onConflictDoNothing({ target: organizations.slug });
  }
}

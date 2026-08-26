import { count, eq } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import { type OrganizationRow, organizations } from "../../../db/schema.js";

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
}

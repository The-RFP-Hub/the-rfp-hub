import { and, count, eq, ilike, or } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import {
  type OrganizationInsert,
  type OrganizationRow,
  organizations,
} from "../../../db/schema.js";

export type OrganizationUpdate = Partial<
  Pick<
    OrganizationRow,
    | "name"
    | "description"
    | "website"
    | "logoUrl"
    | "bannerUrl"
    | "ecosystems"
    | "verified"
    | "verifiedAt"
    | "updatedAt"
  >
>;

export class OrganizationRepository {
  constructor(private readonly exec: DbLike) {}

  /** Keep the directory synchronized with a validated Standard document during ingest. */
  async upsertFromIngest(org: OrganizationInsert): Promise<number> {
    const rows = await this.exec
      .insert(organizations)
      .values(org)
      .onConflictDoUpdate({
        target: organizations.slug,
        set: {
          name: org.name,
          orgType: org.orgType,
          description: org.description,
          website: org.website,
          logoUrl: org.logoUrl,
          bannerUrl: org.bannerUrl,
          socialLinks: org.socialLinks,
          ecosystems: org.ecosystems,
          contacts: org.contacts,
          updatedAt: new Date(),
        },
      })
      .returning({ id: organizations.id });
    const upserted = rows[0];
    if (!upserted) throw new Error(`failed to upsert organization '${org.slug}'`);
    return upserted.id;
  }

  async findBySlug(slug: string): Promise<OrganizationRow | undefined> {
    const rows = await this.exec
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return rows[0];
  }

  async lockBySlug(slug: string): Promise<OrganizationRow | undefined> {
    const rows = await this.exec
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .for("update")
      .limit(1);
    return rows[0];
  }

  async update(id: number, values: OrganizationUpdate): Promise<OrganizationRow | undefined> {
    const rows = await this.exec
      .update(organizations)
      .set(values)
      .where(eq(organizations.id, id))
      .returning();
    return rows[0];
  }

  async search(
    q: string | undefined,
    verified: boolean | undefined,
    limit: number,
  ): Promise<OrganizationRow[]> {
    const query = (q ?? "").trim();
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const where = and(
      query === ""
        ? undefined
        : or(ilike(organizations.slug, like), ilike(organizations.name, like)),
      verified === undefined ? undefined : eq(organizations.verified, verified),
    );
    return this.exec
      .select()
      .from(organizations)
      .where(where)
      .orderBy(organizations.slug)
      .limit(limit);
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

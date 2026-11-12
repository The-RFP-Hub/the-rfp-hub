import { and, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import {
  type OrganizationInsert,
  type OrganizationRow,
  opportunities,
  opportunityClaims,
  orgMembershipInvites,
  orgMemberships,
  organizations,
} from "../../../db/schema.js";

export type OrganizationUpdate = Partial<
  Pick<
    OrganizationRow,
    | "name"
    | "orgType"
    | "description"
    | "website"
    | "logoUrl"
    | "bannerUrl"
    | "socialLinks"
    | "ecosystems"
    | "contacts"
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

  async findById(id: number): Promise<OrganizationRow | undefined> {
    const rows = await this.exec
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
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

  /** The slugs among `slugs` that already have a directory row. */
  async existingSlugs(slugs: string[]): Promise<Set<string>> {
    if (slugs.length === 0) return new Set();
    const rows = await this.exec
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(inArray(organizations.slug, slugs));
    return new Set(rows.map((row) => row.slug));
  }

  /**
   * Every organization that ONLY rejected entries name: unverified, with no membership, invite or
   * claim (each of which would cascade on delete), and no non-rejected citation. Includes uncited
   * rows. What `scripts/cleanup-rejected-org-stubs.ts` reports and,
   * when told to, deletes. Never a verified organization, whatever else is true.
   */
  async citedOnlyByRejected(): Promise<OrganizationRow[]> {
    return this.exec
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.verified, false),
          sql`not exists (select 1 from ${opportunities} o where ${organizations.slug} = any(o.org_slugs) and o.review_status <> 'rejected')`,
          sql`not exists (select 1 from ${orgMemberships} m where m.organization_id = ${organizations.id})`,
          sql`not exists (select 1 from ${orgMembershipInvites} i where i.organization_id = ${organizations.id})`,
          sql`not exists (select 1 from ${opportunityClaims} c where c.organization_id = ${organizations.id})`,
        ),
      )
      .orderBy(organizations.slug);
  }

  /**
   * Delete organizations by id, re-checking the same predicate under the delete so a row that
   * gained a membership, a claim or a live citation since it was listed is left alone.
   */
  async deleteIfStillCitedOnlyByRejected(ids: number[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec
      .delete(organizations)
      .where(
        and(
          inArray(organizations.id, ids),
          eq(organizations.verified, false),
          sql`not exists (select 1 from ${opportunities} o where ${organizations.slug} = any(o.org_slugs) and o.review_status <> 'rejected')`,
          sql`not exists (select 1 from ${orgMemberships} m where m.organization_id = ${organizations.id})`,
          sql`not exists (select 1 from ${orgMembershipInvites} i where i.organization_id = ${organizations.id})`,
          sql`not exists (select 1 from ${opportunityClaims} c where c.organization_id = ${organizations.id})`,
        ),
      )
      .returning({ slug: organizations.slug });
    return rows.map((row) => row.slug);
  }

  /** Remove citations dropped by an edit only when nothing else depends on the row. */
  async deleteUncitedStubs(slugs: string[]): Promise<void> {
    if (slugs.length === 0) return;
    await this.exec
      .delete(organizations)
      .where(
        and(
          inArray(organizations.slug, slugs),
          eq(organizations.verified, false),
          sql`not exists (select 1 from ${opportunities} o where ${organizations.slug} = any(o.org_slugs))`,
          sql`not exists (select 1 from ${orgMemberships} m where m.organization_id = ${organizations.id})`,
          sql`not exists (select 1 from ${orgMembershipInvites} i where i.organization_id = ${organizations.id})`,
          sql`not exists (select 1 from ${opportunityClaims} c where c.organization_id = ${organizations.id})`,
        ),
      );
  }

  async insertStubs(values: OrganizationInsert[]): Promise<void> {
    if (values.length === 0) return;
    await this.exec
      .insert(organizations)
      .values(values)
      .onConflictDoNothing({ target: organizations.slug });
  }
}

/**
 * Fixture teardown for the M3 integration suites.
 *
 * Every suite tags its rows with a prefix (`m3auth:`, `m3write:`, …) and removes exactly those,
 * so the suites are order-independent and safe to run against a database that has other data in it.
 *
 * `audit_log` IS DELIBERATELY NOT CLEANED, and cannot be: a database trigger raises on `DELETE`
 * against it, which is the property the append-only design exists to have. Test rows accumulate;
 * they carry no foreign keys, they are scoped to subject ids that no longer resolve, and a history
 * a test could erase would not be a history.
 */
import { eq, inArray, like } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import {
  accounts,
  apiKeys,
  opportunities,
  opportunityClaims,
  orgMemberships,
  organizations,
} from "../../src/db/schema.js";

export interface FixturePrefixes {
  /** Public-id prefix, e.g. `m3write:`. Also matches the organisation slugs the suite creates. */
  opportunityPrefix?: string;
  /** Organisation slugs to remove outright. */
  organizationSlugs?: string[];
  /** Identity-provider subjects the suite provisioned. */
  privyDids?: string[];
}

export async function cleanupFixtures(prefixes: FixturePrefixes): Promise<void> {
  if (prefixes.opportunityPrefix) {
    const rows = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(like(opportunities.publicId, `${prefixes.opportunityPrefix}%`));
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      // Claims cascade from the opportunity, but deleting them first keeps the intent explicit.
      await db.delete(opportunityClaims).where(inArray(opportunityClaims.opportunityId, ids));
      await db.delete(opportunities).where(inArray(opportunities.id, ids));
    }
  }

  for (const slug of prefixes.organizationSlugs ?? []) {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    const org = rows[0];
    if (!org) continue;
    await db.delete(orgMemberships).where(eq(orgMemberships.organizationId, org.id));
    await db.delete(organizations).where(eq(organizations.id, org.id));
  }

  for (const did of prefixes.privyDids ?? []) {
    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.privyDid, did));
    const account = rows[0];
    if (!account) continue;
    await db.delete(apiKeys).where(eq(apiKeys.accountId, account.id));
    await db.delete(orgMemberships).where(eq(orgMemberships.accountId, account.id));
    await db.delete(accounts).where(eq(accounts.id, account.id));
  }
}

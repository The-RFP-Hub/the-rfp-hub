/**
 * Fixture teardown for the M3 integration suites.
 *
 * Every suite tags its rows with a prefix (`m3auth:`, `m3write:`, …) and removes exactly those,
 * so the suites are order-independent and safe to run against a database that has other data in it.
 *
 * The identity tables are cleaned alongside the account rows: `auth_session`/`auth_account`
 * cascade from `auth_user`, but `auth_verification` is keyed on an ADDRESS and cascades from
 * nothing, so it accumulates one row per sign-in code across runs unless it is collected by hand.
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
  authUser,
  authVerification,
  opportunities,
  opportunityClaims,
  orgMemberships,
  organizations,
} from "../../src/db/schema.js";

export interface FixturePrefixes {
  /**
   * Public-id prefix, e.g. `m3write:`. Also matches the organisation slugs the suite creates.
   *
   * NO NAMESPACE MAY BE A PREFIX OF ANOTHER. This is a `LIKE '<prefix>%'`, and a bare namespace is
   * the right thing to pass — several suites deliberately span `<ns>` and `<ns>-other` and need the
   * wide sweep. What that costs is a naming rule: `m3ana` also matches `m3anashut:one`, and because
   * suites run in PARALLEL that is not a tidy over-delete at the end of a run — it hard-deletes a
   * neighbouring suite's rows while that suite is asserting on them, cascading their analytics
   * events away too. Both collisions that existed (`m3ana`/`m3anashut`, `m3dup`/`m3dupoff`) were
   * fixed by renaming the longer one, not by narrowing the sweep.
   */
  opportunityPrefix?: string;
  /** Organisation slugs to remove outright. */
  organizationSlugs?: string[];
  /** The subjects the suite signed in — `userId` from `signIn()`, never an address. */
  userIds?: string[];
  /**
   * Public handles this suite claims. Handles are globally unique, so a row left behind by an
   * earlier run — or by a run of an older shape, which is what a pre-migration orphan is — would
   * otherwise make the suite unseedable while telling it only that the insert did nothing.
   */
  handles?: string[];
  /**
   * Addresses whose IDENTITY rows should go too. Separate from `userIds` because a suite may want
   * the account gone while the identity survives, and because a sign-in that never reached
   * `accounts` leaves an `auth_user` row that nothing else would collect.
   */
  emails?: string[];
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

  for (const handle of prefixes.handles ?? []) {
    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.handle, handle));
    for (const account of rows) {
      await db.delete(apiKeys).where(eq(apiKeys.accountId, account.id));
      await db.delete(orgMemberships).where(eq(orgMemberships.accountId, account.id));
      await db.delete(accounts).where(eq(accounts.id, account.id));
    }
  }

  for (const userId of prefixes.userIds ?? []) {
    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.authUserId, userId));
    const account = rows[0];
    if (!account) continue;
    await db.delete(apiKeys).where(eq(apiKeys.accountId, account.id));
    await db.delete(orgMemberships).where(eq(orgMemberships.accountId, account.id));
    await db.delete(accounts).where(eq(accounts.id, account.id));
  }

  // The identity rows, last: sessions and linked provider accounts cascade from `auth_user`, so
  // deleting it is enough for those two — but VERIFICATION rows do not cascade (they are keyed on
  // an address, not on a user), so a suite that signed in repeatedly would leave one row per code
  // behind forever. They are collected by identifier here.
  for (const email of prefixes.emails ?? []) {
    const address = email.trim().toLowerCase();
    await db.delete(authVerification).where(like(authVerification.identifier, `%${address}`));
    await db.delete(authUser).where(eq(authUser.email, address));
  }
}

/**
 * What the organization directory says about an organization, and when a submission may say it.
 *
 * THE DIRECTORY IS NOT WRITTEN BY STRANGERS. Every operating and sponsoring organization an entry
 * names gets a directory row, because claims, memberships and invites point at that row by foreign
 * key. Before this module, the FIRST submission to name a slug also wrote that row's website, logo,
 * description, social links and contacts — before any reviewer looked, never updated afterwards,
 * surviving the submission's rejection, and shown under the verified badge once the slug was
 * verified. Planting a real organization's slug with a fake website was one submission.
 *
 * So the directory is written in three steps, each by someone with more standing than the last:
 *
 *   1. A PENDING submission creates a STUB: the slug and the name it was cited under, nothing else
 *      (`organizationStubs`). That is what the foreign keys need, and it is all.
 *   2. An APPROVAL — a reviewer's, a verified publisher's own, or a write that auto-approves —
 *      FILLS the stub's EMPTY fields from the approved entry (`emptyFieldsFilled`). Never
 *      overwrites a field that has a value, and never touches a VERIFIED organization: once
 *      verified, its directory entry belongs to its owners and the reviewers.
 *   3. VERIFICATION shows the reviewer exactly what the directory holds (`organizationDirectoryView`)
 *      with a digest of it. A client that sends the digest back has the verification refused with a
 *      409 if the entry changed after it was shown, so the badge goes on the data somebody saw.
 */
import { createHash } from "node:crypto";
import type { OrganizationInsert, OrganizationRow } from "../../db/schema.js";
import type { OrganizationUpdate } from "../repositories/index.js";
import type { OrganizationDirectoryView } from "./api-views.js";
import { conflict } from "./http-error.js";

/**
 * How many organizations one non-approved write may ADD to the directory.
 *
 * The Standard allows 100 operating plus 100 sponsoring organizations per entry, and a write by
 * anyone with an account could therefore mint 200 directory rows, each squatting a slug. A real
 * programme names a handful; organizations that already exist do not count against this.
 */
export const MAX_NEW_ORGANIZATIONS_PER_SUBMISSION = 10;

/** Step 1: the least a foreign key needs. */
export function organizationStubs(inserts: OrganizationInsert[]): OrganizationInsert[] {
  return inserts.map(({ slug, name }) => ({ slug, name }));
}

const blank = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.trim() === "";
const none = (value: readonly unknown[] | null | undefined): boolean =>
  value === null || value === undefined || value.length === 0;

/**
 * Step 2: the fields of `row` an approved entry may fill — those that are empty on the row and not
 * empty in the entry. Empty for a verified organization, whatever the entry says.
 *
 * `name` is never in it: it is required, so a stub already has one, and renaming an organization is
 * the reviewer's and the owners' verb (`ReviewService.updateOrganization`).
 */
export function emptyFieldsFilled(
  row: OrganizationRow,
  from: OrganizationInsert,
): OrganizationUpdate {
  if (row.verified) return {};
  const set: OrganizationUpdate = {};
  if (row.orgType === null && from.orgType) set.orgType = from.orgType;
  if (blank(row.description) && !blank(from.description)) set.description = from.description;
  if (blank(row.website) && !blank(from.website)) set.website = from.website;
  if (blank(row.logoUrl) && !blank(from.logoUrl)) set.logoUrl = from.logoUrl;
  if (blank(row.bannerUrl) && !blank(from.bannerUrl)) set.bannerUrl = from.bannerUrl;
  if (none(row.socialLinks) && !none(from.socialLinks)) set.socialLinks = from.socialLinks;
  if (none(row.ecosystems) && !none(from.ecosystems)) set.ecosystems = from.ecosystems;
  if (none(row.contacts) && !none(from.contacts)) set.contacts = from.contacts;
  return set;
}

/** The directory fields, in a fixed order — what the digest is over. */
function directoryFields(row: OrganizationRow) {
  return {
    name: row.name,
    orgType: row.orgType,
    description: row.description,
    website: row.website,
    logoUrl: row.logoUrl,
    bannerUrl: row.bannerUrl,
    socialLinks: row.socialLinks,
    ecosystems: row.ecosystems,
    contacts: row.contacts,
  };
}

/** A digest of what the directory says, so "what I was shown" can be compared with "what is". */
export function organizationDirectoryDigest(row: OrganizationRow): string {
  return createHash("sha256")
    .update(JSON.stringify(directoryFields(row)))
    .digest("hex");
}

/**
 * Refuse a verification whose reviewer was shown a different directory entry than the one locked
 * now. No digest means an older client that showed nothing to compare, which is let through.
 */
export function assertDirectoryUnchanged(row: OrganizationRow, expected: string | undefined): void {
  if (expected === undefined) return;
  if (organizationDirectoryDigest(row) !== expected) {
    throw conflict(
      "organization_directory_changed",
      `\`${row.slug}\`'s directory entry changed after it was shown to you. Reload it, check it again, and verify what it says now.`,
    );
  }
}

/** Step 3: everything the directory holds, as a reviewer is shown it before verifying. */
export function organizationDirectoryView(row: OrganizationRow): OrganizationDirectoryView {
  return { ...directoryFields(row), digest: organizationDirectoryDigest(row) };
}

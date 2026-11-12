/**
 * The directory rows an entry's organizations need, written at the standing the write has.
 * The rule itself, and why, is `modules/shared/organization-directory.ts`.
 */
import type { OrganizationInsert, OrganizationRow } from "../../../db/schema.js";
import type { Repositories } from "../../repositories/index.js";
import { badRequest } from "../../shared/http-error.js";
import {
  MAX_NEW_ORGANIZATIONS_PER_SUBMISSION,
  emptyFieldsFilled,
  organizationStubs,
} from "../../shared/organization-directory.js";

/** Who approved, for the trail of what an approval wrote into the directory. */
export interface DirectoryFillActor {
  actorKind: "user" | "api_key";
  actorAccountId: number;
  actorApiKeyId?: number | null;
}

/**
 * A write that is NOT approved: slug-and-name stubs for organizations the directory does not know
 * yet, and nothing at all for the ones it does.
 *
 * Refused with a 400 when the write would add more than `MAX_NEW_ORGANIZATIONS_PER_SUBMISSION`
 * organizations. Checked before anything is inserted, and inside the write's transaction, so a
 * refused write leaves no stub behind.
 */
export async function stubCitedOrganizations(
  repos: Repositories,
  cited: OrganizationInsert[],
): Promise<void> {
  if (cited.length === 0) return;
  const known = await repos.organizations.existingSlugs(cited.map((org) => org.slug));
  const fresh = cited.filter((org) => !known.has(org.slug));
  if (fresh.length > MAX_NEW_ORGANIZATIONS_PER_SUBMISSION) {
    throw badRequest(
      "too_many_new_organizations",
      `this entry names ${fresh.length} organizations the directory does not know yet; an entry that is not published directly may add at most ${MAX_NEW_ORGANIZATIONS_PER_SUBMISSION}. Organizations already in the directory do not count.`,
    );
  }
  await repos.organizations.insertStubs(organizationStubs(fresh));
}

/**
 * An APPROVED entry: create what is missing with the entry's data, and fill the EMPTY fields of
 * unverified organizations that already exist. Never overwrites a value, never touches a verified
 * organization (`emptyFieldsFilled`).
 *
 * Rows are locked in slug order, so two approvals naming the same organizations cannot deadlock.
 * Each fill is audited on the organization, with the entry it came from, because a directory field
 * that nobody remembers setting is exactly the thing a reviewer later has to explain.
 */
export async function fillCitedOrganizations(
  repos: Repositories,
  cited: OrganizationInsert[],
  actor: DirectoryFillActor,
  entryPublicId: string,
  now: Date,
): Promise<void> {
  if (cited.length === 0) return;
  await repos.organizations.insertStubs(cited);
  const ordered = [...cited].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const from of ordered) {
    const row = await repos.organizations.lockBySlug(from.slug);
    if (!row) continue;
    const set = emptyFieldsFilled(row, from);
    const fields = Object.keys(set) as (keyof typeof set)[];
    if (fields.length === 0) continue;
    await repos.organizations.update(row.id, { ...set, updatedAt: now });
    await repos.audit.record({
      ...actor,
      subjectKind: "organization",
      subjectId: row.id,
      action: "update_organization",
      patch: {
        ...Object.fromEntries(
          fields.map((field) => [
            field,
            { before: row[field as keyof OrganizationRow] ?? null, after: set[field] ?? null },
          ]),
        ),
        reason: `filled_from_approved_entry:${entryPublicId}`,
      },
    });
  }
}

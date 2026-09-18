/** publisher_verified: one event per real transition, and one for each member joining later. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db, pool } from "../../src/db/client.js";
import { notifications } from "../../src/db/schema.js";
import { repositories } from "../../src/modules/repositories/index.js";
import { AccountService } from "../../src/modules/services/auth/account.service.js";
import { ReviewService } from "../../src/modules/services/review/review.service.js";
import { grantMembership, seedIdentity, seedOrganization } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAILS = {
  reviewer: "m5verified-reviewer@rfphub.invalid",
  joiner: "m5verified-joiner@rfphub.invalid",
  invited: "m5verified-invited@rfphub.invalid",
};
const HANDLES = ["m5verified-reviewer", "m5verified-joiner"];
const ORGS = { reverify: "m5verified-reverify", join: "m5verified-join" };

async function publisherVerifiedRows(accountId: number, organizationId: number) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.accountId, accountId),
        eq(notifications.kind, "publisher_verified"),
        eq(notifications.subjectId, organizationId),
      ),
    );
}

describeWithDb("publisher_verified events", () => {
  let reviewerId: number;
  let joinerId: number;
  const userIds: string[] = [];

  beforeAll(async () => {
    const reviewer = await seedIdentity(EMAILS.reviewer, { handle: HANDLES[0], role: "reviewer" });
    const joiner = await seedIdentity(EMAILS.joiner, { handle: HANDLES[1] });
    reviewerId = reviewer.account.id;
    joinerId = joiner.account.id;
    userIds.push(reviewer.userId, joiner.userId);
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      organizationSlugs: Object.values(ORGS),
      userIds,
      handles: HANDLES,
      emails: Object.values(EMAILS),
    });
    await pool.end();
  });

  it("records a new publisher_verified event for each real re-verification", async () => {
    const organization = await seedOrganization({ slug: ORGS.reverify, verified: false });
    await grantMembership(joinerId, organization.id, "publisher");
    const queueIds: number[] = [];
    const review = new ReviewService(db, {
      notificationQueue: { enqueue: (ids) => queueIds.push(...ids) },
    });
    await review.setVerified(reviewerId, ORGS.reverify, true);
    await review.setVerified(reviewerId, ORGS.reverify, true);
    await review.setVerified(reviewerId, ORGS.reverify, false);
    await review.setVerified(reviewerId, ORGS.reverify, true);

    const rows = await publisherVerifiedRows(joinerId, organization.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.subjectKind)).size).toBe(2);
    expect(queueIds.sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it("tells a member who joins an already-verified organization, by grant or by invite", async () => {
    const organization = await seedOrganization({ slug: ORGS.join, verified: true });
    const queueIds: number[] = [];
    const queue = { enqueue: (ids: readonly number[]) => queueIds.push(...ids) };
    const review = new ReviewService(db, { notificationQueue: queue });

    await review.grantMembership(reviewerId, ORGS.join, joinerId, "publisher");
    await review.grantMembership(reviewerId, ORGS.join, joinerId, "admin");
    const granted = await publisherVerifiedRows(joinerId, organization.id);
    expect(granted).toHaveLength(1);
    expect(queueIds).toEqual([granted[0]?.id]);

    const invited = await seedIdentity(EMAILS.invited);
    userIds.push(invited.userId);
    await repositories(db).membershipInvites.create({
      organizationId: organization.id,
      email: EMAILS.invited,
      role: "publisher",
      invitedBy: reviewerId,
    });
    await new AccountService(db, undefined, queue).resolveBySubject(invited.userId, EMAILS.invited);
    const redeemed = await publisherVerifiedRows(invited.account.id, organization.id);
    expect(redeemed).toHaveLength(1);
    expect(queueIds).toContain(redeemed[0]?.id);
  });
});

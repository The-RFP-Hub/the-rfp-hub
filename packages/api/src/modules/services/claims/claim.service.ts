/**
 * Claims establish publisher ownership once, for public programs without an owner.
 * Existing members of a verified operating organization get an immediate grant; others queue.
 * API keys need write to file and publish to grant. Reviewer approval may add publisher membership
 * and explicitly verify the organization. Every mutation locks the opportunity first; grants also
 * lock organization and membership, preventing concurrent grants and revoked authority.
 */
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityRow, OrganizationRow } from "../../../db/schema.js";
import { type Repositories, repositories, withTransaction } from "../../repositories/index.js";
import type { ClaimResultView, ClaimSummaryView } from "../../shared/api-views.js";
import { effectiveCaps } from "../../shared/capabilities.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/http-error.js";
import type { RequestPrincipal } from "../auth/principal.service.js";
import { buildPublisherVerifiedNotifications } from "../notifications/email-notification-events.js";
import {
  type NotificationDispatchEnqueuer,
  notificationDispatchQueue,
} from "../notifications/notification-dispatch.queue.js";
import { assertClaimOpen } from "./claim-eligibility.service.js";

const NOTE_MAX = 1_000;
export const MAX_PENDING_CLAIMS_PER_ACCOUNT = 10;

export interface ClaimInput {
  organizationSlug: string;
  note?: string | null;
}

export class ClaimService {
  private readonly repos: Repositories;
  private readonly notificationQueue: NotificationDispatchEnqueuer;

  constructor(
    private readonly db: DB = defaultDb,
    options: { notificationQueue?: NotificationDispatchEnqueuer } = {},
  ) {
    this.repos = repositories(db);
    this.notificationQueue = options.notificationQueue ?? notificationDispatchQueue;
  }

  async claim(
    principal: RequestPrincipal,
    publicId: string,
    input: ClaimInput,
  ): Promise<ClaimResultView> {
    const slug = (input.organizationSlug ?? "").trim().toLowerCase();
    if (slug === "") {
      throw badRequest("organization_required", "`organizationSlug` is required.");
    }
    const note = normalizeNote(input.note);

    const entry = await this.findOpportunity(publicId);
    const organization = await this.findOrganization(slug);

    const caps = effectiveCaps(principal, slug);

    // Scope refusal comes before membership checks.
    if (!caps.canClaimFile) {
      throw forbidden("missing_scope", "filing a claim requires the `write` scope on an API key.");
    }

    const member = principal.memberships.some((m) => m.slug === slug);
    await assertClaimOpen(this.repos, entry);

    const operates = operatingSlugs(entry).includes(slug);
    const grantable = member && operates && organization.verified;

    if (grantable && !caps.canClaimGrant) {
      // A grantable claim must not silently downgrade to a review request.
      throw forbidden(
        "missing_scope",
        "granting publisher ownership requires the `publish` scope on an API key.",
      );
    }

    if (grantable) return this.grant(principal, entry, organization, note);
    return this.queue(principal, entry, organization, note, member);
  }

  /** Re-prove grant authority while holding the rows that revocation would change. */
  private async grant(
    principal: RequestPrincipal,
    entry: OpportunityRow,
    organization: OrganizationRow,
    note: string | null,
  ): Promise<ClaimResultView> {
    return withTransaction(this.db, async (repos) => {
      const row = await repos.opportunities.lockById(entry.id);
      if (!row || row.reviewStatus !== "approved" || !row.isListed)
        throw notFound(`no opportunity ${JSON.stringify(entry.publicId)}.`);

      // Lock verification and membership after the opportunity, always in this order.
      const currentOrg = await repos.organizations.lockByIdForClaim(organization.id);
      const membership = await repos.memberships.lockForAccountAndOrganization(
        principal.accountId,
        organization.id,
      );

      if (!currentOrg?.verified || membership === undefined) {
        throw forbidden(
          "claim_not_grantable",
          "the organization is no longer verified, or your membership on it has been revoked.",
        );
      }
      if (!operatingSlugs(row).includes(currentOrg.slug)) {
        throw forbidden(
          "claim_not_grantable",
          `\`${currentOrg.slug}\` is not an operating organization of this entry. Sponsorship is not operation.`,
        );
      }
      await assertClaimOpen(repos, row);

      const now = new Date();
      const wasPending = row.reviewStatus !== "approved";
      await repos.opportunities.updateClaimPublisher(row.id, {
        sourcePublisher: currentOrg.slug,
        sourceSubmittedBy: currentOrg.slug,
        // A granted claim is a publisher asserting the entry, which is exactly what the staleness
        // clock measures.
        lastSeenAt: now,
        reviewStatus: "approved",
        approvedBy: principal.accountId,
        approvedAt: row.approvedAt ?? now,
        updatedAt: now,
      });

      // Settle only the actor's request: a grant does not validate another claimant's membership.
      const settled = await repos.claims.settlePendingForGrant(
        row.id,
        currentOrg.id,
        principal.accountId,
        now,
      );

      const actor = {
        actorKind:
          principal.credentialKind === "api_key" ? ("api_key" as const) : ("user" as const),
        actorAccountId: principal.accountId,
        actorApiKeyId: principal.apiKeyId ?? null,
      };
      await repos.audit.record({
        ...actor,
        subjectKind: "opportunity",
        subjectId: row.id,
        action: "claim",
        patch: {
          sourcePublisher: { before: row.sourcePublisher, after: currentOrg.slug },
          note,
        },
      });
      await repos.audit.record({
        ...actor,
        subjectKind: "opportunity",
        subjectId: row.id,
        action: "grant_publisher",
        patch: { organizationSlug: currentOrg.slug },
      });
      if (wasPending) {
        await repos.audit.record({
          ...actor,
          subjectKind: "opportunity",
          subjectId: row.id,
          action: "approve",
          patch: {
            reviewStatus: { before: row.reviewStatus, after: "approved" },
            reason: "granted_claim_by_verified_operator",
          },
        });
      }

      return {
        outcome: "granted" as const,
        claimId: settled[0] ?? null,
        opportunityId: row.publicId,
        organizationSlug: currentOrg.slug,
        message: `\`${currentOrg.slug}\` now publishes this entry, and future writes into that namespace auto-approve.`,
      };
    });
  }

  /** File the claim for review. One PENDING row per (entry, organisation), enforced by the index. */
  private async queue(
    principal: RequestPrincipal,
    entry: OpportunityRow,
    organization: OrganizationRow,
    note: string | null,
    member: boolean,
  ): Promise<ClaimResultView> {
    const reason = !member
      ? `you are not a member of \`${organization.slug}\`, so a reviewer will decide.`
      : organization.verified
        ? `\`${organization.slug}\` is not listed among this entry's operating organizations, so a reviewer will decide.`
        : `\`${organization.slug}\` is not a verified publisher yet, so a reviewer will decide.`;

    return withTransaction(this.db, async (repos) => {
      // Serialize filing with grants and decisions: a stale page cannot queue a claim after a grant.
      const row = await repos.opportunities.lockById(entry.id);
      if (!row || row.reviewStatus !== "approved" || !row.isListed)
        throw notFound(`no opportunity ${JSON.stringify(entry.publicId)}.`);
      await assertClaimOpen(repos, row);
      const already = await repos.claims.findPending(entry.id, organization.id);
      if (already)
        return {
          outcome: "queued" as const,
          claimId: already.id,
          opportunityId: entry.publicId,
          organizationSlug: organization.slug,
          message: `a claim from \`${organization.slug}\` is already awaiting review. ${reason}`,
        };
      // Different opportunities must share a lock before checking this account's pending cap.
      if (!(await repos.accounts.lockById(principal.accountId)))
        throw notFound("Your account no longer exists.");
      const pending = await repos.claims.countPendingForAccount(principal.accountId);
      if (pending >= MAX_PENDING_CLAIMS_PER_ACCOUNT) {
        throw conflict(
          "too_many_pending_claims",
          `you already have ${pending} claims awaiting review; wait for a decision before filing more.`,
        );
      }
      const claim = await repos.claims.insert({
        opportunityId: entry.id,
        organizationId: organization.id,
        accountId: principal.accountId,
        note,
      });
      if (!claim) throw new Error("failed to file a claim");
      await repos.audit.record({
        subjectKind: "claim",
        subjectId: claim.id,
        actorKind: principal.credentialKind === "api_key" ? "api_key" : "user",
        actorAccountId: principal.accountId,
        actorApiKeyId: principal.apiKeyId ?? null,
        action: "claim",
        patch: { opportunity: entry.publicId, organizationSlug: organization.slug, note },
      });
      return {
        outcome: "queued" as const,
        claimId: claim.id,
        opportunityId: entry.publicId,
        organizationSlug: organization.slug,
        message: reason,
      };
    });
  }

  private async findOpportunity(publicId: string): Promise<OpportunityRow> {
    const row = await this.repos.opportunities.findByPublicId(publicId);
    // A claim may be filed against a PUBLIC entry only. A pending entry is not discoverable, so
    // answering about one here would be an existence oracle over the review queue.
    if (!row || row.reviewStatus !== "approved" || !row.isListed) {
      throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    }
    return row;
  }

  private async findOrganization(slug: string): Promise<OrganizationRow> {
    const row = await this.repos.organizations.findBySlug(slug);
    if (!row) throw notFound(`no organization \`${slug}\`.`);
    return row;
  }

  // ── review side ────────────────────────────────────────────────────────────────
  async listForReview(status: "pending" | "approved" | "rejected" | "withdrawn" = "pending") {
    const rows = await this.repos.claims.listForReview(status);

    return rows.map(
      ({ claim, opportunity, organization, handle, claimantIsMember }): ClaimSummaryView => ({
        id: claim.id,
        opportunityId: opportunity.publicId,
        opportunityTitle: opportunity.title,
        organizationSlug: organization.slug,
        organizationVerified: organization.verified,
        claimedBy: handle ?? "community",
        claimedByAccountId: claim.accountId,
        claimantIsMember: Boolean(claimantIsMember),
        status: claim.status,
        note: claim.note,
        createdAt: claim.createdAt.toISOString(),
        decidedAt: claim.decidedAt?.toISOString() ?? null,
      }),
    );
  }

  /**
   * A reviewer's decision, with the verification choice made EXPLICIT.
   *
   * `verifyOrganization: false` on an unverified organisation still transfers ownership — and the
   * returned message states that the publisher's future writes will keep landing `pending`, because
   * auto-approval needs a verified organisation and nothing here changed that.
   */
  async decide(
    reviewerId: number,
    claimId: number,
    decision: { approve: boolean; verifyOrganization?: boolean },
  ): Promise<ClaimResultView> {
    const settled = await withTransaction(this.db, async (repos) => {
      // The immutable opportunity id lets us lock entry before claim, matching grant().
      const opportunityId = await repos.claims.findOpportunityId(claimId);
      if (opportunityId === undefined) throw notFound(`no claim ${claimId}.`);

      const entry = await repos.opportunities.lockById(opportunityId);
      if (!entry) throw notFound(`no opportunity for claim ${claimId}.`);

      const found = await repos.claims.lockWithOrganization(claimId);
      if (!found) throw notFound(`no claim ${claimId}.`);
      if (found.claim.status !== "pending") {
        throw conflict("claim_decided", `claim ${claimId} has already been ${found.claim.status}.`);
      }

      if (decision.approve) await assertClaimOpen(repos, entry);

      const now = new Date();
      await repos.claims.decide(
        claimId,
        decision.approve ? "approved" : "rejected",
        reviewerId,
        now,
      );

      const reviewerActor = { actorKind: "user" as const, actorAccountId: reviewerId };

      if (!decision.approve) {
        await repos.audit.record({
          ...reviewerActor,
          subjectKind: "claim",
          subjectId: claimId,
          action: "reject",
          patch: { status: { before: "pending", after: "rejected" } },
        });
        return {
          outcome: "unchanged" as const,
          claimId,
          opportunityId: entry.publicId,
          organizationSlug: found.organization.slug,
          message: "the claim was rejected; publisher ownership is unchanged.",
          publisherVerifiedNotificationIds: [],
        };
      }

      let verified = found.organization.verified;
      let publisherVerifiedNotificationIds: number[] = [];
      if (decision.verifyOrganization === true && !verified) {
        await repos.organizations.verifyForClaim(found.organization.id, now);
        verified = true;
        publisherVerifiedNotificationIds = await repos.notifications.record(
          buildPublisherVerifiedNotifications(
            await repos.memberships.accountIdsForOrganization(found.organization.id),
            found.organization,
            now,
          ),
        );
        await repos.audit.record({
          ...reviewerActor,
          subjectKind: "organization",
          subjectId: found.organization.id,
          action: "verify_organization",
          patch: { verified: { before: false, after: true }, reason: `claim:${claimId}` },
        });
      }

      let membershipGranted = false;
      if (found.claim.accountId !== null) {
        const existing = await repos.memberships.lockForAccountAndOrganization(
          found.claim.accountId,
          found.organization.id,
        );
        if (existing === undefined) {
          await repos.memberships.insertRole(
            found.claim.accountId,
            found.organization.id,
            "publisher",
          );
          membershipGranted = true;
          await repos.audit.record({
            ...reviewerActor,
            subjectKind: "organization",
            subjectId: found.organization.id,
            action: "grant_publisher",
            patch: {
              accountId: found.claim.accountId,
              role: "publisher",
              reason: `claim:${claimId}`,
            },
          });
        }
      }

      const wasPending = entry.reviewStatus !== "approved";
      await repos.opportunities.updateClaimPublisher(entry.id, {
        sourcePublisher: found.organization.slug,
        sourceSubmittedBy: found.organization.slug,
        lastSeenAt: now,
        // Approving the CLAIM publishes the entry only when the new publisher is verified;
        // otherwise the entry keeps whatever review status it had.
        reviewStatus: verified ? "approved" : entry.reviewStatus,
        approvedBy: verified ? (entry.approvedBy ?? reviewerId) : entry.approvedBy,
        approvedAt: verified ? (entry.approvedAt ?? now) : entry.approvedAt,
        updatedAt: now,
      });

      await repos.audit.record({
        ...reviewerActor,
        subjectKind: "claim",
        subjectId: claimId,
        action: "approve",
        patch: { status: { before: "pending", after: "approved" }, verifyOrganization: verified },
      });
      await repos.audit.record({
        ...reviewerActor,
        subjectKind: "opportunity",
        subjectId: entry.id,
        action: "grant_publisher",
        patch: {
          sourcePublisher: { before: entry.sourcePublisher, after: found.organization.slug },
        },
      });
      if (verified && wasPending) {
        await repos.audit.record({
          ...reviewerActor,
          subjectKind: "opportunity",
          subjectId: entry.id,
          action: "approve",
          patch: {
            reviewStatus: { before: entry.reviewStatus, after: "approved" },
            reason: `claim:${claimId}`,
          },
        });
      }

      return {
        outcome: "granted" as const,
        claimId,
        opportunityId: entry.publicId,
        organizationSlug: found.organization.slug,
        message: `${
          verified
            ? `\`${found.organization.slug}\` now publishes this entry, and future writes into that namespace auto-approve.`
            : `\`${found.organization.slug}\` now publishes this entry, but the organization is NOT verified — future writes into that namespace will keep landing pending until it is.`
        }${membershipGranted ? " The claimant was added as a member." : ""}`,
        publisherVerifiedNotificationIds,
      };
    });
    this.notificationQueue.enqueue(settled.publisherVerifiedNotificationIds);
    const { publisherVerifiedNotificationIds: _ignored, ...result } = settled;
    return result;
  }
}

/** Operating organisations only. Sponsorship is not operation — that is the whole point (D-11). */
export function operatingSlugs(row: OpportunityRow): string[] {
  return row.operatingOrganizations.map((org) => org.slug);
}

function normalizeNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const note = raw.trim();
  if (note === "") return null;
  if (note.length > NOTE_MAX) {
    throw badRequest("invalid_note", `\`note\` must be at most ${NOTE_MAX} characters.`);
  }
  return note;
}

/**
 * Claiming publisher ownership of an entry somebody else submitted.
 *
 * FOUR RULES, EACH CLOSING A HOLE:
 *
 * 1. **The match must be an OPERATING organisation, not any organisation on the entry.**
 *    `org_slugs` is the union that includes SPONSORS, and a sponsor is not an operator — matching on
 *    it would let a sponsoring organisation seize publisher ownership of somebody else's programme.
 *
 * 2. **Membership, verification and the operating match are re-checked INSIDE the granting
 *    transaction, against a `SELECT … FOR UPDATE` on the entry.** A decision computed before the
 *    transaction can be won by a revocation racing it: the check passes, the membership is revoked,
 *    the grant lands anyway. Locking the rows is what serialises the two — every row the answer is
 *    derived from, the organisation's `verified` flag included, and always in the same order:
 *    ENTRY, then organisation, then membership. Both paths here and the write path take the entry
 *    first, so a member retrying a claim and a reviewer deciding it cannot close a deadlock cycle.
 *
 * 3. **BOTH outcomes have a credential bar, and neither of them is `read`.** Filing a claim at all
 *    requires `write` on an API-key credential, and a grant is additionally held to the publication
 *    bar — `publish`. The queue path used to have NO scope check, on the reasoning that a queued
 *    claim only asks a human for something; that was wrong. A queued claim is a write on somebody
 *    else's entry with a reviewer decision in flight behind it, and a `read`-only key — the scope
 *    an integration is given precisely so it cannot change anything — could file one. Each bar
 *    fails LOUD with a 403 naming the scope it wanted: for the grant path a silent downgrade to a
 *    queue would tell the caller their key is stronger than it is, and for the queue path there is
 *    no weaker outcome to fall back to.
 *
 * 4. **Approval carries the verification decision explicitly.** A reviewer approving a claim on an
 *    UNVERIFIED organisation transfers ownership but does NOT unlock auto-approval, because that
 *    requires a verified organisation. The response says so; so do the docs. Implying otherwise is
 *    how a publisher discovers the difference by having their next write sit in the queue.
 *
 * 5. **Queueing is IDEMPOTENT, including under a race.** The partial unique index is the only
 *    arbiter of "one pending claim per organisation", and a read that precedes the insert cannot
 *    be. Two colleagues filing the same claim at once therefore both pass the read and one insert
 *    raises 23505 — which is caught and answered with the winning claim, not with a 500. The
 *    claim is the organisation's, so the loser of that race got what they asked for.
 */
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityRow, OrganizationRow } from "../../../db/schema.js";
import { type Repositories, repositories, withTransaction } from "../../repositories/index.js";
import type { ClaimResultView, ClaimSummaryView } from "../../shared/api-views.js";
import { effectiveCaps } from "../../shared/capabilities.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/http-error.js";
import { isUniqueViolation } from "../auth/account.service.js";
import type { RequestPrincipal } from "../auth/principal.service.js";

const NOTE_MAX = 1_000;

export interface ClaimInput {
  organizationSlug: string;
  note?: string | null;
}

export class ClaimService {
  private readonly repos: Repositories;

  constructor(private readonly db: DB = defaultDb) {
    this.repos = repositories(db);
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

    // The credential half of the answer. The membership and verification halves are deliberately
    // NOT decided here — they are decided under the row lock below, where they cannot go stale.
    const caps = effectiveCaps(principal, slug);

    // The floor: `read` is not enough to file a claim of any kind. Checked before the membership
    // arm rather than beside the grant bar below, so an under-scoped key cannot use the ordering of
    // the two refusals to learn which organisations the account it delegates belongs to.
    if (!caps.canClaimFile) {
      throw forbidden("missing_scope", "filing a claim requires the `write` scope on an API key.");
    }

    // A membership is required to file a claim at all: a claim is the ORGANISATION's, and an
    // account with no relationship to it is not entitled to speak for it.
    if (!principal.memberships.some((m) => m.slug === slug)) {
      throw forbidden(
        "not_a_member",
        `you hold no membership on \`${slug}\`, so you cannot claim on its behalf.`,
      );
    }

    if (entry.sourcePublisher === slug) {
      return {
        outcome: "unchanged",
        claimId: null,
        opportunityId: entry.publicId,
        organizationSlug: slug,
        message: `\`${slug}\` already publishes this entry.`,
      };
    }

    const operates = operatingSlugs(entry).includes(slug);
    const grantable = operates && organization.verified;

    if (grantable && !caps.canClaimGrant) {
      // Fail LOUD, not closed-and-quiet: this claim would have been granted, and queueing it
      // silently would tell the caller their key is weaker than it is.
      throw forbidden(
        "missing_scope",
        "granting publisher ownership requires the `publish` scope on an API key.",
      );
    }

    if (grantable) return this.grant(principal, entry, organization, note);
    return this.queue(principal, entry, organization, note);
  }

  /**
   * Transfer ownership now — re-proving every precondition under a row lock.
   *
   * The lock is on the OPPORTUNITY row because that is what is being reassigned; the membership and
   * organisation reads inside the transaction then see a consistent snapshot with it.
   */
  private async grant(
    principal: RequestPrincipal,
    entry: OpportunityRow,
    organization: OrganizationRow,
    note: string | null,
  ): Promise<ClaimResultView> {
    return withTransaction(this.db, async (repos) => {
      const row = await repos.opportunities.lockById(entry.id);
      if (!row) throw notFound(`no opportunity ${JSON.stringify(entry.publicId)}.`);

      // FOR SHARE on the ORGANISATION row as well, for the same reason as the membership below:
      // `verified` is half of what makes this claim grantable, and a plain read of it is beaten by
      // a reviewer un-verifying the organisation between here and the commit. Shared rather than
      // exclusive because two grants on the same organisation are not in conflict with each other,
      // only with whoever is withdrawing its verification.
      //
      // The CURRENT PUBLISHER's organisation, read further down, is deliberately NOT locked: the
      // dangerous direction there is unverified → verified, and a lock cannot help with that — a
      // verification committing after this transaction's snapshot is invisible whether the row is
      // locked or not, and locking a second row of the same table would introduce an ordering
      // hazard between two grants that name each other's organisations.
      const currentOrg = await repos.organizations.lockByIdForClaim(organization.id);
      // FOR UPDATE on the MEMBERSHIP row, not merely a read of it.
      //
      // The opportunity's lock serialises this grant against another grant, and against the
      // staleness job — but it shares nothing with the revoke path, which only ever touches
      // `org_memberships`. So a revocation starting after this SELECT could commit before the
      // update below and the grant would still land on a membership that no longer exists. Locking
      // the row is what makes the two paths conflict: a concurrent DELETE waits here, and whichever
      // commits first is the one the other observes.
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
      if (row.sourcePublisher !== null && row.sourcePublisher !== currentOrg.slug) {
        const ownerVerified = await repos.organizations.verifiedBySlug(row.sourcePublisher);
        if (ownerVerified) {
          throw conflict(
            "already_claimed",
            `this entry is already published by the verified organization \`${row.sourcePublisher}\`.`,
          );
        }
      }

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

      // A pending claim from this organisation is settled by the grant rather than left orphaned.
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
  ): Promise<ClaimResultView> {
    const reason = organization.verified
      ? `\`${organization.slug}\` is not listed among this entry's operating organizations, so a reviewer will decide.`
      : `\`${organization.slug}\` is not a verified publisher yet, so a reviewer will decide.`;

    const already = await this.findPendingClaim(entry.id, organization.id);
    if (already) {
      // A colleague at the same organisation already filed it. The claim is the organisation's, so
      // this is the same claim, not a second one.
      return {
        outcome: "queued",
        claimId: already.id,
        opportunityId: entry.publicId,
        organizationSlug: organization.slug,
        message: `a claim from \`${organization.slug}\` is already awaiting review. ${reason}`,
      };
    }

    return withTransaction(this.db, async (repos) => {
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
        patch: {
          opportunity: entry.publicId,
          organizationSlug: organization.slug,
          note,
        },
      });
      return {
        outcome: "queued" as const,
        claimId: claim.id,
        opportunityId: entry.publicId,
        organizationSlug: organization.slug,
        message: reason,
      };
    }).catch(async (error: unknown) => {
      // TWO COLLEAGUES, ONE CLAIM. The read above and this insert are not one atomic step, so
      // both members of an organisation can see no pending row and both reach here; the partial
      // unique index lets one in and raises 23505 at the other. The claim is the ORGANISATION's,
      // so the loser of that race has not failed — the thing they asked for exists. Loading the
      // winner turns a 500 into the same idempotent 202 a serialised pair of requests would have
      // produced.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findPendingClaim(entry.id, organization.id);
      if (!winner) throw error;
      return {
        outcome: "queued" as const,
        claimId: winner.id,
        opportunityId: entry.publicId,
        organizationSlug: organization.slug,
        message: `a claim from \`${organization.slug}\` is already awaiting review. ${reason}`,
      };
    });
  }

  /** The organisation's outstanding claim on one entry, if it has one. */
  private async findPendingClaim(opportunityId: number, organizationId: number) {
    return this.repos.claims.findPending(opportunityId, organizationId);
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
      ({ claim, opportunity, organization, handle }): ClaimSummaryView => ({
        id: claim.id,
        opportunityId: opportunity.publicId,
        opportunityTitle: opportunity.title,
        organizationSlug: organization.slug,
        organizationVerified: organization.verified,
        claimedBy: handle ?? "community",
        claimedByAccountId: claim.accountId,
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
    return withTransaction(this.db, async (repos) => {
      // THE ENTRY IS LOCKED FIRST, before the claim and the organisation.
      //
      // `grant()` takes the opportunity, then the organisation, then the membership, and settles
      // the claim row last. A decision that took the claim first and then waited for the same
      // opportunity would close a cycle — member retries the claim while a reviewer decides it —
      // and PostgreSQL would answer one of them with a deadlock rather than a decision. Every path
      // that touches an entry and its claim therefore acquires the ENTRY first: this one, `grant()`
      // and the write path (see `services/auth/publish-authority.ts` for the whole order).
      // Learning which entry that is costs one unlocked read, which is safe because a claim's
      // `opportunity_id` is immutable: whatever else changes about the claim before the lock below,
      // it is still a claim about this entry.
      const opportunityId = await repos.claims.findOpportunityId(claimId);
      if (opportunityId === undefined) throw notFound(`no claim ${claimId}.`);

      const entry = await repos.opportunities.lockById(opportunityId);
      if (!entry) throw notFound(`no opportunity for claim ${claimId}.`);
      if (decision.approve && entry.mergedIntoId !== null) {
        throw conflict(
          "opportunity_merged",
          `opportunity ${JSON.stringify(entry.publicId)} has been merged and its claims cannot be approved.`,
        );
      }

      const found = await repos.claims.lockWithOrganization(claimId);
      if (!found) throw notFound(`no claim ${claimId}.`);
      if (found.claim.status !== "pending") {
        throw conflict("claim_decided", `claim ${claimId} has already been ${found.claim.status}.`);
      }

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
        };
      }

      let verified = found.organization.verified;
      if (decision.verifyOrganization === true && !verified) {
        await repos.organizations.verifyForClaim(found.organization.id, now);
        verified = true;
        await repos.audit.record({
          ...reviewerActor,
          subjectKind: "organization",
          subjectId: found.organization.id,
          action: "verify_organization",
          patch: { verified: { before: false, after: true }, reason: `claim:${claimId}` },
        });
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
        message: verified
          ? `\`${found.organization.slug}\` now publishes this entry, and future writes into that namespace auto-approve.`
          : `\`${found.organization.slug}\` now publishes this entry, but the organization is NOT verified — future writes into that namespace will keep landing pending until it is.`,
      };
    });
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

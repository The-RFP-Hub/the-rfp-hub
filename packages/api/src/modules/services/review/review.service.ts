/**
 * The T3 surface: approving and rejecting entries, verifying organisations, and granting the
 * memberships that make a namespace auto-approve.
 *
 * Two things here are load-bearing beyond the obvious:
 *
 * **Organisation metadata is edited HERE and on the org-owner route — never on the write path.**
 * The read path's `upsertOrganization` rewrites name, website, logo, banner, social links,
 * ecosystems and contacts on conflict; letting a submission reach it would let any T1 overwrite a
 * verified organisation's branding by naming its slug. So a submission creates directory stubs and
 * nothing else, and every metadata change arrives through an authorised, audited route.
 *
 * **Verifying an organisation is the single act that flips every one of its members to T2**, in
 * every namespace-scoped decision, immediately. Unverifying takes it back the same way. Both are
 * audited on the ORGANISATION, which is the subject whose state changed — the members' accounts did
 * not.
 */
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityRow, OrganizationRow } from "../../../db/schema.js";
import {
  type OrganizationUpdate,
  type Repositories,
  repositories,
  withTransaction,
} from "../../repositories/index.js";
import type {
  ClosingSoonItemView,
  ClosingSoonListView,
  MembershipResultView,
  OpenConfirmationView,
  OrganizationSummaryView,
  ReviewDecisionView,
} from "../../shared/api-views.js";
import { isPastDue, latestFixedDeadlineAt } from "../../shared/deadlines.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/http-error.js";
import { reviewerPins } from "../../shared/link-out.js";
import { closingDriver, inactivityClosesAt } from "../../shared/staleness.js";
import { OPERATING_ORG_CAPACITY } from "../audit/audit.service.js";
import { isUniqueViolation } from "../auth/account.service.js";
import { resolvePublishAuthority } from "../auth/publish-authority.js";
import { buildPublisherVerifiedNotifications } from "../notifications/email-notification-events.js";
import {
  type NotificationDispatchEnqueuer,
  notificationDispatchQueue,
} from "../notifications/notification-dispatch.queue.js";
import { earliestInactivityClosings } from "./closing-soon.js";

export type OrgRole = "owner" | "admin" | "publisher";

const ORG_ROLES: OrgRole[] = ["owner", "admin", "publisher"];

/** The audit `reason` of a "confirm still open" that carried no note of its own. */
export const CONFIRM_OPEN_DEFAULT_REASON = "reviewer confirmed the listing is still open";

/**
 * How the "closing soon" walk reads. `scanCap` is a safety bound on rows examined, far above any
 * realistic backlog (the job closes whatever is already due every night); reaching it is reported
 * as `complete: false`, never hidden. Injectable so a test can reach it with a handful of rows.
 */
export interface ClosingSoonScan {
  pageSize: number;
  scanCap: number;
  /**
   * TEST SEAM: awaited after each page is read, inside the walk's snapshot. Lets a test commit a
   * concurrent refresh between two pages and prove the walk does not see it.
   */
  afterPage?: (rows: OpportunityRow[]) => Promise<void>;
}
const CLOSING_SOON_SCAN: ClosingSoonScan = { pageSize: 500, scanCap: 50_000 };

/** The directory fields an authorised editor may change. Deliberately not the verified flag. */
export interface OrganizationMetadata {
  name?: string;
  description?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  ecosystems?: string[];
}

export class ReviewService {
  private readonly repos: Repositories;
  private readonly notificationQueue: NotificationDispatchEnqueuer;

  private readonly config: AppConfig;
  private readonly closingSoonScan: ClosingSoonScan;

  constructor(
    private readonly db: DB = defaultDb,
    options: {
      notificationQueue?: NotificationDispatchEnqueuer;
      config?: AppConfig;
      closingSoonScan?: ClosingSoonScan;
    } = {},
  ) {
    this.repos = repositories(db);
    this.notificationQueue = options.notificationQueue ?? notificationDispatchQueue;
    this.config = options.config ?? defaultConfig;
    this.closingSoonScan = options.closingSoonScan ?? CLOSING_SOON_SCAN;
  }

  // ── opportunities ──────────────────────────────────────────────────────────────
  /**
   * Approve or reject one entry.
   *
   * Rejection also UNLISTS: a rejected-but-listed row would be excluded from the public reads by
   * the review status alone, but leaving `is_listed` true records a listing intent that is no
   * longer true, and the two flags disagreeing is how a later query gets it wrong.
   */
  async decide(
    reviewerId: number,
    publicId: string,
    approve: boolean,
    reason?: string | null,
  ): Promise<ReviewDecisionView> {
    return withTransaction(this.db, async (repos) => {
      const row = await lockOpportunity(repos, publicId);
      assertNotMerged(row);
      const now = new Date();
      const target = approve ? "approved" : "rejected";
      if (row.reviewStatus === target) {
        return { id: row.publicId, reviewStatus: row.reviewStatus, isListed: row.isListed };
      }
      const next =
        (await repos.opportunities.update(row.id, {
          reviewStatus: target,
          isListed: approve ? row.isListed : false,
          approvedBy: approve ? reviewerId : row.approvedBy,
          approvedAt: approve ? (row.approvedAt ?? now) : row.approvedAt,
          lastSeenAt: approve ? now : row.lastSeenAt,
          updatedAt: now,
          // AN APPROVAL VOUCHES FOR THE LINKS IT WAS LOOKING AT. Pinned to what the locked row stores
          // right now, and the landing flag cleared — see `modules/shared/link-out.ts`. A rejection
          // pins nothing: it is not public, and nothing it stores is being vouched for.
          ...(approve ? reviewerPins(row) : {}),
        })) ?? row;
      await repos.audit.record({
        subjectKind: "opportunity",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: approve ? "approve" : "reject",
        patch: {
          reviewStatus: { before: row.reviewStatus, after: target },
          ...(approve ? {} : { isListed: { before: row.isListed, after: false } }),
          ...(reason ? { reason } : {}),
        },
      });
      return { id: next.publicId, reviewStatus: next.reviewStatus, isListed: next.isListed };
    });
  }

  /**
   * "I checked by hand, it is still open": refresh the staleness clock of ONE live listing.
   *
   * The only other things that move `last_seen_at` are a matched source check, a publisher write,
   * a granted claim and an approval — so a listing whose page the automated check cannot read (a
   * bot wall, a login, a page that does not carry the programme's title) had no way to stay open
   * except SQL in production. This is that statement, made by a reviewer and audited like every
   * other one.
   *
   * IT CHANGES `last_seen_at` AND NOTHING ELSE (`touchLastSeen`). Not `updated_at`: the verifier's
   * predicate is `verified_at < updated_at`, so a bump would queue an outbound fetch, and the public
   * `updatedAt` would claim a content change nobody made. Not the reviewer pins either: a hand check
   * vouches that the programme still runs, not for where its links go — that is what approval is.
   *
   * Only for a LIVE, OPEN listing, because those are the only ones the staleness job can close for
   * inactivity that anybody can see — and NOT for a past-due one: the job closes that on its
   * deadlines whatever the clock says, so a confirmation would be recorded and change nothing. The
   * remedy there is the listing's deadlines, not this. Likewise `closes_on_deadline` for a listing
   * whose close is set by its final fixed deadline (`closingDriver`): confirming it would move
   * nothing. Each refusal is its own 409 code so a client can say why.
   */
  async confirmOpen(
    reviewerId: number,
    publicId: string,
    note?: string | null,
  ): Promise<OpenConfirmationView> {
    return withTransaction(this.db, async (repos) => {
      const row = await lockOpportunity(repos, publicId);
      assertNotMerged(row);
      if (row.reviewStatus !== "approved") {
        throw conflict(
          "not_approved",
          `opportunity ${JSON.stringify(row.publicId)} is ${row.reviewStatus}; only an approved listing can be confirmed open.`,
        );
      }
      if (!row.isListed) {
        throw conflict(
          "not_listed",
          `opportunity ${JSON.stringify(row.publicId)} is unlisted; only a listed entry can be confirmed open.`,
        );
      }
      if (row.status !== "open") {
        throw conflict(
          "not_open",
          `opportunity ${JSON.stringify(row.publicId)} is ${row.status}; only an open listing can be confirmed open.`,
        );
      }
      const now = new Date();
      if (isPastDue(row.deadlines, now)) {
        throw conflict(
          "past_due",
          `opportunity ${JSON.stringify(row.publicId)} has no deadline left and no rolling intake; the staleness job closes it on its deadlines, which confirming cannot change. Update its deadlines instead.`,
        );
      }
      // The same refusal, for the same reason, one step earlier: a listing whose close is set by its
      // final deadline (fixed deadlines and no rolling intake, or a rolling one whose last deadline
      // outlasts a fresh clock) is not kept open one moment longer by a confirmation. Recording one
      // would tell the reviewer, and the audit trail, that it was.
      if (closingDriver(row, now, this.config.stalenessInactiveDays) === "final_deadline") {
        const latest = latestFixedDeadlineAt(row.deadlines);
        throw conflict(
          "closes_on_deadline",
          `opportunity ${JSON.stringify(row.publicId)} closes at its final fixed deadline${
            latest ? ` (${latest.toISOString()})` : ""
          }; confirming it now cannot keep it open any longer. Update its deadlines instead.`,
        );
      }
      await repos.opportunities.touchLastSeen(row.id, now);
      const reason = note?.trim() || CONFIRM_OPEN_DEFAULT_REASON;
      await repos.audit.record({
        subjectKind: "opportunity",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: "update",
        patch: {
          lastSeenAt: { before: row.lastSeenAt?.toISOString() ?? null, after: now.toISOString() },
          reason,
        },
      });
      const closesAt = inactivityClosesAt(
        { ...row, lastSeenAt: now },
        now,
        this.config.stalenessInactiveDays,
      );
      return {
        id: row.publicId,
        lastSeenAt: now.toISOString(),
        previousLastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        closesAt: closesAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Live, open listings the staleness job would close for inactivity within `windowDays`, soonest
   * first.
   *
   * THE JOB'S RULE PROJECTED ACROSS THE WINDOW, NOT A COPY OF IT. Every candidate is put through
   * `inactivityClosesAt` — `stalenessClosureReason` solved for time — so a rolling listing whose
   * fixed date passes inside the window is listed at `max(clock + days, that date)`, while a
   * past-due entry and one whose last fixed date lies beyond the window drop out exactly as the job
   * would treat them. The list cannot promise a date the job will not keep.
   *
   * THE TRUE EARLIEST, NOT THE EARLIEST OF A SAMPLE. The database can only order by the clock, so the
   * walk (`earliestInactivityClosings`) reads in clock order, keyset-paged, and stops as soon as no
   * unread row can close earlier than what it already holds. `complete: false` is reported only if
   * the safety cap on rows examined stops it first.
   */
  async closingSoon(
    windowDays: number,
    limit: number,
    now: Date = new Date(),
  ): Promise<ClosingSoonListView> {
    const inactiveDays = this.config.stalenessInactiveDays;
    const horizon = now.getTime() + windowDays * 86_400_000;
    // Every projected close is >= clock + inactiveDays, so closesAt <= horizon needs
    // clock <= horizon - inactiveDays.
    const clockAtOrBefore = new Date(horizon - inactiveDays * 86_400_000);
    const scan = this.closingSoonScan;
    // ONE SNAPSHOT FOR EVERY PAGE. Under READ COMMITTED each page would see the commits made since
    // the last one, and a listing confirmed (or matched by a source check) mid-walk would move past
    // the cursor and be read again — twice in the answer, with two dates. REPEATABLE READ pins the
    // snapshot at the first page; READ ONLY because nothing here writes.
    const { due, truncated, complete } = await withTransaction(
      this.db,
      (repos) =>
        earliestInactivityClosings<OpportunityRow>({
          readPage: async (after, size) => {
            const page = await repos.opportunities.listClosingSoonCandidates(
              new Date(horizon),
              clockAtOrBefore,
              after,
              size,
            );
            await scan.afterPage?.(page.map((candidate) => candidate.row));
            return page;
          },
          now,
          horizon,
          inactiveDays,
          limit,
          pageSize: scan.pageSize,
          scanCap: scan.scanCap,
        }),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const items: ClosingSoonItemView[] = due.map(({ row, closesAt }) => ({
      id: row.publicId,
      title: row.title,
      namespace: row.sourcePublisher,
      applicationUrl: row.applicationUrl,
      website: row.website,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      closesAt: closesAt.toISOString(),
      closesBy: closingDriver(row, now, inactiveDays),
    }));
    return { items, windowDays, inactiveDays, asOf: now.toISOString(), truncated, complete };
  }

  /** Unlist or relist. Separate from approval: a listing decision is not a conformance decision. */
  async setListed(
    reviewerId: number,
    publicId: string,
    isListed: boolean,
  ): Promise<ReviewDecisionView> {
    return withTransaction(this.db, async (repos) => {
      const row = await lockOpportunity(repos, publicId);
      assertNotMerged(row);
      if (row.isListed === isListed) {
        return { id: row.publicId, reviewStatus: row.reviewStatus, isListed: row.isListed };
      }
      const next =
        (await repos.opportunities.update(row.id, { isListed, updatedAt: new Date() })) ?? row;
      await repos.audit.record({
        subjectKind: "opportunity",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: isListed ? "relist" : "unlist",
        patch: { isListed: { before: row.isListed, after: isListed } },
      });
      return { id: next.publicId, reviewStatus: next.reviewStatus, isListed: next.isListed };
    });
  }

  // ── organisations ──────────────────────────────────────────────────────────────
  async setVerified(
    reviewerId: number,
    slug: string,
    verified: boolean,
  ): Promise<OrganizationSummaryView> {
    const settled = await withTransaction(this.db, async (repos) => {
      // The no-op check is part of the write. Lock first so two identical concurrent decisions do
      // not both read the old flag, both UPDATE it, and append two audit rows for one transition.
      const row = await lockOrganization(repos, slug);
      if (row.verified === verified)
        return { summary: await this.summarize(repos, row), notificationIds: [] };
      const now = new Date();
      const next =
        (await repos.organizations.update(row.id, {
          verified,
          verifiedAt: verified ? now : null,
          updatedAt: now,
        })) ?? row;
      await repos.audit.record({
        subjectKind: "organization",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: verified ? "verify_organization" : "unverify_organization",
        patch: { verified: { before: row.verified, after: verified } },
      });
      const notificationIds = verified
        ? await repos.notifications.record(
            buildPublisherVerifiedNotifications(
              await repos.memberships.accountIdsForOrganization(next.id),
              next,
              now,
            ),
          )
        : [];
      return { summary: await this.summarize(repos, next), notificationIds };
    });
    this.notificationQueue.enqueue(settled.notificationIds);
    return settled.summary;
  }

  /** Directory metadata. Never the verified flag — that has its own audited verb. */
  async updateOrganization(
    actorAccountId: number,
    slug: string,
    metadata: OrganizationMetadata,
    /** Owner/admin route only: re-prove the membership inside the transaction that writes. */
    requireManager = false,
  ): Promise<OrganizationSummaryView> {
    return withTransaction(this.db, async (repos) => {
      // The controller's check is only a cheap fail-fast. A membership can be revoked after that
      // read and before this UPDATE; locking the organisation first, then re-reading the membership
      // under a shared lock, makes revocation and the write serialize in the repository's standing
      // organisation → membership order. Whichever commits first is what the other observes.
      const row = await lockOrganization(repos, slug);
      if (requireManager) {
        const role = await repos.memberships.lockRoleForManagerCheck(actorAccountId, row.id);
        if (role !== "owner" && role !== "admin") {
          throw forbidden(
            "not_an_org_manager",
            `editing \`${slug}\` requires an owner or admin membership on it.`,
          );
        }
      }
      const set: OrganizationUpdate = { updatedAt: new Date() };
      const patch: Record<string, unknown> = {};

      if (metadata.name !== undefined) {
        const name = metadata.name.trim();
        if (name === "") throw badRequest("invalid_name", "`name` may not be empty.");
        if (name !== row.name) {
          set.name = name;
          patch.name = { before: row.name, after: name };
        }
      }
      if (metadata.description !== undefined && metadata.description !== row.description) {
        set.description = metadata.description;
        patch.description = { before: row.description, after: metadata.description };
      }
      if (metadata.website !== undefined && metadata.website !== row.website) {
        set.website = metadata.website;
        patch.website = { before: row.website, after: metadata.website };
      }
      if (metadata.logoUrl !== undefined && metadata.logoUrl !== row.logoUrl) {
        set.logoUrl = metadata.logoUrl;
        patch.logoUrl = { before: row.logoUrl, after: metadata.logoUrl };
      }
      if (metadata.bannerUrl !== undefined && metadata.bannerUrl !== row.bannerUrl) {
        set.bannerUrl = metadata.bannerUrl;
        patch.bannerUrl = { before: row.bannerUrl, after: metadata.bannerUrl };
      }
      if (metadata.ecosystems !== undefined) {
        set.ecosystems = metadata.ecosystems;
        patch.ecosystems = { before: row.ecosystems, after: metadata.ecosystems };
      }

      if (Object.keys(patch).length === 0) return this.summarize(repos, row);

      const next = (await repos.organizations.update(row.id, set)) ?? row;
      await repos.audit.record({
        subjectKind: "organization",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: actorAccountId,
        action: "update_organization",
        patch,
      });
      return this.summarize(repos, next);
    });
  }

  // ── memberships ────────────────────────────────────────────────────────────────
  async grantMembership(
    actorAccountId: number,
    slug: string,
    accountId: number,
    role: string | undefined,
    /** Internal: caps the one-time retry below at one, so a genuine bug cannot recurse forever. */
    retried = false,
  ): Promise<MembershipResultView> {
    const orgRole = normalizeOrgRole(role);
    try {
      const settled = await withTransaction(this.db, async (repos) => {
        const org = await findOrganization(repos, slug);
        const account = await repos.accounts.findById(accountId);
        if (!account) throw notFound(`no account ${accountId}.`);

        // A concurrent revoke must finish before this grant decides whether to UPDATE or INSERT.
        // Without the lock, DELETE can remove the row after this read; the UPDATE then affects
        // zero rows while the endpoint still audits and reports a membership that does not exist.
        const existing = await repos.memberships.lockForAccountAndOrganization(accountId, org.id);
        let notificationIds: number[] = [];

        if (existing) {
          if (existing.role === orgRole) {
            return {
              result: { organizationSlug: org.slug, accountId, role: orgRole, member: true },
              notificationIds,
            };
          }
          await repos.memberships.updateRole(existing.id, orgRole);
        } else {
          await repos.memberships.insertRole(accountId, org.id, orgRole);
          if (org.verified) {
            notificationIds = await repos.notifications.record(
              buildPublisherVerifiedNotifications([accountId], org, new Date()),
            );
          }
        }

        await repos.audit.record({
          subjectKind: "organization",
          subjectId: org.id,
          actorKind: "user",
          actorAccountId: actorAccountId,
          action: "grant_publisher",
          patch: {
            accountId,
            role: { before: existing?.role ?? null, after: orgRole },
          },
        });
        return {
          result: { organizationSlug: org.slug, accountId, role: orgRole, member: true },
          notificationIds,
        };
      });
      this.notificationQueue.enqueue(settled.notificationIds);
      return settled.result;
    } catch (error) {
      // TWO REVIEWERS, ONE GRANT. The read above and the insert are not one atomic step, so two
      // concurrent grants of the same previously-absent membership can both see no row and both
      // reach the insert; the unique index (`ux_org_membership`) lets one in and raises 23505 at
      // the other. The grant is documented as idempotent, so the loser of that race has not
      // failed — retrying finds the row the winner just committed and takes the ordinary
      // "already a member" path above (updating the role if this call asked for a different one).
      if (retried || !isUniqueViolation(error)) throw error;
      return this.grantMembership(actorAccountId, slug, accountId, role, true);
    }
  }

  async revokeMembership(
    actorAccountId: number,
    slug: string,
    accountId: number,
  ): Promise<MembershipResultView> {
    return withTransaction(this.db, async (repos) => {
      const org = await findOrganization(repos, slug);
      const removedRole = await repos.memberships.removeForAccountAndOrganization(
        accountId,
        org.id,
      );
      if (removedRole === null) {
        return { organizationSlug: org.slug, accountId, role: null, member: false };
      }
      await repos.audit.record({
        subjectKind: "organization",
        subjectId: org.id,
        actorKind: "user",
        actorAccountId: actorAccountId,
        action: "revoke_publisher",
        patch: { accountId, role: { before: removedRole, after: null } },
      });
      return { organizationSlug: org.slug, accountId, role: null, member: false };
    });
  }

  /** Whether this account may edit the organisation's directory entry as its owner/admin. */
  /**
   * A VERIFIED MEMBER PUBLISHES THEIR OWN ORGANISATION'S QUEUE.
   *
   * The same act a T2 write performs automatically, performed deliberately after the fact: an entry
   * filed under an organisation's namespace by somebody who could not auto-publish — a colleague
   * without a key's `publish` scope, a submission that arrived before the organisation was verified,
   * an edit that returned an approved entry to the queue — is the organisation's to release. Making
   * them wait for a Hub reviewer to rubber-stamp their own programme is a queue that exists only
   * because nobody wired this route.
   *
   * FOUR BOUNDARIES, and each one is a decision rather than an omission:
   *
   *   1. **VERIFIED membership, not any membership.** The list endpoint beside this one admits any
   *      member, because looking is not publishing. This one publishes to the world, so it rides the
   *      same trust event auto-publish does — the moment a reviewer verified the organisation.
   *   2. **Session only.** A leaked key must not be able to publish unreviewed content, which is the
   *      whole of the `canPublishImmediately` rule; approving is that same power in a second shape.
   *   3. **The NAMESPACE, not any operating organisation.** Widening this to "any org named in
   *      `operatingOrganizations`" was considered and rejected: an entry can name several operators,
   *      and approving publishes it in the NAMESPACE's name — so a co-operator could publish under
   *      somebody else's banner, which is the cross-org hazard the write path's containment rule
   *      exists to close. An entry filed under a namespace you do not publish for is answered 404,
   *      not 403, so this route cannot be used to enumerate other organisations' pending queues.
   *   4. **BOTH VERBS, and a REQUIRED REASON on the rejection.** Verified members decide — approve
   *      AND reject — within their own namespace; Hub reviewers decide anywhere. Rejection was
   *      withheld at first over the obvious conflict of interest (anyone may submit an entry ABOUT
   *      an organisation, and that organisation should not quietly suppress a third party's account
   *      of its own programme), but withholding it left spam in an organisation's namespace waiting
   *      on Hub staff. The counterweight is accountability rather than absence: a rejection here
   *      REQUIRES a written reason, the trail attributes it to the member by handle rather than
   *      coarsening it to "reviewer", and the submitter is shown that reason on their own listing.
   *      An organisation may still refuse things — it may no longer do it silently or anonymously.
   *
   * The membership is re-proved UNDER THE ENTRY'S LOCK, not trusted from the request's principal:
   * memberships are resolved when the bearer is exchanged, and a request can outlive that answer.
   * A reviewer un-verifying the organisation while this is in flight must not be beaten by it, so
   * the authority is read again inside the transaction, in the repo's standing lock order
   * (entry → organisation → membership). Fails closed: gone or unverified ⇒ refused.
   */
  async approveForNamespace(accountId: number, slug: string, publicId: string) {
    return this.decideForNamespace(accountId, slug, publicId, { approve: true });
  }

  /**
   * The same authority, the other verdict — and the reason is not optional.
   *
   * See `approveForNamespace` for the four boundaries; they are identical, and deliberately so:
   * the thing that makes a member trusted to publish is the thing that makes them trusted to
   * refuse, and a route pair whose guards drifted apart would be the interesting bug.
   */
  async rejectForNamespace(accountId: number, slug: string, publicId: string, reason: string) {
    const written = reason.trim();
    if (written === "") {
      throw badRequest(
        "reason_required",
        "rejecting an entry in your own namespace requires a reason. It is recorded against your account and shown to whoever submitted it — that accountability is what makes this decision yours to make.",
      );
    }
    return this.decideForNamespace(accountId, slug, publicId, { approve: false, reason: written });
  }

  private async decideForNamespace(
    accountId: number,
    slug: string,
    publicId: string,
    decision: { approve: boolean; reason?: string },
  ): Promise<ReviewDecisionView> {
    return withTransaction(this.db, async (repos) => {
      const row = await lockOpportunity(repos, publicId);
      // Not 403: an entry filed under a namespace this account does not publish for is, as far as
      // this route is concerned, not there at all.
      if (row.sourcePublisher !== slug) {
        throw notFound(`no opportunity ${JSON.stringify(publicId)} published under \`${slug}\`.`);
      }

      const authority = await resolvePublishAuthority(repos, accountId, slug);
      if (!authority.member || !authority.verified) {
        throw forbidden(
          "not_a_verified_member",
          `approving an entry published under \`${slug}\` requires a membership on it while it is a verified publisher.`,
        );
      }

      assertNotMerged(row);

      if (row.reviewStatus !== "pending") {
        throw conflict(
          "not_pending",
          `that entry is already ${row.reviewStatus}; only a pending entry can be decided here.`,
        );
      }

      const now = new Date();
      const target = decision.approve ? "approved" : "rejected";
      const next =
        (await repos.opportunities.update(row.id, {
          reviewStatus: target,
          // APPROVAL IS NOT A LISTING DECISION, and the staff route has always known that: it
          // preserves `is_listed` on approve and clears it on reject. Forcing it true here would
          // silently republish a row a reviewer had deliberately unlisted, or one that was rejected
          // (and therefore unlisted), edited, and requeued — an unlisting undone by somebody who
          // never saw it. Rejection still unlists, because leaving the flag true records a listing
          // intent that is no longer true and two flags that disagree are how a later query gets it
          // wrong.
          isListed: decision.approve ? row.isListed : false,
          approvedBy: decision.approve ? (row.approvedBy ?? accountId) : row.approvedBy,
          approvedAt: decision.approve ? (row.approvedAt ?? now) : row.approvedAt,
          // A publisher releasing their own entry is the same "still real" signal a write is; a
          // rejection says nothing about whether the programme exists.
          lastSeenAt: decision.approve ? now : row.lastSeenAt,
          updatedAt: now,
          // NO LINK PINS, unlike the staff route's approval. This is the publisher vouching for its
          // own programme — the same trust event as an auto-approved write, which leaves the pins
          // alone for the same reason: the hub's link-out vouches only for what a HUB reviewer saw.
          // A link the reviewer already pinned stays vouched; a new one gets the leaving page.
        })) ?? row;

      await repos.audit.record({
        subjectKind: "opportunity",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: accountId,
        action: decision.approve ? "approve" : "reject",
        patch: {
          reviewStatus: { before: row.reviewStatus, after: target },
          ...(decision.approve || row.isListed === false
            ? {}
            : { isListed: { before: row.isListed, after: false } }),
          // `reason` is the human-facing half — the server's own words on an approval, the member's
          // written justification on a rejection — and `via` is the machine-readable one. The trail
          // has to distinguish a Hub reviewer's decision from a publisher's for BOTH verbs, and
          // `reason` alone cannot carry that once it is holding somebody's sentence.
          //
          // `via` is ALSO what keeps the by-handle promise for a member who happens to be staff:
          // the trail's public actor label coarsens a reviewer or admin to "reviewer", and a
          // dual-role member deciding in their PUBLISHER capacity would otherwise be anonymised by
          // a global role that had nothing to do with this decision. See `publicActor`.
          reason: decision.approve ? "operating_org_approval" : (decision.reason as string),
          via: OPERATING_ORG_CAPACITY,
        },
      });
      return { id: next.publicId, reviewStatus: next.reviewStatus, isListed: next.isListed };
    });
  }

  /** The organisation a slug names, or the same 404 every other organisation route answers with. */
  async requireOrganization(slug: string): Promise<OrganizationRow> {
    return findOrganization(this.repos, slug);
  }

  async isOrgManager(accountId: number, slug: string): Promise<boolean> {
    const role = await this.repos.memberships.roleForAccountAndOrganizationSlug(accountId, slug);
    return role === "owner" || role === "admin";
  }

  // ── discovery ──────────────────────────────────────────────────────────────────
  async searchOrganizations(
    q: string | undefined,
    verified: boolean | undefined,
    limit = 25,
  ): Promise<OrganizationSummaryView[]> {
    const rows = await this.repos.organizations.search(q, verified, limit);
    return Promise.all(rows.map((row) => this.summarize(this.repos, row)));
  }

  private async summarize(
    repos: Repositories,
    row: OrganizationRow,
  ): Promise<OrganizationSummaryView> {
    return {
      slug: row.slug,
      name: row.name,
      verified: row.verified,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      website: row.website,
      ecosystems: row.ecosystems,
      memberCount: await repos.memberships.countForOrganization(row.id),
    };
  }
}

/** The entry, locked, or a 404. Locked because every caller is about to change its state. */
async function lockOpportunity(repos: Repositories, publicId: string): Promise<OpportunityRow> {
  const row = await repos.opportunities.lockByPublicId(publicId);
  if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
  return row;
}

/** A merge is terminal: no review or listing decision may make its loser live again. */
function assertNotMerged(row: OpportunityRow): void {
  if (row.mergedIntoId !== null) {
    throw conflict(
      "opportunity_merged",
      `opportunity ${JSON.stringify(row.publicId)} has been merged and cannot be changed.`,
    );
  }
}

/** The organisation row a metadata transaction is about to change, locked before membership. */
async function lockOrganization(repos: Repositories, slug: string): Promise<OrganizationRow> {
  const row = await repos.organizations.lockBySlug(slug);
  if (!row) throw notFound(`no organization \`${slug}\`.`);
  return row;
}

async function findOrganization(repos: Repositories, slug: string): Promise<OrganizationRow> {
  const row = await repos.organizations.findBySlug(slug);
  if (!row) throw notFound(`no organization \`${slug}\`.`);
  return row;
}

function normalizeOrgRole(raw: string | undefined): OrgRole {
  if (raw === undefined) return "publisher";
  const role = raw.trim().toLowerCase();
  if (!(ORG_ROLES as string[]).includes(role)) {
    throw badRequest("invalid_role", `\`role\` must be one of ${ORG_ROLES.join(", ")}.`);
  }
  return role as OrgRole;
}

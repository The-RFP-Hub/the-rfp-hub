/**
 * Email publishers about live listings that have gone quiet.
 *
 * This job only emits durable email rows. `notification-dispatch` owns provider calls, bounded
 * retries and delivery evidence, so a provider outage never changes the listing or this job's
 * eligibility decision.
 */
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type Repositories, repositories, withTransaction } from "../../repositories/index.js";
import type { StalePublisherGroup, StalePublisherGroupCursor } from "../../repositories/index.js";
import { isPastDue } from "../../shared/deadlines.js";
import { staleReminderSubject } from "../notifications/email-notification-events.js";
import {
  type NotificationDispatchEnqueuer,
  notificationDispatchQueue,
} from "../notifications/notification-dispatch.queue.js";
import type { JobResult } from "./types.js";

const DEFAULT_LIMIT = 5_000;
const MAX_LISTINGS_PER_EMAIL = 20;
const LISTING_PAGE_SIZE = MAX_LISTINGS_PER_EMAIL;
const DAY_MS = 86_400_000;

export interface StaleListingReminderOptions {
  limit?: number;
  now?: Date;
  config?: AppConfig;
  notificationQueue?: NotificationDispatchEnqueuer;
}

interface GroupProcessResult {
  notificationId?: number;
  eligibleListings: number;
  skippedPastDue: number;
  skippedNoMembership: number;
  skippedCooldown: number;
  skippedPending: number;
}

export class StaleListingReminderService {
  private readonly repos: Repositories;
  private readonly appConfig: AppConfig;
  private readonly notificationQueue: NotificationDispatchEnqueuer;

  constructor(
    private readonly db: DB = defaultDb,
    options: Omit<StaleListingReminderOptions, "now" | "limit"> = {},
  ) {
    this.repos = repositories(db);
    this.appConfig = options.config ?? defaultConfig;
    this.notificationQueue = options.notificationQueue ?? notificationDispatchQueue;
  }

  /**
   * Process recipient groups, not joined listing rows.
   *
   * A page is bounded by `limit`, but a page containing only expired rows is not allowed to report
   * zero progress while a later group is eligible: the cursor advances through every page until an
   * event is created or the predicate is exhausted. Each group's listing payload has its own
   * bounded scan, so an expired first page cannot hide a valid tail listing either.
   */
  async runBatch(options: StaleListingReminderOptions = {}): Promise<JobResult> {
    const now = options.now ?? new Date();
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const cadenceMs = this.appConfig.notifications.staleReminderCadenceDays * DAY_MS;
    const inactiveBefore = new Date(
      now.getTime() - this.appConfig.notifications.staleReminderDays * DAY_MS,
    );
    const cooldownBefore = new Date(now.getTime() - cadenceMs);
    const cursor: StalePublisherGroupCursor = { accountId: 0, organizationId: 0 };
    const ids: number[] = [];
    let exhausted = false;
    let scannedGroups = 0;
    let recipientGroups = 0;
    let eligibleListings = 0;
    let skippedPastDue = 0;
    let skippedNoMembership = 0;
    let skippedCooldown = 0;
    let skippedPending = 0;

    while (ids.length < limit && !exhausted) {
      const page = await this.repos.opportunities.listStalePublisherGroups(
        inactiveBefore,
        cooldownBefore,
        cursor,
        limit,
      );
      if (page.length === 0) {
        exhausted = true;
        break;
      }

      for (const group of page) {
        cursor.accountId = group.accountId;
        cursor.organizationId = group.organizationId;
        scannedGroups++;
        const result = await this.processGroup(group, inactiveBefore, cooldownBefore, now);
        skippedPastDue += result.skippedPastDue;
        eligibleListings += result.eligibleListings;
        skippedNoMembership += result.skippedNoMembership;
        skippedCooldown += result.skippedCooldown;
        skippedPending += result.skippedPending;
        if (result.notificationId !== undefined) {
          ids.push(result.notificationId);
          recipientGroups++;
        }
        if (ids.length >= limit) break;
      }

      // A short page is exhausted only if every group in it was visited. When the limit stopped
      // us in the middle of a full page, there is necessarily an unvisited group. For a complete
      // page, probe once after the cursor so `remaining` reflects the post-insert predicate rather
      // than the page size heuristic.
      if (ids.length >= limit) {
        exhausted = page.length < limit;
        if (!exhausted) {
          const next = await this.repos.opportunities.listStalePublisherGroups(
            inactiveBefore,
            cooldownBefore,
            cursor,
            1,
          );
          exhausted = next.length === 0;
        }
      } else if (page.length < limit) {
        exhausted = true;
      }
    }

    if (ids.length > 0) this.notificationQueue.enqueue(ids);
    return {
      processed: ids.length,
      remaining: exhausted ? 0 : 1,
      details: {
        eligibleListings,
        recipientGroups,
        createdNotifications: ids.length,
        scannedGroups,
        skippedPastDue,
        skippedNoMembership,
        skippedCooldown,
        skippedPending,
      },
    };
  }

  /**
   * Serialize cooldown check and insert on the unique membership row.
   *
   * The read-side group query is intentionally not trusted for this decision: two maintenance
   * processes may read the same page before either commits. The lock, SQL activity predicate and
   * partial unique index together make one generator win and every concurrent loser harmless.
   */
  private async processGroup(
    group: StalePublisherGroup,
    inactiveBefore: Date,
    cooldownBefore: Date,
    now: Date,
  ): Promise<GroupProcessResult> {
    return withTransaction(this.db, async (repos) => {
      const membership = await repos.memberships.lockForAccountAndOrganization(
        group.accountId,
        group.organizationId,
      );
      if (!membership) {
        return {
          eligibleListings: 0,
          skippedPastDue: 0,
          skippedNoMembership: 1,
          skippedCooldown: 0,
          skippedPending: 0,
        };
      }
      if (
        !(await repos.memberships.hasVerifiedMembershipForOrganization(
          group.accountId,
          group.organizationId,
        ))
      ) {
        return {
          eligibleListings: 0,
          skippedPastDue: 0,
          skippedNoMembership: 1,
          skippedCooldown: 0,
          skippedPending: 0,
        };
      }
      if (
        await repos.notifications.hasRecentStaleReminder({
          accountId: group.accountId,
          organizationId: group.organizationId,
          cooldownBefore,
        })
      ) {
        return {
          eligibleListings: 0,
          skippedPastDue: 0,
          skippedNoMembership: 0,
          skippedCooldown: 1,
          skippedPending: 0,
        };
      }

      const listings: Array<{ id: string; title: string }> = [];
      let afterId = 0;
      let skippedPastDue = 0;
      while (listings.length < MAX_LISTINGS_PER_EMAIL) {
        const page = await repos.opportunities.listStalePublisherListingsForRecipient(
          group.accountId,
          group.organizationId,
          inactiveBefore,
          afterId,
          LISTING_PAGE_SIZE,
        );
        if (page.length === 0) break;
        for (const candidate of page) {
          afterId = candidate.opportunity.id;
          if (isPastDue(candidate.opportunity.deadlines, now)) {
            skippedPastDue++;
            continue;
          }
          listings.push({
            id: candidate.opportunity.publicId,
            title: candidate.opportunity.title,
          });
          if (listings.length >= MAX_LISTINGS_PER_EMAIL) break;
        }
        if (page.length < LISTING_PAGE_SIZE) break;
      }
      if (listings.length === 0) {
        return {
          eligibleListings: 0,
          skippedPastDue,
          skippedNoMembership: 0,
          skippedCooldown: 0,
          skippedPending: 0,
        };
      }

      const inserted = await repos.notifications.record([
        {
          accountId: group.accountId,
          kind: "stale_listing_reminder",
          subjectKind: staleReminderSubject(group.organizationId, now),
          subjectId: group.accountId,
          payload: {
            organizationId: group.organizationId,
            organizationSlug: group.organizationSlug,
            organizationName: group.organizationName,
            listings,
            inactivityDays: this.appConfig.notifications.staleReminderDays,
            closeAfterDays: this.appConfig.stalenessInactiveDays,
            reminderCreatedAt: now.toISOString(),
          },
        },
      ]);
      const notificationId = inserted[0];
      if (notificationId === undefined) {
        // The partial unique index covers a writer that did not take the lock or a stale pending
        // row outside this rolling window. Do not report a false positive or enqueue a phantom id.
        return {
          eligibleListings: listings.length,
          skippedPastDue,
          skippedNoMembership: 0,
          skippedCooldown: 0,
          skippedPending: 1,
        };
      }
      return {
        notificationId,
        eligibleListings: listings.length,
        skippedPastDue,
        skippedNoMembership: 0,
        skippedCooldown: 0,
        skippedPending: 0,
      };
    });
  }
}

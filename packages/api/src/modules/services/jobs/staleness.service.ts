/**
 * The staleness job: close what has stopped being an opportunity, and keep the deadline key honest.
 *
 * Two passes, one walk, both audited.
 *
 *   1. **Past due.** `status='open'` and `isPastDue(deadlines)` → `closed`, `reason: 'past_due'`.
 *      The predicate is the unit-tested pure helper in `modules/shared/deadlines.ts`, not a second
 *      copy of the rule written in SQL — which is why the walk happens in this process rather than
 *      in one `UPDATE`. A rolling entry is never past due, however old its fixed dates are.
 *   2. **Inactive.** `status='open'`, no future fixed deadline, and nobody has touched it for
 *      `STALENESS_INACTIVE_DAYS` (90) → `closed`, `reason: 'inactive'`.
 *
 * ROLLING-ONLY ENTRIES ARE ELIGIBLE FOR THE SECOND PASS, and that is the decision, not an accident.
 * A rolling programme has `next_deadline_at = NULL` forever, so pass 1 can never close it and
 * without pass 2 it would stay open for as long as the database does. A rolling programme nobody
 * has re-asserted for ninety days is exactly the stale listing this job exists to close — and any
 * publisher write, granted claim or successful verification resets `last_seen_at`, so an entry that
 * is still real is trivially kept open by the people who own it. The `next_deadline_at IS NULL`
 * clause is load-bearing for the opposite reason: an entry with a known future deadline is never
 * closed for inactivity, however quiet its publisher has been.
 *
 * THE CANDIDATE PREDICATE, AND WHY THE RUN RETIRES IT.
 *
 *   status = 'open' AND merged_into_id IS NULL AND (next_deadline_at IS NULL OR next_deadline_at <= now)
 *
 * An entry with a FUTURE `next_deadline_at` can be neither past due (it holds a future fixed date)
 * nor inactive (that pass requires the column to be NULL), so this one predicate covers both passes
 * exactly while staying an index range on `ix_opp_public_live`. It is a superset of what gets
 * closed, and the run shrinks it three ways: a close leaves `status='open'`, and a recompute that
 * finds a later fixed date writes a future `next_deadline_at`. What is left over — an open entry
 * with rolling deadlines that somebody touched last week — is *correctly* left alone, and is why
 * `processed` rather than `remaining` is what tells a runner whether to go round again.
 *
 * `updated_at` IS DELIBERATELY NOT TOUCHED, by either pass. Two things read it:
 *   - this job's own inactivity clock is `coalesce(last_seen_at, updated_at)`, so bumping it would
 *     reset the very timer that selected the row;
 *   - the verification job's predicate is `verified_at < updated_at`, so bumping it would re-queue
 *     every closed entry for an outbound fetch, every night, forever.
 * The audit row carries the timestamp of the change, which is where that fact belongs anyway.
 */
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityRow } from "../../../db/schema.js";
import { type Repositories, repositories, withTransaction } from "../../repositories/index.js";
import { isPastDue, nextDeadlineAt } from "../../shared/deadlines.js";
import { SYSTEM_ACTOR } from "../audit/audit.service.js";
import type { JobResult } from "./types.js";

/** Why an entry was closed. Recorded verbatim in the audit patch. */
export type StalenessReason = "past_due" | "inactive";

/** How many candidates one invocation will examine before reporting the rest as remaining. */
const DEFAULT_LIMIT = 5000;

/** How many rows are read from the database at a time while walking the candidate set. */
const PAGE = 200;

export interface StalenessOptions {
  /** Cap on candidates EXAMINED in this invocation. The default is above any realistic backlog. */
  limit?: number;
  /** Injected clock. The integration suite seeds relative dates and needs to name "now". */
  now?: Date;
}

export interface StalenessLogger {
  error(payload: Record<string, unknown>, message: string): void;
}

const consoleLogger: StalenessLogger = {
  error(payload, message) {
    console.error(message, JSON.stringify(payload));
  },
};

export class StalenessService {
  private readonly config: AppConfig;
  private readonly repos: Repositories;
  private readonly logger: StalenessLogger;

  constructor(
    private readonly db: DB = defaultDb,
    options: { config?: AppConfig; logger?: StalenessLogger } = {},
  ) {
    this.config = options.config ?? defaultConfig;
    this.repos = repositories(db);
    this.logger = options.logger ?? consoleLogger;
  }

  /**
   * One pass over the candidate set.
   *
   * `processed` counts rows this run CHANGED — closed, or had their derived deadline key
   * rewritten. A second run over the same data changes nothing and reports `0`, which is what
   * makes the job safe to run twice and what tells the runner to stop.
   */
  async runBatch(options: StalenessOptions = {}): Promise<JobResult> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? DEFAULT_LIMIT;
    const inactiveBefore = new Date(now.getTime() - this.config.stalenessInactiveDays * 86_400_000);

    let examined = 0;
    let processed = 0;
    let failed = 0;
    let cursor = 0;
    const closed: Record<StalenessReason, number> = { past_due: 0, inactive: 0 };
    let recomputed = 0;

    while (examined < limit) {
      const page = await this.candidates(now, cursor, Math.min(PAGE, limit - examined));
      if (page.length === 0) break;
      for (const row of page) {
        cursor = row.id;
        examined++;
        let outcome: Awaited<ReturnType<StalenessService["settle"]>>;
        try {
          outcome = await this.settle(row, now, inactiveBefore);
        } catch (error) {
          // ONE POISON ROW MUST NOT END THE WALK — the same rule both backfills already keep, and
          // it matters more here. `settle` opens a transaction per row, so a deadlock victim, a
          // lock timeout or a constraint nobody anticipated is a per-row failure; letting it out
          // abandons every candidate after it, and because the walk is ordered by id the SAME
          // rows are abandoned every night. The row stays in the predicate for the next run, which
          // is precisely the cursor contract.
          failed++;
          this.logger.error(
            {
              job: "staleness",
              opportunityId: row.id,
              error: error instanceof Error ? error.name : typeof error,
              reason: error instanceof Error ? error.message : String(error),
            },
            "staleness could not settle an entry",
          );
          continue;
        }
        if (outcome === "unchanged") continue;
        processed++;
        if (outcome === "recomputed") recomputed++;
        else closed[outcome]++;
      }
    }

    return {
      processed,
      // Candidates the cap kept this invocation from looking at — NOT "work still owed", which is
      // unknowable without examining each row. Zero whenever the whole candidate set was walked.
      remaining: examined < limit ? 0 : await this.candidateCount(now, cursor),
      details: {
        examined,
        closedPastDue: closed.past_due,
        closedInactive: closed.inactive,
        deadlinesRecomputed: recomputed,
        // Rows that threw and were skipped. A run that swallowed them silently would report a
        // clean `processed` while the same entries went unsettled indefinitely.
        failed,
      },
    };
  }

  /** Decide and apply one entry's fate. */
  private async settle(
    row: OpportunityRow,
    now: Date,
    inactiveBefore: Date,
  ): Promise<"unchanged" | "recomputed" | StalenessReason> {
    const next = nextDeadlineAt(row.deadlines, now);
    const nextChanged = (next?.getTime() ?? null) !== (row.nextDeadlineAt?.getTime() ?? null);

    const reason = this.closureReason(row, next, now, inactiveBefore);
    if (reason === null) {
      if (!nextChanged) return "unchanged";
      // THE SAME LOCKED RE-READ THE CLOSURE BRANCH USES, for the same reason and against a key
      // that is read far more often. `next_deadline_at` is derived from `deadlines`, and a
      // publisher's `PUT` between the walk's SELECT and this UPDATE has already recomputed it from
      // the NEW deadlines — writing the value derived from the stale ones would overwrite a correct
      // derived key with an obsolete one, and every deadline filter and sort would read it until
      // the row happened to become a candidate again. The lock makes the publisher's write the one
      // that stands.
      return withTransaction(this.db, async (repos) => {
        const current = await repos.opportunities.lockById(row.id);
        if (!current) return "unchanged";
        const currentNext = nextDeadlineAt(current.deadlines, now);
        if ((currentNext?.getTime() ?? null) === (current.nextDeadlineAt?.getTime() ?? null)) {
          return "unchanged";
        }
        await repos.opportunities.updateNextDeadline(row.id, currentNext);
        return "recomputed";
      });
    }

    // The locked re-read's OWN decision is what `runBatch` must count against, not the pre-lock
    // `reason` above: if a publisher's write between the walk's SELECT and this lock already took
    // the row out of contention (closed it themselves, or resolved the condition), the transaction
    // correctly does nothing — and the caller has to be told that, or it reports an entry as
    // processed and closed for a mutation that never happened.
    return withTransaction(this.db, async (repos): Promise<"unchanged" | StalenessReason> => {
      // Re-read under a row lock: a publisher editing this entry between the walk's SELECT and this
      // UPDATE must win, because their edit is the newer statement of fact.
      const current = await repos.opportunities.lockById(row.id);
      if (!current || current.status !== "open") return "unchanged";
      const currentNext = nextDeadlineAt(current.deadlines, now);
      const currentReason = this.closureReason(current, currentNext, now, inactiveBefore);
      if (currentReason === null) return "unchanged";

      await repos.opportunities.closeForStaleness(row.id, currentNext);
      await repos.audit.record({
        ...SYSTEM_ACTOR,
        subjectKind: "opportunity",
        subjectId: row.id,
        action: "close",
        patch: {
          job: "staleness",
          reason: currentReason,
          status: { before: current.status, after: "closed" },
        },
      });
      return currentReason;
    });
  }

  /** The two rules, in the order they are applied. `null` when the entry stays open. */
  private closureReason(
    row: OpportunityRow,
    next: Date | null,
    now: Date,
    inactiveBefore: Date,
  ): StalenessReason | null {
    if (isPastDue(row.deadlines, now)) return "past_due";
    if (next !== null) return null;
    const touched = row.lastSeenAt ?? row.updatedAt;
    return touched.getTime() < inactiveBefore.getTime() ? "inactive" : null;
  }

  private async candidates(now: Date, afterId: number, limit: number): Promise<OpportunityRow[]> {
    return this.repos.opportunities.listStalenessCandidates(now, afterId, limit);
  }

  private async candidateCount(now: Date, afterId: number): Promise<number> {
    return this.repos.opportunities.countStalenessCandidates(now, afterId);
  }
}

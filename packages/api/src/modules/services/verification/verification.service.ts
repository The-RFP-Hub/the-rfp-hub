/**
 * Verification-assist: fetch the page an entry points at and say, field by field, what it does and
 * does not appear to corroborate.
 *
 * WHAT THIS PRODUCES, stated plainly because the name overpromises: `matched` is
 * "the page exists and its title is about the same programme". It is a LOW-BAR ANTI-SPAM SIGNAL —
 * it catches an `applicationUrl` pointing at nothing, or at something unrelated — and it is not a
 * claim that the amounts, dates or eligibility are right. A reviewer still approves.
 *
 * NO LANGUAGE MODEL, on purpose. Determinism means the same page and record produce the same diff
 * on every run, so a reviewer comparing two runs is looking at a change in the PAGE rather than a
 * change in a sampler. It also costs nothing per submission and can be tested exhaustively against
 * fixtures — none of which is true of a prose verdict.
 *
 * A FAILED RUN IS STILL A RUN. A refused address, a timeout, an unusable content type and a soft
 * 404 all write a row, because "we tried and this is what happened" is the answer a reviewer needs
 * and silence is indistinguishable from never having checked. BUT A FAILED RUN IS NOT A VERDICT:
 * a run that never reached the source leaves `verified_at` alone, so the entry stays owed a check
 * rather than being retired by an outage (`TRANSIENT_FETCH_FAILURES`, below).
 *
 * A CHECK EXPIRES. `verified_at` older than `VERIFY_RECHECK_DAYS` puts the entry back in the
 * selection, because a page checked once in the week it was imported says nothing about whether the
 * programme is still running today — and because a matched check is the ONLY thing that refreshes
 * `last_seen_at` for an entry with no future deadline, without which `staleness` closes it after
 * ninety quiet days. The selection is capped per invocation (`VERIFY_NIGHTLY_LIMIT`) and ordered
 * never-checked first, so a corpus larger than the cap is worked through rather than half-ignored.
 *
 * THE RUN LOG IS APPEND-ONLY BUT NOT UNBOUNDED. Each row carries up to 200 KB of `snapshot_text`,
 * and an entry re-checked on a schedule accumulates one per check forever — megabytes a year, for a
 * history nobody reads past the most recent few. So the backfill prunes to the newest
 * `VERIFICATION_RUNS_KEEP` runs per entry it touched. The trail an audit needs is `audit_log`, which
 * is immutable in the database and is never pruned; this table is evidence for a reviewer looking at
 * a page NOW, and the retention bound says so.
 *
 * THE BACKFILL IS PACED PER HOST (`host-pacer.ts`). A corpus clusters by publisher, so a serial
 * pass over 500 entries is fifty requests to one foundation's domain in the two seconds it takes
 * that domain to answer them — indistinguishable from a scraper, and a block reads back here as
 * "every entry from this publisher stopped matching". A reviewer's own manual check is not paced:
 * one request is not a crawl, and making it queue behind a batch charges politeness to the wrong
 * person.
 *
 * A RE-CHECK THAT FINDS THE PAGE UNMOVED SAYS SO. The digest is over the raw bytes, so an equal
 * digest is proof the page has not changed since the last check; the run still records a full
 * assessment (the RECORD may have moved even though the page did not) but is flagged
 * `snapshotUnchanged`, and carries the previous run's snapshot text forward rather than a second
 * copy of a fresh extraction. Conditional requests — `If-None-Match` / `If-Modified-Since` — would
 * save the transfer as well, and are NOT sent: neither `FetchedSource` nor `verification_runs`
 * keeps a response's `ETag` or `Last-Modified`, so there is nothing to send them from without a
 * migration.
 *
 * THE SUBMIT-TIME QUEUE IS BOUNDED, AND THE BOUND IS THE BACKLOG, NOT THE PARALLELISM. A
 * concurrency limit of 2 caps how many fetches run at once; it does nothing about a submitter
 * queueing ten thousand. So the queue itself has a ceiling (`VERIFY_QUEUE_MAX`) and, when it is
 * full, the submit-time trigger is simply SKIPPED — the entry still satisfies the cron predicate
 * below, so nothing is lost, it is only later.
 */
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityRow, VerificationRunRow } from "../../../db/schema.js";
import { type Repositories, repositories, withTransaction } from "../../repositories/index.js";
import type { VerificationRunView } from "../../shared/api-views.js";
import { type FieldDiff, fieldDiff, isMatched } from "../../shared/field-diff.js";
import { detectBotChallenge, detectSoftNotFound, extractPage } from "../../shared/html-extract.js";
import { badRequest, notFound } from "../../shared/http-error.js";
import { type AuditActor, SYSTEM_ACTOR } from "../audit/audit.service.js";
import type { JobResult } from "../jobs/types.js";
import {
  type FetchedSource,
  SourceFetchError,
  type SourceTransport,
  fetchSource,
} from "./fetcher.service.js";
import { HOST_MIN_GAP_MS, HostPacer, type PacerClock } from "./host-pacer.js";

/** How many source fetches may be in flight at once. Politeness, and a bound on sockets. */
const CONCURRENCY = 2;

/** The snapshot column's budget. `html-extract` caps the text it returns at the same number. */
export const SNAPSHOT_TEXT_LIMIT = 200_000;

export interface VerificationOptions {
  config?: AppConfig;
  /** Injected by the fixture suites; a deployment uses the pinning transport. */
  transport?: SourceTransport;
  /** Injected so the backfill's per-host spacing can be tested without spending the seconds. */
  clock?: PacerClock;
}

export class VerificationService {
  private readonly config: AppConfig;
  private readonly repos: Repositories;
  private readonly transport: SourceTransport | undefined;
  private readonly clock: PacerClock | undefined;
  /** Ids waiting for a submit-time check. Bounded by `VERIFY_QUEUE_MAX`; overflow drops to cron. */
  private readonly queue: number[] = [];
  private active = 0;

  constructor(
    private readonly db: DB = defaultDb,
    options: VerificationOptions = {},
  ) {
    this.config = options.config ?? defaultConfig;
    this.transport = options.transport;
    this.clock = options.clock;
    this.repos = repositories(db);
  }

  /** Waiting plus in flight — what a test asserts against `VERIFY_QUEUE_MAX`. */
  get queueDepth(): number {
    return this.queue.length + this.active;
  }

  /**
   * Ask for a submit-time check, and accept being told no.
   *
   * Fire-and-forget by design: the submission has already been stored and answered, and a source
   * fetch is a network round trip to a site nobody here controls. When the queue is full this does
   * nothing at all — the entry stays in `pendingIds`'s predicate, and the nightly backfill takes it.
   */
  enqueue(opportunityId: number): void {
    if (!this.config.verification.enabled) return;
    if (this.queue.length >= this.config.verification.queueMax) return;
    if (this.queue.includes(opportunityId)) return;
    this.queue.push(opportunityId);
    this.pump();
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) return;
      this.active++;
      void this.verify(id, SYSTEM_ACTOR)
        .catch(() => {
          // A failed check already wrote its own run row where it could. Nothing here can be
          // reported to anyone — the response went out long ago.
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  /**
   * Check one entry now, and record what happened.
   *
   * Throws only for the two things that are not a run: an entry that does not exist, and one with
   * no `applicationUrl` to fetch. Everything else — a refused address, a timeout, a 404, a page
   * about something else — is a recorded run and a returned view.
   */
  async verify(
    opportunityId: number,
    actor: AuditActor = SYSTEM_ACTOR,
  ): Promise<VerificationRunView> {
    return (await this.verifyOnce(opportunityId, actor)).view;
  }

  /**
   * The same check, plus whether the verdict was APPLIED to the entry.
   *
   * The backfill needs that second half and a caller of the route does not: `processed` must count
   * rows this pass actually settled, or a job that only met dead hosts would report progress and the
   * runner would go round again over the very same selection.
   */
  private async verifyOnce(
    opportunityId: number,
    actor: AuditActor,
    pacer?: HostPacer,
  ): Promise<{ view: VerificationRunView; applied: boolean; pacedMs: number }> {
    const row = await this.loadRow(opportunityId);
    const url = row.applicationUrl?.trim();
    if (!url) {
      throw badRequest(
        "no_application_url",
        `${JSON.stringify(row.publicId)} carries no \`applicationUrl\`, so there is nothing to check it against.`,
      );
    }

    // POLITENESS, and only where a queue exists to be polite with: the backfill passes a pacer, so
    // fifty entries under one foundation's domain are fetched a second apart instead of as fast as
    // that domain can answer. A reviewer pressing "verify" passes none — making one interactive
    // check wait on an unrelated batch's reservations would be politeness charged to the wrong
    // person, and one request is not a crawl.
    const pacedMs = pacer ? await pacer.wait(url) : 0;

    // OUTSIDE any transaction. A source fetch is a network round trip to a stranger's server and
    // must never be what holds a database transaction open.
    let fetched: FetchedSource | undefined;
    let failure: SourceFetchError | undefined;
    try {
      fetched = await fetchSource(url, {
        timeoutMs: this.config.verification.timeoutMs,
        maxBytes: this.config.verification.maxBytes,
        allowPrivateHosts: this.config.verification.allowPrivateHosts,
        transport: this.transport,
      });
    } catch (error) {
      failure =
        error instanceof SourceFetchError
          ? error
          : new SourceFetchError(
              error instanceof Error ? error.message : String(error),
              "transport_failure",
              url,
            );
    }

    const assessed = fetched ? assess(row, fetched) : undefined;
    // WHETHER THIS RUN IS AN ANSWER ABOUT THE ENTRY, or only about the network in the last ten
    // seconds. See `isTransientFailure` — a timeout is not a verdict, and must not retire the row.
    const transient = assessed === undefined && isTransientFailure(failure);
    const now = new Date();

    return withTransaction(this.db, async (repos) => {
      // COMPARE-AND-SET AGAINST THE ROW THIS VERDICT IS ABOUT.
      //
      // The fetch above is a network round trip, and a `PUT` landing during it replaces the very
      // content the verdict was computed from. Applying it anyway is worse than doing nothing: it
      // stamps `verified_at` LATER than the edit's `updated_at`, and the backfill predicate is
      // `verified_at < updated_at`, so the new content is marked current and never re-checked. The
      // record would then claim, permanently, that a page corroborates text it never saw.
      //
      // So the row is re-read under a lock and the verdict is applied only if nothing moved:
      // `updated_at` unchanged and the URL still the one that was fetched. Otherwise the RUN IS
      // STILL RECORDED — a fetch happened and its result is evidence — flagged stale, and the
      // opportunity is left exactly as it is, which leaves it in the predicate for the next pass.
      const current = await repos.opportunities.lockById(row.id);
      const stale =
        current === undefined ||
        current.updatedAt.getTime() !== row.updatedAt.getTime() ||
        (current.applicationUrl?.trim() ?? null) !== url;

      // SKIP-UNCHANGED. The previous run's digest is over the same raw bytes this one just read, so
      // an equal digest means the page has not moved a byte since the last check. The run is still
      // written and the assessment still recomputed — the RECORD may have changed even though the
      // page did not, and the diff is against both — but the run is marked as carrying nothing new,
      // which is what a reviewer comparing two checks actually wants to know.
      //
      // The snapshot text is COPIED FORWARD rather than left null. Retention deletes older runs
      // (`pruneToLatest`), so a run whose text lived only on a pruned ancestor would carry a digest
      // of bytes nobody stores any more — the snapshot of record has to be on the row that claims
      // it. Nothing is re-fetched to do this; it is the row already in front of us.
      const previous = fetched ? await repos.verificationRuns.latest(row.id) : undefined;
      const unchanged =
        fetched !== undefined &&
        previous?.snapshotSha256 != null &&
        previous.snapshotSha256 === fetched.sha256;

      const failureText = failure ? `${failure.category}: ${failure.message}` : null;
      const transientText = transient
        ? "not_a_verdict: the source could not be reached, so the previous verdict stands and the entry stays owed a check"
        : null;
      const staleText = stale
        ? "stale_result: the entry changed while its source was being fetched, so this verdict was recorded but not applied"
        : null;

      const run = await repos.verificationRuns.insert({
        opportunityId: row.id,
        runAt: now,
        requestedUrl: url,
        finalUrl: fetched?.finalUrl ?? failure?.url ?? null,
        httpStatus: fetched?.status ?? failure?.status ?? null,
        existsAtSource: assessed?.existsAtSource ?? false,
        extracted: assessed
          ? {
              ...assessed.extracted,
              ...(unchanged
                ? { snapshotUnchanged: true, snapshotUnchangedSince: previous?.runAt.toISOString() }
                : {}),
            }
          : null,
        fieldDiff: (assessed?.diff ?? null) as Record<string, unknown> | null,
        matched: assessed?.matched ?? false,
        snapshotText: unchanged
          ? (previous?.snapshotText ?? assessed?.snapshotText ?? null)
          : (assessed?.snapshotText ?? null),
        snapshotSha256: fetched?.sha256 ?? null,
        error:
          [staleText, transientText, failureText].filter((part) => part !== null).join(" — ") ||
          null,
      });
      if (!run) throw new Error(`failed to record a verification run for ${row.publicId}`);

      const matched = assessed?.matched ?? false;
      const applied = !stale && !transient;
      if (applied) {
        await repos.opportunities.applyVerification(row.id, {
          verifiedAgainstSource: matched,
          verifiedAt: now,
          // A SUCCESSFUL check is a "still real" signal and resets the staleness clock. A failed
          // one is the opposite of evidence, so it deliberately does not — but it must not
          // regress the clock either: this update does not touch `updatedAt`, so a second
          // overlapping run's staleness check (above) cannot detect a `lastSeenAt` some OTHER
          // run committed in between. Write back the LOCKED row's value, never the pre-fetch
          // snapshot, or a failed run finishing after a concurrent successful one silently
          // reverts it. (`current` is always defined here: `stale` is true whenever it is not.)
          lastSeenAt: matched ? now : (current?.lastSeenAt ?? row.lastSeenAt),
        });
      }

      await repos.audit.record({
        ...actor,
        subjectKind: "opportunity",
        subjectId: row.id,
        action: "verify_source",
        patch: applied
          ? {
              verifiedAgainstSource: { before: row.verifiedAgainstSource, after: matched },
              url,
              finalUrl: fetched?.finalUrl ?? null,
              httpStatus: fetched?.status ?? failure?.status ?? null,
              ...(failure ? { error: failure.category } : {}),
            }
          : {
              // No before/after pair in either case: nothing about the entry changed, and a trail
              // that implied otherwise would be the same lie the update itself would have been.
              ...(stale
                ? {
                    discarded: "stale_result",
                    reason: "the entry changed while its source was being fetched",
                  }
                : {
                    discarded: "transient_fetch_failure",
                    reason: "the source could not be reached, so no verdict was applied",
                    error: failure?.category ?? "unknown",
                  }),
              url,
            },
      });

      return { view: toRunView(run), applied, pacedMs };
    });
  }

  // ── the backfill job's entry point ─────────────────────────────────────────────
  /**
   * Check the entries owed a look — never checked, edited since, or checked longer ago than
   * `VERIFY_RECHECK_DAYS` — up to `limit`, then prune the run log of the ones it touched.
   *
   * `limit` IS A NIGHTLY CAP, not a page size. The TTL clause means the predicate now matches the
   * whole corpus on a rolling schedule rather than draining to nothing, so something has to bound
   * one invocation's wall clock and its outbound traffic; `VERIFY_NIGHTLY_LIMIT` (500) is it, and
   * `--limit` overrides it for an operator draining a backlog by hand. The selection is ordered
   * never-checked first, so the cap drops re-checks before it drops anything unexamined.
   *
   * `processed` counts entries this pass SETTLED. A run whose fetch failed transiently, and a run
   * whose entry was edited underneath it, are both recorded and both deliberately excluded — the
   * runner's `processed > 0` rule is what stops it looping over a selection it cannot retire.
   */
  async runBatch(options: { limit?: number } = {}): Promise<JobResult> {
    if (!this.config.verification.enabled) {
      return { processed: 0, remaining: 0, skipped: "verification is disabled" };
    }
    const limit = options.limit ?? this.config.verification.nightlyLimit;
    const ids = await this.pendingIds(limit);
    // ONE PACER FOR THE WHOLE PASS, so the spacing is between this run's fetches rather than
    // between each entry and itself. A seeded corpus clusters by host, and that clustering is the
    // only reason this exists.
    const pacer = new HostPacer(HOST_MIN_GAP_MS, this.clock);
    let processed = 0;
    let unsettled = 0;
    let pacedMs = 0;
    for (const id of ids) {
      try {
        const outcome = await this.verifyOnce(id, SYSTEM_ACTOR, pacer);
        pacedMs += outcome.pacedMs;
        if (outcome.applied) processed++;
        else unsettled++;
      } catch {
        // One unverifiable entry must not end the batch.
        unsettled++;
      }
    }
    return {
      processed,
      remaining: await this.pendingCount(),
      details: {
        selected: ids.length,
        unsettled,
        // What the politeness cost, so a pass that took an hour can be attributed to the spacing
        // or to the sites rather than guessed at.
        pacedMs,
        pruned: await this.pruneRuns(ids),
      },
    };
  }

  /**
   * RETENTION, run AFTER the batch over exactly the entries it touched.
   *
   * Scoped rather than a whole-table sweep for two reasons: a sweep would be a second job pretending
   * to be this one, scanning rows this pass has no reason to look at; and runs are APPENDED here and
   * nowhere else, so pruning what this pass just appended to is enough to keep the log bounded.
   *
   * Exposed as its own method so the retention rule can be driven — and tested — without an
   * unscoped batch selecting every entry in the database.
   */
  async pruneRuns(opportunityIds: number[]): Promise<number> {
    return this.repos.verificationRuns.pruneToLatest(
      opportunityIds,
      this.config.verification.runsKeep,
    );
  }

  /**
   * The selection, never-checked first: has a URL, and has either never been checked, been edited
   * since it last was, or not been checked for `VERIFY_RECHECK_DAYS`.
   */
  async pendingIds(limit: number, now: Date = new Date()): Promise<number[]> {
    return this.repos.opportunities.listPendingVerificationIds(limit, this.recheckBefore(now));
  }

  async pendingCount(now: Date = new Date()): Promise<number> {
    return this.repos.opportunities.countPendingVerification(this.recheckBefore(now));
  }

  /** The TTL cutoff: a `verified_at` older than this is owed another look. */
  private recheckBefore(now: Date): Date {
    return new Date(now.getTime() - this.config.verification.recheckDays * 86_400_000);
  }

  private async loadRow(opportunityId: number): Promise<OpportunityRow> {
    const row = await this.repos.opportunities.findById(opportunityId);
    if (!row) throw notFound(`no opportunity ${opportunityId}.`);
    return row;
  }

  /** Resolve a public id to the row id, for the routes that name an entry the way callers do. */
  async resolvePublicId(publicId: string): Promise<OpportunityRow> {
    const row = await this.repos.opportunities.findByPublicId(publicId);
    if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    return row;
  }
}

/**
 * Fetch failures that say something about the NETWORK rather than about the entry.
 *
 * A run in this set is recorded — it is still "we tried and this is what happened" — but it does not
 * stamp `verified_at`, does not overwrite `verified_against_source`, and leaves the entry owed a
 * check. WHY THAT MATTERS: with the re-check TTL, stamping on a timeout would not merely mislabel a
 * run, it would suppress the entry for `VERIFY_RECHECK_DAYS`; and since only a MATCHED check
 * refreshes `last_seen_at`, three consecutive suppressed months are exactly the ninety days after
 * which `staleness` closes a rolling entry as inactive. A resolver hiccup would close listings.
 *
 * Everything NOT in this set is a verdict about the entry and does stamp `verified_at`, including
 * the refusals: `scheme_not_allowed`, `address_refused:*`, `content_type_not_allowed` and the
 * redirect failures are all facts about the URL a submitter supplied, and re-fetching them nightly
 * would learn nothing. So is any HTTP response at all — a 404 is an answer, not an outage.
 *
 * THE TRADE-OFF, stated because it is real: a domain that has genuinely stopped resolving stays in
 * the selection forever, at the head of it (never-checked and never-stamped sort first). The nightly
 * cap bounds what that costs — a DNS refusal is cheap and there are only ever so many of them — and
 * `staleness` closes such an entry at ninety days on its own, since nothing is refreshing its
 * `last_seen_at`. Retrying a dead host is the price of not retiring a live one during an outage.
 */
const TRANSIENT_FETCH_FAILURES = new Set(["timeout", "transport_failure", "dns_failure"]);

function isTransientFailure(failure: SourceFetchError | undefined): boolean {
  return failure !== undefined && TRANSIENT_FETCH_FAILURES.has(failure.category);
}

interface Assessment {
  existsAtSource: boolean;
  matched: boolean;
  diff: FieldDiff;
  extracted: Record<string, unknown>;
  snapshotText: string;
}

/**
 * Everything derived from a fetched page: what it says it is, whether it is really there, and how
 * it compares to the record.
 *
 * `exists_at_source` is 2xx AND not a soft 404, because sites answer 200 for a deleted programme
 * far more often than they answer 404 — status alone would mark half the dead links verified. WHICH
 * heuristic fired is recorded, since a heuristic whose reasoning is invisible is one a reviewer has
 * to take on faith.
 */
function assess(row: OpportunityRow, fetched: FetchedSource): Assessment {
  const page = extractPage(fetched.text, { textLimit: SNAPSHOT_TEXT_LIMIT });
  const soft = detectSoftNotFound(page);
  const challenge = detectBotChallenge(page);
  const ok = fetched.status >= 200 && fetched.status < 300;
  const existsAtSource = ok && !soft.suspected;

  const diff = fieldDiff(
    {
      title: row.title,
      deadlines: row.deadlines,
      minAward: numeric(row.minAward),
      maxAward: numeric(row.maxAward),
      budget: numeric(row.budget),
      operatingOrganizations: row.operatingOrganizations,
    },
    { title: page.title, ogTitle: page.ogTitle, text: page.text },
    { requested: fetched.requestedUrl, final: fetched.finalUrl },
  );

  return {
    existsAtSource,
    matched: isMatched(existsAtSource, diff),
    diff,
    extracted: {
      title: page.title ?? null,
      ogTitle: page.ogTitle ?? null,
      description: page.description ?? null,
      meta: page.meta,
      // Read, never evaluated and never merged into a record: at worst it is noise in a diff.
      // Capped because a page can publish an arbitrarily large block and this column is not storage.
      jsonLd: page.jsonLd.slice(0, 5),
      contentType: fetched.contentType,
      truncated: fetched.truncated,
      redirects: fetched.redirects,
      softNotFound: soft.suspected,
      ...(soft.heuristic ? { softNotFoundHeuristic: soft.heuristic } : {}),
      automatedCheckBlocked: challenge.suspected,
      ...(challenge.heuristic ? { automatedCheckBlockedHeuristic: challenge.heuristic } : {}),
    },
    snapshotText: page.text.slice(0, SNAPSHOT_TEXT_LIMIT),
  };
}

/** `numeric` columns arrive as strings; the diff compares numbers. */
function numeric(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toRunView(run: VerificationRunRow): VerificationRunView {
  return {
    runAt: run.runAt.toISOString(),
    requestedUrl: run.requestedUrl,
    finalUrl: run.finalUrl,
    httpStatus: run.httpStatus,
    existsAtSource: run.existsAtSource,
    matched: run.matched,
    fieldDiff: run.fieldDiff,
    extracted: run.extracted,
    snapshotSha256: run.snapshotSha256,
    error: run.error,
  };
}

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
 * and silence is indistinguishable from never having checked.
 *
 * THE SUBMIT-TIME QUEUE IS BOUNDED, AND THE BOUND IS THE BACKLOG, NOT THE PARALLELISM. A
 * concurrency limit of 2 caps how many fetches run at once; it does nothing about a submitter
 * queueing ten thousand. So the queue itself has a ceiling (`VERIFY_QUEUE_MAX`) and, when it is
 * full, the submit-time trigger is simply SKIPPED — the entry still satisfies the cron predicate
 * below, so nothing is lost, it is only later.
 */
import { and, asc, count, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type OpportunityRow, opportunities, verificationRuns } from "../../../db/schema.js";
import type { VerificationRunView } from "../../shared/api-views.js";
import { type FieldDiff, fieldDiff, isMatched } from "../../shared/field-diff.js";
import { detectSoftNotFound, extractPage } from "../../shared/html-extract.js";
import { badRequest, notFound } from "../../shared/http-error.js";
import { type AuditActor, AuditService, SYSTEM_ACTOR } from "../audit/audit.service.js";
import {
  type FetchedSource,
  SourceFetchError,
  type SourceTransport,
  fetchSource,
} from "./fetcher.service.js";

/** How many source fetches may be in flight at once. Politeness, and a bound on sockets. */
const CONCURRENCY = 2;

/** The snapshot column's budget. `html-extract` caps the text it returns at the same number. */
export const SNAPSHOT_TEXT_LIMIT = 200_000;

export interface VerificationOptions {
  config?: AppConfig;
  /** Injected by the fixture suites; a deployment uses the pinning transport. */
  transport?: SourceTransport;
}

export class VerificationService {
  private readonly config: AppConfig;
  private readonly audit: AuditService;
  private readonly transport: SourceTransport | undefined;
  /** Ids waiting for a submit-time check. Bounded by `VERIFY_QUEUE_MAX`; overflow drops to cron. */
  private readonly queue: number[] = [];
  private active = 0;

  constructor(
    private readonly db: DB = defaultDb,
    options: VerificationOptions = {},
  ) {
    this.config = options.config ?? defaultConfig;
    this.transport = options.transport;
    this.audit = new AuditService(db);
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
    const row = await this.loadRow(opportunityId);
    const url = row.applicationUrl?.trim();
    if (!url) {
      throw badRequest(
        "no_application_url",
        `${JSON.stringify(row.publicId)} carries no \`applicationUrl\`, so there is nothing to check it against.`,
      );
    }

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
    const now = new Date();

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(verificationRuns)
        .values({
          opportunityId: row.id,
          runAt: now,
          requestedUrl: url,
          finalUrl: fetched?.finalUrl ?? failure?.url ?? null,
          httpStatus: fetched?.status ?? failure?.status ?? null,
          existsAtSource: assessed?.existsAtSource ?? false,
          extracted: assessed?.extracted ?? null,
          fieldDiff: (assessed?.diff ?? null) as Record<string, unknown> | null,
          matched: assessed?.matched ?? false,
          snapshotText: assessed?.snapshotText ?? null,
          snapshotSha256: fetched?.sha256 ?? null,
          error: failure ? `${failure.category}: ${failure.message}` : null,
        })
        .returning();
      const run = inserted[0];
      if (!run) throw new Error(`failed to record a verification run for ${row.publicId}`);

      const matched = assessed?.matched ?? false;
      await tx
        .update(opportunities)
        .set({
          verifiedAgainstSource: matched,
          verifiedAt: now,
          // A SUCCESSFUL check is a "still real" signal and resets the staleness clock. A failed one
          // is the opposite of evidence, so it deliberately does not.
          lastSeenAt: matched ? now : row.lastSeenAt,
        })
        .where(eq(opportunities.id, row.id));

      await this.audit.record(tx, {
        ...actor,
        subjectKind: "opportunity",
        subjectId: row.id,
        action: "verify_source",
        patch: {
          verifiedAgainstSource: { before: row.verifiedAgainstSource, after: matched },
          url,
          finalUrl: fetched?.finalUrl ?? null,
          httpStatus: fetched?.status ?? failure?.status ?? null,
          ...(failure ? { error: failure.category } : {}),
        },
      });

      return toRunView(run);
    });
  }

  // ── the backfill job's entry point ─────────────────────────────────────────────
  /**
   * Check every entry whose source has not been looked at since it last changed, up to `limit`.
   *
   * A CURSOR job: the run retires the rows it selects (it stamps `verified_at`), so `remaining`
   * decreases and the runner may loop to zero. NO QUEUE TABLE — the predicate below IS the queue,
   * which is also why the submit-time trigger can drop work without losing it.
   */
  async runBatch(options: { limit?: number } = {}): Promise<{
    processed: number;
    remaining: number;
    skipped?: string;
  }> {
    if (!this.config.verification.enabled) {
      return { processed: 0, remaining: 0, skipped: "verification is disabled" };
    }
    const limit = options.limit ?? 25;
    const ids = await this.pendingIds(limit);
    let processed = 0;
    for (const id of ids) {
      try {
        await this.verify(id, SYSTEM_ACTOR);
        processed++;
      } catch {
        // One unverifiable entry must not end the batch.
      }
    }
    return { processed, remaining: await this.pendingCount() };
  }

  /**
   * The selection predicate, in one place: has a URL, and has either never been checked or has been
   * edited since it last was.
   */
  private stalePredicate() {
    return and(
      isNotNull(opportunities.applicationUrl),
      isNull(opportunities.mergedIntoId),
      or(
        isNull(opportunities.verifiedAt),
        sql`${opportunities.verifiedAt} < ${opportunities.updatedAt}`,
      ),
    );
  }

  async pendingIds(limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(this.stalePredicate())
      .orderBy(asc(opportunities.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(opportunities)
      .where(this.stalePredicate());
    return rows[0]?.value ?? 0;
  }

  private async loadRow(opportunityId: number): Promise<OpportunityRow> {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunityId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound(`no opportunity ${opportunityId}.`);
    return row;
  }

  /** Resolve a public id to the row id, for the routes that name an entry the way callers do. */
  async resolvePublicId(publicId: string): Promise<OpportunityRow> {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    return row;
  }
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

export function toRunView(run: typeof verificationRuns.$inferSelect): VerificationRunView {
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

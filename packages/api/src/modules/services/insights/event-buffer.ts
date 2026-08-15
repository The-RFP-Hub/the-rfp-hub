/**
 * The in-process analytics buffer: batch the events, write them on a timer, and drain on shutdown.
 *
 * WHY BUFFER AT ALL. A list request that returns twenty entries records twenty events. Writing them
 * inline would put twenty INSERTs on the critical path of a public read — the traffic this project
 * exists to serve — to produce a number a dashboard already labels best-effort. So capture is a
 * push onto an array, and the array is written in one statement every couple of seconds.
 *
 * THIS IS BEST-EFFORT AND SAYS SO. A crash loses whatever is buffered. That trade is deliberate and
 * it is stated in the docs and on the dashboard rather than implied by a number that looks exact:
 * the alternative is either an inline write on every read, or an outbox with its own delivery
 * problem, and neither is worth it for a view count.
 *
 * PUBLIC IDS, NOT ROW IDS. Capture happens in the controllers, where what exists is the public id
 * the caller asked for; the row id is resolved here, in bulk, at flush time. That keeps the capture
 * call free of a database round trip AND means an entry deleted between capture and flush simply
 * drops out instead of failing the insert on its foreign key.
 *
 * ORDERING ON SHUTDOWN IS LOAD-BEARING. Fastify runs `onClose` hooks LIFO, so the flush hook has to
 * be registered AFTER the pool-closing hook to run BEFORE it — see `buildApp`, where both are
 * registered in one place precisely so the order is a decision rather than an accident.
 */
import { inArray } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityEventInsert,
  opportunities,
  opportunityEvents,
} from "../../../db/schema.js";

export type AnalyticsEventType = "list_view" | "detail_view" | "source_click" | "apply_click";

export interface AnalyticsEventInput {
  /** The public id, because that is what a controller has. Resolved to a row id at flush. */
  publicId: string;
  eventType: AnalyticsEventType;
  occurredAt: Date;
  sessionHash: string | null;
  ipHash: string | null;
  /** HOST only. A full referring URL is a page somebody was reading. */
  referrer: string | null;
}

export interface EventBufferOptions {
  flushIntervalMs?: number;
  flushSize?: number;
  /**
   * A hard ceiling on the buffer.
   *
   * Without one, a database that has stopped accepting writes turns a bounded memory cost into an
   * unbounded one: every request keeps appending and nothing ever drains. At the cap the OLDEST
   * events are dropped — recent traffic is the more useful half of an approximate count.
   */
  maxPending?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_FLUSH_SIZE = 100;
const DEFAULT_MAX_PENDING = 10_000;

export class AnalyticsEventBuffer {
  private pending: AnalyticsEventInput[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<number> | undefined;
  private closed = false;
  private readonly flushIntervalMs: number;
  private readonly flushSize: number;
  private readonly maxPending: number;
  /** Events dropped at the cap, so a health check can say the count is understated. */
  dropped = 0;

  constructor(
    private readonly db: DB = defaultDb,
    options: EventBufferOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushSize = options.flushSize ?? DEFAULT_FLUSH_SIZE;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  get depth(): number {
    return this.pending.length;
  }

  /** Buffer some events. Never awaits, never throws — a read must not fail because of a metric. */
  record(events: AnalyticsEventInput[]): void {
    if (this.closed || events.length === 0) return;
    for (const event of events) {
      if (this.pending.length >= this.maxPending) {
        this.pending.shift();
        this.dropped++;
      }
      this.pending.push(event);
    }
    if (this.pending.length >= this.flushSize) {
      void this.flush();
      return;
    }
    this.arm();
  }

  /** One timer at a time, and it never holds the process open on its own. */
  private arm(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  /**
   * Write everything buffered. Safe to call concurrently — a second call joins the first.
   *
   * A failed write DISCARDS the batch rather than retrying it. Retrying would mean holding the
   * events while the same failure repeats, which is how a buffer with a cap becomes a buffer that
   * only ever holds the same doomed batch.
   */
  async flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    const batch = this.pending;
    if (batch.length === 0) return 0;
    this.pending = [];

    this.flushing = (async () => {
      try {
        const ids = await this.resolveIds(batch.map((event) => event.publicId));
        const rows: OpportunityEventInsert[] = [];
        for (const event of batch) {
          const opportunityId = ids.get(event.publicId);
          if (opportunityId === undefined) continue;
          rows.push({
            opportunityId,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            sessionHash: event.sessionHash,
            ipHash: event.ipHash,
            referrer: event.referrer,
          });
        }
        if (rows.length === 0) return 0;
        await this.db.insert(opportunityEvents).values(rows);
        return rows.length;
      } catch {
        // Best-effort, and labelled as such everywhere it is served.
        return 0;
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private async resolveIds(publicIds: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(publicIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: opportunities.id, publicId: opportunities.publicId })
      .from(opportunities)
      .where(inArray(opportunities.publicId, unique));
    return new Map(rows.map((row) => [row.publicId, row.id]));
  }

  /** Stop accepting, cancel the timer, drain once. Registered as the app's `onClose` flush. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  /** Reopen after a close — the integration suites build several apps in one process. */
  reopen(): void {
    this.closed = false;
  }
}

/**
 * The process-wide buffer the controllers push to.
 *
 * A singleton for the same reason the pg pool is one: it is a shared resource with a lifecycle, and
 * two of them would mean two timers and two half-drained batches on shutdown.
 */
export const analyticsEvents = new AnalyticsEventBuffer();

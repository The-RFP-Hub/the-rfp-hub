/**
 * The analytics buffer's scheduling, with the database faked and the flush held open on purpose.
 *
 * The interesting states of this component are all TIMING states — what happens to events that
 * arrive while a write is in flight — and none of them needs a database to reach. A fake handle
 * that resolves when the test says so makes "a burst landed mid-flush" an ordinary assertion
 * instead of a sleep.
 */
import { describe, expect, it } from "vitest";
import type { DB } from "../../src/db/client.js";
import {
  AnalyticsEventBuffer,
  type AnalyticsEventInput,
} from "../../src/modules/services/insights/event-buffer.js";

/** A promise the test resolves by hand, so a flush can be held open across other calls. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

interface FakeDb {
  db: DB;
  /** Every row handed to `insert().values()`, in order. */
  written: { opportunityId: number }[];
  /** One gate per flush, in call order. A flush blocks until its gate is opened. */
  gates: { promise: Promise<void>; open: () => void }[];
  /** Resolves once `count` flushes have STARTED. */
  started(count: number): Promise<void>;
}

/**
 * A handle shaped like the two calls the buffer makes and nothing else.
 *
 * `select().from().where()` and `insert().values()` are both awaited directly — drizzle's builders
 * are thenables — so an async function in each terminal position is a faithful stand-in.
 */
function fakeDb(): FakeDb {
  const written: { opportunityId: number }[] = [];
  const gates: { promise: Promise<void>; open: () => void }[] = [];
  let starts = 0;
  let announce = (): void => {};

  const state: FakeDb = {
    written,
    gates,
    started: (count) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (starts >= count) resolve();
        };
        announce = check;
        check();
      }),
    db: {
      // Every public id resolves to a row id derived from it, so nothing is dropped for being
      // unknown — this test is about scheduling, not about resolution.
      select: () => ({
        from: () => ({
          where: async () => [
            { id: 1, publicId: "ns:one" },
            { id: 2, publicId: "ns:two" },
          ],
        }),
      }),
      insert: () => ({
        values: async (rows: { opportunityId: number }[]) => {
          const own = gate();
          gates.push(own);
          starts++;
          announce();
          await own.promise;
          written.push(...rows);
        },
      }),
    } as unknown as DB,
  };
  return state;
}

const event = (publicId: string): AnalyticsEventInput => ({
  publicId,
  eventType: "detail_view",
  occurredAt: new Date("2026-08-14T00:00:00.000Z"),
  sessionHash: null,
  ipHash: null,
  referrer: null,
});

describe("the analytics event buffer's flush scheduling", () => {
  it("writes a burst that arrives while an earlier flush is still in flight", async () => {
    const fake = fakeDb();
    // A long interval, so nothing here can pass by accident on the ordinary timer.
    const buffer = new AnalyticsEventBuffer(fake.db, {
      flushSize: 2,
      flushIntervalMs: 60_000,
    });

    buffer.record([event("ns:one"), event("ns:two")]);
    await fake.started(1);
    expect(buffer.depth).toBe(0);

    // THE BUG THIS COVERS: a full batch arriving now joins the in-flight promise, which is
    // already writing a different batch. Nothing schedules a writer for these two, so before the
    // fix they sat in memory until unrelated traffic happened to arm a timer — and if traffic
    // stopped, forever.
    buffer.record([event("ns:one"), event("ns:two")]);
    expect(buffer.depth).toBe(2);

    fake.gates[0]?.open();
    await fake.started(2);
    fake.gates[1]?.open();
    // Let the second write settle.
    await buffer.flush();

    expect(fake.written).toHaveLength(4);
    expect(buffer.depth).toBe(0);
    await buffer.close();
  });

  it("drains everything on close, including what arrived during the flush it joined", async () => {
    const fake = fakeDb();
    const buffer = new AnalyticsEventBuffer(fake.db, {
      flushSize: 2,
      flushIntervalMs: 60_000,
    });

    buffer.record([event("ns:one"), event("ns:two")]);
    await fake.started(1);
    buffer.record([event("ns:one")]);
    expect(buffer.depth).toBe(1);

    // `close()` joins the flush that is already running; a single flush would return there and
    // leave the third event unwritten. It drains instead.
    const closing = buffer.close();
    fake.gates[0]?.open();
    await fake.started(2);
    fake.gates[1]?.open();
    await closing;

    expect(fake.written).toHaveLength(3);
    expect(buffer.depth).toBe(0);
  });
});

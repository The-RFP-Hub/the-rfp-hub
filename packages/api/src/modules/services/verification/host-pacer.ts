/**
 * Politeness, in the only form this service can honestly offer: a minimum gap between two fetches
 * to the SAME host.
 *
 * The nightly backfill walks up to `VERIFY_NIGHTLY_LIMIT` entries in one pass, and a seeded corpus
 * clusters hard by host — dozens of programmes published by one foundation, all under one domain.
 * Serial fetching alone does not fix that: a fast server answering in 40 ms means fifty requests in
 * two seconds, which is indistinguishable from a scraper at the other end and is how a verifier
 * earns a block that then reads back as "every entry from this publisher stopped matching".
 *
 * EVERY HOP IS PACED, NOT EVERY ENTRY. `fetchSource` follows redirects by hand, and a corpus is
 * full of vanity domains that redirect to one grants platform. Pacing only the URL stored on the
 * entry would space thirty requests to thirty vanity hosts perfectly and land thirty requests on
 * the platform behind them in the same second — the exact burst this exists to prevent, aimed at
 * the one host that actually serves the pages. So the pacer is handed to `fetchSource` as its
 * `onHop` hook and consulted before EACH hop.
 *
 * IN-PROCESS AND PER-RUN, deliberately. A shared token bucket in the database would be a second
 * piece of distributed state to keep correct for a job that already runs one at a time under an
 * advisory lock (`jobs/lock.ts`), and the thing being defended against is one pass hammering one
 * host, which is exactly what one process can see for itself.
 *
 * THE SLOT IS RESERVED BEFORE THE WAIT, not after it. Recording "last fetched at" when the fetch
 * returns lets two overlapping callers both read the same stale timestamp and both go immediately;
 * reserving the next free instant up front makes the gap hold however many callers are queued
 * against a host, which matters because the submit-time queue runs two at a time.
 */

/** The seam a fake clock replaces, so the spacing can be tested without spending the time. */
export interface PacerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One second between fetches to one host. Enough to be a visitor rather than a crawler. */
export const HOST_MIN_GAP_MS = 1_000;

/**
 * How many hosts are remembered before the map is swept. A pass over 500 entries can touch 500
 * hosts, and the reservations of hosts already free are dead weight; sweeping those is enough to
 * keep the map proportional to what is actually in flight.
 */
const SWEEP_ABOVE = 1_024;

export class HostPacer {
  /** Host → the earliest instant a fetch to it may start. */
  private readonly freeAt = new Map<string, number>();

  constructor(
    private readonly minGapMs: number = HOST_MIN_GAP_MS,
    private readonly clock: PacerClock = systemClock,
  ) {}

  /**
   * Hold the caller until this URL's host is free, then reserve the next slot.
   *
   * Returns how long it waited, which is what the job reports as `details.pacedMs` — an operator
   * looking at a pass that took an hour needs to know whether it was the sites or the politeness.
   */
  async wait(url: string): Promise<number> {
    const host = hostOf(url);
    if (host === undefined) return 0;

    const now = this.clock.now();
    const earliest = this.freeAt.get(host) ?? now;
    const waitMs = Math.max(0, earliest - now);
    this.freeAt.set(host, Math.max(now, earliest) + this.minGapMs);
    if (this.freeAt.size > SWEEP_ABOVE) this.sweep(now);
    if (waitMs > 0) await this.clock.sleep(waitMs);
    return waitMs;
  }

  private sweep(now: number): void {
    for (const [host, freeAt] of this.freeAt) {
      if (freeAt <= now) this.freeAt.delete(host);
    }
  }
}

/**
 * The host to space against — lowercased, port included — or `undefined` for anything this verifier
 * will never open a connection to.
 *
 * A port is part of the identity because two services on one machine are two servers.
 *
 * NOTHING THAT IS NOT `http(s)` IS PACED, and neither is a URL with no host at all. `file:`,
 * `mailto:` and `data:` all parse, and all yield an EMPTY host — so pacing them would file every
 * one of them under the same `""` slot and make a batch of ten such entries sleep nine seconds
 * before the fetcher refuses all ten without a packet leaving the process. Politeness is owed to
 * servers that are about to be asked for something; there is no server here.
 */
function hostOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.host === "" ? undefined : parsed.host.toLowerCase();
}

/**
 * The backfill's per-host spacing, against a FAKE CLOCK.
 *
 * A real clock would make this suite spend the very seconds the pacer exists to spend, which is
 * both slow and untestable at the boundaries: "did it wait 1000 ms or 997?" is a question about the
 * test runner rather than about the pacer. The clock seam answers it exactly.
 */
import { describe, expect, it } from "vitest";
import {
  type SourceTransport,
  fetchSource,
} from "../../src/modules/services/verification/fetcher.service.js";
import { HostPacer, type PacerClock } from "../../src/modules/services/verification/host-pacer.js";

/**
 * A clock that only moves when `sleep` is called, so every wait is recorded and none is spent.
 *
 * The advance happens in a MICROTASK rather than synchronously, and that detail is the whole
 * difference between the serial and the concurrent case. Real time does not jump forward the
 * instant one caller decides to sleep — a second caller reserving its slot in the same tick still
 * reads the old `now`. Advancing synchronously would hand that caller a clock from the future and
 * quietly turn the concurrency test into a second serial one.
 */
function fakeClock(): PacerClock & { readonly slept: number[]; readonly elapsed: number } {
  let time = 1_000_000;
  const slept: number[] = [];
  return {
    slept,
    get elapsed() {
      return time - 1_000_000;
    },
    now: () => time,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve().then(() => {
        time += ms;
      });
    },
  };
}

describe("HostPacer", () => {
  it("lets the first fetch to a host go immediately", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    expect(await pacer.wait("https://example.org/a")).toBe(0);
    expect(clock.slept).toEqual([]);
  });

  it("holds a second fetch to the SAME host for the full gap", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    await pacer.wait("https://example.org/a");
    expect(await pacer.wait("https://example.org/b")).toBe(1_000);
    expect(clock.slept).toEqual([1_000]);
  });

  it("does not hold a fetch to a different host", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    await pacer.wait("https://example.org/a");
    expect(await pacer.wait("https://other.example.net/a")).toBe(0);
    // …and the two hosts' reservations are independent, not one shared queue.
    expect(await pacer.wait("https://other.example.net/b")).toBe(1_000);
  });

  /**
   * The shape a clustered corpus actually has: twenty programmes under one foundation's domain, in
   * one pass. Nineteen gaps, not twenty, because the first request is free.
   */
  it("spaces a run of entries under one domain by the gap, once each", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    for (let i = 0; i < 20; i++) await pacer.wait(`https://programmes.example.org/p${i}`);
    expect(clock.slept).toHaveLength(19);
    expect(clock.elapsed).toBe(19_000);
  });

  /**
   * The reservation is taken BEFORE the wait, so two callers queued against one host serialise
   * behind each other instead of both reading the same "last fetched at" and both going at once.
   * The submit-time queue runs two fetches concurrently, which is exactly this case.
   */
  it("serialises concurrent callers against one host instead of letting them collide", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    const waits = await Promise.all([
      pacer.wait("https://example.org/a"),
      pacer.wait("https://example.org/b"),
      pacer.wait("https://example.org/c"),
    ]);
    expect(waits).toEqual([0, 1_000, 2_000]);
  });

  it("treats a port as part of the host, and does not pace a URL it cannot parse", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    await pacer.wait("https://example.org:8443/a");
    expect(
      await pacer.wait("https://example.org/a"),
      "a different port is a different server",
    ).toBe(0);
    // A URL that does not parse fails in the fetcher a moment later; sleeping for it would only
    // slow down the entries that can succeed.
    expect(await pacer.wait("not a url")).toBe(0);
  });

  /**
   * `file:`, `mailto:` and `data:` all PARSE, and all have an empty host — so a pacer that keyed on
   * `url.host` alone filed every one of them under the same `""` slot. Ten such entries in a batch
   * then slept nine seconds between refusals that never open a socket at all. Politeness is owed to
   * a server that is about to be asked for something, and there is no server in any of these.
   */
  it("never paces a scheme it will not fetch, or a URL with no host", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    for (const url of [
      "file:///etc/passwd",
      "file:///etc/shadow",
      "mailto:grants@example.org",
      "data:text/html,<h1>hi</h1>",
      "gopher://example.org/1",
    ]) {
      expect(await pacer.wait(url), url).toBe(0);
    }
    expect(clock.slept, "not one of them may cost the batch a second").toEqual([]);
  });

  /**
   * THE REDIRECT CASE, which pacing the entry's own URL alone gets exactly wrong. A corpus is full
   * of vanity domains — `grants-a.example.org`, `grants-b.example.org` — that all redirect to one
   * grants platform. Spacing only the requested host spaces the vanity hosts perfectly, one request
   * each, and lands every one of the redirected requests on the platform in the same instant.
   * Driven through `fetchSource`'s `onHop` seam, which is how the service wires the pacer in.
   */
  it("spaces the host a redirect lands on, not just the one the entry names", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    const PLATFORM = "https://platform.example.net/apply";
    const page = "<!doctype html><html><head><title>Apply</title></head><body>Hi.</body></html>";

    const transport: SourceTransport = async (url, options) => {
      // The real transport pauses here, once an address has passed its checks and just before the
      // socket. A fixture that skipped it would pass this test without pacing anything.
      await options.onHop?.(url);
      return url === PLATFORM
        ? {
            status: 200,
            headers: { "content-type": "text/html" },
            bytes: Buffer.from(page),
            truncated: false,
          }
        : {
            status: 302,
            headers: { location: PLATFORM },
            bytes: Buffer.alloc(0),
            truncated: false,
          };
    };

    for (const vanity of ["a", "b", "c"]) {
      await fetchSource(`https://grants-${vanity}.example.org/`, {
        transport,
        onHop: async (target) => {
          await pacer.wait(target);
        },
      });
    }

    // Three distinct vanity hosts: never spaced, one request each. The platform behind them: three
    // requests, so two gaps. Without per-hop pacing this would have been no gaps at all.
    expect(clock.slept).toEqual([1_000, 1_000]);
  });

  /**
   * A HOST THAT IS REFUSED IS OWED NOTHING. The pacer is called by the TRANSPORT, once an address
   * has been resolved, classified and pinned and immediately before the socket — not by
   * `fetchSource` before all of that. So a batch of entries pointing at loopback, the metadata
   * endpoint, or a name that does not resolve costs the run no time at all: there is no stranger's
   * server on the other end to be polite to, and sleeping between refusals would spend the batch's
   * budget on the entries that cannot succeed.
   *
   * Driven against the REAL transport, because the refusal being tested is a fact about a resolved
   * address and the fixture transport is exactly the layer that does not have one.
   */
  it("costs a batch nothing when the hosts are refused before any socket", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    const onHop = async (target: string) => {
      await pacer.wait(target);
    };

    for (const url of [
      "http://127.0.0.1:9/",
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:9/again",
    ]) {
      await expect(
        fetchSource(url, { allowPrivateHosts: false, onHop }),
        url,
      ).rejects.toMatchObject({ category: expect.stringContaining("address_refused") });
    }

    expect(clock.slept, "three refusals, and not one second spent on them").toEqual([]);
    expect(clock.elapsed).toBe(0);
  });

  /** Time really does pass between fetches, and the gap already elapsed is not waited out again. */
  it("does not re-wait a gap that has already gone by", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock);
    await pacer.wait("https://example.org/a");
    await clock.sleep(5_000);
    expect(await pacer.wait("https://example.org/b")).toBe(0);
  });
});

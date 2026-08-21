/**
 * Controlled fixture web server for the E2E suite's HTTP-layer verification tests.
 *
 * This is the "external" site the verifier fetches when a spec drives `POST
 * /v1/review/opportunities/:id/verify` (or the verification backfill job) against a fixture
 * opportunity's `applicationUrl`. It is deliberately dumb: every response is `text/html` (the
 * fetcher's allowed content type), nothing here talks to the API or the database, and every
 * inbound request is recorded so a spec can assert what the verifier actually sent — in
 * particular that it identifies itself with a distinct user agent and carries no cookie,
 * authorization or referer.
 *
 * Routes (see the E2E plan, Step 5, for the full rationale):
 *
 *   /programme/<runId>        200, the fixture entry's title / deadline / award range
 *   /programme/<runId>?v=2    200, the same page with a mutated body (page-change diff)
 *   /missing                  404
 *   /soft-404                 200, but the body reads as a not-found page
 *   /redirect-public          302 -> /programme/<runId>, a single hop
 *   /redirect-loop[/1..4]     302, cycling through 4 hops that never resolve to 200 — a
 *                             redirect-LIMIT fixture, not an address fixture; it stays on this
 *                             loopback-adjacent public server throughout
 *   /big                      200, chunked (no Content-Length), streaming well past a typical
 *                             VERIFY_MAX_BYTES cap — the reader must enforce the cap by counting
 *                             bytes actually read, not by trusting a header
 *
 * `/redirect-private` is deliberately NOT implemented here: with SSRF protection enabled, the
 * first hop to a private address (127.0.0.1, link-local, etc.) is refused before any request is
 * made, so a fixture route could never exercise anything a unit/integration test doesn't already
 * cover more directly. That case belongs at the INT layer, against the real fetcher with an
 * injected first hop (see `packages/api/test/integration/verification.test.ts`).
 */
import { type IncomingMessage, type Server, createServer } from "node:http";

export interface FixtureEntry {
  title: string;
  deadline: string;
  awardMin: number;
  awardMax: number;
}

export interface RecordedRequestHeaders {
  userAgent?: string;
  cookie?: string;
  authorization?: string;
  referer?: string;
}

export interface RecordedRequest {
  method: string;
  /** Pathname plus query string, exactly as requested. */
  path: string;
  headers: RecordedRequestHeaders;
  at: string;
}

export interface FixtureServerOptions {
  /** The E2E run id — the programme fixture is served at `/programme/<runId>`. */
  runId: string;
  entry?: FixtureEntry;
  /** Bytes streamed by `/big`. Default is comfortably over the API's default 2 MiB verify cap. */
  bigBodyBytes?: number;
}

export interface FixtureServer {
  port: number;
  /** Every request received so far, in order. Mutated in place — read it, don't copy it once. */
  requests: RecordedRequest[];
  stop: () => Promise<void>;
}

const DEFAULT_ENTRY: FixtureEntry = {
  title: "Sample RFP Hub Fixture Programme",
  deadline: "2026-12-31",
  awardMin: 5_000,
  awardMax: 50_000,
};

const DEFAULT_BIG_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB — well past a 2 MiB cap
const REDIRECT_LOOP_HOPS = 4;

/** Starts the fixture server on `127.0.0.1`, an OS-assigned port. Resolves once it is listening. */
export function start(options: FixtureServerOptions): Promise<FixtureServer> {
  const entry = options.entry ?? DEFAULT_ENTRY;
  const bigBodyBytes = options.bigBodyBytes ?? DEFAULT_BIG_BODY_BYTES;
  const requests: RecordedRequest[] = [];
  const programmePath = `/programme/${options.runId}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    /**
     * The recorded-request log, readable over HTTP.
     *
     * This server runs inside the RUNNER's process, and the specs that need to know what the
     * verifier sent run inside a Playwright WORKER — a different process, with no view of this
     * array. So the log is exposed as a route. It is deliberately outside the `/programme` and
     * `/redirect` namespaces, answers JSON rather than the `text/html` everything else answers, and
     * is NOT itself recorded: a spec reading the log must not append to what it is reading.
     */
    if (url.pathname === "/__requests") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ requests }));
      return;
    }

    requests.push(recordOf(req, url));
    res.setHeader("content-type", "text/html; charset=utf-8");

    if (url.pathname === programmePath) {
      const version = url.searchParams.get("v") === "2" ? 2 : 1;
      res.writeHead(200);
      res.end(renderProgrammePage(options.runId, entry, version));
      return;
    }

    if (url.pathname === "/missing") {
      res.writeHead(404);
      res.end(page("Not found", "<h1>Not found</h1>"));
      return;
    }

    if (url.pathname === "/soft-404") {
      // Status 200, body reads as "not found" — proves the verifier looks past the status code.
      res.writeHead(200);
      res.end(page("Page not found", "<h1>Page not found</h1><p>We could not find that page.</p>"));
      return;
    }

    if (url.pathname === "/redirect-public") {
      res.writeHead(302, { location: programmePath });
      res.end();
      return;
    }

    const loopHop = url.pathname.match(/^\/redirect-loop(?:\/(\d+))?$/);
    if (loopHop) {
      const current = loopHop[1] ? Number(loopHop[1]) : 0;
      const next = (current % REDIRECT_LOOP_HOPS) + 1;
      res.writeHead(302, { location: `/redirect-loop/${next}` });
      res.end();
      return;
    }

    if (url.pathname === "/big") {
      streamBig(res, bigBodyBytes);
      return;
    }

    res.writeHead(404);
    res.end(page("Not found", "<h1>Not found</h1>"));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fixture-server: server did not bind a TCP port"));
        return;
      }
      resolve({ port: address.port, requests, stop: () => stop(server) });
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function recordOf(req: IncomingMessage, url: URL): RecordedRequest {
  return {
    method: req.method ?? "GET",
    path: `${url.pathname}${url.search}`,
    headers: {
      userAgent: headerString(req.headers["user-agent"]),
      cookie: headerString(req.headers.cookie),
      authorization: headerString(req.headers.authorization),
      referer: headerString(req.headers.referer),
    },
    at: new Date().toISOString(),
  };
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The programme page, which must read as a REAL page to the verifier.
 *
 * The prose below is not decoration. The verifier's soft-not-found heuristic treats a 200 with less
 * than `MIN_CONTENT_CHARS` (200) of visible text as a page that is not really there — sites answer
 * 200 for a deleted programme all the time, and a status code alone is not evidence of existence.
 * An earlier version of this fixture carried only a heading and a definition list, came in under
 * that floor, and was correctly classified as absent — which made every positive verification
 * assertion in the suite unprovable. The right fix is a fixture that looks like the thing it is
 * standing in for; lowering the threshold would have deleted the heuristic to make a test pass.
 */
function renderProgrammePage(runId: string, entry: FixtureEntry, version: number): string {
  const title = version > 1 ? `${entry.title} (revised)` : entry.title;
  const summary =
    version > 1
      ? "This programme has been revised since it was first published. The award range and the " +
        "application deadline below supersede any earlier figures, and applications already " +
        "submitted under the previous terms will be reassessed against these."
      : "This programme funds open-source protocol research and public infrastructure work. " +
        "Applications are reviewed on a rolling basis, and every applicant receives a written " +
        "decision. Awards are paid in two instalments against agreed milestones.";
  const body = `
    <h1>${escapeHtml(title)}</h1>
    <p data-field="summary">${escapeHtml(summary)}</p>
    <dl>
      <dt>Deadline</dt><dd data-field="deadline">${escapeHtml(entry.deadline)}</dd>
      <dt>Award (min)</dt><dd data-field="award-min">${entry.awardMin}</dd>
      <dt>Award (max)</dt><dd data-field="award-max">${entry.awardMax}</dd>
      <dt>Run</dt><dd data-field="run-id">${escapeHtml(runId)}</dd>
      ${version > 1 ? `<dt>Revision</dt><dd data-field="revision">${version}</dd>` : ""}
    </dl>
    <h2>How to apply</h2>
    <p>Send a short proposal describing the work, the team and the milestones. Proposals are
    acknowledged within five working days.</p>`;
  return page(title, body);
}

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body>${bodyHtml}</body>
</html>`;
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/** Streams `total` bytes with no Content-Length, so a cap must be enforced on bytes read, not on a header. */
function streamBig(res: import("node:http").ServerResponse, total: number): void {
  res.writeHead(200);
  const chunk = "a".repeat(64 * 1024);
  let sent = 0;

  const writeMore = () => {
    while (sent < total) {
      const remaining = total - sent;
      const piece = remaining < chunk.length ? chunk.slice(0, remaining) : chunk;
      sent += piece.length;
      if (!res.write(piece)) {
        res.once("drain", writeMore);
        return;
      }
    }
    res.end();
  };

  writeMore();
}

/**
 * A thin, dependency-free client for the public `/v1/` API — the same shape as the repository's
 * TypeScript example, with four rules this server needs and a general client does not.
 *
 * 1. READS ARE ANONYMOUS. No `Authorization` header is attached to a GET even when a key is
 *    configured. Search results are public data; sending a credential to fetch them would tie
 *    every model-driven read to an identity for no benefit, and would put the key on the wire far
 *    more often than submitting does.
 * 2. A `POST` IS NEVER RETRIED, AND ANY FAILURE ONCE IT IS IN FLIGHT IS AMBIGUOUS. The API is
 *    idempotent for a byte-identical repeat from the same submitter, but the CLIENT cannot tell a
 *    lost request from a lost response. Crucially that is true *after* the response headers arrive
 *    too: a body that is cut off, unparseable or over the cap says nothing about whether the row
 *    was written, and neither does a `5xx` — a server that failed while answering may well have
 *    committed first. Every one of those is reported as "may have landed", never as a plain
 *    failure. A CODED `4xx` is different: the API read the request, decided, and said no.
 * 2b. A `POST` NEVER FOLLOWS A REDIRECT. `redirect: "manual"` means a `3xx` comes back as a `3xx`
 *    instead of the runtime silently re-sending the body — and the credential — somewhere this
 *    server never resolved and no human ever approved. The write approval binds the destination
 *    origin precisely so the destination cannot move; a followed redirect would move it after the
 *    binding was checked.
 * 3. RESPONSES ARE CAPPED AT 1 MB WHILE STREAMING. The check is applied chunk by chunk and the
 *    body is abandoned as soon as it goes over, so an enormous response costs bounded memory
 *    rather than being buffered whole and then rejected. Nothing is ever truncated into a value: a
 *    half-read JSON document parses as something else, or as nothing.
 * 4. A `404` ON A DETAIL FETCH IS A REAL ANSWER, and one shape of it carries the id of the entry
 *    the old one was merged into. Losing that turns a followable pointer into "not found".
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import type { McpConfig } from "./config.js";
import {
  type ApiErrorBody,
  ToolError,
  ambiguousWriteError,
  apiErrorToToolError,
  nonJsonResponseError,
} from "./errors.js";

/** One megabyte, in bytes. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** Upper bound on how long a `Retry-After` may make a read wait. */
export const MAX_RETRY_AFTER_MS = 5_000;

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  /**
   * `Math.max(1, ceil(total / limit))` on the server, so an EMPTY page reports `totalPages: 1`,
   * not 0. Anything deciding "is this empty" must test `total === 0`.
   */
  totalPages: number;
}

/**
 * Strip the generated type's `[k: string]: unknown` index signature so `Omit` can drop a named key.
 * Without this, `Omit<Opportunity, "fundingDetails">` collapses to the index signature alone and
 * every field read off it is `unknown`.
 */
type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** The list projection: a full document minus `fundingDetails`. */
export type OpportunitySummary = Omit<RemoveIndex<Opportunity>, "fundingDetails">;

export interface DuplicateMatch {
  id: string;
  title: string;
  isPublic: boolean;
  similarity: number | null;
  reasons?: string[];
}

/** `SubmissionResultView` as the API serializes it. Note: no top-level `id`. */
export interface SubmissionResult {
  opportunity: Opportunity;
  created: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
  isListed: boolean;
  warnings: string[];
  duplicateCheck: "ok" | "unavailable" | "disabled";
  duplicates: DuplicateMatch[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Injected for tests; defaults to the runtime's global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests so a retry does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse `Retry-After` (delta-seconds or HTTP-date) into a bounded millisecond delay. */
export function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 1_000;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
  return 1_000;
}

/** Raised while draining a body that went past the cap. Carries the operation for the message. */
export class ResponseTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    this.name = "ResponseTooLargeError";
    this.bytes = bytes;
  }
}

/**
 * Read a body chunk by chunk, stopping the moment it goes past the cap.
 *
 * Buffering the whole thing and measuring afterwards means a hostile or broken upstream can make
 * this process hold an arbitrary amount of memory before being told no. The reader is cancelled on
 * the way out so the connection is not left draining.
 */
export async function readCapped(res: Response, cap = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    // Cancelled, not merely abandoned. An un-cancelled body holds its socket out of the connection
    // pool until the runtime gets around to collecting it, so refusing enormous responses would
    // slowly starve the pool — the failure mode being avoided here would cause a different one.
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(declared);
  }

  const body = res.body;
  if (body === null) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > cap) throw new ResponseTooLargeError(seen);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    // Releasing rather than cancelling on the success path would leave a half-read stream open on
    // the over-cap path, which is the one that matters.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Whether a 2xx body really is the API's submission result.
 *
 * Only the members this package promises its own callers are checked — the id it promotes, and the
 * three flags it reports. Validating the whole document would reject a response that is fine and
 * merely newer, which is the opposite of what a client should do with a contract it does not own.
 */
export function isSubmissionResult(body: unknown): body is SubmissionResult {
  if (body === null || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  const opportunity = record.opportunity;
  if (opportunity === null || typeof opportunity !== "object") return false;
  if (typeof (opportunity as Record<string, unknown>).id !== "string") return false;
  if (typeof record.created !== "boolean") return false;
  if (typeof record.reviewStatus !== "string") return false;
  if (typeof record.isListed !== "boolean") return false;
  return true;
}

export class ApiClient {
  private readonly config: McpConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: McpConfig, options: ApiClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** `GET /v1/opportunities` — anonymous, one retry on 429. */
  async listOpportunities(query: URLSearchParams): Promise<Paginated<OpportunitySummary>> {
    const qs = query.toString();
    const path = `/v1/opportunities${qs ? `?${qs}` : ""}`;
    return this.getJson<Paginated<OpportunitySummary>>(path, "search_opportunities");
  }

  /** `GET /v1/opportunities/{id}` — anonymous, one retry on 429. */
  async getOpportunity(id: string): Promise<Opportunity> {
    return this.getJson<Opportunity>(
      `/v1/opportunities/${encodeURIComponent(id)}`,
      "fetch_opportunity",
    );
  }

  /**
   * `POST /v1/opportunities` with the configured credential. NO retry, at any status.
   *
   * Once the request has left, every failure is reported as ambiguous — including one that happens
   * after the response headers arrived. The caller is told the write may have landed and that
   * `/v1/me/opportunities` is where to find out, because that owner-scoped route lists pending
   * entries the public read hides.
   */
  async submitOpportunity(document: unknown): Promise<SubmissionResult> {
    if (this.config.apiKey === null) {
      throw new ToolError(
        "policy_denied",
        "No credential is configured. Set RFPHUB_API_KEY in the MCP client's env block; it is never accepted as a tool argument.",
      );
    }
    const url = `${this.config.apiBase}/v1/opportunities`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(document),
        // NOT followed. See rule 2b in the file header.
        redirect: "manual",
      });
    } catch (cause) {
      throw ambiguousWriteError(
        this.config.apiOrigin,
        "the connection failed before a response arrived",
        cause,
      );
    }

    if (res.status >= 300 && res.status < 400) {
      // NOT FOLLOWED, and NOT a clean refusal either.
      //
      // The redirect is not followed: the document and the credential are never re-sent to a host
      // this server did not resolve and no human approved. But "not followed" is not the same as
      // "not written". POST/Redirect/GET is the ordinary way a server acknowledges a resource it
      // just created and sends the client to look at it, so a 303 — or a 307 from a proxy that
      // wrote through — is entirely consistent with a row that exists. Reporting this as a refusal
      // would tell somebody to submit again, which is how the duplicate gets made.
      //
      // Naming the destination is deliberate: the operator has to be able to see where they were
      // being sent and decide whether it is somewhere they want to approve for.
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      throw ambiguousWriteError(
        this.config.apiOrigin,
        `the API answered ${res.status}, a redirect${location === null ? "" : ` to ${location}`}, which this server does not follow on a write — the document and credential were NOT re-sent anywhere, but a redirect is also how a server acknowledges something it has just created`,
        new Error(`HTTP ${res.status}`),
        "An approval binds the destination origin, so continuing to another host would spend a decision made about a different destination. If that destination is the right one, point RFPHUB_API_BASE at it and take a fresh preview.",
      );
    }

    // From here the request HAS been delivered. A body that will not read, will not parse, or is
    // over the cap tells us nothing about whether the row was written, so none of those may be
    // reported as an ordinary failure.
    let raw: string;
    try {
      raw = await readCapped(res);
    } catch (cause) {
      throw ambiguousWriteError(
        this.config.apiOrigin,
        cause instanceof ResponseTooLargeError
          ? `the API answered ${res.status} with a body over this server's ${MAX_RESPONSE_BYTES}-byte cap, which could not be read`
          : "the response body could not be read to the end",
        cause,
      );
    }

    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch (cause) {
      throw ambiguousWriteError(
        this.config.apiOrigin,
        `the API answered ${res.status} with a body that is not JSON`,
        cause,
      );
    }

    if (res.status >= 500) {
      // A 5xx is NOT an answer about the write, however well-formed its body is. The API commits
      // the row and then does more work — duplicate detection, notification queueing — so a
      // failure while answering is entirely consistent with a row that exists. Treating it as a
      // clean refusal is what produces the duplicate: the caller retries something that landed.
      throw ambiguousWriteError(
        this.config.apiOrigin,
        `the API answered ${res.status}, which says its request failed but not whether the entry was written`,
        new Error(`HTTP ${res.status}`),
      );
    }

    if (!res.ok) {
      // A coded 4xx IS an answer: the API read the request, decided, and the decision was "no".
      // That is not ambiguous, and reporting it as such would send people hunting for a row nobody
      // wrote.
      throw apiErrorToToolError(res.status, (body ?? {}) as ApiErrorBody, {
        operation: "submit_opportunity",
        keyConfigured: true,
      });
    }

    // A 2xx WHOSE BODY IS NOT A SUBMISSION RESULT IS AMBIGUOUS TOO. An empty 200, a `{}`, or a
    // body from something that is not this API says the request reached a server and tells us
    // nothing about what that server did with it — and the approval has already been claimed. The
    // alternative is worse than an error: passing the shape through would surface as
    // `id: "(the API returned no id)"` in a result that otherwise reads like a success.
    if (!isSubmissionResult(body)) {
      throw ambiguousWriteError(
        this.config.apiOrigin,
        `the API answered ${res.status} with a body that is not a submission result, so what it did with the request cannot be read off it`,
        new Error("unrecognised submission response"),
      );
    }
    return body;
  }

  private async getJson<T>(path: string, operation: string): Promise<T> {
    const url = `${this.config.apiBase}${path}`;
    // Deliberately no `authorization` header: see the file header, rule 1.
    let res = await this.transport(url, operation);
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers.get("retry-after"), Date.now());
      // The refused response still has a body, and an unread one keeps its socket out of the
      // connection pool. Cancelling it before sleeping means the retry reuses the connection
      // instead of racing the runtime's cleanup for a new one.
      await res.body?.cancel().catch(() => {});
      await this.sleep(wait);
      res = await this.transport(url, operation);
    }
    return this.readJson<T>(res, operation);
  }

  private async transport(url: string, operation: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
    } catch (cause) {
      throw new ToolError(
        "exec_failed",
        `Could not reach the RFP Hub API at ${this.config.apiOrigin} for ${operation}. Check RFPHUB_API_BASE and network access.`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }

  /**
   * Read a READ's body once, under the cap, then decide what it was.
   *
   * `res.json()` consumes the stream even when it rejects, so a `res.text()` fallback after it
   * would throw "Body is unusable" and bury the actual HTTP error — which is exactly the case that
   * matters (a proxy answering with HTML).
   */
  private async readJson<T>(res: Response, operation: string): Promise<T> {
    let raw: string;
    try {
      raw = await readCapped(res);
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw this.tooLarge(err.bytes, operation);
      throw new ToolError(
        "exec_failed",
        `The API's response to ${operation} ended before it could be read. Nothing was returned.`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }

    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch {
      if (!res.ok) throw nonJsonResponseError(res.status, operation);
      throw new ToolError(
        "exec_failed",
        `${operation} received a ${res.status} whose body is not JSON. The API always answers with JSON, so something else answered.`,
        { status: res.status, transport: true },
      );
    }

    if (!res.ok) {
      throw apiErrorToToolError(res.status, (body ?? {}) as ApiErrorBody, {
        operation,
        // FALSE, always, and not `apiKey !== null`. This method serves READS, and reads attach no
        // credential. The flag says whether one was sent on THIS request, because it decides which
        // sentence a 401 gets — and "the API rejected the configured credential" is a bad thing to
        // tell somebody about a request that carried none. A 401 on an anonymous read is the
        // public surface asking for a credential, not a credential being refused.
        keyConfigured: false,
      });
    }
    return body as T;
  }

  private tooLarge(bytes: number, operation: string): ToolError {
    return new ToolError(
      "exec_failed",
      `The API's response to ${operation} passed this server's ${MAX_RESPONSE_BYTES}-byte cap at ${bytes} bytes and was abandoned. Nothing was truncated — a half-read JSON document is worse than none. Narrow the request (a smaller \`limit\`, or more filters) and try again.`,
      { bytes, cap: MAX_RESPONSE_BYTES },
    );
  }
}

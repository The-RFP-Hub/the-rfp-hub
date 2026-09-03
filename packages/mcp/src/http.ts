/**
 * A dependency-free client for the public `/v1/` API, with four rules a general client would not
 * have. Reads are anonymous — no credential goes on the wire for public data. A POST is never
 * retried, and every failure once it is in flight is reported as "may have landed", including a
 * 5xx, an unreadable body and a redirect (which is never followed). Responses are capped at 1 MB
 * while streaming and every request has a deadline. And a 2xx body is validated before it is
 * believed, so a proxy's `{}` is not a successful empty record.
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
import { redactString } from "./redact.js";
import { truncate } from "./untrusted.js";

/** One megabyte, in bytes. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** Upper bound on how long a `Retry-After` may make a read wait. */
export const MAX_RETRY_AFTER_MS = 5_000;

/** How much of a redirect's `Location` is reported back. It is attacker-controlled text. */
export const MAX_LOCATION_CHARS = 200;

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  /** Server-side `max(1, ceil(total/limit))`: an EMPTY page reports 1. Emptiness is `total === 0`. */
  totalPages: number;
}

/** Without this, `Omit<Opportunity, "fundingDetails">` collapses to the index signature alone. */
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

/** Delta-seconds or HTTP-date, clamped to 0…5 s. Every branch ends inside the clamp. */
export function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 1_000;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds * 1_000, 0), MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
  return 1_000;
}

export class ResponseTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    this.name = "ResponseTooLargeError";
    this.bytes = bytes;
  }
}

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`no complete response within ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Read a body chunk by chunk, stopping the moment it goes past the cap.
 *
 * Buffering the whole thing and measuring afterwards means a hostile or broken upstream can make
 * this process hold an arbitrary amount of memory before being told no. The reader is canceled on
 * the way out so the connection is not left draining.
 */
export async function readCapped(res: Response, cap = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    // Canceled, not abandoned: an unread body holds its socket out of the connection pool.
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
    // Cancel, not release: the over-cap path would otherwise leave a half-read stream open.
    await reader.cancel().catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown, min: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/**
 * Only the fields the projection reads are required, and unknown members are ignored — but a body
 * missing them is refused, because every such body renders as an ordinary empty result set.
 */
export function isListPage(body: unknown): body is Paginated<OpportunitySummary> {
  if (!isRecord(body) || !Array.isArray(body.items)) return false;
  if (!isCount(body.page, 1) || !isCount(body.limit, 1)) return false;
  if (!isCount(body.total, 0) || !isCount(body.totalPages, 1)) return false;
  return body.items.every(isOpportunityLike);
}

/** Not a schema check: rejecting a document that is merely NEWER is the wrong failure here. */
export function isOpportunityLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const field of ["id", "title", "fundingType", "status"]) {
    if (typeof value[field] !== "string") return false;
  }
  return Array.isArray(value.operatingOrganizations);
}

const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
const DUPLICATE_CHECKS = new Set(["ok", "unavailable", "disabled"]);

/**
 * Every member the renderer consumes, including both closed enums: an unknown `duplicateCheck`
 * would otherwise crash the exhaustive switch AFTER the row was written.
 */
export function isSubmissionResult(body: unknown): body is SubmissionResult {
  if (!isRecord(body)) return false;
  if (!isRecord(body.opportunity) || typeof body.opportunity.id !== "string") return false;
  if (typeof body.created !== "boolean" || typeof body.isListed !== "boolean") return false;
  if (typeof body.reviewStatus !== "string" || !REVIEW_STATUSES.has(body.reviewStatus))
    return false;
  if (typeof body.duplicateCheck !== "string" || !DUPLICATE_CHECKS.has(body.duplicateCheck)) {
    return false;
  }
  if (!Array.isArray(body.warnings) || !body.warnings.every((w) => typeof w === "string")) {
    return false;
  }
  if (!Array.isArray(body.duplicates)) return false;
  return body.duplicates.every(
    (d) =>
      isRecord(d) &&
      typeof d.id === "string" &&
      typeof d.title === "string" &&
      (d.similarity === null || typeof d.similarity === "number"),
  );
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
    const body = await this.getJson(path, "search_opportunities");
    if (!isListPage(body)) throw this.badShape("search_opportunities", "a page of opportunities");
    return body;
  }

  /** `GET /v1/opportunities/{id}` — anonymous, one retry on 429. */
  async getOpportunity(id: string): Promise<Opportunity> {
    const body = await this.getJson(
      `/v1/opportunities/${encodeURIComponent(id)}`,
      "fetch_opportunity",
    );
    if (!isOpportunityLike(body)) {
      throw this.badShape("fetch_opportunity", "one opportunity document");
    }
    return body as Opportunity;
  }

  /** `POST /v1/opportunities`. NO retry at any status; every failure in flight is ambiguous. */
  async submitOpportunity(document: unknown): Promise<SubmissionResult> {
    if (this.config.apiKey === null) {
      throw new ToolError(
        "policy_denied",
        "No credential is configured. Set RFPHUB_API_KEY in the MCP client's env block; it is never accepted as a tool argument.",
      );
    }
    const url = `${this.config.apiBase}/v1/opportunities`;
    const deadline = newDeadline(this.config.timeoutMs);
    try {
      return await this.post(url, document, deadline);
    } catch (cause) {
      if (cause instanceof ToolError) throw cause;
      throw ambiguousWriteError(this.config.apiOrigin, this.writeFailure(deadline), cause);
    } finally {
      deadline.done();
    }
  }

  /** Both are ambiguous; they are distinguished because "check your network" misdirects on a slow host. */
  private writeFailure(deadline: Deadline): string {
    return deadline.expired()
      ? `no complete response arrived within this server's ${this.config.timeoutMs}ms deadline, so the request was abandoned mid-flight`
      : "the connection failed before a response arrived";
  }

  private async post(
    url: string,
    document: unknown,
    deadline: Deadline,
  ): Promise<SubmissionResult> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(document),
      // NOT followed. See rule 2b in the file header.
      redirect: "manual",
      signal: deadline.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      // NOT FOLLOWED, and NOT a clean refusal either: POST/Redirect/GET is how a server
      // acknowledges something it just created, so a 3xx is consistent with a row that exists.
      // The Location is named for the operator, bounded and redacted because it is attacker text.
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      // REDACTED FIRST, THEN BOUNDED: truncating first cuts a secret in half, and the redactor
      // never sees the whole of it, so the surviving half stays in the message.
      const where =
        location === null ? "" : ` to ${truncate(redactString(location), MAX_LOCATION_CHARS)}`;
      throw ambiguousWriteError(
        this.config.apiOrigin,
        `the API answered ${res.status}, a redirect${where}, which this server does not follow on a write — the document and credential were NOT re-sent anywhere, but a redirect is also how a server acknowledges something it has just created`,
        new Error(`HTTP ${res.status}`),
        "An approval binds the destination origin, so continuing to another host would spend a decision made about a different destination. If that destination is the right one, point RFPHUB_API_BASE at it and take a fresh preview.",
      );
    }

    // From here the request HAS been delivered, so nothing below may be an ordinary failure.
    let raw: string;
    try {
      raw = await readCapped(res);
    } catch (cause) {
      throw ambiguousWriteError(
        this.config.apiOrigin,
        cause instanceof ResponseTooLargeError
          ? `the API answered ${res.status} with a body over this server's ${MAX_RESPONSE_BYTES}-byte cap, which could not be read`
          : deadline.expired()
            ? `the API answered ${res.status} and then stopped sending, passing this server's ${this.config.timeoutMs}ms deadline mid-body`
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
      // A 5xx is not an answer about the write: the API commits the row and then does more work.
      throw ambiguousWriteError(
        this.config.apiOrigin,
        `the API answered ${res.status}, which says its request failed but not whether the entry was written`,
        new Error(`HTTP ${res.status}`),
      );
    }

    if (!res.ok) {
      // A coded 4xx IS an answer: read, decided, refused. Not ambiguous.
      throw apiErrorToToolError(res.status, (body ?? {}) as ApiErrorBody, {
        operation: "submit_opportunity",
        keyConfigured: true,
      });
    }

    // A 2xx whose body is not a submission result is ambiguous too, and the approval is spent.
    if (!isSubmissionResult(body)) {
      throw ambiguousWriteError(
        this.config.apiOrigin,
        `the API answered ${res.status} with a body that is not a submission result, so what it did with the request cannot be read off it`,
        new Error("unrecognized submission response"),
      );
    }
    return body;
  }

  private async getJson(path: string, operation: string): Promise<unknown> {
    const url = `${this.config.apiBase}${path}`;
    const first = await this.attempt(url, operation);
    if (first.res.status !== 429) return this.readJson(first, operation);

    const wait = retryAfterMs(first.res.headers.get("retry-after"), Date.now());
    await first.res.body?.cancel().catch(() => {});
    first.deadline.done();
    await this.sleep(wait);
    return this.readJson(await this.attempt(url, operation), operation);
  }

  /** The deadline stays armed through the body: a peer that stalls mid-body is the same hang. */
  private async attempt(url: string, operation: string): Promise<InFlight> {
    const deadline = newDeadline(this.config.timeoutMs);
    try {
      // Deliberately no `authorization` header: see the file header, rule 1.
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: deadline.signal,
      });
      return { res, deadline };
    } catch (cause) {
      deadline.done();
      if (deadline.expired()) throw this.timedOut(operation);
      throw new ToolError(
        "exec_failed",
        `Could not reach the RFP Hub API at ${this.config.apiOrigin} for ${operation}. Check RFPHUB_API_BASE and network access.`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }

  /** Read once. `res.json()` consumes the stream even when it rejects, so a text fallback after
   * it would bury the real error — a proxy answering with HTML being the case that matters. */
  private async readJson({ res, deadline }: InFlight, operation: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await readCapped(res);
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw this.tooLarge(err.bytes, operation);
      if (deadline.expired()) throw this.timedOut(operation);
      throw new ToolError(
        "exec_failed",
        `The API's response to ${operation} ended before it could be read. Nothing was returned.`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      deadline.done();
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
        // FALSE always, not `apiKey !== null`: reads send none, and a 401 here is the public
        // surface asking for a credential rather than one being refused.
        keyConfigured: false,
      });
    }
    return body;
  }

  private timedOut(operation: string): ToolError {
    return new ToolError(
      "exec_failed",
      `The API did not answer ${operation} within this server's ${this.config.timeoutMs}ms deadline, so the request was abandoned. Nothing was retried. The deadline is fixed; a destination that is legitimately this slow is a destination to fix.`,
      { timeoutMs: this.config.timeoutMs, transport: true },
    );
  }

  private badShape(operation: string, expected: string): ToolError {
    return new ToolError(
      "exec_failed",
      `${operation} got a 2xx from ${this.config.apiOrigin} whose body is not ${expected}. Nothing is returned rather than an empty-looking record built from a shape this server does not recognize — a proxy, a captive portal or an API version this build predates can all answer 200 with something else.`,
      { transport: true },
    );
  }

  private tooLarge(bytes: number, operation: string): ToolError {
    return new ToolError(
      "exec_failed",
      `The API's response to ${operation} passed this server's ${MAX_RESPONSE_BYTES}-byte cap at ${bytes} bytes and was abandoned. Nothing was truncated — a half-read JSON document is worse than none. Narrow the request (a smaller \`limit\`, or more filters) and try again.`,
      { bytes, cap: MAX_RESPONSE_BYTES },
    );
  }
}

interface Deadline {
  signal: AbortSignal;
  expired(): boolean;
  done(): void;
}

interface InFlight {
  res: Response;
  deadline: Deadline;
}

/** Armed until `done()`: `fetch` resolves on HEADERS, and aborting also errors the body stream. */
function newDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new RequestTimeoutError(timeoutMs));
  }, timeoutMs);
  // An armed timer must not by itself keep the process alive after stdin closes.
  timer.unref?.();
  return {
    signal: controller.signal,
    expired: () => fired,
    done: () => clearTimeout(timer),
  };
}

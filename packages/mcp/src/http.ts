/**
 * A thin, dependency-free client for the public `/v1/` API — the same shape as the repository's
 * TypeScript example, with three rules this server needs and a general client does not.
 *
 * 1. READS ARE ANONYMOUS. No `Authorization` header is attached to a GET even when a key is
 *    configured. Search results are public data; sending a credential to fetch them would tie
 *    every model-driven read to an identity for no benefit, and would put the key on the wire far
 *    more often than submitting does.
 * 2. A `POST` IS NEVER RETRIED. The API is idempotent for a byte-identical repeat from the same
 *    submitter, but the CLIENT cannot tell a lost request from a lost response: on a timeout the
 *    body may already have been written. Retrying would also spend an approval that was already
 *    claimed. The ambiguity is reported instead, with where to go and check.
 * 3. RESPONSES ARE CAPPED AT 1 MB, AND EXCEEDING IT FAILS. Truncating JSON produces a document
 *    that parses as something else or not at all; a hard failure with "narrow the query" is
 *    information, a silent half-record is not.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import type { McpConfig } from "./config.js";
import {
  type ApiErrorBody,
  ToolError,
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
   * A transport failure here is reported as ambiguous on purpose: the caller is told the write may
   * have landed and that `/v1/me/opportunities` is where to find out, because that owner-scoped
   * route lists pending entries the public read hides.
   */
  async submitOpportunity(document: unknown): Promise<SubmissionResult> {
    if (this.config.apiKey === null) {
      throw new ToolError(
        "policy_denied",
        "No credential is configured. Set RFPHUB_API_KEY in the MCP client's env block; it is " +
          "never accepted as a tool argument.",
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
      });
    } catch (cause) {
      throw new ToolError(
        "exec_failed",
        `The submission could not be completed and its outcome is UNKNOWN: the connection to ${this.config.apiOrigin} failed before a response arrived. The entry may or may not have been written. Do NOT resubmit blindly — check GET /v1/me/opportunities first (the public read hides pending entries).`,
        { ambiguous: true, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    return this.readJson<SubmissionResult>(res, "submit_opportunity");
  }

  private async getJson<T>(path: string, operation: string): Promise<T> {
    const url = `${this.config.apiBase}${path}`;
    // Deliberately no `authorization` header: see the file header, rule 1.
    let res = await this.transport(url, operation);
    if (res.status === 429) {
      await this.sleep(retryAfterMs(res.headers.get("retry-after"), Date.now()));
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
   * Read a body ONCE, enforce the size cap, then decide what it was.
   *
   * `res.json()` consumes the stream even when it rejects, so a `res.text()` fallback after it
   * would throw "Body is unusable" and bury the actual HTTP error — which is exactly the case that
   * matters (a proxy answering with HTML).
   */
  private async readJson<T>(res: Response, operation: string): Promise<T> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw this.tooLarge(declared, operation);
    }
    const raw = await res.text();
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > MAX_RESPONSE_BYTES) throw this.tooLarge(bytes, operation);

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
        keyConfigured: this.config.apiKey !== null,
      });
    }
    return body as T;
  }

  private tooLarge(bytes: number, operation: string): ToolError {
    return new ToolError(
      "exec_failed",
      `The API's response to ${operation} is ${bytes} bytes, over this server's ${MAX_RESPONSE_BYTES}-byte cap. Nothing was truncated — a half-truncated JSON document is worse than none. Narrow the request (a smaller \`limit\`, or more filters) and try again.`,
      { bytes, cap: MAX_RESPONSE_BYTES },
    );
  }
}

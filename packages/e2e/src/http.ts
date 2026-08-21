/**
 * A thin HTTP client for the live API.
 *
 * Deliberately NOT Playwright's `APIRequestContext`: the runner and the identity provisioner use
 * this too, and they run outside Playwright entirely. One client for every layer means a spec and
 * the bring-up that prepared it are talking to the API the same way, and a difference between them
 * is a difference in the request rather than in the library.
 *
 * Two properties matter for the assertions built on top of it:
 *
 *   - **Redirects are NOT followed** (`redirect: "manual"`). `GET /v1/r/:id/apply` answers 302, and
 *     a criterion about the redirect being a 302 cannot be checked by a client that silently
 *     followed it and reported the destination's 200.
 *   - **Errors are values, not throws.** The API's error envelope is flat —
 *     `{ error: "&lt;code&gt;", message: "…" }` (`packages/api/src/modules/shared/http-error.ts`) — and
 *     most of this suite's assertions are about a specific code on a specific status. A client that
 *     threw on 4xx would turn every negative test into a try/catch.
 */

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  /** The raw text, for the cases where the body is not JSON (a 302 with none, an HTML page). */
  text: string;
}

/** The API's flat error envelope. `details` members are spread in at the top level. */
export interface ApiErrorBody {
  error: string;
  message: string;
  [key: string]: unknown;
}

export interface RequestInput {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Overrides the client's own credential for this one call (or clears it with `null`). */
  auth?: string | null;
  timeoutMs?: number;
  /**
   * Whether to wait out a 429 and try again. Default true.
   *
   * Set false where the STATUS ITSELF is the observation — a test about concurrent behaviour that
   * treats being rate limited as one of the legitimate outcomes must see the 429, not a retry of it.
   */
  retryOn429?: boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** A Bearer credential: a Privy session token or an `rfph_…` key. */
  token?: string;
  /**
   * The User-Agent every request carries.
   *
   * It is explicit because analytics countability depends on it: `analytics-hash.ts` excludes bot
   * user agents and the checker's own agent by name, so a suite that let the runtime pick a UA
   * would be asserting on counters whose movement it could not explain.
   */
  userAgent?: string;
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly userAgent: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.userAgent = options.userAgent ?? "rfphub-e2e/1.0";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** A client identical to this one but carrying a different credential (or none). */
  as(token: string | undefined): ApiClient {
    return new ApiClient({
      baseUrl: this.baseUrl,
      token,
      userAgent: this.userAgent,
      defaultTimeoutMs: this.defaultTimeoutMs,
    });
  }

  /** A client identical to this one but with a different User-Agent. */
  withUserAgent(userAgent: string): ApiClient {
    return new ApiClient({
      baseUrl: this.baseUrl,
      token: this.token,
      userAgent,
      defaultTimeoutMs: this.defaultTimeoutMs,
    });
  }

  /**
   * How many times a 429 is waited out before the response is returned as-is.
   *
   * THE WRITE ROUTES ARE LIMITED TO 60 PER MINUTE, and with `TRUST_PROXY` unset every request in the
   * run arrives from 127.0.0.1 — so the whole suite shares a single bucket regardless of how many
   * identities it has. A full run creates well over sixty entries, and at the point the limiter
   * engages the suite would otherwise fail on a protection that is working exactly as designed.
   *
   * Waiting and retrying is what a well-behaved client does, and it keeps the limiter genuinely in
   * force — the run really is slowed down by it. Raising the limit for the test stack was the
   * alternative and was rejected: it would remove a real protection from the environment under test
   * in order to make the harness's own throughput somebody else's problem.
   */
  private static readonly MAX_429_RETRIES = 4;

  async request<T = unknown>(input: RequestInput): Promise<ApiResponse<T>> {
    let attempt = 0;
    for (;;) {
      const response = await this.attempt<T>(input);
      if (
        response.status !== 429 ||
        input.retryOn429 === false ||
        attempt >= ApiClient.MAX_429_RETRIES
      ) {
        return response;
      }
      attempt++;
      // `retry-after` is seconds when the server sends it; the window is a minute, so a missing
      // header falls back to a wait long enough to matter rather than a busy loop.
      const header = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : 5_000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 61_000)));
    }
  }

  private async attempt<T = unknown>(input: RequestInput): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${input.path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
      ...input.headers,
    };

    const credential = input.auth === undefined ? this.token : (input.auth ?? undefined);
    if (credential) headers.authorization = `Bearer ${credential}`;

    let payload: string | undefined;
    if (input.body !== undefined) {
      payload = JSON.stringify(input.body);
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? this.defaultTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method ?? "GET",
        headers,
        body: payload,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return { status: response.status, headers: response.headers, body: body as T, text };
  }

  get<T = unknown>(path: string, extra: Omit<RequestInput, "path" | "method"> = {}) {
    return this.request<T>({ ...extra, method: "GET", path });
  }
  post<T = unknown>(
    path: string,
    body?: unknown,
    extra: Omit<RequestInput, "path" | "method" | "body"> = {},
  ) {
    return this.request<T>({ ...extra, method: "POST", path, body });
  }
  put<T = unknown>(
    path: string,
    body?: unknown,
    extra: Omit<RequestInput, "path" | "method" | "body"> = {},
  ) {
    return this.request<T>({ ...extra, method: "PUT", path, body });
  }
  patch<T = unknown>(
    path: string,
    body?: unknown,
    extra: Omit<RequestInput, "path" | "method" | "body"> = {},
  ) {
    return this.request<T>({ ...extra, method: "PATCH", path, body });
  }
  delete<T = unknown>(path: string, extra: Omit<RequestInput, "path" | "method"> = {}) {
    return this.request<T>({ ...extra, method: "DELETE", path });
  }

  /**
   * The same request, but a non-2xx is an Error carrying the API's own code and message.
   *
   * Used ONLY by bring-up and provisioning, where a failure means the run cannot continue and the
   * useful thing is a message naming the route. Specs use the plain methods and assert on status.
   */
  async expectOk<T = unknown>(input: RequestInput): Promise<T> {
    const response = await this.request<T>(input);
    if (response.status < 200 || response.status >= 300) {
      const envelope = response.body as ApiErrorBody | undefined;
      const code = envelope?.error ? `${envelope.error}: ` : "";
      const message = envelope?.message ?? response.text.slice(0, 400);
      throw new Error(
        `${input.method ?? "GET"} ${input.path} → ${response.status} ${code}${message}`,
      );
    }
    return response.body;
  }
}

/** Polls `GET /v1/health` until it reports `{status:"ok", db:"up"}`. The API's only readiness path. */
export async function isHealthy(baseUrl: string): Promise<boolean> {
  const client = new ApiClient({ baseUrl, defaultTimeoutMs: 2_000 });
  const response = await client.get<{ status?: string; db?: string }>("/v1/health");
  return response.status === 200 && response.body?.status === "ok" && response.body?.db === "up";
}

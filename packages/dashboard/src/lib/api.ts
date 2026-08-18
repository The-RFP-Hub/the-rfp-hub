/**
 * THE ONLY MODULE THAT KNOWS THE API EXISTS.
 *
 * Every network call in this package goes through `createApiClient`. That is not tidiness: it is
 * what makes three properties checkable in one place instead of on every page.
 *
 *   1. The bearer token is attached HERE, from the caller's own Privy session, and nowhere else. No
 *      page composes an `Authorization` header, so none can leak one into a third-party request.
 *   2. A failure is an `ApiError` with the API's own machine-readable `error` code, whatever went
 *      wrong — a 400 with a humanized field report, a 401, a 409 naming another entry, a body that
 *      is not JSON, or a transport failure. Pages branch on the code; they never parse a message.
 *   3. The base URL is read once. A component cannot accidentally talk to a different origin than
 *      the one the Content-Security-Policy allows.
 *
 * It is deliberately not a data-fetching library. There is no cache, no retry and no revalidation:
 * a publisher acting on numbers wants to know when they were read, and a silent retry of a POST
 * that already succeeded is a duplicate submission.
 */
import type {
  AccountList,
  AccountSummary,
  ApiErrorBody,
  ApiKey,
  ApiKeyCreated,
  ApiKeyList,
  ApiKeyScope,
  AuditTrail,
  ClaimList,
  ClaimResult,
  ClaimStatus,
  DuplicateList,
  DuplicatePair,
  DuplicatePairList,
  DuplicateStatus,
  InsightsSeries,
  InsightsSummary,
  ManagedOpportunityList,
  Me,
  MembershipResult,
  MergeResult,
  Opportunity,
  OrganizationList,
  OrganizationSummary,
  PaginatedOpportunities,
  PublisherList,
  ReviewDecision,
  ReviewStatus,
  SubmissionResult,
  VerificationRun,
} from "./types";

/**
 * A failed call, whatever the layer it failed at.
 *
 * `status: 0` is the transport failure — DNS, TLS, a blocked cross-origin request, an offline
 * browser. It is kept distinct from an HTTP status so a page can say "the API could not be
 * reached" rather than inventing a server error the server never sent.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The API's snake_case code (`validation_failed`, `survivor_already_merged`, …). */
  readonly code: string;
  /** The humanized, field-by-field report from a Standard validation failure. Empty otherwise. */
  readonly details: string[];
  /** Set on `survivor_already_merged`: the entry that really survived, for a link-out. */
  readonly survivorId: string | undefined;

  constructor(status: number, code: string, message: string, extra?: Partial<ApiErrorBody>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = extra?.errors ?? [];
    this.survivorId = extra?.survivorId;
  }

  /** The session is gone or was never presented. Pages offer a login rather than an error. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Authenticated, but this account may not do it. A different message, and never a retry. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export type TokenSource = () => Promise<string | null>;

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the caller's access token, or null when they are not logged in. */
  getToken?: TokenSource;
  /** Injected in tests. Production passes nothing and gets the browser's `fetch`. */
  fetchImpl?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * The querystring of `GET /v1/opportunities`, as far as the public browse surface uses it.
 *
 * A `type` rather than an `interface` on purpose: only a type alias is assignable to `Query`'s index
 * signature, and being assignable to it is what stops a page inventing a parameter. That matters
 * more here than anywhere else in this client — the list endpoint validates its querystring with
 * `additionalProperties: false` and answers a misspelled filter with a 400, never with a silently
 * ignored one. Every member below is a parameter the endpoint actually declares.
 *
 * The list filters accept a comma-separated list as well as a single value; the browse UI sends one
 * value at a time, and the wire form is the same either way.
 */
export type DirectoryQuery = {
  /** Free text over title, summary and description. */
  q?: string;
  fundingType?: string;
  status?: string;
  ecosystem?: string;
  category?: string;
  /** Organisation slug — matches any operating OR sponsoring organisation. */
  organization?: string;
  minAward?: number;
  maxAward?: number;
  /** RFC 3339 instants, compared against the derived `nextDeadlineAt`. */
  deadlineAfter?: string;
  deadlineBefore?: string;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  limit?: number;
};

/**
 * The measurable link-out for an entry.
 *
 * A dashboard that linked straight to `applicationUrl` would make its own analytics tab lie: the
 * click counters only move when the hop goes through the API. Every "open" button in this package
 * uses this.
 */
export function linkOutUrl(baseUrl: string, id: string, kind: "apply" | "source"): string {
  return `${baseUrl}/v1/r/${encodeURIComponent(id)}/${kind}`;
}

function queryString(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    method: string,
    path: string,
    init?: { query?: Query; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init?.body !== undefined) headers["content-type"] = "application/json";

    // A token is attached when there is one. Public routes work without it, and asking for one on
    // every call would force a login prompt on a page that does not need it.
    const token = options.getToken ? await options.getToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}${queryString(init?.query)}`, {
        method,
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        // Credentials stay header-borne. The API's CORS policy is `origin: *` with
        // `credentials: false` precisely because no cookie is ever sent; sending one would break
        // that invariant from this side.
        credentials: "omit",
      });
    } catch (cause) {
      throw new ApiError(
        0,
        "network_error",
        `Could not reach the API at ${baseUrl}. ${cause instanceof Error ? cause.message : ""}`.trim(),
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError(
          response.status,
          "invalid_response",
          `The API returned ${response.status} with a body that is not JSON.`,
        );
      }
    }

    if (!response.ok) {
      const body = (parsed ?? {}) as ApiErrorBody;
      throw new ApiError(
        response.status,
        body.error ?? "http_error",
        body.message ?? `Request failed with status ${response.status}.`,
        body,
      );
    }
    return parsed as T;
  }

  return {
    baseUrl,

    // ── identity ────────────────────────────────────────────────────────────────
    me: {
      get: () => request<Me>("GET", "/v1/me"),
      update: (body: { handle?: string | null; displayName?: string | null }) =>
        request<Me>("PATCH", "/v1/me", { body }),
      opportunities: (query?: { reviewStatus?: ReviewStatus; page?: number; limit?: number }) =>
        request<ManagedOpportunityList>("GET", "/v1/me/opportunities", { query }),
      /** The one route that serves an owner their own pending or rejected record in full. */
      opportunity: (id: string) =>
        request<Opportunity>("GET", `/v1/me/opportunities/${encodeURIComponent(id)}`),
      duplicates: () => request<DuplicateList>("GET", "/v1/me/duplicates"),
    },

    keys: {
      list: () => request<ApiKeyList>("GET", "/v1/keys"),
      create: (body: { name?: string | null; scopes?: ApiKeyScope[]; expiresAt?: string | null }) =>
        request<ApiKeyCreated>("POST", "/v1/keys", { body }),
      revoke: (id: number) => request<ApiKey>("DELETE", `/v1/keys/${id}`),
    },

    // ── writes ──────────────────────────────────────────────────────────────────
    opportunities: {
      create: (document: unknown) =>
        request<SubmissionResult>("POST", "/v1/opportunities", { body: document }),
      replace: (id: string, document: unknown) =>
        request<SubmissionResult>("PUT", `/v1/opportunities/${encodeURIComponent(id)}`, {
          body: document,
        }),
      claim: (id: string, body: { organizationSlug: string; note?: string | null }) =>
        request<ClaimResult>("POST", `/v1/opportunities/${encodeURIComponent(id)}/claim`, { body }),
      audit: (id: string) =>
        request<AuditTrail>("GET", `/v1/opportunities/${encodeURIComponent(id)}/audit`),
      duplicates: (id: string) =>
        request<DuplicateList>("GET", `/v1/opportunities/${encodeURIComponent(id)}/duplicates`),
      verification: (id: string) =>
        request<VerificationRun>("GET", `/v1/opportunities/${encodeURIComponent(id)}/verification`),
    },

    // ── insights ────────────────────────────────────────────────────────────────
    insights: {
      forOpportunity: (id: string, days?: number) =>
        request<InsightsSeries>("GET", `/v1/insights/opportunities/${encodeURIComponent(id)}`, {
          query: { days },
        }),
      summary: (days?: number) =>
        request<InsightsSummary>("GET", "/v1/insights/me/summary", { query: { days } }),
    },

    // ── review (T3) ─────────────────────────────────────────────────────────────
    review: {
      opportunities: (query?: { reviewStatus?: ReviewStatus; page?: number; limit?: number }) =>
        request<ManagedOpportunityList>("GET", "/v1/review/opportunities", { query }),
      /** One entry in full, entitled by ROLE rather than by ownership. See `loadOpportunity`. */
      opportunity: (id: string) =>
        request<Opportunity>("GET", `/v1/review/opportunities/${encodeURIComponent(id)}`),
      approve: (id: string, reason?: string | null) =>
        request<ReviewDecision>(
          "POST",
          `/v1/review/opportunities/${encodeURIComponent(id)}/approve`,
          {
            body: { reason: reason ?? null },
          },
        ),
      reject: (id: string, reason?: string | null) =>
        request<ReviewDecision>(
          "POST",
          `/v1/review/opportunities/${encodeURIComponent(id)}/reject`,
          {
            body: { reason: reason ?? null },
          },
        ),
      setListed: (id: string, isListed: boolean) =>
        request<ReviewDecision>("PATCH", `/v1/review/opportunities/${encodeURIComponent(id)}`, {
          body: { isListed },
        }),
      verifySource: (id: string) =>
        request<VerificationRun>(
          "POST",
          `/v1/review/opportunities/${encodeURIComponent(id)}/verify`,
        ),
      duplicates: (query?: { status?: DuplicateStatus; limit?: number }) =>
        request<DuplicatePairList>("GET", "/v1/review/duplicates", { query }),
      confirmDuplicate: (pairId: number) =>
        request<DuplicatePair>("POST", `/v1/review/duplicates/${pairId}/confirm`),
      dismissDuplicate: (pairId: number) =>
        request<DuplicatePair>("POST", `/v1/review/duplicates/${pairId}/dismiss`),
      /** `fields` is omitted by default: a merge copies nothing unless a reviewer asks it to. */
      mergeDuplicate: (pairId: number, body: { survivorId: string; fields?: string[] }) =>
        request<MergeResult>("POST", `/v1/review/duplicates/${pairId}/merge`, { body }),
      claims: (query?: { status?: ClaimStatus }) =>
        request<ClaimList>("GET", "/v1/review/claims", { query }),
      /** `verifyOrganization` is required: an approval that does not verify leaves auto-approval off. */
      approveClaim: (claimId: number, verifyOrganization: boolean) =>
        request<ClaimResult>("POST", `/v1/review/claims/${claimId}/approve`, {
          body: { verifyOrganization },
        }),
      rejectClaim: (claimId: number) =>
        request<ClaimResult>("POST", `/v1/review/claims/${claimId}/reject`),
      accounts: (query?: { q?: string; limit?: number }) =>
        request<AccountList>("GET", "/v1/review/accounts", { query }),
      organizations: (query?: { q?: string; verified?: boolean; limit?: number }) =>
        request<OrganizationList>("GET", "/v1/review/organizations", { query }),
      verifyOrganization: (slug: string) =>
        request<OrganizationSummary>(
          "POST",
          `/v1/review/organizations/${encodeURIComponent(slug)}/verify`,
        ),
      unverifyOrganization: (slug: string) =>
        request<OrganizationSummary>(
          "POST",
          `/v1/review/organizations/${encodeURIComponent(slug)}/unverify`,
        ),
      grantMembership: (slug: string, body: { accountId: number; role?: string }) =>
        request<MembershipResult>(
          "POST",
          `/v1/review/organizations/${encodeURIComponent(slug)}/members`,
          { body },
        ),
    },

    // ── administration (T4) ─────────────────────────────────────────────────────
    admin: {
      setRole: (accountId: number, role: "submitter" | "reviewer" | "admin") =>
        request<AccountSummary>("POST", `/v1/admin/accounts/${accountId}/role`, { body: { role } }),
      setDirectCreate: (accountId: number, directCreate: boolean) =>
        request<AccountSummary>("POST", `/v1/admin/accounts/${accountId}/direct-create`, {
          body: { directCreate },
        }),
    },

    // ── public ──────────────────────────────────────────────────────────────────
    /**
     * The unauthenticated browse surface: the published directory, as a visitor with no account
     * reads it.
     *
     * Deliberately NOT folded into `opportunities` above, which is the publisher's write and
     * sub-resource group. These two routes are the ones a visitor hits, and they are the ones the
     * API counts: `GET /v1/opportunities` records a list view for every row it serves, and
     * `GET /v1/opportunities/{id}` records the detail view. A browse page that read an entry through
     * any other route would leave a publisher's `detailViews` at zero while people were reading it.
     *
     * Both 404 anything that is not `approved AND is_listed`, which is why the workbench keeps its
     * own owner and reviewer routes: a pending entry is invisible here by design.
     */
    directory: {
      list: (query?: DirectoryQuery) =>
        request<PaginatedOpportunities>("GET", "/v1/opportunities", { query }),
      /** The full Standard object, and the read the API counts as a detail view. */
      find: (id: string) =>
        request<Opportunity>("GET", `/v1/opportunities/${encodeURIComponent(id)}`),
    },

    publishers: {
      /** Takes no parameters: the verified set is small and the route returns all of it. */
      list: () => request<PublisherList>("GET", "/v1/publishers"),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * One entry in full, from whichever route this session is entitled to read it through.
 *
 * There are two, and neither one alone serves this page. `/v1/me/opportunities/{id}` is scoped to
 * entries the caller submitted or publishes — right for an owner, and a 404 for a reviewer, who is
 * sent here from the review queue, a claim or a duplicate pair, all of which are by definition
 * somebody else's entry. `/v1/review/opportunities/{id}` is entitled by role and is a 403 for
 * everybody else.
 *
 * OWNER FIRST, and the fallback is narrow on purpose: only a 404, and only for a session that
 * reports `canReview`. A reviewer looking at their OWN entry still reads it as its owner, so the
 * ordinary case does not depend on the role at all — and a 401 or a transport failure is passed
 * straight through rather than being retried against a route that will answer the same way.
 */
export async function loadOpportunity(
  api: ApiClient,
  id: string,
  canReview: boolean,
): Promise<Opportunity> {
  try {
    return await api.me.opportunity(id);
  } catch (error) {
    if (!canReview || !(error instanceof ApiError) || !error.isNotFound) throw error;
    return api.review.opportunity(id);
  }
}

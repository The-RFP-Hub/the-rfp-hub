/**
 * The API wrapper is the only module in this package that touches the network, so it is the only
 * one whose failure modes have to be proven rather than assumed. Each test here corresponds to a
 * behaviour a page depends on: the token is attached, a failure is an `ApiError` carrying the API's
 * own code, and a body that is not JSON is not silently treated as one.
 */
import { ApiError, createApiClient, linkOutUrl, loadOpportunity } from "@/lib/api";
import { describe, expect, it } from "vitest";

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(responder: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createApiClient", () => {
  it("attaches the bearer token the token source returns", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ accountId: 1 }));
    const api = createApiClient({
      baseUrl: "https://api.example.com",
      getToken: async () => "token-abc",
      fetchImpl,
    });

    await api.me.get();

    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-abc");
    expect(calls[0]?.url).toBe("https://api.example.com/v1/me");
  });

  it("omits the header entirely when there is no session", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ items: [], total: 0 }));
    const api = createApiClient({
      baseUrl: "https://api.example.com",
      getToken: async () => null,
      fetchImpl,
    });

    await api.publishers.list();

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("never sends cookies — every credential here is header-borne", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ accountId: 1 }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.me.get();

    expect(calls[0]?.init.credentials).toBe("omit");
  });

  it("builds a query string and drops undefined parameters", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ items: [] }));
    const api = createApiClient({ baseUrl: "https://api.example.com/", fetchImpl });

    await api.me.opportunities({ reviewStatus: undefined, page: 2, limit: 20 });

    expect(calls[0]?.url).toBe("https://api.example.com/v1/me/opportunities?page=2&limit=20");
  });

  it("percent-encodes an id that contains the namespace separator", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ entries: [] }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.opportunities.audit("acme:round-1");

    expect(calls[0]?.url).toBe("https://api.example.com/v1/opportunities/acme%3Around-1/audit");
  });

  it("turns a validation failure into an ApiError carrying the humanized report", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(
        {
          error: "validation_failed",
          message: "The document is not conformant.",
          errors: ["/title must be a string", "/fundingDetails must have fundingType"],
        },
        400,
      ),
    );
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    const failure = await api.opportunities.create({}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.status).toBe(400);
    expect(error.code).toBe("validation_failed");
    expect(error.details).toHaveLength(2);
  });

  it("flags a 401 as unauthenticated so a page can offer a login instead of an error", async () => {
    const { fetchImpl } = stubFetch(() => json({ error: "unauthorized", message: "no" }, 401));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    const error = (await api.me.get().catch((e: unknown) => e)) as ApiError;

    expect(error.isUnauthenticated).toBe(true);
    expect(error.isForbidden).toBe(false);
  });

  it("carries survivorId off a merge conflict so the page can link to the real survivor", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(
        {
          error: "survivor_already_merged",
          message: "acme:a was merged into acme:c.",
          survivorId: "acme:c",
        },
        409,
      ),
    );
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    const error = (await api.review
      .mergeDuplicate(7, { survivorId: "acme:a" })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("survivor_already_merged");
    expect(error.survivorId).toBe("acme:c");
  });

  it("does not pretend a non-JSON body is JSON", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("<html>gateway timeout</html>", { status: 504 }),
    );
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    const error = (await api.me.get().catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("invalid_response");
    expect(error.status).toBe(504);
  });

  it("reports a transport failure as status 0 rather than inventing a server error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    const error = (await api.me.get().catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(0);
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("https://api.example.com");
  });

  it("returns undefined for a 204 without trying to parse a body", async () => {
    const { fetchImpl } = stubFetch(() => new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await expect(api.keys.revoke(3)).resolves.toBeUndefined();
  });

  it("sends a JSON body with a content type only when there is one", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ id: "x", reviewStatus: "approved" }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.review.approve("acme:1", "looks right");
    await api.review.verifySource("acme:1");

    const first = calls[0]?.init.headers as Record<string, string>;
    expect(first["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ reason: "looks right" }));
    const second = calls[1]?.init.headers as Record<string, string>;
    expect(second["content-type"]).toBeUndefined();
    expect(calls[1]?.init.body).toBeUndefined();
  });
});

describe("linkOutUrl", () => {
  it("points at the API's redirect route, which is what makes a click countable", () => {
    expect(linkOutUrl("https://api.example.com", "acme:round-1", "apply")).toBe(
      "https://api.example.com/v1/r/acme%3Around-1/apply",
    );
    expect(linkOutUrl("https://api.example.com", "acme:1", "source")).toBe(
      "https://api.example.com/v1/r/acme%3A1/source",
    );
  });
});

/**
 * The two-route read behind every link into `/listings/[id]`.
 *
 * The review queue, the claims list and the duplicate pairs all link a reviewer to entries they do
 * not own, and the owner route answers those with a 404. What must NOT happen is the fallback
 * firing for anything else: a submitter must not probe a reviewer route, and a 401 must not be
 * retried against a route that will answer the same way.
 */
describe("loadOpportunity", () => {
  const client = (responder: (call: Call) => Response) => {
    const { fetchImpl, calls } = stubFetch(responder);
    return {
      api: createApiClient({
        baseUrl: "https://api.example.com",
        getToken: async () => "token",
        fetchImpl,
      }),
      calls,
    };
  };

  it("reads an owned entry through the owner route and stops there", async () => {
    const { api, calls } = client(() => json({ id: "acme:1", title: "Mine" }));

    await expect(loadOpportunity(api, "acme:1", true)).resolves.toMatchObject({ id: "acme:1" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.com/v1/me/opportunities/acme%3A1",
    ]);
  });

  it("falls back to the reviewer route for an entry a reviewer does not own", async () => {
    const { api, calls } = client((call) =>
      call.url.includes("/v1/me/")
        ? json({ error: "not_found", message: "no opportunity of yours." }, 404)
        : json({ id: "other:1", title: "Somebody else's" }),
    );

    await expect(loadOpportunity(api, "other:1", true)).resolves.toMatchObject({ id: "other:1" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.com/v1/me/opportunities/other%3A1",
      "https://api.example.com/v1/review/opportunities/other%3A1",
    ]);
  });

  it("does not reach for the reviewer route without the role", async () => {
    const { api, calls } = client(() => json({ error: "not_found", message: "no." }, 404));

    await expect(loadOpportunity(api, "other:1", false)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it("passes a non-404 failure straight through, whatever the role", async () => {
    const { api, calls } = client(() => json({ error: "unauthorized", message: "no." }, 401));

    await expect(loadOpportunity(api, "other:1", true)).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });
});

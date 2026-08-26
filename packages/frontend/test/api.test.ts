/**
 * The API wrapper is the only module in this package that touches the network, so it is the only
 * one whose failure modes have to be proven rather than assumed. Each test here corresponds to a
 * behaviour a page depends on: the token is attached, a failure is an `ApiError` carrying the API's
 * own code, and a body that is not JSON is not silently treated as one.
 */
import {
  ApiError,
  createApiClient,
  linkOutUrl,
  loadManagedOpportunity,
  loadOpportunity,
} from "@/lib/api";
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

    await api.me.opportunities({
      reviewStatus: undefined,
      publisherStatus: "hidden",
      page: 2,
      limit: 20,
    });

    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/me/opportunities?publisherStatus=hidden&page=2&limit=20",
    );
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
          issues: [
            { path: "/title", message: "must be a string" },
            { path: "/fundingDetails", message: "must have fundingType" },
          ],
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
    expect(error.issues).toEqual([
      { path: "/title", message: "must be a string" },
      { path: "/fundingDetails", message: "must have fundingType" },
    ]);
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

  it("reopens a dismissed duplicate through the pair route without a body", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ id: 17, status: "suspected" }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.review.reopenDuplicate(17);

    expect(calls[0]?.url).toBe("https://api.example.com/v1/review/duplicates/17/reopen");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("lists and settles notifications on the account routes without inventing request bodies", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ items: [], unreadCount: 0 }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.me.notifications({ unread: true, page: 2, limit: 20 });
    await api.me.readNotification(17);
    await api.me.readAllNotifications();

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "https://api.example.com/v1/me/notifications?unread=true&page=2&limit=20"],
      ["POST", "https://api.example.com/v1/me/notifications/17/read"],
      ["POST", "https://api.example.com/v1/me/notifications/read-all"],
    ]);
    expect(calls[1]?.init.body).toBeUndefined();
    expect(calls[2]?.init.body).toBeUndefined();
  });

  it("lists, creates and revokes membership invites on the reviewer organization route", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ items: [] }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.review.membershipInvites("filecoin foundation");
    await api.review.inviteMembership("filecoin foundation", {
      email: "person@example.org",
      role: "owner",
    });
    await api.review.revokeMembershipInvite("filecoin foundation", 14);

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "https://api.example.com/v1/review/organizations/filecoin%20foundation/invites"],
      ["POST", "https://api.example.com/v1/review/organizations/filecoin%20foundation/invites"],
      [
        "DELETE",
        "https://api.example.com/v1/review/organizations/filecoin%20foundation/invites/14",
      ],
    ]);
    expect(calls[1]?.init.body).toBe(
      JSON.stringify({ email: "person@example.org", role: "owner" }),
    );
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

/**
 * The two routes the public browse pages read. They are unauthenticated, and the point of testing
 * them here is that they stay that way: a directory that only worked for a signed-in reader would
 * look perfectly fine to whoever built it.
 */
describe("the public directory", () => {
  it("lists through the public route with no credential at all", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ items: [], page: 1, limit: 20, total: 0, totalPages: 1 }),
    );
    const api = createApiClient({
      baseUrl: "https://api.example.com",
      getToken: async () => null,
      fetchImpl,
    });

    await api.directory.list({ q: "zk", fundingType: "grant", sort: "postedAt", order: "desc" });

    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/opportunities?q=zk&fundingType=grant&sort=postedAt&order=desc",
    );
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("reads one entry through the route the API counts as a detail view", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ id: "acme:round-1" }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.directory.find("acme:round-1");

    expect(calls[0]?.url).toBe("https://api.example.com/v1/opportunities/acme%3Around-1");
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

describe("loadManagedOpportunity", () => {
  const row = {
    id: "acme:1",
    title: "One",
    fundingType: "grant",
    status: "archived",
    reviewStatus: "rejected",
    isListed: false,
    namespace: "acme",
    submittedBy: "acme",
    mergedInto: { id: "acme:2", title: "Two" },
    lastDecision: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
  };
  const page = (items: (typeof row)[]) => ({
    items,
    page: 1,
    limit: 1,
    total: items.length,
    totalPages: 1,
  });

  it("queries the owner list by exact id and stops when it finds the row", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(page([row])));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await expect(loadManagedOpportunity(api, "acme:1", true)).resolves.toMatchObject(row);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.com/v1/me/opportunities?id=acme%3A1&limit=1",
    ]);
  });

  it("falls back to the reviewer list when the owner-scoped id lookup is empty", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.includes("/v1/me/opportunities") ? json(page([])) : json(page([row])),
    );
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await expect(loadManagedOpportunity(api, "acme:1", true)).resolves.toMatchObject(row);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.com/v1/me/opportunities?id=acme%3A1&limit=1",
      "https://api.example.com/v1/review/opportunities?id=acme%3A1&limit=1",
    ]);
  });

  it("does not probe the reviewer list for an account without that role", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(page([])));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await expect(loadManagedOpportunity(api, "acme:1", false)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(calls).toHaveLength(1);
  });
});

/**
 * AN ORGANIZATION ACTING ON ITSELF — four routes whose URLs carry the authorisation.
 *
 * The slug and the id are both in the path, and the API scopes the decision by BOTH: a listing filed
 * under another organization answers 404 rather than 403, so a mis-encoded slug does not silently
 * decide somebody else's queue. That makes the exact path worth pinning.
 */
describe("the organization routes", () => {
  it("lists a namespace's own listings, filtered and paginated", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ items: [], page: 1, limit: 20, total: 0, totalPages: 1 }),
    );
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.organizations.opportunities("filecoin", { reviewStatus: "pending", limit: 50 });

    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/organizations/filecoin/opportunities?reviewStatus=pending&limit=50",
    );
  });

  it("approves with no body — the route declares none", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ id: "filecoin:1", reviewStatus: "approved", isListed: true }),
    );
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.organizations.approve("filecoin", "filecoin:1");

    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/organizations/filecoin/opportunities/filecoin%3A1/approve",
    );
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("sends the reason on a rejection, which the API requires", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ id: "filecoin:1", reviewStatus: "rejected", isListed: false }),
    );
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.organizations.reject("filecoin", "filecoin:1", "not our programme");

    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/organizations/filecoin/opportunities/filecoin%3A1/reject",
    );
    expect(calls[0]?.init.body).toBe(JSON.stringify({ reason: "not our programme" }));
  });

  it("patches the directory entry, sending null to clear rather than omitting", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ slug: "filecoin", name: "Filecoin" }));
    const api = createApiClient({ baseUrl: "https://api.example.com", fetchImpl });

    await api.organizations.update("filecoin", { name: "Filecoin", website: null });

    expect(calls[0]?.url).toBe("https://api.example.com/v1/organizations/filecoin");
    expect(calls[0]?.init.method).toBe("PATCH");
    // `null` and "absent" are different instructions; a form that could only omit could never
    // empty a website field.
    expect(calls[0]?.init.body).toBe(JSON.stringify({ name: "Filecoin", website: null }));
  });
});

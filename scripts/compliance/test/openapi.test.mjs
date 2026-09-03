/**
 * Criterion 2 against a real socket: what the checker says about an operation whose declared media
 * type is not JSON.
 *
 * The bug these cases exist for: `validateAgainstResponse` matched the response's declared media
 * type and then parsed the body as JSON unconditionally, so `/v1/feeds/opportunities.atom` and
 * `.rss` — documented, served and correct — failed criterion 2 with "body is not valid JSON:
 * Unexpected token '<'", and the whole sign-off run went red against any deployment carrying feeds.
 * The first case below is the one that fails against that code.
 *
 * Everything runs over a throwaway `node:http` server rather than a mocked `request`, because the
 * thing under test is exactly the handling of what comes back over the wire: bytes, a status and a
 * `Content-Type` header. The served OpenAPI document declares one XML operation and one JSON one,
 * so each case also demonstrates that the JSON half of the criterion is untouched.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkOpenApi } from "../checks/openapi.mjs";
import { Report } from "../report.mjs";

const FEED = "/v1/feeds/opportunities.atom";
const HEALTH = "/v1/health";
const REDIRECT = "/v1/r/{id}/apply";
const ME = "/v1/me/opportunities";
const FEED_CHECK = `GET ${FEED} conforms to its published contract`;
const HEALTH_CHECK = `GET ${HEALTH} conforms to its published contract`;
const REDIRECT_CHECK = `GET ${REDIRECT} conforms to its published contract`;
const ME_ANON_CHECK = `GET ${ME} refuses an anonymous caller as documented`;
const ME_PUBLIC_CHECK = `GET ${ME} conforms to its published contract`;
const ME_401_DOC_CHECK = `GET ${ME} documents a 401 response`;
const ME_NEGATIVE_SKIP = `GET ${ME} is held to the strict-query negative contract`;
const ME_UNKNOWN_PARAM_CHECK = `GET ${ME} rejects an undocumented query parameter`;
/** A secured template the checker has no representative value for — no `{slug}` is discoverable. */
const ORG = "/v1/organizations/{slug}/opportunities";
const ORG_ANON_CHECK = `GET ${ORG} refuses an anonymous caller as documented`;
const ORG_NEGATIVE_SKIP = `GET ${ORG} is held to the strict-query negative contract`;

/** What the API actually answers an anonymous caller on a secured route. */
const UNAUTHORIZED = {
  status: 401,
  type: "application/json",
  body: '{"error":"unauthorized","message":"Missing bearer token."}',
};

/** A feed shaped like the one packages/api's mapper emits, escaping and all. */
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://example.org/v1/feeds/opportunities.atom</id>
  <title>RFP Hub — recent opportunities</title>
  <updated>2026-01-01T00:00:00.000Z</updated>
  <link rel="self" type="application/atom+xml" href="https://example.org/v1/feeds/opportunities.atom"/>
  <entry>
    <id>https://example.org/v1/opportunities/x</id>
    <title>R&amp;D &quot;grants&quot;</title>
    <updated>2026-01-01T00:00:00.000Z</updated>
    <link rel="alternate" href="https://example.org/apply?a=1&amp;b=2"/>
    <summary type="text">A grant.</summary>
  </entry>
</feed>
`;

/**
 * The published document: one operation per media-type family, each declaring exactly what the API
 * declares for it — a `$ref` component for JSON, and for XML the `type: "string"` placeholder that
 * packages/api/src/modules/routes/feeds/index.ts uses, since an XML document has no JSON Schema.
 */
const documentFor = (base, { redirect, me } = {}) => ({
  openapi: "3.1.0",
  info: { title: "RFP Hub API (test double)", version: "1.0.0" },
  servers: [{ url: base }],
  // Document-level `security` is the inherited case: an operation that declares none of its own
  // is closed by it, and only an explicit `security: []` opts back out.
  ...(me?.docSecurity ? { security: me.docSecurity } : {}),
  paths: {
    // A secured template whose path parameter the checker cannot discover a value for, carrying a
    // required query parameter it cannot build a value for either (a bare `type: string` declares
    // no example, default or enum). Neither is a reason to leave the refusal unverified.
    ...(me?.template
      ? {
          [ORG]: {
            get: {
              operationId: "listOrganizationOpportunities",
              ...(me.security === undefined ? {} : { security: me.security }),
              parameters: [
                { name: "slug", in: "path", required: true, schema: { type: "string" } },
                { name: "cursor", in: "query", required: true, schema: { type: "string" } },
              ],
              responses: {
                200: {
                  description: "The organization's opportunities",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/MyList" } },
                  },
                },
                401: {
                  description: "Unauthorized",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
                  },
                },
              },
            },
          },
        }
      : {}),
    // The authenticated surface: an operation the checker holds no credential for. Declared only
    // when a case asks for it, like the redirect above.
    ...(me
      ? {
          [ME]: {
            get: {
              operationId: "listMyOpportunities",
              ...(me.security === undefined ? {} : { security: me.security }),
              parameters: [{ name: "page", in: "query", schema: { type: "integer", minimum: 1 } }],
              responses: {
                200: {
                  description: "The caller's own opportunities",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/MyList" } },
                  },
                },
                400: {
                  description: "Invalid query",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
                  },
                },
                ...(me.omit401
                  ? {}
                  : {
                      401: {
                        description: "Unauthorized",
                        content: {
                          "application/json": {
                            schema: { $ref: "#/components/schemas/ErrorResponse" },
                          },
                        },
                      },
                    }),
              },
            },
          },
        }
      : {}),
    // The link-out shape: an operation whose CORRECT answer is a redirect. Declared only when a
    // case asks for it, so the other cases keep exercising exactly what they did before.
    ...(redirect
      ? {
          [REDIRECT]: {
            get: {
              operationId: "redirectToApplication",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              responses: {
                302: {
                  description: "Redirect to the application URL",
                  headers: { Location: { schema: { type: "string", format: "uri" } } },
                },
              },
            },
          },
        }
      : {}),
    [HEALTH]: {
      get: {
        operationId: "getHealth",
        responses: {
          200: {
            description: "healthy",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
          },
        },
      },
    },
    [FEED]: {
      get: {
        operationId: "getOpportunitiesAtomFeed",
        responses: {
          200: {
            description: "An Atom 1.0 feed",
            content: {
              "application/atom+xml": { schema: { type: "string", description: "Atom 1.0" } },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      Health: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string" } },
        additionalProperties: false,
      },
      MyList: {
        type: "object",
        required: ["items"],
        properties: { items: { type: "array" } },
        additionalProperties: false,
      },
      ErrorResponse: {
        type: "object",
        required: ["error", "message"],
        properties: { error: { type: "string" }, message: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
});

let running;

/** Serve the document plus whatever the case wants at each operation, and run criterion 2 on it. */
async function runCriterion({
  feed = { type: "application/atom+xml", body: ATOM },
  health = { type: "application/json", body: '{"status":"ok"}' },
  redirect,
  me,
}) {
  const server = createServer((req, res) => {
    const { pathname, search } = new URL(req.url, "http://127.0.0.1");
    const send = ({ status = 200, type, body = "", headers = {} }) => {
      res.writeHead(status, { ...(type ? { "content-type": type } : {}), ...headers });
      res.end(body);
    };
    if (pathname === "/v1/docs")
      return send({ type: "text/html", body: "<!doctype html><title>d" });
    if (pathname === "/v1/docs/json") {
      return send({
        type: "application/json",
        body: JSON.stringify(
          documentFor(`http://127.0.0.1:${server.address().port}`, { redirect, me }),
        ),
      });
    }
    // The checker discovers a representative `{id}` from the live list endpoint, so a case with a
    // path-parameterised operation needs one entry here or the operation is reported as skipped.
    if (pathname === "/v1/opportunities") {
      return send({ type: "application/json", body: '{"items":[{"id":"example:one"}],"total":1}' });
    }
    // Matched by shape: the id arrives percent-encoded (`example%3Aone`) and `pathname` does not
    // decode it.
    if (redirect && /^\/v1\/r\/.+\/apply$/.test(pathname)) return send(redirect);
    // The authenticated route. `serve` is what an ANONYMOUS caller gets — 401 unless a case is
    // demonstrating the defect where it is not. A query string only ever arrives here from the
    // strict-query probes, and the API's own answer to those, once past auth, is a 400.
    // Route-shaped, parameter unread: exactly how the API answers before the handler runs.
    if (me?.template && /^\/v1\/organizations\/.+\/opportunities$/.test(pathname)) {
      return send(me.serveTemplate ?? UNAUTHORIZED);
    }
    if (me && pathname === ME) {
      if (search) {
        return send({
          status: 400,
          type: "application/json",
          body: '{"error":"bad_request","message":"Unknown or invalid query parameter."}',
        });
      }
      return send(me.serve ?? UNAUTHORIZED);
    }
    if (pathname === HEALTH) return send(health);
    if (pathname === FEED) return send(feed);
    send({ status: 404, type: "application/json", body: '{"error":{"code":"not_found"}}' });
  });
  running = server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const report = new Report({ baseUrl, exportUrl: baseUrl });
  const { criterion } = await checkOpenApi(report, { baseUrl, timeoutMs: 5000 });
  return criterion;
}

const checkNamed = (criterion, name) => criterion.checks.find((c) => c.name === name);

afterEach(async () => {
  if (running) await new Promise((resolve) => running.close(resolve));
  running = undefined;
});

describe("criterion 2 — an operation whose declared media type is not JSON", () => {
  it("passes a well-formed XML body served under the media type the operation declares", async () => {
    // THE REGRESSION. Against the pre-fix checker this check is a FAIL reading
    // "body is not valid JSON: Unexpected token '<'", because the body was parsed as JSON the
    // moment its media type matched.
    const criterion = await runCriterion({ feed: { type: "application/atom+xml", body: ATOM } });
    const check = checkNamed(criterion, FEED_CHECK);
    expect(check.detail).not.toMatch(/not valid JSON/);
    expect(check.status).toBe("pass");
  });

  it("says which half of the contract it verified, and which did not apply", async () => {
    const criterion = await runCriterion({
      // The charset parameter is part of what the API actually sends; the media type still matches.
      feed: { type: "application/atom+xml; charset=utf-8", body: ATOM },
    });
    const check = checkNamed(criterion, FEED_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/schema validation is not applicable/);
    expect(check.detail).toMatch(/verified the documented status, the declared content type/);
    expect(check.detail).toMatch(/well-formedness \(root <feed>, 11 elements\)/);
    // And it never claims a validation it did not perform.
    expect(check.detail).not.toMatch(/body validates against/);
  });

  it("fails a JSON body served under an XML media type", async () => {
    const criterion = await runCriterion({
      feed: { type: "application/atom+xml", body: '{"items":[],"total":0}' },
    });
    const check = checkNamed(criterion, FEED_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/not well-formed XML/);
  });

  it("fails a body that is not well-formed XML", async () => {
    const criterion = await runCriterion({
      // A serializer that forgot to escape an ampersand: 200, right content type, unreadable feed.
      feed: {
        type: "application/atom+xml",
        body: "<feed><entry><title>R&D grants</title></entry></feed>",
      },
    });
    const check = checkNamed(criterion, FEED_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/not well-formed XML: unescaped '&'/);
  });

  it("fails an empty body under a media type the operation declares a document for", async () => {
    const criterion = await runCriterion({ feed: { type: "application/atom+xml", body: "" } });
    const check = checkNamed(criterion, FEED_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/empty body/);
  });

  it("fails a content type the operation does not declare, XML or not", async () => {
    const criterion = await runCriterion({
      feed: { type: "application/json", body: '{"items":[]}' },
    });
    const check = checkNamed(criterion, FEED_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/which the operation does not declare/);
  });
});

describe("criterion 2 — the JSON half is unchanged", () => {
  it("still validates a JSON body against the schema the operation declares", async () => {
    const criterion = await runCriterion({ feed: { type: "application/atom+xml", body: ATOM } });
    const check = checkNamed(criterion, HEALTH_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/body validates against Health/);
  });

  it("still fails a JSON body that violates the declared schema", async () => {
    const criterion = await runCriterion({
      feed: { type: "application/atom+xml", body: ATOM },
      health: { type: "application/json", body: '{"status":3,"extra":true}' },
    });
    const check = checkNamed(criterion, HEALTH_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/violates the declared application\/json schema/);
  });

  it("still fails a body that is not valid JSON under a JSON media type", async () => {
    const criterion = await runCriterion({
      feed: { type: "application/atom+xml", body: ATOM },
      health: { type: "application/json", body: "<html>502</html>" },
    });
    const check = checkNamed(criterion, HEALTH_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/body is not valid JSON/);
  });
});

/**
 * THE REDIRECT CASE — and the reason the client stopped following redirects.
 *
 * The checker executes every operation the PUBLISHED document declares, and the nightly workflow
 * fails the job on a non-zero exit. So the moment the API publishes a link-out operation whose
 * documented answer is a `302`, a following client fetches the DESTINATION SITE and judges that
 * site's `200 text/html` against a declared `302`. Correct route, correct document, red gate.
 *
 * The first case below is the one that fails against a following client. The rest are what
 * "validate a redirect" has to mean once the body is no longer the thing being checked.
 */
describe("criterion 2 — an operation whose documented answer IS a redirect", () => {
  const applyUrl = "https://example.org/apply?ref=hub";

  it("passes a 302 that carries a usable Location, without fetching the destination", async () => {
    const criterion = await runCriterion({
      redirect: { status: 302, headers: { location: applyUrl } },
    });
    const check = checkNamed(criterion, REDIRECT_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/a documented redirect: 302/);
    expect(check.detail).toMatch(/deliberately not fetched/);
    // Against a following client this read "answered 200, which the operation does not document".
    expect(check.detail).not.toMatch(/does not document/);
  });

  it("says whether the operation declares the Location header a client needs", async () => {
    const criterion = await runCriterion({
      redirect: { status: 302, headers: { location: applyUrl } },
    });
    expect(checkNamed(criterion, REDIRECT_CHECK).detail).toMatch(
      /the operation declares the Location header/,
    );
  });

  // A redirect with nowhere to go is a dead end no client can act on, and it answers with the
  // right status — so only a Location check catches it.
  it("fails a 302 with no Location", async () => {
    const criterion = await runCriterion({ redirect: { status: 302 } });
    const check = checkNamed(criterion, REDIRECT_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/no Location header/);
  });

  // Worse than a dead end: it looks like a working link-out until somebody clicks it.
  it("fails a Location whose scheme a browser will not navigate to", async () => {
    const criterion = await runCriterion({
      redirect: { status: 302, headers: { location: "javascript:alert(1)" } },
    });
    const check = checkNamed(criterion, REDIRECT_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/must be http\(s\)/);
  });

  it("still fails an operation that answers a status it does not document", async () => {
    const criterion = await runCriterion({
      redirect: { status: 200, type: "text/html", body: "<h1>the destination page</h1>" },
    });
    const check = checkNamed(criterion, REDIRECT_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/does not document/);
  });
});

/**
 * THE SECURED-OPERATION CASE — and the reason the checker reads `security` at all.
 *
 * The checker holds no credential. Once the API published its authenticated surface
 * (`/v1/me/opportunities`, `/v1/review/…`, `/v1/keys`, …), every one of those operations was
 * enumerated like any other: the positive probe was judged against a documented 200 the anonymous
 * checker could never be served, and the strict-query probes demanded a 400 where the deployment
 * correctly answers 401 — authentication runs in an `onRequest` hook, ahead of query validation,
 * so that a caller without a credential learns nothing about the shape of the query. The nightly
 * open-data export's gate went red on an API that was behaving exactly as documented.
 *
 * So a secured operation is held to the OTHER thing its document promises: the refusal.
 */
describe("criterion 2 — an operation the document says needs a credential", () => {
  const secured = { security: [{ bearerAuth: [] }] };

  it("passes a secured operation that refuses the anonymous caller with its documented 401", async () => {
    // Against the pre-fix checker this check read "answered 401, which the operation does not
    // document" — it does document it — or, worse, was never asked the right question at all.
    const criterion = await runCriterion({ me: secured });
    const check = checkNamed(criterion, ME_ANON_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/→ 401 application\/json/);
    expect(check.detail).toMatch(/body validates against ErrorResponse/);
    // The old name belongs to the public contract, which is not what was verified here.
    expect(checkNamed(criterion, ME_PUBLIC_CHECK)).toBeUndefined();
  });

  it("FAILS a secured operation that serves an anonymous caller a 200", async () => {
    // The worse defect of the two this criterion can find here: the published security
    // requirement is decoration, and the body validating against the declared schema does not
    // redeem it. A checker that graded the body would report this as a pass.
    const criterion = await runCriterion({
      me: { ...secured, serve: { type: "application/json", body: '{"items":[]}' } },
    });
    const check = checkNamed(criterion, ME_ANON_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/→ 200, expected 401/);
    expect(check.detail).toMatch(/the published requirement is not enforced/);
  });

  it("holds the refusal body to the declared error schema", async () => {
    const criterion = await runCriterion({
      me: {
        ...secured,
        serve: { status: 401, type: "application/json", body: '{"error":"unauthorized"}' },
      },
    });
    const check = checkNamed(criterion, ME_ANON_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/→ 401 as documented, but/);
    expect(check.detail).toMatch(/violates the declared application\/json schema/);
  });

  it("reports a secured operation that documents no 401 as a documentation defect, and still checks the body", async () => {
    const criterion = await runCriterion({ me: { ...secured, omit401: true } });
    const defect = checkNamed(criterion, ME_401_DOC_CHECK);
    expect(defect.status).toBe("fail");
    expect(defect.detail).toMatch(/do not describe one/);
    // Falling back to the shared ErrorResponse means the refusal is still verified, not waved past.
    const check = checkNamed(criterion, ME_ANON_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/body validates against ErrorResponse/);
  });

  it("defers the strict-query contract of a secured operation, by name, rather than probing it", async () => {
    const criterion = await runCriterion({ me: secured });
    const skip = checkNamed(criterion, ME_NEGATIVE_SKIP);
    expect(skip.status).toBe("skip");
    expect(skip.detail).toMatch(/authentication precedes validation by design/);
    expect(skip.detail).toMatch(/must be verified with a credential/);
    // The probe that produced the production failure is not issued at all.
    expect(checkNamed(criterion, ME_UNKNOWN_PARAM_CHECK)).toBeUndefined();
    expect(criterion.checks.some((c) => /rejects page=0/.test(c.name))).toBe(false);
  });

  it("treats an operation with no security of its own as closed under a document-level requirement", async () => {
    const criterion = await runCriterion({
      me: { docSecurity: [{ bearerAuth: [] }], security: undefined },
    });
    expect(checkNamed(criterion, ME_ANON_CHECK).status).toBe("pass");
    expect(checkNamed(criterion, ME_NEGATIVE_SKIP).status).toBe("skip");
  });

  it("honours an operation-level `security: []` opting back out of a document-level requirement", async () => {
    const criterion = await runCriterion({
      me: {
        docSecurity: [{ bearerAuth: [] }],
        security: [],
        serve: { type: "application/json", body: '{"items":[]}' },
      },
    });
    // Public again: the documented 200 is exercised under the old name, and the strict-query
    // probes are issued rather than deferred.
    const check = checkNamed(criterion, ME_PUBLIC_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/body validates against MyList/);
    expect(checkNamed(criterion, ME_ANON_CHECK)).toBeUndefined();
    expect(checkNamed(criterion, ME_NEGATIVE_SKIP)).toBeUndefined();
    expect(checkNamed(criterion, ME_UNKNOWN_PARAM_CHECK).status).toBe("pass");
    expect(criterion.checks.some((c) => /rejects page=0/.test(c.name))).toBe(true);
  });

  it("leaves an operation the document says nothing about entirely alone", async () => {
    // The public half of the surface, under a document that now carries security schemes: same
    // check name, same verdict, same negative probes as before any of this existed.
    const criterion = await runCriterion({ me: secured });
    expect(checkNamed(criterion, HEALTH_CHECK).status).toBe("pass");
    expect(checkNamed(criterion, FEED_CHECK).status).toBe("pass");
    expect(
      criterion.checks.some(
        (c) => c.name === `GET ${HEALTH} refuses an anonymous caller as documented`,
      ),
    ).toBe(false);
  });
});

/**
 * The three ways this check can quietly stop checking, each one found in review rather than in
 * production — which is the point: every one of them reads as a green or grey line in the report.
 */
describe("criterion 2 — the ways a secured operation can go unverified", () => {
  const secured = { security: [{ bearerAuth: [] }] };

  // FINDING 1. The entries of a security requirement are ALTERNATIVES. `[{}, {bearerAuth: []}]`
  // says "a credential if you have one, otherwise come in anyway" — which is what an API does for
  // an endpoint whose response is richer when signed in. Treating it as secured would demand a 401
  // from an operation documented to serve everyone, turning the fix into the original bug with the
  // sign flipped.
  it("treats an empty alternative alongside a scheme as the anonymous door it is", async () => {
    const criterion = await runCriterion({
      me: {
        security: [{}, { bearerAuth: [] }],
        serve: { type: "application/json", body: '{"items":[]}' },
      },
    });
    const check = checkNamed(criterion, ME_PUBLIC_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/body validates against MyList/);
    expect(checkNamed(criterion, ME_ANON_CHECK)).toBeUndefined();
    // And its strict-query contract IS this run's business, because an anonymous caller reaches it.
    expect(checkNamed(criterion, ME_NEGATIVE_SKIP)).toBeUndefined();
    expect(checkNamed(criterion, ME_UNKNOWN_PARAM_CHECK).status).toBe("pass");
  });

  it("still requires a credential when every alternative names a scheme", async () => {
    const criterion = await runCriterion({
      me: { security: [{ bearerAuth: [] }, { cookieAuth: [] }] },
    });
    expect(checkNamed(criterion, ME_ANON_CHECK).status).toBe("pass");
  });

  // FINDING 2. `/v1/organizations/{slug}/opportunities` was reported as skipped — "no
  // representative value is available for path parameter {slug}" — which is true of the RECORD and
  // irrelevant to the question. The refusal is issued in an onRequest hook, ahead of the route's
  // own parameters, so a route-shaped placeholder gets the same 401 and the check is real.
  it("probes a secured template it has no representative path value for, rather than skipping it", async () => {
    const criterion = await runCriterion({ me: { ...secured, template: true } });
    const check = checkNamed(criterion, ORG_ANON_CHECK);
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/→ 401 application\/json/);
    expect(check.detail).toMatch(/body validates against ErrorResponse/);
    expect(check.detail).not.toMatch(/no representative value/);
  });

  it("catches a secured template that serves an anonymous caller, placeholder and all", async () => {
    const criterion = await runCriterion({
      me: {
        ...secured,
        template: true,
        serveTemplate: { type: "application/json", body: '{"items":[]}' },
      },
    });
    const check = checkNamed(criterion, ORG_ANON_CHECK);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/→ 200, expected 401/);
  });

  it("keeps skipping a PUBLIC operation it cannot build a request for", async () => {
    // The skip is right there: without an id there is no record to ask about, and the documented
    // 200 is a statement about a record. Only the secured case changed.
    const criterion = await runCriterion({
      me: { security: [], docSecurity: [{ bearerAuth: [] }], template: true },
    });
    const check = checkNamed(criterion, `GET ${ORG} conforms to its published contract`);
    expect(check.status).toBe("skip");
    expect(check.detail).toMatch(
      /no representative value is available for path parameter \{slug\}/,
    );
  });

  // FINDING 3. The named skip is the README's promise — one per secured operation — and the
  // resolvability gate sat in front of it, silently swallowing exactly the operations whose paths
  // the run knows least about.
  it("names the deferred strict-query contract even when the path is unresolvable", async () => {
    const criterion = await runCriterion({ me: { ...secured, template: true } });
    const skip = checkNamed(criterion, ORG_NEGATIVE_SKIP);
    expect(skip.status).toBe("skip");
    expect(skip.detail).toMatch(/authentication precedes validation by design/);
  });
});

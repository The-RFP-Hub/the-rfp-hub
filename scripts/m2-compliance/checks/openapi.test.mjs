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
import { Report } from "../report.mjs";
import { checkOpenApi } from "./openapi.mjs";

const FEED = "/v1/feeds/opportunities.atom";
const HEALTH = "/v1/health";
const REDIRECT = "/v1/r/{id}/apply";
const FEED_CHECK = `GET ${FEED} conforms to its published contract`;
const HEALTH_CHECK = `GET ${HEALTH} conforms to its published contract`;
const REDIRECT_CHECK = `GET ${REDIRECT} conforms to its published contract`;

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
const documentFor = (base, { redirect } = {}) => ({
  openapi: "3.1.0",
  info: { title: "RFP Hub API (test double)", version: "1.0.0" },
  servers: [{ url: base }],
  paths: {
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
    schemas: {
      Health: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string" } },
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
}) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
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
          documentFor(`http://127.0.0.1:${server.address().port}`, { redirect }),
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

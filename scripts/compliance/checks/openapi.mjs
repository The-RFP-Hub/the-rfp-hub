/**
 * Criterion 2 — OpenAPI conformance of the LIVE service to its PUBLISHED document.
 *
 * The document served at `{base}/v1/docs/json` is the only input. For every operation it declares,
 * a representative request goes to the live URL and the answer is held to what that operation
 * says about it: the status must be one the operation documents, the content type must be one it
 * declares, and the body must validate against the schema declared for that pair.
 *
 * "Validate against the schema" is a JSON sentence, and not every operation here serves JSON — the
 * syndication feeds serve Atom and RSS. Those responses are held to everything that still applies
 * (documented status, declared content type, non-empty body, and, for an XML media type, that the
 * document is actually parseable), and the report SAYS that the schema half was not applicable
 * rather than quietly claiming a validation that never happened. See `validateAgainstResponse`.
 *
 * Nothing is enumerated from the repo. The path list, the parameter list, the accepted values and
 * the error contract are all read out of the served document, so this fails when the deployment
 * and its own published spec disagree — which is precisely the failure the in-process test in
 * packages/api/test/integration/openapi.test.ts cannot see, because it builds the app itself.
 *
 * Negative checks are derived the same way: every query parameter the document constrains is
 * probed with a value that violates the published constraint, and the strict contract says that is
 * a 400 — never a silently unfiltered 200.
 *
 * WHO MAY CALL AN OPERATION IS PART OF THAT DOCUMENT TOO, and it is read here rather than assumed.
 * An operation whose every published security alternative names a scheme — its own `security`, or
 * the document's, since an operation-level `security: []` is how one opts back out — cannot be
 * exercised by a checker that holds no credential: its documented 200 is not on offer. So it is
 * held to the other thing the document promises, the one that IS addressed to a caller without a
 * credential: a 401, in a media type the operation declares, whose body validates against the
 * error schema declared for that status. A secured operation that documents no 401 at all is
 * reported as the documentation defect it is. That probe needs no representative path or query
 * value, and does not wait for one — the refusal is issued before the route's own parameters are
 * read, so a route-shaped placeholder reaches it.
 *
 * The negative half is SKIPPED for those operations, out loud, one skip each. This API
 * authenticates in an `onRequest` hook, which runs before query validation, so an anonymous
 * `?page=0` is refused as unauthenticated and never reaches the schema — deliberately, so that a
 * caller without a credential learns nothing about the shape of the query. Reading that 401 as a
 * missing 400 would be the checker misreporting a security property as a defect. The strict-query
 * contract of a secured operation is real, and it has to be verified with a credential.
 */
import { url, asJson, mediaType, request } from "../http.mjs";
import { OpenApiBundle } from "../schema.mjs";
import { checkWellFormed } from "../xml.mjs";

const DOC_PATHS = ["/v1/docs/json", "/v1/docs/openapi.json", "/v1/openapi.json"];
const UNKNOWN_PARAM = "definitely_not_a_documented_parameter";

/**
 * The path segment a secured operation's anonymous probe travels through. It only has to be
 * route-shaped: authentication answers before the parameter is read, so nothing about the record
 * is being asked, and a name that says so keeps the request out of anyone's logs as a lookup.
 */
const ANONYMOUS_PLACEHOLDER = "compliance-anonymous";

/** Why a secured operation's strict-query probes are deferred rather than run. See the header. */
const SECURED_NEGATIVE_REASON =
  "authentication precedes validation by design; the strict-query contract of a secured operation must be verified with a credential";

export async function checkOpenApi(report, ctx) {
  const c = report.criterion(
    "openapi",
    "OpenAPI conformance",
    "Every operation in the PUBLISHED OpenAPI document, executed against the live service and held to its own declared status, media type and response schema — plus the strict-query negative contract.",
  );

  // ── the document itself ──────────────────────────────────────────────────────────────────
  // `follow: true` on the two discovery probes: the question here is "is the documentation
  // reachable", and a UI that redirects to its own trailing-slash form is reachable. The operation
  // loop below is the opposite case and runs with redirects UNfollowed.
  const ui = await request(url(ctx.api, "/v1/docs"), {
    timeoutMs: ctx.timeoutMs,
    follow: true,
  });
  c.expect(
    ui.ok && ui.status === 200,
    "GET /v1/docs serves the API documentation UI",
    `→ 200 (${ui.contentType || "?"})`,
    `→ ${ui.ok ? ui.status : ui.error}`,
  );

  let docRes;
  let docPath;
  for (const candidate of DOC_PATHS) {
    docRes = await request(url(ctx.api, candidate), {
      timeoutMs: ctx.timeoutMs,
      follow: true,
    });
    if (docRes.ok && docRes.status === 200) {
      docPath = candidate;
      break;
    }
  }
  if (!docPath) {
    c.fail(
      "the OpenAPI document is published and fetchable",
      `none of ${DOC_PATHS.join(", ")} answered 200 (last: ${docRes?.ok ? docRes.status : docRes?.error})`,
    );
    return { criterion: c.finish(), doc: null, bundle: null };
  }
  const { json: doc, error: docError } = asJson(docRes);
  if (docError) {
    c.fail("the OpenAPI document is published and fetchable", `${docPath}: ${docError}`);
    return { criterion: c.finish(), doc: null, bundle: null };
  }
  c.pass(
    "the OpenAPI document is published and fetchable",
    `${docPath} → 200 in ${docRes.elapsedMs} ms, ${docRes.body.length} bytes`,
  );

  c.expect(
    String(doc.openapi ?? "").startsWith("3.1"),
    "the document declares OpenAPI 3.1",
    `openapi: ${doc.openapi}`,
    `openapi: ${JSON.stringify(doc.openapi)} — expected 3.1.x`,
  );
  c.info(
    "document identity",
    `${doc.info?.title ?? "?"} ${doc.info?.version ?? "?"}, license ${doc.info?.license?.identifier ?? doc.info?.license?.name ?? "(none declared)"}`,
  );

  // `servers[0].url` is what every generated client will resolve operations against, so on a
  // deployed service it has to be that service's own origin. A relative "/" is correct wherever
  // the document is fetched from, and is what an unconfigured PUBLIC_BASE_URL leaves behind — fine
  // locally, but worth seeing in a sign-off run.
  const server = doc.servers?.[0]?.url;
  if (server === undefined) {
    c.fail("the document advertises a server URL", "servers[] is absent or empty");
  } else if (server === "/") {
    c.warn(
      "the document advertises this deployment's own origin",
      'servers[0].url is the relative "/" — correct wherever the document is fetched from, but a deployed service should publish its own absolute origin (PUBLIC_BASE_URL).',
    );
  } else {
    const same = originOf(server) === originOf(ctx.api);
    c.expect(
      same,
      "the document advertises this deployment's own origin",
      `servers[0].url = ${server}`,
      `servers[0].url = ${server}, but the service under test is ${ctx.api} — every generated client would talk to the wrong host`,
    );
    c.expect(
      !server.endsWith("/"),
      "the advertised server URL carries no trailing slash",
      server,
      `${server} — operations already start with "/", so this resolves to //v1/…`,
    );
  }

  const operations = listOperations(doc);
  c.expect(
    operations.length > 0,
    "the document declares at least one operation",
    `${operations.length} operations over ${Object.keys(doc.paths ?? {}).length} paths`,
    "paths is empty",
  );

  const ids = operations.map((op) => op.operation.operationId).filter(Boolean);
  c.expect(
    ids.length === operations.length && new Set(ids).size === ids.length,
    "every operation carries a unique operationId",
    `${ids.length} unique operationIds`,
    `${operations.length} operations, ${ids.length} with an operationId, ${new Set(ids).size} distinct`,
  );
  const slashed = Object.keys(doc.paths ?? {}).filter((p) => p !== "/" && p.endsWith("/"));
  c.expect(
    slashed.length === 0,
    "no published path carries a trailing slash",
    "collection paths are published in the no-slash form",
    `trailing-slash paths published: ${slashed.join(", ")}`,
  );

  const bundle = new OpenApiBundle(doc);

  // ── a representative path-parameter value, discovered from the live dataset ──────────────
  const sample = await request(url(ctx.api, "/v1/opportunities?limit=1"), {
    timeoutMs: ctx.timeoutMs,
  });
  const sampleId =
    sample.ok && sample.status === 200 ? asJson(sample).json?.items?.[0]?.id : undefined;
  if (sampleId) {
    c.info(
      "representative path parameter",
      `{id} → ${sampleId} (taken from the live list endpoint)`,
    );
  } else {
    c.warn(
      "representative path parameter",
      "no id could be read from GET /v1/opportunities?limit=1 — operations with a path parameter will be reported as not executable here",
    );
  }
  const pathValues = { id: sampleId };

  // ── every documented operation, executed live ────────────────────────────────────────────
  for (const { path, method, operation } of operations) {
    await exerciseOperation(c, ctx, bundle, { path, method, operation, pathValues });
  }

  // ── the strict-query negative contract ───────────────────────────────────────────────────
  await exerciseNegatives(c, ctx, bundle, operations, pathValues);

  return { criterion: c.finish(), doc, bundle };
}

/** Flatten `paths` into `{path, method, operation}` triples, skipping non-operation keys. */
function listOperations(doc) {
  const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
  const out = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (METHODS.has(method.toLowerCase()))
        out.push({ path, method: method.toLowerCase(), operation });
    }
  }
  return out;
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/** The parameters that apply to an operation. */
function parametersOf(operation) {
  return (operation.parameters ?? []).filter((p) => p && typeof p === "object");
}

/**
 * Does the document say this operation needs a credential?
 *
 * The effective requirement is the operation's own `security` when it declares one and the
 * document's top-level `security` otherwise — an override, not a merge. Both levels use the same
 * spelling for "no credential needed": the empty array. An operation-level `security: []` is
 * therefore how a single public operation opts out of a document-level requirement, and it has to
 * mean public here or every operation under such a document would be probed as though it were
 * closed.
 *
 * The entries WITHIN a requirement are alternatives, not conjuncts — the caller satisfies the
 * operation by satisfying any ONE of them. So an entry naming no scheme (`{}`) is the published
 * way of saying the credential is OPTIONAL, and `[{}, {bearerAuth: []}]` admits an anonymous
 * caller just as surely as `[]` does. A credential is required only when EVERY alternative on
 * offer names a scheme; one empty alternative anywhere in the list opens the operation, which is
 * why this reads `every` and not `some`.
 */
export function requiresCredential(document, operation) {
  const effective = operation?.security ?? document?.security;
  if (!Array.isArray(effective) || effective.length === 0) return false;
  return effective.every((entry) => entry && Object.keys(entry).length > 0);
}

/**
 * A value for a REQUIRED parameter, taken from what the document itself says is acceptable.
 * Optional parameters are deliberately left off: the representative request is the one a consumer
 * makes, and the documented defaults are part of what is being verified.
 */
function representativeValue(param) {
  const schema = param.schema ?? {};
  if (param.example !== undefined) return param.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  if (schema.format === "date-time") return new Date().toISOString();
  return undefined;
}

/** Execute one documented operation and hold the answer to what the operation declares. */
async function exerciseOperation(c, ctx, bundle, { path, method, operation, pathValues }) {
  const label = `${method.toUpperCase()} ${path}`;

  if (method !== "get") {
    c.skip(
      `${label} conforms to its published contract`,
      "the checker issues read-only requests only; a published non-GET operation must be verified by hand",
    );
    return;
  }

  // What this checker can even ask of the operation, given that it carries no credential. A
  // secured operation's documented 200 is not on offer to it; its documented 401 is.
  const secured = requiresCredential(bundle.doc, operation);
  const name = secured
    ? `${label} refuses an anonymous caller as documented`
    : `${label} conforms to its published contract`;

  // Path parameters: every `{name}` in the template needs a value.
  //
  // A PUBLIC operation needs a real one — the question being asked of it is about a record, and
  // there is no answer without one. A SECURED operation does not, and insisting on one is how
  // `/v1/organizations/{slug}/opportunities` went unchecked: the refusal happens in an `onRequest`
  // hook, before the route's own parameters are ever looked at, so any route-SHAPED segment
  // reaches the same 401. The placeholder is deliberately not a plausible identifier — nothing
  // about the record is being asked, and the report should not read as though it were.
  let resolved = path;
  for (const key of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
    const value = pathValues[key];
    if (value === undefined && !secured) {
      c.skip(name, `no representative value is available for path parameter {${key}}`);
      return;
    }
    resolved = resolved.replace(
      `{${key}}`,
      value === undefined ? ANONYMOUS_PLACEHOLDER : encodeURIComponent(value),
    );
  }

  // Required query parameters, from the document's own examples/defaults/enums. Same reasoning:
  // an unbuildable one stops a public operation from being exercised at all, but cannot change
  // what a secured operation answers a caller who never gets as far as query validation.
  const qs = new URLSearchParams();
  for (const param of parametersOf(operation)) {
    if (param.in !== "query" || !param.required) continue;
    const value = representativeValue(param);
    if (value === undefined) {
      if (secured) continue;
      c.skip(
        name,
        `required query parameter "${param.name}" declares no example, default or enum to build a request from`,
      );
      return;
    }
    qs.append(param.name, String(value));
  }

  const target = url(ctx.api, resolved) + (qs.toString() ? `?${qs}` : "");
  const res = await request(target, { timeoutMs: ctx.timeoutMs });
  if (!res.ok) {
    c.fail(name, `${target}: ${res.error}`);
    return;
  }

  if (secured) {
    expectAnonymousRefusal(c, bundle, operation, {
      label,
      name,
      res,
      why: "the document declares a security requirement for this operation, so the answer to a caller without a credential is the 401 it publishes — a 200 here would mean the published requirement is not enforced",
    });
    return;
  }

  const declared = operation.responses ?? {};
  const response = responseFor(declared, res.status);
  if (!response) {
    c.fail(
      name,
      `answered ${res.status}, which the operation does not document (it declares ${Object.keys(declared).join(", ") || "nothing"})`,
    );
    return;
  }

  const detail = validateAgainstResponse(bundle, response, res);
  if (detail.ok) {
    c.pass(name, `→ ${res.status} ${res.contentType} in ${res.elapsedMs} ms, ${summarize(detail)}`);
  } else {
    c.fail(name, `→ ${res.status}: ${detail.problem}`);
  }
}

/**
 * Hold a secured operation to what its document promises a caller WITHOUT a credential.
 *
 * The status is the security property: 401, and nothing else. A 200 here is the worse defect of
 * the two this function can report — it means the published security requirement is decoration —
 * so it is a failure of the operation's own check rather than a note beside a pass.
 *
 * The body is then held to the operation's declared 401 exactly as any other status would be:
 * declared media type, declared schema. Where the operation declares no 401 the check falls back
 * to the document's shared `ErrorResponse` so the body is still verified, and records the omission
 * as its own failure — a secured operation that never mentions 401 leaves every generated client
 * without a description of the one answer an unauthenticated caller is guaranteed to get.
 */
function expectAnonymousRefusal(c, bundle, operation, { label, name, res, why }) {
  if (res.status !== 401) {
    c.fail(name, `→ ${res.status}, expected 401 — ${why}. Body: ${res.body.slice(0, 160)}`);
    return;
  }

  // `responseFor` rather than a bare lookup: a `4XX` range or a `default` IS the operation
  // describing this answer, and holding the body to it is holding it to the published contract.
  let declared = responseFor(operation.responses ?? {}, 401);
  if (!declared) {
    c.fail(
      `${label} documents a 401 response`,
      "the operation declares a security requirement, so 401 is part of its published contract for every caller without a credential — but its responses do not describe one. The refusal body was validated against the document's shared ErrorResponse instead.",
    );
    declared = bundle.component("ErrorResponse")
      ? {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
          },
        }
      : {};
  }

  const detail = validateAgainstResponse(bundle, declared, res);
  c.expect(
    detail.ok,
    name,
    `→ 401 ${res.contentType} in ${res.elapsedMs} ms, ${summarize(detail)}`,
    `→ 401 as documented, but ${detail.problem}`,
  );
}

/** The response object a status resolves to: exact, then `4XX`-style range, then `default`. */
function responseFor(responses, status) {
  return (
    responses[String(status)] ??
    responses[`${String(status)[0]}XX`] ??
    responses.default ??
    undefined
  );
}

/**
 * Hold one live response to one declared response object: media type, then schema.
 *
 * A successful result carries either `against` (what the body was validated against, for the JSON
 * case) or `verified` (a full phrase, for the case where schema validation does not apply); render
 * both through `summarize` so the report never says "validates against" about something it did not
 * validate.
 */
function validateAgainstResponse(bundle, response, res) {
  // A redirect is not a body to validate — it is a Location to check. The request that produced
  // `res` did NOT follow it (see `request`'s `follow` option), so this is the redirect the
  // operation itself issued rather than whatever sits at the end of the chain.
  if (res.status >= 300 && res.status < 400) return verifyRedirect(response, res);

  const content = response.content;
  if (!content || Object.keys(content).length === 0) {
    return res.body.length === 0
      ? { ok: true, against: "a declared empty body" }
      : {
          ok: true,
          against: "no declared schema (the operation documents no response body for this status)",
        };
  }
  const key = Object.keys(content).find((k) => mediaType(k) === res.contentType);
  if (!key) {
    return {
      ok: false,
      problem: `served as ${res.contentType || "(no content-type)"}, which the operation does not declare (it declares ${Object.keys(content).join(", ")})`,
    };
  }
  // A JSON Schema describes a JSON value. When the declared media type is not one, the declared
  // schema cannot be applied to the body — parsing it as JSON is not a stricter check, it is a
  // wrong one — so the non-JSON branch verifies what is verifiable and reports the difference.
  if (!isJson(key)) return verifyNonJsonBody(key, res);

  const schema = content[key].schema;
  if (!schema) return { ok: true, against: `${key} with no declared schema` };

  const { json, error } = asJson(res);
  if (error) return { ok: false, problem: error };

  const { valid, errors } = bundle.validate(schema, json);
  if (valid) {
    return {
      ok: true,
      against: schema.$ref ? schema.$ref.split("/").pop() : `the inline ${key} schema`,
    };
  }
  return {
    ok: false,
    problem: `body violates the declared ${key} schema:\n${errors
      .slice(0, 8)
      .map((e) => `  - ${e}`)
      .join("\n")}${errors.length > 8 ? `\n  … and ${errors.length - 8} more` : ""}`,
  };
}

/**
 * Everything a documented redirect can be held to.
 *
 * A `302` with no `Location` is a dead end that no client can act on; a `Location` naming a scheme
 * a browser will not navigate to is worse, because it looks like a working link-out until someone
 * clicks it. Neither shows up in a body check, which is why following the redirect — the previous
 * behaviour — could not verify a redirect operation at all: it verified the destination SITE, and
 * then failed the operation for answering `200 text/html` where `302` was declared.
 *
 * What is NOT checked is deliberate. The destination is a third party's URL that the entry's
 * publisher chose; whether it resolves today is a question for the verification-assist job, not
 * for a conformance run that must not make a request to someone else's server for every published
 * record.
 */
function verifyRedirect(response, res) {
  const location = res.location;
  if (!location) {
    return {
      ok: false,
      problem: `answered ${res.status} with no Location header, so no client can follow it`,
    };
  }

  let resolved;
  try {
    resolved = new URL(location, res.url);
  } catch {
    return { ok: false, problem: `Location is not a usable URL: ${JSON.stringify(location)}` };
  }

  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
    return {
      ok: false,
      problem: `Location uses the ${resolved.protocol} scheme — a link-out must be http(s): ${location}`,
    };
  }

  // The document may declare the header; when it does, say so, because a declared `Location` is
  // what tells a generated client the operation is a redirect rather than an empty response.
  const declaresLocation = Object.keys(response.headers ?? {}).some(
    (name) => name.toLowerCase() === "location",
  );
  const note = declaresLocation
    ? "the operation declares the Location header"
    : "the operation does not declare a Location header, so a generated client is not told this is a link-out";

  return {
    ok: true,
    verified: `a documented redirect: ${res.status} → ${resolved.protocol}//${resolved.host}${resolved.pathname} (${note}); the destination is a third party's URL and is deliberately not fetched`,
  };
}

/** `application/json`, `application/schema+json`, `text/json` — anything a JSON Schema applies to. */
function isJson(type) {
  const value = mediaType(type);
  return value === "application/json" || value === "text/json" || value.endsWith("+json");
}

/** `application/xml`, `text/xml`, `application/atom+xml`, `application/rss+xml`, … */
function isXml(type) {
  const value = mediaType(type);
  return value === "application/xml" || value === "text/xml" || value.endsWith("+xml");
}

/**
 * Everything a response whose media type is not JSON can still be held to.
 *
 * The status was already matched to a documented response and the content type to a declared media
 * type — that is how the caller found `key` — so what is left is the body: it must not be empty,
 * and if the media type says XML it must be a document a reader could actually parse. That last
 * one is the check with teeth: a serializer that forgets to escape an ampersand in a title still
 * answers 200 with the right content type, and only a parse catches it.
 *
 * What is NOT claimed is said out loud. A pass here means "these things held and the schema half
 * did not apply", never "the body validated".
 */
function verifyNonJsonBody(key, res) {
  const bytes = res.body.length;
  if (bytes === 0) {
    return {
      ok: false,
      problem: `served as ${key} with an empty body, but the operation declares a body for this status`,
    };
  }
  if (!isXml(key)) {
    return {
      ok: true,
      verified: `${key} is not a JSON media type: schema validation is not applicable; verified the documented status, the declared content type and a non-empty body (${bytes} bytes)`,
    };
  }
  const xml = checkWellFormed(res.body);
  if (!xml.ok) {
    return {
      ok: false,
      problem: `served as ${key}, but the body is not well-formed XML: ${xml.error}`,
    };
  }
  return {
    ok: true,
    verified: `${key} is an XML media type: schema validation is not applicable; verified the documented status, the declared content type, a non-empty body (${bytes} bytes) and well-formedness (root <${xml.root}>, ${xml.elements} elements)`,
  };
}

/** How one validation result reads in the report — and it only says "validates" when it did. */
function summarize(detail) {
  return detail.verified ?? `body validates against ${detail.against}`;
}

/**
 * The negative half of the contract, derived from the published document rather than assumed:
 *
 *   - an undocumented query parameter is a 400, never a silently unfiltered 200;
 *   - a value outside a documented enum, pattern, format or numeric bound is a 400;
 *   - a path template whose operation documents a 404 actually answers 404 for a missing id;
 *
 * and in every case the error body validates against the error schema the operation declares.
 *
 * None of that is addressable without a credential on a secured operation, and pretending
 * otherwise is how this check reads a security property as a bug: see `SECURED_NEGATIVE_REASON`.
 */
async function exerciseNegatives(c, ctx, bundle, operations, pathValues) {
  let probed = 0;
  let deferred = 0;

  for (const { path, method, operation } of operations) {
    if (method !== "get") continue;
    const queryParams = parametersOf(operation).filter((p) => p.in === "query");
    if (queryParams.length === 0) continue;

    const label = `GET ${path}`;

    // One skip per secured operation, not a silent `continue`: the strict-query contract of these
    // operations is unverified by this run, and the report has to say so by name.
    //
    // AHEAD of the resolvability gate below, and that ordering is the promise. Whether a
    // representative path value happens to exist has nothing to do with why these probes are not
    // issued; letting the gate swallow the operation first would drop the named skip for exactly
    // the secured operations the run knows least about.
    if (requiresCredential(bundle.doc, operation)) {
      c.skip(`${label} is held to the strict-query negative contract`, SECURED_NEGATIVE_REASON);
      deferred++;
      continue;
    }

    let resolved = path;
    let resolvable = true;
    for (const key of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
      if (pathValues[key] === undefined) resolvable = false;
      else resolved = resolved.replace(`{${key}}`, encodeURIComponent(pathValues[key]));
    }
    if (!resolvable) continue;

    probed++;

    // 1. An unknown parameter. The strict contract's headline case: a misspelled filter must fail
    //    loudly rather than return the whole dataset.
    await expect400(c, ctx, bundle, operation, {
      name: `${label} rejects an undocumented query parameter`,
      target: `${url(ctx.api, resolved)}?${UNKNOWN_PARAM}=1`,
      why: "an unknown parameter must be a 400, never a silently unfiltered 200",
    });

    // 2. Every documented constraint, violated on its own terms.
    for (const param of queryParams) {
      const bad = violatingValue(param);
      if (bad === undefined) continue;
      await expect400(c, ctx, bundle, operation, {
        name: `${label} rejects ${param.name}=${bad.value} (${bad.why})`,
        target: `${url(ctx.api, resolved)}?${encodeURIComponent(param.name)}=${encodeURIComponent(bad.value)}`,
        why: `the document constrains ${param.name}: ${bad.why}`,
      });
    }
  }

  if (probed === 0 && deferred === 0) {
    c.skip(
      "the strict-query negative contract",
      "no documented operation declares query parameters to probe",
    );
  }

  // 3. A path template that documents a 404 must answer 404 for an id that does not exist — unless
  //    it is secured, in which case the anonymous probe never gets far enough to learn whether the
  //    record exists, and 401 is the documented answer.
  for (const { path, method, operation } of operations) {
    if (method !== "get" || !path.includes("{")) continue;
    if (!operation.responses?.["404"]) continue;
    const secured = requiresCredential(bundle.doc, operation);
    const label = `GET ${path}`;
    // Deliberately not the same name the positive half gives this operation: that check asked
    // about a record that exists, this one asks about one that does not, and a report that lists
    // the same sentence twice has stopped saying which question was answered.
    const name = secured
      ? `${label} refuses an anonymous caller as documented, for a record that does not exist`
      : `${label} answers 404 for a record that does not exist`;
    const missing = path.replace(/\{[^}]+\}/g, `compliance:no-such-record-${Date.now()}`);
    const target = url(ctx.api, missing);
    const res = await request(target, { timeoutMs: ctx.timeoutMs });
    if (!res.ok) {
      c.fail(name, `${target}: ${res.error}`);
      continue;
    }
    if (secured) {
      expectAnonymousRefusal(c, bundle, operation, {
        label,
        name,
        res,
        why: "the operation is secured, so an anonymous caller is refused before the record is ever looked up — the existence of an id is not something this operation tells an unauthenticated caller",
      });
      continue;
    }
    if (res.status !== 404) {
      c.fail(name, `→ ${res.status} (body: ${res.body.slice(0, 160)})`);
      continue;
    }
    const detail = validateAgainstResponse(bundle, operation.responses["404"], res);
    c.expect(detail.ok, name, `→ 404, ${summarize(detail)}`, `→ 404, but ${detail.problem}`);
  }
}

/** Issue a request that must be rejected, and hold the rejection to the declared 400 schema. */
async function expect400(c, ctx, bundle, operation, { name, target, why }) {
  const res = await request(target, { timeoutMs: ctx.timeoutMs });
  if (!res.ok) {
    c.fail(name, `${target}: ${res.error}`);
    return;
  }
  if (res.status !== 400) {
    c.fail(name, `→ ${res.status}, expected 400 — ${why}. Body: ${res.body.slice(0, 160)}`);
    return;
  }
  const declared = operation.responses?.["400"];
  if (!declared) {
    c.fail(
      name,
      "→ 400 as required, but the operation does not document a 400 response, so the error contract is unpublished",
    );
    return;
  }
  const detail = validateAgainstResponse(bundle, declared, res);
  c.expect(detail.ok, name, `→ 400, ${summarize(detail)}`, `→ 400, but ${detail.problem}`);
}

/**
 * A value that violates whatever the document says about a parameter — or `undefined` when the
 * document constrains it so loosely that no value could violate it (a bare `type: string`).
 */
function violatingValue(param) {
  const schema = param.schema ?? {};
  const items = schema.items ?? {};

  if (Array.isArray(schema.enum)) {
    return { value: "not-in-the-published-enum", why: "outside the documented enum" };
  }
  if (Array.isArray(items.enum)) {
    return { value: "not-in-the-published-enum", why: "outside the documented enum" };
  }
  if (typeof items.pattern === "string") {
    return { value: "not-in-the-published-value-set", why: "outside the documented value set" };
  }
  if (typeof schema.pattern === "string") {
    return {
      value: "not-in-the-published-value-set",
      why: "does not match the documented pattern",
    };
  }
  if (schema.format === "date-time") {
    return { value: "the-thirty-second-of-may", why: "not an RFC 3339 instant" };
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof schema.maximum === "number") {
      return {
        value: String(schema.maximum + 1),
        why: `above the documented maximum of ${schema.maximum}`,
      };
    }
    if (typeof schema.minimum === "number") {
      return {
        value: String(schema.minimum - 1),
        why: `below the documented minimum of ${schema.minimum}`,
      };
    }
    return { value: "not-a-number", why: `not a ${schema.type}` };
  }
  return undefined;
}

export const meta = {
  key: "openapi",
  requires: [],
  needs: ["api"],
  contract: { m2: "M2-2" },
};

export async function run(ctx) {
  // The one read criterion that PRODUCES data: the dataset criterion holds the served documents to
  // the document this one fetched, rather than to a second copy of it.
  ctx.results.openapi = await checkOpenApi(ctx.report, ctx);
}

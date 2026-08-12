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
 */
import { url, asJson, mediaType, request } from "../http.mjs";
import { OpenApiBundle } from "../schema.mjs";
import { checkWellFormed } from "../xml.mjs";

const DOC_PATHS = ["/v1/docs/json", "/v1/docs/openapi.json", "/v1/openapi.json"];
const UNKNOWN_PARAM = "definitely_not_a_documented_parameter";

export async function checkOpenApi(report, ctx) {
  const c = report.criterion(
    "2",
    "OpenAPI conformance",
    "Every operation in the PUBLISHED OpenAPI document, executed against the live service and held to its own declared status, media type and response schema — plus the strict-query negative contract.",
  );

  // ── the document itself ──────────────────────────────────────────────────────────────────
  const ui = await request(url(ctx.baseUrl, "/v1/docs"), { timeoutMs: ctx.timeoutMs });
  c.expect(
    ui.ok && ui.status === 200,
    "GET /v1/docs serves the API documentation UI",
    `→ 200 (${ui.contentType || "?"})`,
    `→ ${ui.ok ? ui.status : ui.error}`,
  );

  let docRes;
  let docPath;
  for (const candidate of DOC_PATHS) {
    docRes = await request(url(ctx.baseUrl, candidate), { timeoutMs: ctx.timeoutMs });
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
    const same = originOf(server) === originOf(ctx.baseUrl);
    c.expect(
      same,
      "the document advertises this deployment's own origin",
      `servers[0].url = ${server}`,
      `servers[0].url = ${server}, but the service under test is ${ctx.baseUrl} — every generated client would talk to the wrong host`,
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
  const sample = await request(url(ctx.baseUrl, "/v1/opportunities?limit=1"), {
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

  // Path parameters: every `{name}` in the template needs a live value.
  let resolved = path;
  for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
    const value = pathValues[name];
    if (value === undefined) {
      c.skip(
        `${label} conforms to its published contract`,
        `no representative value is available for path parameter {${name}}`,
      );
      return;
    }
    resolved = resolved.replace(`{${name}}`, encodeURIComponent(value));
  }

  // Required query parameters, from the document's own examples/defaults/enums.
  const qs = new URLSearchParams();
  for (const param of parametersOf(operation)) {
    if (param.in !== "query" || !param.required) continue;
    const value = representativeValue(param);
    if (value === undefined) {
      c.skip(
        `${label} conforms to its published contract`,
        `required query parameter "${param.name}" declares no example, default or enum to build a request from`,
      );
      return;
    }
    qs.append(param.name, String(value));
  }

  const target = url(ctx.baseUrl, resolved) + (qs.toString() ? `?${qs}` : "");
  const res = await request(target, { timeoutMs: ctx.timeoutMs });
  if (!res.ok) {
    c.fail(`${label} conforms to its published contract`, `${target}: ${res.error}`);
    return;
  }

  const declared = operation.responses ?? {};
  const response = responseFor(declared, res.status);
  if (!response) {
    c.fail(
      `${label} conforms to its published contract`,
      `answered ${res.status}, which the operation does not document (it declares ${Object.keys(declared).join(", ") || "nothing"})`,
    );
    return;
  }

  const detail = validateAgainstResponse(bundle, response, res);
  if (detail.ok) {
    c.pass(
      `${label} conforms to its published contract`,
      `→ ${res.status} ${res.contentType} in ${res.elapsedMs} ms, ${summarize(detail)}`,
    );
  } else {
    c.fail(`${label} conforms to its published contract`, `→ ${res.status}: ${detail.problem}`);
  }
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
 */
async function exerciseNegatives(c, ctx, bundle, operations, pathValues) {
  let probed = 0;

  for (const { path, method, operation } of operations) {
    if (method !== "get") continue;
    const queryParams = parametersOf(operation).filter((p) => p.in === "query");
    let resolved = path;
    let resolvable = true;
    for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
      if (pathValues[name] === undefined) resolvable = false;
      else resolved = resolved.replace(`{${name}}`, encodeURIComponent(pathValues[name]));
    }
    if (!resolvable || queryParams.length === 0) continue;

    const label = `GET ${path}`;
    probed++;

    // 1. An unknown parameter. The strict contract's headline case: a misspelled filter must fail
    //    loudly rather than return the whole dataset.
    await expect400(c, ctx, bundle, operation, {
      name: `${label} rejects an undocumented query parameter`,
      target: `${url(ctx.baseUrl, resolved)}?${UNKNOWN_PARAM}=1`,
      why: "an unknown parameter must be a 400, never a silently unfiltered 200",
    });

    // 2. Every documented constraint, violated on its own terms.
    for (const param of queryParams) {
      const bad = violatingValue(param);
      if (bad === undefined) continue;
      await expect400(c, ctx, bundle, operation, {
        name: `${label} rejects ${param.name}=${bad.value} (${bad.why})`,
        target: `${url(ctx.baseUrl, resolved)}?${encodeURIComponent(param.name)}=${encodeURIComponent(bad.value)}`,
        why: `the document constrains ${param.name}: ${bad.why}`,
      });
    }
  }

  if (probed === 0) {
    c.skip(
      "the strict-query negative contract",
      "no documented operation declares query parameters to probe",
    );
  }

  // 3. A path template that documents a 404 must answer 404 for an id that does not exist.
  for (const { path, method, operation } of operations) {
    if (method !== "get" || !path.includes("{")) continue;
    if (!operation.responses?.["404"]) continue;
    const missing = path.replace(/\{[^}]+\}/g, `m2-compliance:no-such-record-${Date.now()}`);
    const target = url(ctx.baseUrl, missing);
    const res = await request(target, { timeoutMs: ctx.timeoutMs });
    if (!res.ok) {
      c.fail(`GET ${path} answers 404 for a record that does not exist`, `${target}: ${res.error}`);
      continue;
    }
    if (res.status !== 404) {
      c.fail(
        `GET ${path} answers 404 for a record that does not exist`,
        `→ ${res.status} (body: ${res.body.slice(0, 160)})`,
      );
      continue;
    }
    const detail = validateAgainstResponse(bundle, operation.responses["404"], res);
    c.expect(
      detail.ok,
      `GET ${path} answers 404 for a record that does not exist`,
      `→ 404, ${summarize(detail)}`,
      `→ 404, but ${detail.problem}`,
    );
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

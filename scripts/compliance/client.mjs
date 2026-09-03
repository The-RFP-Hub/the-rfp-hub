/**
 * The HTTP surface the M3 checks use: the M2 client, plus credentials and two identities.
 *
 * TWO USER-AGENTS, AND THE DIFFERENCE IS LOAD-BEARING.
 *
 * The API excludes its own automation from analytics BY NAME, and `rfphub-m3-compliance` is on that
 * list — otherwise this tool, run nightly against a deployment, would be most of every publisher's
 * view count. That is right for every request this checker makes except one set: the analytics
 * criterion has to prove that real traffic is counted, and traffic the API is contractually
 * required to ignore cannot prove it. So the analytics criterion, and only it, generates its reads
 * under a plain browser-shaped agent — and then reads the numbers back under the compliance agent,
 * so the act of checking does not change the thing being checked.
 *
 * Everything below returns a plain result object; a refused connection is a RESULT the report
 * renders, not an exception that aborts a run before the other criteria are looked at.
 */
import { url, asJson, mapLimit, query, request } from "./http.mjs";

export { asJson, mapLimit, normalizeBase, query, url } from "./http.mjs";

/** Identifies this tool, and is excluded from analytics capture by the API, deliberately. */
export const CHECKER_AGENT = "rfphub-m3-compliance";

/**
 * A countable agent for the analytics criterion. Deliberately NOT a real browser string — it says
 * what it is — but it avoids every token the API's conservative bot pattern matches, because the
 * point of the criterion is to be counted.
 */
export const TRAFFIC_AGENT = "Mozilla/5.0 (rfphub m3 acceptance traffic)";

/** One request, with an optional bearer credential and an explicit agent. */
export async function call(ctx, path, options = {}) {
  const { token, agent = CHECKER_AGENT, headers = {}, ...rest } = options;
  return request(url(ctx.api, path), {
    timeoutMs: ctx.timeoutMs,
    ...rest,
    headers: {
      "user-agent": agent,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

/**
 * A request whose response is parsed as JSON, and whose body — if there is one — is serialized
 * here so no caller forgets the content type.
 *
 * The content type is set ONLY when a body is actually sent. Fastify rejects a request that
 * declares `application/json` and then sends nothing with a 400, so a `DELETE` carrying a
 * reflexive content-type header fails for a reason that has nothing to do with the route.
 */
export async function callJson(ctx, path, options = {}) {
  const { body, ...rest } = options;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const response = await call(ctx, path, {
    ...rest,
    headers: {
      ...(serialized === undefined ? {} : { "content-type": "application/json" }),
      ...(rest.headers ?? {}),
    },
    body: serialized,
  });
  if (!response.ok) return response;
  return { ...response, ...asJson(response) };
}

/** `?a=1&b=2` from an object, dropping undefined. Re-exported for the checks' readability. */
export const qs = query;

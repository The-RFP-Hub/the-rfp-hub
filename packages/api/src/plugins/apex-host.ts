/**
 * THE APEX RESERVATION, ENFORCED RATHER THAN ASSERTED.
 *
 * `adr/0007` reserves the apex — `ethrfps.app` — for the spec and its site: "no service is ever
 * mounted here". That reservation is the entire reason `/schemas/`, `/meta/`, `/registries/` and
 * `/ns/` are safe to use as permanent identifier paths, because nothing else can ever claim them.
 *
 * Until spec serving moves to static hosting, the same deployable answers on both hostnames, so
 * the reservation is a property of ONE process rather than two. Routing the apex to this service
 * and calling the apex reserved would be false the moment DNS lands: `GET https://ethrfps.app/v1/opportunities`
 * would answer 200, the whole `/v1` API would be published at the identifier authority, and every
 * future apex path would become API collision surface — exactly what the reservation exists to
 * prevent. So the apex is enforced here, on the request, and asserted in tests with both `Host`
 * headers.
 *
 * The rule, stated as narrowly as it can be:
 *
 *   - On the apex host, this service answers ONLY the Standard's own published files — the
 *     canonical documents and the directories they live in. Everything else is 404 — `/v1/**`,
 *     the service-info root, the docs UI, all of it.
 *   - On every other host (`api.ethrfps.app`, `api-staging.ethrfps.app`, `localhost:3001`, an
 *     ALB target-group health check hitting the task IP), nothing changes. Those files
 *     deliberately answer everywhere: an identifier that only resolves on one hostname
 *     is not more reserved, just harder to serve.
 *
 * The apex is derived from the Standard's own `baseUrl`, never typed here — the same rule the
 * rest of this module follows, so a domain decision stays a one-line edit in `spec.config.json`.
 *
 * **The load balancer must agree.** A host rule that forwards `ethrfps.app` to this service
 * wholesale is what makes this hook load-bearing; the listener rule should be path-scoped to the
 * canonical document prefixes so the apex's `/v1` traffic never reaches a task at all. This hook
 * is the second half of that, and the half that survives an infrastructure edit.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { canonicalDocuments, specConfig } from "../modules/shared/canonical-documents.js";
import { specArtifactPaths } from "../modules/shared/spec-artifacts.js";

/** `https://ethrfps.app` → `ethrfps.app`. The one hostname reserved for the spec. */
export const APEX_HOST = new URL(specConfig.baseUrl).host;

/**
 * Exactly what the apex serves: the Standard's own published files, and nothing else.
 *
 * The documents whose identifiers name this host, plus the rest of the directories those
 * identifiers live in (`modules/shared/spec-artifacts.ts`) — which is the same set the ADR's
 * path-scoped load-balancer rule forwards, `/schemas/*` `/meta/*` `/registries/*`. Still derived,
 * never typed: a route added anywhere else is invisible here on the day it is written.
 */
const APEX_PATHS: ReadonlySet<string> = new Set([
  ...canonicalDocuments.map((doc) => doc.path),
  ...specArtifactPaths,
]);

/**
 * Does this request address the apex?
 *
 * `www.` is folded in because a wildcard certificate covers it and a stray `www` A record is a
 * routine mistake; treating it as the apex keeps the reservation true rather than opening a
 * second, unreserved spelling of the same site.
 */
export function isApexRequest(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === APEX_HOST || host === `www.${APEX_HOST}`;
}

/** Is this path one the apex is allowed to answer? */
export function servedOnApex(url: string): boolean {
  return APEX_PATHS.has(url.split("?")[0] as string);
}

const RESERVED =
  "This hostname is reserved for the RFP Hub Standard's canonical documents and serves nothing else (adr/0007).";

/**
 * What the apex tells a caller it just refused.
 *
 * This message must not name the apex. Sending someone to `specConfig.baseUrl` — which IS the
 * hostname that just 404'd — is a redirect loop written in prose: the caller asked this host for
 * the API, and the answer "the API is on its own host, see <this host>" tells them nothing and
 * reads as a bug in the service. Only the deployment knows the API's public origin, so it comes
 * from `PUBLIC_BASE_URL` — the same value the OpenAPI document advertises as `servers[0].url`,
 * because it is the same fact and there is no version of this service where the two differ.
 *
 * Its default is the relative `/`, which names no host at all; that and an empty value both mean
 * "the deployment has not told us", and the message then says plainly that the API is elsewhere
 * rather than inventing a hostname or echoing the one that was refused.
 */
const publicOrigin = (): string => (config.publicBaseUrl === "/" ? "" : config.publicBaseUrl);

export const apexDenialMessage = (): string => {
  const origin = publicOrigin();
  return `${RESERVED} ${
    origin
      ? `The API is served on a different host: ${origin}`
      : "The API is served on a different host."
  }`;
};

/**
 * Registered on the ROOT instance, before the routes, so it covers every route this service has
 * or gains — including ones added later by someone who has never read `adr/0007`. An allowlist
 * fails closed: a new `/v2/` prefix is invisible on the apex on the day it is written.
 */
export function registerApexHostRule(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply) => {
    if (!isApexRequest(request.hostname) || servedOnApex(request.url)) return;
    await reply.code(404).send({ error: "not_found", message: apexDenialMessage() });
  });
}

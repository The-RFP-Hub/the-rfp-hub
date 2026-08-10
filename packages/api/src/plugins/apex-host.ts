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
 *   - On the apex host, this service answers ONLY the spec's canonical documents. Everything
 *     else is 404 — `/v1/**`, the service-info root, the docs UI, all of it.
 *   - On every other host (`api.ethrfps.app`, `api-staging.ethrfps.app`, `localhost:3001`, an
 *     ALB target-group health check hitting the task IP), nothing changes. The canonical
 *     documents deliberately answer everywhere: an identifier that only resolves on one hostname
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
import { canonicalDocuments, specConfig } from "../modules/shared/canonical-documents.js";

/** `https://ethrfps.app` → `ethrfps.app`. The one hostname reserved for the spec. */
export const APEX_HOST = new URL(specConfig.baseUrl).host;

/** Exactly what the apex serves: the documents whose identifiers name it, and nothing else. */
const APEX_PATHS: ReadonlySet<string> = new Set(canonicalDocuments.map((doc) => doc.path));

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

/**
 * Registered on the ROOT instance, before the routes, so it covers every route this service has
 * or gains — including ones added later by someone who has never read `adr/0007`. An allowlist
 * fails closed: a new `/v2/` prefix is invisible on the apex on the day it is written.
 */
export function registerApexHostRule(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply) => {
    if (!isApexRequest(request.hostname) || servedOnApex(request.url)) return;
    await reply.code(404).send({
      error: "not_found",
      message:
        `${APEX_HOST} serves the RFP Hub Standard's canonical documents only — it is reserved ` +
        `for the spec (adr/0007). The API lives on its own host; see ${specConfig.baseUrl}.`,
    });
  });
}

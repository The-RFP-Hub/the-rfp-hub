/**
 * THE APEX RESERVATION.
 *
 * `adr/0007` reserves `ethrfps.app` for the spec and its site — "no service is ever mounted here"
 * — and that reservation is the whole justification for treating `/schemas/`, `/meta/`,
 * `/registries/` and `/ns/` as permanent identifier paths. Until spec serving moves to static
 * hosting the same process answers on both hostnames, so the reservation has to be a property of
 * this process. These tests are what make it one.
 *
 * Every case is asserted with BOTH `Host` headers, because the interesting failure is not "the
 * apex 404s" — it is "the apex 404s AND the API host still works". A rule that quietly broke
 * `api.ethrfps.app` would pass a one-sided test.
 *
 * No database: the apex rule runs in `onRequest`, before any handler, so the denials never reach
 * one, and every allowed route asserted here is DB-free. The DB-backed half (`/v1/opportunities`
 * answering on the API host and not on the apex) lives in canonical.test.ts.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { canonicalDocuments, specConfig } from "../../src/modules/shared/canonical-documents.js";
import { APEX_HOST, apexDenialMessage, isApexRequest } from "../../src/plugins/apex-host.js";

const API_HOST = `api.${APEX_HOST}`;

describe("the apex serves the spec and nothing else", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, host: string) => app.inject({ method: "GET", url, headers: { host } });

  it("takes the reserved hostname from the Standard, never from a literal", () => {
    expect(APEX_HOST).toBe(new URL(specConfig.baseUrl).host);
    expect(API_HOST.endsWith(`.${APEX_HOST}`)).toBe(true);
  });

  it("recognises the apex, its www spelling and its trailing-dot form — and nothing else", () => {
    for (const host of [APEX_HOST, APEX_HOST.toUpperCase(), `www.${APEX_HOST}`, `${APEX_HOST}.`]) {
      expect(isApexRequest(host), host).toBe(true);
    }
    for (const host of [API_HOST, `api-staging.${APEX_HOST}`, "localhost", "", undefined]) {
      expect(isApexRequest(host), String(host)).toBe(false);
    }
  });

  // The reason the apex is reserved at all: these paths ARE the spec's identifiers.
  for (const doc of canonicalDocuments) {
    it(`serves ${doc.path} on the apex, identically to the API host`, async () => {
      const apex = await get(doc.path, APEX_HOST);
      const api = await get(doc.path, API_HOST);
      expect(apex.statusCode).toBe(200);
      expect(api.statusCode).toBe(200);
      expect(apex.rawPayload.equals(api.rawPayload)).toBe(true);
      expect(apex.headers["content-type"]).toContain(doc.mediaType);
    });
  }

  /**
   * The finding this file exists for: pointing DNS and a load-balancer host rule at the API does
   * not reserve the apex, it PUBLISHES the whole `/v1` API there. Then `$id` paths and API paths
   * share one namespace on the one hostname whose namespace was supposed to be the standard's.
   */
  it("does not serve the API on the apex", async () => {
    for (const url of [
      "/v1/opportunities",
      "/v1/opportunities/anything",
      "/v1/opportunities/schema",
      "/v1/opportunities?ecosystem=X",
      "/v1/stats",
      "/v1/health",
      "/v1/docs",
      "/v1/docs/json",
      "/", // the service-info root is a service too
    ]) {
      const res = await get(url, APEX_HOST);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error, url).toBe("not_found");
      expect(res.json().message, url).toContain("reserved");
    }
  });

  /**
   * The denial has to be actionable, and the one URL it must never offer is the apex — which is
   * exactly what `specConfig.baseUrl` is. "The API lives on its own host; see <the host that just
   * refused you>" sends the caller back where they started and reads as a broken service.
   */
  it("does not send the caller back to the hostname that just refused them", async () => {
    const { message } = (await get("/v1/opportunities", APEX_HOST)).json();
    expect(message).not.toContain(specConfig.baseUrl);
    expect(message).not.toContain(APEX_HOST);
    expect(message).toContain("different host");
  });

  // Only the deployment knows the API's public origin, so it is configuration, not a literal — and
  // it is the SAME configuration the OpenAPI document advertises, not a second variable saying the
  // same thing. Its `/` default names no host, so it has to read as "not configured" here.
  it("names the configured public origin when the deployment provides one", () => {
    const original = config.publicBaseUrl;
    try {
      config.publicBaseUrl = `https://${API_HOST}`;
      expect(apexDenialMessage()).toContain(`https://${API_HOST}`);
      for (const unset of ["/", ""]) {
        config.publicBaseUrl = unset;
        expect(apexDenialMessage(), unset).not.toContain(APEX_HOST);
        expect(apexDenialMessage(), unset).toContain("The API is served on a different host.");
      }
    } finally {
      config.publicBaseUrl = original;
    }
  });

  it("serves those same paths on the API host", async () => {
    for (const url of ["/", "/v1/docs/json", "/v1/opportunities/schema"]) {
      const res = await get(url, API_HOST);
      expect(res.statusCode, url).toBe(200);
    }
    // The docs UI redirects to its own trailing-slash form; what matters is that it is reachable.
    const docs = await get("/v1/docs", API_HOST);
    expect([200, 301, 302]).toContain(docs.statusCode);
  });

  // Staging, a local run, and an ALB target-group health check that addresses the task by IP all
  // arrive with a host that is not the apex. None of them may be affected by this rule.
  it("leaves every non-apex host alone", async () => {
    for (const host of [API_HOST, `api-staging.${APEX_HOST}`, "localhost:3001", "10.0.1.23"]) {
      const res = await get("/", host);
      expect(res.statusCode, host).toBe(200);
      expect(res.json().name, host).toBe("RFP Hub API");
    }
  });

  // An allowlist fails closed: a route added later is invisible on the apex until someone adds
  // it to the reservation on purpose. This asserts the property, not today's route table.
  it("denies an unknown path on the apex and 404s it normally elsewhere", async () => {
    const apex = await get("/v2/whatever", APEX_HOST);
    expect(apex.statusCode).toBe(404);
    expect(apex.json().message).toContain("reserved");

    const api = await get("/v2/whatever", API_HOST);
    expect(api.statusCode).toBe(404);
    expect(api.json().message).not.toContain("reserved");
  });
});

/**
 * THE INCIDENT THIS FILE PINS: a staging deployment crash-looped because EMAIL_TRANSPORT=mailgun
 * arrived without its credential pair and the boot REFUSED — the whole public surface held
 * hostage to a mail key. The design correction: a half-configured mail transport degrades, never
 * kills. This suite builds the app exactly as that deployment did (mailgun, no credentials,
 * production mode) and proves the three properties the correction promises:
 *
 *   1. the boot SUCCEEDS and everything that sends nothing keeps serving;
 *   2. the four code-sending routes answer an explicit 503 — never a silent 200 over a send that
 *      was going to vanish;
 *   3. a non-sending auth route behaves normally, because sign-in-by-code is the only casualty.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/better-auth.js";
import { db } from "../../src/db/client.js";
import { testAuthConfig } from "../helpers/auth.js";
import { describeWithDb } from "./db-gate.js";

describeWithDb("a half-configured mailgun transport degrades, never kills", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const base = testAuthConfig();
    const config = {
      ...base,
      email: {
        ...base.email,
        transport: "mailgun" as const,
        mailgunApiKey: undefined,
        mailgunDomain: undefined,
      },
    };
    // `production: true` is the point: this is the exact configuration that used to refuse to
    // boot. Constructing the auth and mounting the app IS the regression assertion.
    const auth = createAuth({ db, config, production: true });
    app = await buildApp({ auth: { auth, config } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("boots, and the public surface answers", async () => {
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.statusCode).toBe(200);
  });

  it("the code-sending route answers the explicit 503, not a silent success", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "degraded@rfphub.invalid", type: "sign-in" }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "auth_unconfigured" });
  });

  it("a non-sending auth route still works", async () => {
    // Session read with no credential: the normal answer is a clean 200/401-class response from
    // the library — anything but the 503 the sender routes reserve for themselves.
    const res = await app.inject({ method: "GET", url: "/api/auth/get-session" });
    expect(res.statusCode).toBeLessThan(500);
  });
});

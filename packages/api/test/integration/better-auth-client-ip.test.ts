/**
 * Who the auth library's limiter thinks a caller is.
 *
 * Left to its defaults the library read `X-Forwarded-For` straight off the request, trusted it only
 * when it held exactly one value, and otherwise keyed every caller on one shared `no-trusted-ip`
 * bucket per route. So a caller could (a) pick a fresh bucket per request with a single forged
 * value, and (b) spend the shared bucket — locking out sign-in for everyone else who arrived with a
 * multi-value header — with two. The mount now drops every address header a caller sends and hands
 * the library `request.ip` in a header only it writes (`CLIENT_IP_HEADER`). These cases pin that,
 * and the ceilings `authRateLimit` declares.
 *
 * Each simulated client has its own `remoteAddress` (TEST-NET-2, one block per case): the library's
 * store is process memory shared by every suite in this worker, all of which arrive as 127.0.0.1.
 *
 * Isolation tag: `M3CIP` / `m3cip-*@rfphub.invalid`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  CLIENT_IP_HEADER,
  OTP_CHECK_RATE_LIMIT,
  OTP_SEND_RATE_LIMIT,
} from "../../src/auth/better-auth.js";
import { pool } from "../../src/db/client.js";
import { clientAddressForAuth } from "../../src/plugins/better-auth.js";
import { testAuth, testAuthConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAILS = {
  rotate: "m3cip-rotate@rfphub.invalid",
  multi: "m3cip-multi@rfphub.invalid",
  victim: "m3cip-victim@rfphub.invalid",
  separate: "m3cip-separate@rfphub.invalid",
  check: "m3cip-check@rfphub.invalid",
};

/** The library's own 429, as opposed to the mount's Fastify ceiling (`error: rate_limited`). */
function isLibraryThrottle(res: { statusCode: number; body: string }): boolean {
  return res.statusCode === 429 && res.body.includes("Too many requests");
}

describe("clientAddressForAuth", () => {
  it("passes one canonical address, the same one the /v1 limiters key on", () => {
    expect(clientAddressForAuth("203.0.113.9")).toBe("203.0.113.9");
    expect(clientAddressForAuth("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientAddressForAuth("203.0.113.9:4000")).toBe("203.0.113.9");
    expect(clientAddressForAuth("2001:db8:1:1::9")).toBe("2001:db8:1:1::");
  });

  it("passes nothing for something that is not an address", () => {
    expect(clientAddressForAuth("")).toBeUndefined();
    expect(clientAddressForAuth("1.2.3.4, 5.6.7.8")).toBeUndefined();
    expect(clientAddressForAuth("acct:1")).toBeUndefined();
  });
});

describeWithDb("M3CIP the auth library's view of the client address", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth(), config: testAuthConfig() } });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({ emails: Object.values(EMAILS) });
    await app.close();
    await pool.end();
  }, 60_000);

  const sendCode = (remoteAddress: string, email: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      remoteAddress,
      headers: { "content-type": "application/json", ...headers },
      payload: JSON.stringify({ email, type: "sign-in" }),
    });

  it("limits the same client however it rewrites its address headers", async () => {
    // Before: each single-value X-Forwarded-For was a new client to the library, so rotating it
    // was an unlimited code sender. The forged copies of the library's own header and of
    // X-Real-IP are dropped too.
    const client = "198.51.100.11";
    const results = [];
    for (let i = 0; i <= OTP_SEND_RATE_LIMIT.max; i++) {
      results.push(
        await sendCode(client, EMAILS.rotate, {
          "x-forwarded-for": `203.0.113.${i + 1}`,
          "x-real-ip": `203.0.113.${i + 101}`,
          [CLIENT_IP_HEADER]: `203.0.113.${i + 201}`,
        }),
      );
    }
    for (const res of results.slice(0, OTP_SEND_RATE_LIMIT.max)) {
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(isLibraryThrottle(results[OTP_SEND_RATE_LIMIT.max] ?? { statusCode: 0, body: "" })).toBe(
      true,
    );
  }, 60_000);

  it("does not put callers with a forged multi-value X-Forwarded-For in one shared bucket", async () => {
    // Before: two values meant "no trusted address", and every such caller shared one bucket per
    // route. Spending it from one place locked everyone else with a multi-value header out.
    const attacker = "198.51.100.21";
    for (let i = 0; i < OTP_SEND_RATE_LIMIT.max; i++) {
      const res = await sendCode(attacker, EMAILS.multi, { "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(
      isLibraryThrottle(
        await sendCode(attacker, EMAILS.multi, { "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
      ),
    ).toBe(true);

    const victim = await sendCode("198.51.100.22", EMAILS.victim, {
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    });
    expect(victim.statusCode, victim.body).toBe(200);
  }, 60_000);

  it("gives different clients separate buckets", async () => {
    for (let i = 0; i < OTP_SEND_RATE_LIMIT.max; i++) {
      expect((await sendCode("198.51.100.31", EMAILS.separate)).statusCode).toBe(200);
    }
    expect(isLibraryThrottle(await sendCode("198.51.100.31", EMAILS.separate))).toBe(true);
    expect((await sendCode("198.51.100.32", EMAILS.separate)).statusCode).toBe(200);
  }, 60_000);

  it("limits checking codes at its own, looser ceiling", async () => {
    const client = "198.51.100.41";
    const check = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email-otp",
        remoteAddress: client,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: EMAILS.check, otp: "000000" }),
      });
    for (let i = 0; i < OTP_CHECK_RATE_LIMIT.max; i++) {
      const res = await check();
      // A wrong code is a client error, never the throttle, until the ceiling is spent.
      expect(isLibraryThrottle(res), `attempt ${i + 1}: ${res.body}`).toBe(false);
    }
    const over = await check();
    expect(isLibraryThrottle(over), over.body).toBe(true);
  }, 60_000);
});

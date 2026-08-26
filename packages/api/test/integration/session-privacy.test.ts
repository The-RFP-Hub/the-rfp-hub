/**
 * THE OWNER DECISION THIS FILE PINS: session rows keep NO network identity. The library fills
 * `ipAddress` and `userAgent` from request headers by default, and the databaseHooks strip in
 * `better-auth.ts` blanks both at the persistence seam — the columns stay in the schema, always
 * empty. This test signs in WITH those headers present, so it discriminates: without the strip,
 * the row holds the forwarded address and the user agent verbatim; with it, both are empty.
 */
import { eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { createAuth } from "../../src/auth/better-auth.js";
import { db } from "../../src/db/client.js";
import { authSession, authUser } from "../../src/db/schema.js";
import { createEmailTransport } from "../../src/modules/services/email/email-transport.js";
import { EmailService } from "../../src/modules/services/email/email.service.js";
import { testAuthConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAIL = "m3priv-headers@rfphub.invalid";
const FORWARDED_IP = "203.0.113.7";
const USER_AGENT = "m3priv-proof/1.0";

describeWithDb("session rows carry no network identity", () => {
  afterAll(async () => {
    await cleanupFixtures({ emails: [EMAIL] });
  });

  it("a sign-in that ARRIVES with an address and a user agent stores neither", async () => {
    // A second instance over the same database, exactly the helper's shape — but this one sends
    // every call with the headers the library would harvest, which `signIn()` deliberately omits.
    const config = testAuthConfig();
    const transport = createEmailTransport(config.email);
    const auth = createAuth({
      db,
      config,
      email: new EmailService({ config: config.email, transport }),
    });

    const headers = new Headers({
      "x-forwarded-for": FORWARDED_IP,
      "user-agent": USER_AGENT,
    });

    await auth.api.sendVerificationOTP({ body: { email: EMAIL, type: "sign-in" }, headers });
    const messages = transport.drain?.(EMAIL) ?? [];
    const otp = /\b(\d{6})\b/.exec(messages[messages.length - 1]?.text ?? "")?.[1];
    expect(otp, "the one-time code must be readable from the memory transport").toBeTruthy();

    await auth.api.signInEmailOTP({ body: { email: EMAIL, otp: otp ?? "" }, headers });

    const rows = await db
      .select({ ipAddress: authSession.ipAddress, userAgent: authSession.userAgent })
      .from(authSession)
      .innerJoin(authUser, eq(authSession.userId, authUser.id))
      .where(eq(authUser.email, EMAIL));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Empty or null — never the values the request carried. The exact forwarded address is the
      // discriminating assertion: it is what the default path would have stored.
      expect(row.ipAddress ?? "").toBe("");
      expect(row.userAgent ?? "").toBe("");
      expect(row.ipAddress).not.toBe(FORWARDED_IP);
      expect(row.userAgent).not.toBe(USER_AGENT);
    }
  });
});

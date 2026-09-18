import { describe, expect, it } from "vitest";
import {
  UNSUBSCRIBE_TOKEN_PATTERN,
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "../../src/modules/services/notifications/unsubscribe-token.js";

const SECRET = "unit-test-secret-that-is-long-enough-000";
const PURPOSE = "stale_listing_reminder";

describe("unsubscribe token", () => {
  it("round-trips the account id and matches the published pattern", () => {
    const token = signUnsubscribeToken(SECRET, 42, PURPOSE);
    expect(token).toMatch(new RegExp(UNSUBSCRIBE_TOKEN_PATTERN));
    expect(verifyUnsubscribeToken(SECRET, token, PURPOSE)).toBe(42);
  });

  it("rejects another account's id, another secret, and malformed input", () => {
    const token = signUnsubscribeToken(SECRET, 42, PURPOSE);
    const signature = token.split(".")[1];
    expect(verifyUnsubscribeToken(SECRET, `43.${signature}`, PURPOSE)).toBeUndefined();
    expect(verifyUnsubscribeToken(`${SECRET}x`, token, PURPOSE)).toBeUndefined();
    for (const bad of ["", "42", "0.abc", `42.${signature}=`, `042.${signature}`]) {
      expect(verifyUnsubscribeToken(SECRET, bad, PURPOSE), bad).toBeUndefined();
    }
  });

  it("never equals a plain HMAC of the same input under the raw secret", async () => {
    const { createHmac } = await import("node:crypto");
    const raw = createHmac("sha256", SECRET).update(`${PURPOSE}:42`).digest("base64url");
    expect(signUnsubscribeToken(SECRET, 42, PURPOSE)).not.toBe(`42.${raw}`);
  });

  it("builds the link on the API origin", () => {
    expect(unsubscribeUrl("https://api.example.org", "1.x")).toBe(
      "https://api.example.org/v1/email/unsubscribe?token=1.x",
    );
  });
});

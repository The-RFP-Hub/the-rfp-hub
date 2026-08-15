/**
 * Verification of the identity provider's access token — locally, with `jose`, no vendor SDK.
 *
 * The dashboard sends `Authorization: Bearer <access token>`; this service turns that string into a
 * DID or refuses it. Three claims are checked and none of them is optional:
 *
 *   `iss` — must be the provider's own issuer. A token minted by anything else is not a login.
 *   `aud` — must be THIS app's id. Separate applications are used per environment (and separate
 *           from any other product's user base), so a staging token must not open production.
 *   `exp` — enforced by `jose`, with no clock tolerance configured: a token that has expired is
 *           expired.
 *
 * The algorithm is pinned to ES256 rather than read from the header. An unpinned verifier accepts
 * whatever the token says it is signed with, which is the `alg: none` / HS256-with-the-public-key
 * family of forgeries.
 *
 * THE PEM IS THE PRIMARY MECHANISM. The provider documents an app verification key (a PEM public
 * key) for app access tokens; it does not document a JWKS endpoint for them. `PRIVY_JWKS_URL` is
 * therefore supported only as an explicitly optional override and is documented as UNVERIFIED —
 * see docs/auth.md. When both are configured the PEM wins.
 *
 * Nothing here reaches the provider's API. Enrichment (wallet, email) needs a second credential and
 * is heavily rate-limited, so it is deliberately off this path: a login completes with the DID
 * alone and a provider outage never locks anybody out.
 */
import { type JWTPayload, type JWTVerifyGetKey, type KeyObject, importSPKI, jwtVerify } from "jose";
import type { PrivyConfig } from "../../../config.js";
import { HttpError, unauthorized } from "../../shared/http-error.js";

/** The provider's issuer claim. Fixed by the provider, not by a deployment. */
export const PRIVY_ISSUER = "privy.io";

/** The only signature algorithm accepted. Never read from the token's own header. */
export const PRIVY_ALGORITHM = "ES256";

/** What a verified token tells us. The DID is the only identity claim we trust or store. */
export interface PrivyClaims {
  /** `sub` — the provider's subject identifier, e.g. `did:privy:…`. THE account join key. */
  did: string;
  expiresAt: Date | undefined;
  issuedAt: Date | undefined;
}

/**
 * A PEM public key, tolerating the two shapes a secret store hands back: a full
 * `-----BEGIN PUBLIC KEY-----` block, or the bare base64 body with the armour stripped (which is
 * what a console copy or a single-line environment variable often yields).
 */
function normalizePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body = trimmed.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

export class PrivyTokenService {
  private key: Promise<KeyObject> | undefined;
  private jwks: JWTVerifyGetKey | undefined;

  constructor(private readonly privy: PrivyConfig) {}

  /** Whether a session login can be verified at all in this deployment. */
  get configured(): boolean {
    return (
      this.privy.appId !== undefined &&
      (this.privy.verificationKey !== undefined || this.privy.jwksUrl !== undefined)
    );
  }

  private async resolveKey(): Promise<KeyObject | JWTVerifyGetKey> {
    if (this.privy.verificationKey !== undefined) {
      // Imported once and cached: the import parses ASN.1, and doing that per request would put a
      // key parse on the hot path of every authenticated call.
      this.key ??= importSPKI(normalizePem(this.privy.verificationKey), PRIVY_ALGORITHM);
      return this.key;
    }
    if (this.privy.jwksUrl !== undefined) {
      if (!this.jwks) {
        // Imported lazily so a deployment that uses the documented PEM never opens a remote key
        // set, and the unverified override costs nothing when unused.
        const { createRemoteJWKSet } = await import("jose");
        this.jwks = createRemoteJWKSet(new URL(this.privy.jwksUrl));
      }
      return this.jwks;
    }
    throw new HttpError(
      503,
      "auth_unconfigured",
      "session authentication is not configured on this deployment (PRIVY_APP_ID and PRIVY_VERIFICATION_KEY are unset).",
    );
  }

  /** Verify a bearer access token, or refuse it. Never returns a partially-trusted result. */
  async verify(token: string): Promise<PrivyClaims> {
    if (this.privy.appId === undefined) {
      throw new HttpError(
        503,
        "auth_unconfigured",
        "session authentication is not configured on this deployment (PRIVY_APP_ID is unset).",
      );
    }
    const key = await this.resolveKey();

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], {
        issuer: PRIVY_ISSUER,
        audience: this.privy.appId,
        algorithms: [PRIVY_ALGORITHM],
      });
      payload = verified.payload;
    } catch {
      // Deliberately one message for every failure mode. "Expired", "wrong audience" and "bad
      // signature" are all the same answer to the caller, and distinguishing them tells a prober
      // which half of a forgery attempt worked.
      throw unauthorized("the access token could not be verified.");
    }

    const did = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (did === "") throw unauthorized("the access token carries no subject.");

    return {
      did,
      expiresAt: payload.exp === undefined ? undefined : new Date(payload.exp * 1000),
      issuedAt: payload.iat === undefined ? undefined : new Date(payload.iat * 1000),
    };
  }
}

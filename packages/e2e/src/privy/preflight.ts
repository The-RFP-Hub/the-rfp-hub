/**
 * What identity material this run actually has — decided BEFORE the stack is touched.
 *
 * TWO RULES SHAPE THIS FILE.
 *
 * 1. **It makes no call to the RFP Hub API.** The very first `/v1/me` a fresh DID ever sends is
 *    itself an assertion — just-in-time account provisioning is an M3 criterion, and a preflight
 *    that "checked the token works" would consume the only chance to observe it. So the preflight
 *    talks to Privy and to nothing else; acceptance of those tokens by the API is asserted in the
 *    Playwright setup project, where it is a visible, reported test rather than a silent probe.
 *
 * 2. **It fails closed on tenant identity.** A Privy tenant is opaque: nothing in an app id, an app
 *    name or the API's responses distinguishes a throwaway development app from the production one,
 *    and this harness LOGS IN — a test-account login can persist a user record. An app-name regex
 *    would be a guess, and an undocumented app-metadata probe would be a guess with a network call
 *    attached. The only mechanism that cannot be wrong is a human writing the app id down:
 *    `E2E_PRIVY_TENANT_ACK` must be present and must equal `PRIVY_APP_ID` exactly. Absent or
 *    mismatched, the run degrades to the no-Privy level rather than guessing.
 *
 * The identity COUNT is the number of distinct `sub` claims across the tokens minted, never the
 * number of credentials configured: an email test account and a phone test account may resolve to
 * one and the same user, and a ladder level chosen from the credential count would then claim a
 * second independent actor that does not exist.
 */
import { decodeJwt } from "jose";
import { type TenantCredentials, readTenantCredentials } from "../env.js";
import { mask, presence, register } from "../redact.js";

/**
 * The fallback ladder. Higher number, less real identity available.
 *
 * Every level below L0 names, per criterion, what it can still prove — the levels exist so a run
 * with partial credentials reports BLOCKED with a reason rather than silently testing less.
 */
export type LadderLevel =
  | "L0-FULL"
  | "L1-REDUCED-IDENTITY"
  | "L2-API-ONLY"
  | "L3-BROWSER-ONLY"
  | "L4-NO-PRIVY";

export interface MintedIdentity {
  /** The token's `sub` — the Privy DID. The identity key for everything downstream. */
  did: string;
  /** How it was obtained, for the report. */
  via: "test-account-email" | "test-account-phone" | "test-account-default";
  /** The credential used, masked. This is the only form that may be DISPLAYED. */
  credential: string;
  /**
   * The exact credential this DID was minted from, kept so the association never has to be
   * reconstructed.
   *
   * An earlier version threw this away and later re-derived it by matching the masked form's last
   * four characters against the configured list. Ordinary same-domain addresses share a suffix
   * (`…@example.org` — every one of them ends `.org`), so that lookup happily assigned one
   * credential to several DIDs; `tokenForDid` then minted tokens for the wrong account and the
   * actors silently collapsed onto one identity. The mapping is known exactly at the moment of
   * minting, so it is simply kept. It is written only into the run's 0700 identity file and is
   * never logged, printed, or placed in `state.json`.
   */
  exactEmail?: string;
  exactPhone?: string;
  /** Unix seconds. Tokens are short-lived; fixtures re-mint rather than caching across a run. */
  expiresAt: number;
}

export type MintFailureKind =
  | "test-accounts-not-enabled"
  | "allowed-origins-or-base-domain-enabled"
  | "credentials-absent"
  | "other";

export interface MintFailure {
  kind: MintFailureKind;
  /** The credential attempted, masked. */
  credential: string;
  /** The provider's message, redacted. Kept because the three classifications are a heuristic. */
  detail: string;
}

export interface PreflightResult {
  level: LadderLevel;
  /** Distinct DIDs available for server-side token minting. */
  identities: MintedIdentity[];
  failures: MintFailure[];
  /** True when a real browser email-OTP login can be driven. */
  browserLoginAvailable: boolean;
  /**
   * The DID the browser will sign in as, when it is knowable before the login happens.
   *
   * It IS knowable at every level that can mint: the browser signs in with
   * `E2E_PRIVY_TEST_EMAIL`, and a token minted for that same address carries the same `sub`. That
   * matters because the actor assignment has to be fixed before the API boots, while the browser
   * login (at most levels) happens after it — so without this the run could hand `storageState` to
   * one identity and the "publisher" role to another, and every owner-only browser assertion would
   * be driving a session that does not own anything.
   */
  browserDid?: string;
  tenant: {
    acknowledged: boolean;
    appIdMasked: string;
    credentials: TenantCredentials["report"];
  };
  /** Human-readable reasons, printed by the runner and reproduced in the report. */
  notes: string[];
  /** Retained in-process only; never written to `state.json`. */
  credentials: TenantCredentials;
}

/** Splits `A, B ,C` into `["A","B","C"]`; an unset or blank variable yields `[]`. */
function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Classifies a mint failure into the three states an operator can act on.
 *
 * Privy's errors are prose, so this is a heuristic and is documented as one: the raw message is
 * always carried alongside the classification, and the runner prints both. A wrong label here
 * costs an operator one confusing sentence; dropping the message would cost them the fix.
 */
function classify(err: unknown): { kind: MintFailureKind; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  const lowered = detail.toLowerCase();

  if (
    lowered.includes("test account") ||
    lowered.includes("test_account") ||
    lowered.includes("not enabled")
  ) {
    return { kind: "test-accounts-not-enabled", detail };
  }
  if (
    lowered.includes("allowed origin") ||
    lowered.includes("allowed_origin") ||
    lowered.includes("base domain") ||
    lowered.includes("origin is not allowed")
  ) {
    return { kind: "allowed-origins-or-base-domain-enabled", detail };
  }
  return { kind: "other", detail };
}

/** The last four characters of a credential — enough to tell two apart, not enough to reuse one. */
function maskCredential(value: string): string {
  return mask(value);
}

/**
 * Mints one test-account access token.
 *
 * The call shape is taken from the INSTALLED `@privy-io/node@0.29` type declarations, not from
 * memory or from the deprecated `@privy-io/server-auth`:
 *
 *   `new PrivyClient({ appId, appSecret })`
 *   `client.apps()` → `PrivyAppsService`
 *   `.getTestAccessToken(params?)` where params is `{ email }` XOR `{ phone_number }`
 *   → `{ access_token: string }`      (snake_case, both in and out)
 *
 * Anything that drifts from that shape is a version change, and the failure will be a TypeScript
 * error at build time rather than a runtime surprise mid-run.
 */
async function mintToken(
  client: import("@privy-io/node").PrivyClient,
  target: { email?: string; phone?: string },
): Promise<string> {
  const apps = client.apps();
  if (target.email) {
    const response = await apps.getTestAccessToken({ email: target.email });
    return response.access_token;
  }
  if (target.phone) {
    const response = await apps.getTestAccessToken({ phone_number: target.phone });
    return response.access_token;
  }
  const response = await apps.getTestAccessToken();
  return response.access_token;
}

/**
 * Decides the ladder level and gathers whatever identity material exists.
 *
 * Makes no request to the RFP Hub API. Makes network calls to Privy ONLY after the tenant
 * acknowledgement has matched.
 */
export async function preflight(): Promise<PreflightResult> {
  const credentials = readTenantCredentials();
  const notes: string[] = [];
  const failures: MintFailure[] = [];

  const ack = process.env.E2E_PRIVY_TENANT_ACK;
  const acknowledged = Boolean(ack && credentials.appId && ack === credentials.appId);

  const browserEmail = process.env.E2E_PRIVY_TEST_EMAIL;
  const browserOtp = process.env.E2E_PRIVY_TEST_OTP;
  register(browserOtp, { label: "privy-test-otp", longLived: true });

  // Every OTP the operator handed over, registered whether or not this run signs in with it.
  //
  // ONLY the browser identity needs a code: API actors get their tokens from the provider's
  // test-access-token endpoint, which takes an address and no code at all. The other accounts' codes
  // are therefore unused here — but they are standing tenant credentials that do not expire, so
  // registering them means the end-of-run artifact scan is looking for them too. A secret the
  // harness was told about and then ignored is exactly the one nobody would think to search for.
  for (const otp of list(process.env.E2E_PRIVY_TEST_OTPS)) {
    register(otp, { label: "privy-test-otp", longLived: true });
  }
  const browserLoginAvailable = Boolean(browserEmail && browserOtp);

  const tenant = {
    acknowledged,
    appIdMasked: mask(credentials.appId),
    credentials: credentials.report,
  };

  if (!credentials.appId || !credentials.verificationKey) {
    notes.push(
      "PRIVY_APP_ID and/or PRIVY_VERIFICATION_KEY are absent (checked as real environment variables " +
        "and then in packages/api/.env, read-only). Without a verification key the API cannot accept " +
        "any real token, so no real-auth criterion can be exercised.",
    );
    return blocked("L4-NO-PRIVY", { credentials, notes, failures, browserLoginAvailable, tenant });
  }

  if (!acknowledged) {
    notes.push(
      ack
        ? `E2E_PRIVY_TENANT_ACK is set but does not equal PRIVY_APP_ID (${mask(credentials.appId)}). The acknowledgement must name the exact app this run may write into; a mismatch is treated as no acknowledgement at all.`
        : `E2E_PRIVY_TENANT_ACK is not set. This harness signs in to a real identity tenant and a test-account login can persist a user record there, so it refuses to touch a tenant nobody has acknowledged. Set E2E_PRIVY_TENANT_ACK to the app id (this run would use ${mask(credentials.appId)}).`,
    );
    return blocked("L4-NO-PRIVY", { credentials, notes, failures, browserLoginAvailable, tenant });
  }

  if (!credentials.appSecret) {
    notes.push(
      `PRIVY_APP_SECRET is absent, so no server-side token minting is possible. ${
        browserLoginAvailable
          ? "A browser email-OTP login is configured, so the run proceeds at the browser-only level."
          : "No browser login is configured either."
      }`,
    );
    return browserLoginAvailable
      ? blocked("L3-BROWSER-ONLY", { credentials, notes, failures, browserLoginAvailable, tenant })
      : blocked("L4-NO-PRIVY", { credentials, notes, failures, browserLoginAvailable, tenant });
  }

  // ── minting ──────────────────────────────────────────────────────────────────────────────────
  // Imported lazily: the SDK is only needed once the tenant has been acknowledged, and a run that
  // degrades before this point should not pay for loading it (nor fail on a bad install it never
  // uses).
  const { PrivyClient } = await import("@privy-io/node");
  const client = new PrivyClient({ appId: credentials.appId, appSecret: credentials.appSecret });

  const targets: Array<{
    email?: string;
    phone?: string;
    via: MintedIdentity["via"];
    credential: string;
    /** True for the one credential the browser will also sign in with. */
    browser?: boolean;
  }> = [];
  // The no-argument form first: it asks Privy for the app's default test account and is the only
  // form that works when nobody has written a credential into the environment.
  targets.push({ via: "test-account-default", credential: "(default test account)" });
  for (const email of [...list(process.env.E2E_PRIVY_TEST_EMAILS), ...list(browserEmail)]) {
    targets.push({
      email,
      via: "test-account-email",
      credential: maskCredential(email),
      browser: email === browserEmail,
    });
  }
  for (const phone of [
    ...list(process.env.E2E_PRIVY_TEST_PHONES),
    ...list(process.env.E2E_PRIVY_TEST_PHONE),
  ]) {
    targets.push({ phone, via: "test-account-phone", credential: maskCredential(phone) });
  }

  const byDid = new Map<string, MintedIdentity>();
  let browserDid: string | undefined;
  for (const target of targets) {
    try {
      const token = await mintToken(client, target);
      register(token, { label: "privy-access-token", longLived: false });
      const claims = decodeJwt(token);
      const did = typeof claims.sub === "string" ? claims.sub : undefined;
      if (!did) {
        failures.push({
          kind: "other",
          credential: target.credential,
          detail: "minted token carries no `sub` claim",
        });
        continue;
      }
      // Dedupe by `sub`, NOT by credential: an email and a phone test account can be the same
      // Privy user, and counting them twice would claim a second independent actor that does not
      // exist and silently downgrade a BLOCKED criterion to a false PASS.
      if (target.browser) browserDid = did;
      if (!byDid.has(did)) {
        byDid.set(did, {
          did,
          via: target.via,
          credential: target.credential,
          exactEmail: target.email,
          exactPhone: target.phone,
          expiresAt: typeof claims.exp === "number" ? claims.exp : 0,
        });
      }
    } catch (err) {
      const { kind, detail } = classify(err);
      failures.push({ kind, credential: target.credential, detail });
    }
  }

  const identities = [...byDid.values()];
  const n = identities.length;

  if (n === 0) {
    notes.push(
      `No test-account token could be minted. ${
        failures.some((f) => f.kind === "allowed-origins-or-base-domain-enabled")
          ? "Allowed origins / base domain appear to be enabled on the app, which blocks server-side minting."
          : failures.some((f) => f.kind === "test-accounts-not-enabled")
            ? "Test accounts appear to be disabled for this app (User management → Authentication → Advanced)."
            : "See the failure detail below."
      }`,
    );
    return browserLoginAvailable
      ? blocked("L3-BROWSER-ONLY", {
          credentials,
          notes,
          failures,
          browserLoginAvailable,
          tenant,
          identities,
        })
      : blocked("L4-NO-PRIVY", {
          credentials,
          notes,
          failures,
          browserLoginAvailable,
          tenant,
          identities,
        });
  }

  let level: LadderLevel;
  if (!browserLoginAvailable) {
    level = "L2-API-ONLY";
    notes.push(
      "E2E_PRIVY_TEST_EMAIL and/or E2E_PRIVY_TEST_OTP are absent, so no browser login can be driven: " +
        "every criterion that needs a signed-in browser is BLOCKED.",
    );
  } else if (n >= 4) {
    level = "L0-FULL";
  } else {
    level = "L1-REDUCED-IDENTITY";
    notes.push(
      n === 1
        ? "Exactly 1 distinct identity is available (counted by distinct token `sub`, not by credential): the tenant holds a single test account, and its email and phone credentials resolve to the same user. That identity serves as administrator, reviewer and publisher at once — sound, because publish authority comes from a verified membership rather than from a role. Everything needing an unaffiliated submitter, or a second party to refuse, is BLOCKED."
        : `${n} distinct identities are available (counted by distinct token \`sub\`, not by credential). Criteria that need a second independent verified publisher are CONDITIONAL — the role-transition choreography covers everything else.`,
    );
  }

  notes.push(`Identity count N=${n}, from ${targets.length} credential(s) attempted.`);
  return {
    level,
    identities,
    failures,
    browserLoginAvailable,
    browserDid,
    tenant,
    notes,
    credentials,
  };
}

function blocked(
  level: LadderLevel,
  parts: {
    credentials: TenantCredentials;
    notes: string[];
    failures: MintFailure[];
    browserLoginAvailable: boolean;
    tenant: PreflightResult["tenant"];
    identities?: MintedIdentity[];
  },
): PreflightResult {
  return {
    level,
    identities: parts.identities ?? [],
    failures: parts.failures,
    browserLoginAvailable: parts.browserLoginAvailable,
    tenant: parts.tenant,
    notes: parts.notes,
    credentials: parts.credentials,
  };
}

/**
 * The environment variable that unblocks each ladder level, named so a BLOCKED criterion can say
 * what would fix it rather than just that it did not run.
 */
export const UNBLOCKED_BY: Record<LadderLevel, string[]> = {
  "L0-FULL": [],
  "L1-REDUCED-IDENTITY": ["E2E_PRIVY_TEST_EMAILS (more distinct test accounts)"],
  "L2-API-ONLY": ["E2E_PRIVY_TEST_EMAIL", "E2E_PRIVY_TEST_OTP"],
  "L3-BROWSER-ONLY": ["PRIVY_APP_SECRET (server-side test-account token minting)"],
  "L4-NO-PRIVY": ["E2E_PRIVY_TENANT_ACK", "E2E_PRIVY_TEST_EMAIL", "E2E_PRIVY_TEST_OTP"],
};

/** A short, safe summary line for the console and the report. Contains no secret. */
export function describe(result: PreflightResult): string {
  return [
    `ladder level: ${result.level}`,
    `tenant acknowledged: ${result.tenant.acknowledged ? "yes" : "no"} (app ${result.tenant.appIdMasked})`,
    `identities (distinct sub): ${result.identities.length}`,
    `browser login: ${result.browserLoginAvailable ? "available" : "unavailable"}`,
    `app secret: ${presence(result.credentials.appSecret)}`,
  ].join(" · ");
}

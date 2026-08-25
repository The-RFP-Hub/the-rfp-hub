/**
 * What is left to decide before a run starts — which, now, is almost nothing.
 *
 * THE FILE THIS REPLACES WAS 425 LINES. It read credentials out of another package's `.env`, refused
 * to touch a tenant nobody had acknowledged, minted tokens against a third party, classified the
 * three ways that minting could fail, deduplicated identities by the `sub` claim of the tokens it
 * got back, and mapped the result onto a five-rung ladder — L0 through L4 — that every spec then had
 * to consult before deciding whether it was allowed to run.
 *
 * All of it existed to answer one question: *how much of this suite can execute on this machine
 * today?* The answer is now "all of it", unconditionally and offline, because the identity provider
 * is the product itself and sign-in codes are written to a file inside the run's own directory.
 * There is no tenant to acknowledge, no secret to hold, no rate limit to respect and no ceiling on
 * how many identities a run may create.
 *
 * So the ladder is deleted rather than kept with one rung. A degradation path that can no longer be
 * reached is one nobody maintains and everybody trusts, and it is exactly the shape of thing that
 * silently starts reporting BLOCKED instead of failing when something breaks.
 *
 * What remains genuinely optional is the one lane that talks to somebody else's software: the
 * social-provider path. This module reports whether it has been switched on, and nothing else.
 */

/** The opt-in for the local OIDC stub lane. Never on by default; never a CI gate while it is new. */
export const OIDC_STUB_ENV = "E2E_OIDC_STUB";

export interface Preflight {
  /**
   * True when the run should stand up a local OIDC provider and exercise the social redirect,
   * the callback, the one-time-token handoff and the account-linking rules against it.
   *
   * It proves the WIRING. It proves nothing whatsoever about Google — a stub answers exactly what
   * it is written to answer — and any spec that runs under it has to say so in its own header.
   */
  oidcStub: boolean;
  /**
   * True when a real social provider has been configured for a manual, scheduled run.
   *
   * Never a pull-request gate: it needs a live account at a third party, which is the whole class of
   * dependency this migration existed to remove from the everyday path.
   */
  realGoogle: boolean;
  /** Human-readable, printed by the runner and reproduced in the report. */
  notes: string[];
}

export function preflight(): Preflight {
  const oidcStub = process.env[OIDC_STUB_ENV] === "1";
  const realGoogle = Boolean(
    process.env.E2E_GOOGLE_CLIENT_ID && process.env.E2E_GOOGLE_CLIENT_SECRET,
  );

  const notes = [
    "email sign-in: available offline, no configuration required — codes are written to this run's own outbox",
    oidcStub
      ? `social sign-in: local OIDC stub enabled (${OIDC_STUB_ENV}=1). Exercises the redirect, callback, handoff and linking rules; proves nothing about any real provider.`
      : `social sign-in: not exercised (set ${OIDC_STUB_ENV}=1 for the local stub lane).`,
  ];
  if (realGoogle) {
    notes.push(
      "a real social provider is configured; that lane is manual and reported separately, never a gate.",
    );
  }

  return { oidcStub, realGoogle, notes };
}

/** A one-line summary for the console. Contains no credential, because there is none to contain. */
export function describe(result: Preflight): string {
  return `identity: email (offline) · oidc-stub ${result.oidcStub ? "on" : "off"}`;
}

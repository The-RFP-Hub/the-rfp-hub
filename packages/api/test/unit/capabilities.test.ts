/**
 * THE AUTHORIZATION MATRIX.
 *
 * Every case below is a hole that a plausible simpler implementation leaves open. The two that
 * matter most, and that a `principal.tier` model cannot express at all:
 *
 *   1. A GLOBAL ROLE NEVER ELEVATES AN API KEY. A reviewer's or admin's key, and a key belonging
 *      to an account with `direct_create`, still needs the `publish` scope before anything it does
 *      publishes immediately. A leaked key must not inherit the powers of the human it belongs to.
 *   2. T2 IS PER-NAMESPACE. The same account is a verified publisher in one namespace and an
 *      ordinary submitter in the next, in the same request.
 */
import { describe, expect, it } from "vitest";
import {
  type Principal,
  canPublishWith,
  canWriteWith,
  effectiveCaps,
} from "../../src/modules/shared/capabilities.js";

const principal = (over: Partial<Principal> = {}): Principal => ({
  accountId: 1,
  credentialKind: "session",
  role: "submitter",
  directCreate: false,
  scopes: [],
  memberships: [],
  ...over,
});

const VERIFIED = { slug: "example", verified: true };
const UNVERIFIED = { slug: "unverified-org", verified: false };

describe("credential capability", () => {
  it("a session may always write; a key needs write or publish", () => {
    expect(canWriteWith(principal())).toBe(true);
    expect(canWriteWith(principal({ credentialKind: "api_key", scopes: ["read"] }))).toBe(false);
    expect(canWriteWith(principal({ credentialKind: "api_key", scopes: ["write"] }))).toBe(true);
    // publish implies write, so a publisher key does not need both scopes to do its job.
    expect(canWriteWith(principal({ credentialKind: "api_key", scopes: ["publish"] }))).toBe(true);
  });

  it("only `publish` lets a key cause immediate publication", () => {
    expect(canPublishWith(principal({ credentialKind: "api_key", scopes: ["write"] }))).toBe(false);
    expect(canPublishWith(principal({ credentialKind: "api_key", scopes: ["publish"] }))).toBe(
      true,
    );
  });
});

describe("publishing into a namespace", () => {
  it("a verified membership auto-approves in THAT namespace only", () => {
    const p = principal({ memberships: [VERIFIED] });
    expect(effectiveCaps(p, "example").canPublishImmediately).toBe(true);
    expect(effectiveCaps(p, "somewhere-else").canPublishImmediately).toBe(false);
    expect(effectiveCaps(p, undefined).canPublishImmediately).toBe(false);
  });

  // Verification is the whole point of T2 — approval of a claim without verifying the org
  // transfers ownership but must NOT unlock auto-approval.
  it("an UNVERIFIED membership does not auto-approve", () => {
    const p = principal({ memberships: [UNVERIFIED] });
    expect(effectiveCaps(p, "unverified-org").canPublishImmediately).toBe(false);
    expect(effectiveCaps(p, "unverified-org").canSubmit).toBe(true);
  });

  it("direct-create publishes in any namespace", () => {
    const p = principal({ directCreate: true });
    expect(effectiveCaps(p, "anything-at-all").canPublishImmediately).toBe(true);
  });

  // THE ESCALATION CASE. Both of these accounts could publish through a session; neither may do it
  // with a `write`-only key. The submission simply lands pending — failing closed to the safe
  // outcome rather than erroring, because a submitter who cannot publish still wants to submit.
  it("a write-only key on a direct-create account does NOT auto-approve", () => {
    const caps = effectiveCaps(
      principal({ credentialKind: "api_key", scopes: ["write"], directCreate: true }),
      "anything",
    );
    expect(caps.canSubmit).toBe(true);
    expect(caps.canPublishImmediately).toBe(false);
  });

  it("a write-only key on a reviewer account, in its own verified namespace, does NOT auto-approve", () => {
    const caps = effectiveCaps(
      principal({
        credentialKind: "api_key",
        scopes: ["write"],
        role: "reviewer",
        memberships: [VERIFIED],
      }),
      "example",
    );
    expect(caps.canPublishImmediately).toBe(false);
  });

  it("a publish key still needs the account to be allowed to publish there", () => {
    const caps = effectiveCaps(
      principal({ credentialKind: "api_key", scopes: ["publish"], memberships: [VERIFIED] }),
      "a-namespace-they-have-nothing-to-do-with",
    );
    expect(caps.canPublishImmediately).toBe(false);
  });

  it("both halves together are what publishes", () => {
    const caps = effectiveCaps(
      principal({ credentialKind: "api_key", scopes: ["publish"], memberships: [VERIFIED] }),
      "example",
    );
    expect(caps.canPublishImmediately).toBe(true);
  });

  it("a read-only key cannot even submit", () => {
    const caps = effectiveCaps(
      principal({ credentialKind: "api_key", scopes: ["read"], memberships: [VERIFIED] }),
      "example",
    );
    expect(caps.canSubmit).toBe(false);
    expect(caps.canPublishImmediately).toBe(false);
  });
});

describe("session-only surfaces", () => {
  // A leaked API key must not be able to mint a stronger key, approve anything, or grant itself a
  // role — so these four are false for EVERY key, whatever its scopes and whatever the role.
  it("keys, review and admin are refused to an API key regardless of role or scope", () => {
    for (const role of ["submitter", "reviewer", "admin"] as const) {
      const caps = effectiveCaps(
        principal({ credentialKind: "api_key", role, scopes: ["read", "write", "publish"] }),
        "example",
      );
      expect(caps.canManageKeys, role).toBe(false);
      expect(caps.canReview, role).toBe(false);
      expect(caps.canAdmin, role).toBe(false);
    }
  });

  it("a session gets exactly what its role says", () => {
    expect(effectiveCaps(principal()).canManageKeys).toBe(true);
    expect(effectiveCaps(principal()).canReview).toBe(false);

    const reviewer = effectiveCaps(principal({ role: "reviewer" }));
    expect(reviewer.canReview).toBe(true);
    expect(reviewer.canAdmin).toBe(false);

    const admin = effectiveCaps(principal({ role: "admin" }));
    // An admin reviews too — T4 is above T3, not beside it.
    expect(admin.canReview).toBe(true);
    expect(admin.canAdmin).toBe(true);
  });
});

describe("claims", () => {
  // A claim that would grant ownership immediately is held to the same credential bar as
  // publication: a `write`-only key gets a 403 naming the missing scope rather than a silent queue.
  it("granting requires publish on a key credential", () => {
    expect(effectiveCaps(principal()).canClaimGrant).toBe(true);
    expect(
      effectiveCaps(principal({ credentialKind: "api_key", scopes: ["write"] })).canClaimGrant,
    ).toBe(false);
    expect(
      effectiveCaps(principal({ credentialKind: "api_key", scopes: ["publish"] })).canClaimGrant,
    ).toBe(true);
  });
});

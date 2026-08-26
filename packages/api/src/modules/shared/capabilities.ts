/**
 * PURE authorization — what a principal may do, in one place, as a function of who they are AND
 * which credential they presented. No DB, no HTTP, unit-tested exhaustively.
 *
 * The shape is `effectiveCaps(principal, namespace)` rather than `principal.tier` because the
 * tiers are not a ladder:
 *
 *   T3 (reviewer) and T4 (admin) are GLOBAL — a role on the account.
 *   T2 (verified publisher) is PER-NAMESPACE — a membership on one verified organization. The same
 *   account is T2 in one namespace and T1 in the next, in the same request.
 *
 * A single `tier` field would have to pick one of those, and whichever it picked would be wrong
 * somewhere. So capabilities are computed against the namespace being acted on.
 *
 * THE RULE THAT CLOSES THE ESCALATION HOLE: a global role never elevates an API key. Any path that
 * causes IMMEDIATE PUBLICATION requires the `publish` scope on an API-key credential — including a
 * reviewer's key, an admin's key, and a key belonging to an account with `direct_create`. A leaked
 * key is a leaked key; it must not inherit the powers of the human it belongs to. Without
 * `publish` an otherwise-auto-approving submission simply LANDS PENDING (the safe outcome) rather
 * than erroring, because a submitter who cannot publish still wants their submission recorded.
 */

/** How the caller proved who they are. The distinction is load-bearing, not informational. */
export type CredentialKind = "session" | "api_key";

/** Global role on the account: T1, T3, T4. T2 is a membership, not a role. */
export type AccountRole = "submitter" | "reviewer" | "admin";

/** API-key scopes. `publish` is strictly stronger than `write`. */
export type ApiKeyScope = "read" | "write" | "publish";

/** A membership the account holds on one organization. */
export interface Membership {
  /** The organization's slug — which IS the namespace. */
  slug: string;
  /** Whether the organization is a verified publisher. Unverified never auto-approves. */
  verified: boolean;
}

export interface Principal {
  accountId: number;
  credentialKind: CredentialKind;
  role: AccountRole;
  /** Granted by an admin: publish anywhere, in any namespace, without a membership. */
  directCreate: boolean;
  /** Empty for a session — a session is not scoped, it is the account itself. */
  scopes: ApiKeyScope[];
  memberships: Membership[];
}

export interface Capabilities {
  /** May create or update entries at all (they may land `pending`). */
  canSubmit: boolean;
  /** A write in this namespace is published immediately rather than queued for review. */
  canPublishImmediately: boolean;
  /** May file a claim at all, whatever its outcome — including one that only reaches the queue. */
  canClaimFile: boolean;
  /** A claim on this namespace's organization would be GRANTED rather than queued. */
  canClaimGrant: boolean;
  /** May list, mint and revoke this account's API keys. Session only, always. */
  canManageKeys: boolean;
  /** T3: the review queue, merges, org verification, membership grants. Session only. */
  canReview: boolean;
  /** T4: roles and direct-create grants. Session only. */
  canAdmin: boolean;
}

const has = (scopes: ApiKeyScope[], scope: ApiKeyScope): boolean => scopes.includes(scope);

/**
 * Whether the credential itself permits writing.
 *
 * A session always may — it is the account acting directly. A key must carry `write` or the
 * strictly stronger `publish`; `publish` implying `write` is what stops a publisher key from
 * needing both scopes to do the thing it exists for.
 */
export function canWriteWith(principal: Principal): boolean {
  if (principal.credentialKind === "session") return true;
  return has(principal.scopes, "write") || has(principal.scopes, "publish");
}

/**
 * Whether the credential permits causing immediate publication.
 *
 * The session case is "is this account allowed to publish here at all"; the API-key case is that
 * AND the explicit `publish` scope. This single function is why a reviewer's `write`-only key
 * cannot approve by the back door.
 */
export function canPublishWith(principal: Principal): boolean {
  if (principal.credentialKind === "session") return true;
  return has(principal.scopes, "publish");
}

/** Whether the account is a member of a VERIFIED organization with this namespace. */
export function hasVerifiedMembership(
  principal: Principal,
  namespace: string | undefined,
): boolean {
  if (namespace === undefined) return false;
  return principal.memberships.some((m) => m.slug === namespace && m.verified);
}

/** Whether the account is a member of this organization at all, verified or not. */
export function hasMembership(principal: Principal, namespace: string | undefined): boolean {
  if (namespace === undefined) return false;
  return principal.memberships.some((m) => m.slug === namespace);
}

/**
 * Everything the principal may do with respect to one namespace.
 *
 * `namespace` is `undefined` for the account-scoped surfaces (keys, `/me`, admin), where no
 * namespace is being acted on — the per-namespace answers are then simply false.
 */
export function effectiveCaps(principal: Principal, namespace?: string): Capabilities {
  const session = principal.credentialKind === "session";
  const write = canWriteWith(principal);
  const publishCredential = canPublishWith(principal);

  // Who is allowed to publish into THIS namespace, ignoring the credential:
  //   a verified membership on it (T2), or an admin-granted direct-create (publish anywhere).
  // A reviewer/admin role is deliberately NOT on this list: approving is a review action with its
  // own audited route, not something a role does implicitly by submitting.
  const accountMayPublishHere =
    hasVerifiedMembership(principal, namespace) || principal.directCreate;

  return {
    canSubmit: write,
    // Both halves. Either alone is a hole: the account half alone lets a leaked `write` key
    // publish; the credential half alone lets any key with `publish` publish into a namespace its
    // owner has no relationship with.
    canPublishImmediately: write && accountMayPublishHere && publishCredential,
    // FILING a claim is a write even when it only queues: it puts a reviewer decision in flight
    // that can move publisher ownership of somebody else's entry. A `read`-only key is a reader,
    // and a reader must not be able to start that — so the queue path is held to `write`.
    canClaimFile: write,
    // GRANTING is a grant of ownership, so it is held to the same credential bar as publication.
    // The membership and verification checks belong to the claim service, which must make them
    // inside the granting transaction against the row it is about to write — a decision computed
    // here, before that transaction, could be won by a revocation racing it.
    canClaimGrant: publishCredential,
    // Session only, every one of them. A leaked API key must not be able to mint a stronger key,
    // change the account's identity, approve anything, or grant itself a role.
    canManageKeys: session,
    canReview: session && (principal.role === "reviewer" || principal.role === "admin"),
    canAdmin: session && principal.role === "admin",
  };
}

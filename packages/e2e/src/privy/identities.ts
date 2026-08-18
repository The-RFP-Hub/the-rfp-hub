/**
 * Which real identity plays which part, and how each part is actually provisioned.
 *
 * TWO SEPARATE CONCERNS, deliberately kept apart:
 *
 *   `assignActors()` is pure. It maps however many distinct DIDs the preflight found onto the named
 *   parts the specs ask for, and — where a part cannot be filled independently — records WHY, as a
 *   CONDITIONAL or BLOCKED entry that the report reproduces. It makes no network call and can be
 *   reasoned about (and, in principle, tested) without a stack.
 *
 *   `provision()` performs the promotions, organisation setup, memberships and verifications, and
 *   it does all of it **through the API's own routes**. Nothing here reaches into the database to
 *   manufacture a state the product cannot produce: if a publisher cannot be made a publisher by
 *   the documented sequence, that is a finding, not something to work around with an INSERT.
 *
 * WHERE THE ORGANISATIONS COME FROM. There is no organisation-creation endpoint. Organisations come
 * into existence as directory stubs when an opportunity naming them is submitted
 * (`opportunity-write.service.ts` → `insertOrganizationStubs`, create-only). So the provisioning
 * sequence for a publisher is necessarily: submit an entry naming the namespace → a reviewer grants
 * membership → a reviewer verifies the organisation. That ordering is the product's, not this
 * harness's, and every step is a real route a real publisher walks.
 */
import type { ApiClient } from "../http.js";
import type { ActorName, ActorState, RunState } from "../state.js";
import type { MintedIdentity, PreflightResult } from "./preflight.js";

export interface ActorAssignment {
  actors: Partial<Record<ActorName, ActorState>>;
  conditional: RunState["conditional"];
  blocked: RunState["blocked"];
}

export interface Namespaces {
  publisher: string;
  other: string;
}

/**
 * Run-scoped namespaces. Lowercase and hyphenated, the shape the API holds a namespace to.
 *
 * The SUFFIXES vary with the actor seed as well as the run id. Both already differ between runs
 * through the run id alone, so this buys one specific thing: it stops anything — a fixture, an
 * assertion, a stray hard-coded string — from quietly depending on the literal words "pubco" and
 * "otherco". If something does, the seeded run fails and says so.
 */
const NAMESPACE_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["pubco", "otherco"],
  ["orgone", "orgtwo"],
  ["alpha", "beta"],
  ["primary", "secondary"],
];

export function namespacesFor(runId: string, seed = 0): Namespaces {
  const base = `m3e2e-${runId.toLowerCase()}`;
  const shape = NAMESPACE_SHAPES[
    ((seed % NAMESPACE_SHAPES.length) + NAMESPACE_SHAPES.length) % NAMESPACE_SHAPES.length
  ] as readonly [string, string];
  return { publisher: `${base}-${shape[0]}`, other: `${base}-${shape[1]}` };
}

/**
 * Maps distinct DIDs onto parts.
 *
 * The administrator is chosen by the rotation and then MADE by the operator ceremony during
 * bring-up (`grant-admin`, against the migration credential). It is a one-off audited grant, not a
 * standing rule re-evaluated on every login — so unlike the environment-variable bootstrap it
 * replaced, the role can be revoked afterwards over the ordinary admin route, and the identity
 * carries nothing into the next run.
 *
 * Reviewer duties are performed by the ADMIN rather than by a dedicated identity, because
 * `requireRole("reviewer")` admits admins (`plugins/auth.ts`). That is what makes a small identity
 * count workable: the scarce resource is *non*-admin actors, so none is spent on a role an admin
 * already satisfies. The reviewer ROLE itself is still exercised — by promoting and then demoting
 * the plain submitter, which is two criteria rather than a shortcut. That aliasing is SAFE because
 * the two parts are capability-equivalent: everything `reviewer` does, an admin may do.
 *
 * NO OTHER ALIASING IS PERMITTED, and this is the rule that used to be broken. With exactly two
 * identities an earlier version pointed both `publisher` and `submitter` at the same DID, on the
 * theory that it "transitions between the roles across the run". But setup grants that DID a
 * verified membership, and the specs then read `submitter` as an ordinary account whose writes must
 * land `pending` — against an account that auto-publishes. Those tests do not fail informatively;
 * they assert the OPPOSITE of the product's rule and report it as satisfied. A part that cannot be
 * filled independently is therefore left EMPTY, and the criteria that need it are recorded as
 * blocked with the variable that would supply it.
 *
 * `browserDid`, when known, is assigned the PUBLISHER part. The browser session's `storageState`
 * belongs to exactly one identity, and every owner-only dashboard assertion reads entries created
 * through `api("publisher")` — so if the two were different identities, those specs would drive a
 * signed-in session that owns none of the data they are about.
 */
export function assignActors(
  identities: MintedIdentity[],
  namespaces: Namespaces,
  browserDid?: string,
  /**
   * Rotates which identity plays which part, deterministically.
   *
   * The point is not variety for its own sake. Privy tenant users PERSIST between runs while this
   * suite's database is destroyed with its container, so "the admin" is a role this run grants, not
   * a property the identity carries. Rotating the seed makes a DIFFERENT identity the bootstrap
   * administrator next time — and the identity that was administrator last time must come back as
   * an ordinary account with nothing. That is a real cross-run guarantee, and rotating is what makes
   * it observable instead of assumed.
   *
   * The BROWSER identity is exempt and always plays the publisher: `storageState` belongs to exactly
   * one identity, and the owner-only dashboard assertions read entries that actor created.
   */
  seed = 0,
): ActorAssignment {
  const actors: Partial<Record<ActorName, ActorState>> = {};
  const conditional: RunState["conditional"] = [];
  const blocked: RunState["blocked"] = [];
  const dids = identities.map((identity) => identity.did);

  if (dids.length === 0) {
    blocked.push({
      area: "every real-auth criterion",
      reason:
        "no real identity is available — no token could be minted and no browser login is configured",
      unblockedBy: ["E2E_PRIVY_TENANT_ACK", "E2E_PRIVY_TEST_EMAIL", "E2E_PRIVY_TEST_OTP"],
    });
    return { actors, conditional, blocked };
  }

  // The bootstrap admin is the first identity that is NOT the browser's: the browser identity is
  // needed as the publisher, and the bootstrap list is re-evaluated on every login, so a bootstrap
  // DID can never be demoted to one.
  // The pool the seed rotates: everyone except the browser's identity, which is spoken for.
  const hasBrowser = Boolean(browserDid && dids.includes(browserDid));
  const pool = hasBrowser ? dids.filter((did) => did !== browserDid) : [...dids];
  const offset = pool.length > 0 ? ((seed % pool.length) + pool.length) % pool.length : 0;
  const rotated = pool.map((_, index) => pool[(index + offset) % pool.length] as string);

  // With a browser identity present the pool excludes it, so the administrator is drawn from the
  // rotation and the publisher is the browser's. Without one, the rotation supplies both.
  const adminDid = (rotated[0] ?? dids[0]) as string;
  const publisherDid = hasBrowser
    ? (browserDid as string)
    : rotated.find((did) => did !== adminDid);
  const spare = rotated.filter((did) => did !== adminDid && did !== publisherDid);

  actors.admin = { name: "admin", did: adminDid, aliasGroup: "privileged" };
  // The admin performs reviewer duties. Recorded as a distinct actor pointing at the same DID so a
  // spec can say `actors.reviewer` and a reader of the state file can see it is not independent.
  actors.reviewer = { name: "reviewer", did: adminDid, shared: true, aliasGroup: "privileged" };

  if (publisherDid) {
    // Its own identity: no alias group, so any collision with another part is a hard skip.
    actors.publisher = {
      name: "publisher",
      did: publisherDid,
      namespace: namespaces.publisher,
      isBrowserIdentity: publisherDid === browserDid,
    };
  }

  if (spare.length >= 2) {
    actors.otherPublisher = {
      name: "otherPublisher",
      did: spare[0] as string,
      namespace: namespaces.other,
    };
    actors.submitter = { name: "submitter", did: spare[1] as string };
  } else if (spare.length === 1) {
    actors.submitter = { name: "submitter", did: spare[0] as string };
    conditional.push({
      area: "M3-5 another publisher has no access",
      reason:
        "3 distinct identities: no independent SECOND verified publisher exists. The criterion is " +
        "exercised as unauthenticated → 401 and authenticated non-owner → 403, which is weaker than " +
        "second verified publisher → 403.",
    });
  } else if (publisherDid) {
    // Two identities: an admin and one publisher. There is NO plain submitter, and the part is left
    // empty rather than aliased onto the publisher — see the header. Everything that needs an
    // ordinary, unaffiliated account is blocked and says so.
    blocked.push({
      area: "every criterion needing a plain (non-publishing) submitter",
      reason:
        "2 distinct identities: the only non-administrator account is the verified publisher, and " +
        "reusing it as the plain submitter would test the opposite of the rule — its writes " +
        "auto-publish. No account is left that can stand for an unaffiliated submitter.",
      unblockedBy: ["E2E_PRIVY_TEST_EMAILS (a third distinct test account)"],
    });
    blocked.push({
      area: "M3-5 another publisher has no access",
      reason: "no second non-admin identity exists to be that other publisher",
      unblockedBy: ["E2E_PRIVY_TEST_EMAILS (a third and fourth distinct test account)"],
    });
  } else {
    // ONE identity in the whole tenant. It is the bootstrap administrator, and it ALSO stands as the
    // publisher — which is sound rather than convenient, because publish authority comes from a
    // verified membership and never from a global role: `effectiveCaps` computes
    // `accountMayPublishHere` from `hasVerifiedMembership || directCreate`, and the code says in as
    // many words that a reviewer/admin role is deliberately not on that list. So the auto-publish,
    // out-of-namespace and operating-organisation criteria all still mean what they say.
    //
    // The plain SUBMITTER is still not filled, and must not be: that part's entire content is an
    // account WITHOUT a verified membership, which this identity has. Everything resting on it is
    // blocked below.
    actors.publisher = {
      name: "publisher",
      did: adminDid,
      namespace: namespaces.publisher,
      shared: true,
      aliasGroup: "privileged",
      isBrowserIdentity: adminDid === browserDid,
    };
    conditional.push({
      area: "M3-2 write path, M3-3 dedupe, M3-4 verification, M3-6 staleness, M3-5 analytics",
      reason:
        "1 distinct identity: the publisher is also the administrator. Publish authority is derived " +
        "from verified membership rather than from role, so these criteria are exercised faithfully " +
        "— but every one of them is performed by a privileged account, and none of them observes an " +
        "ordinary publisher acting alone.",
    });
    blocked.push({
      area: "every criterion needing a plain (non-publishing) submitter, or a second actor",
      reason:
        "1 distinct identity: there is no unaffiliated account to submit as, and no second party to " +
        "be refused. The pending-write path, the cross-account key isolation, and every 403 that " +
        "depends on being somebody else cannot be observed.",
      unblockedBy: [
        "E2E_PRIVY_TEST_EMAILS (further distinct test accounts in the identity tenant)",
      ],
    });
  }

  return { actors, conditional, blocked };
}

// ── provisioning ───────────────────────────────────────────────────────────────────────────────

export interface ProvisionContext {
  /** A client per actor, already carrying that actor's own real token. */
  clientFor: (actor: ActorName) => ApiClient;
  actors: Partial<Record<ActorName, ActorState>>;
  namespaces: Namespaces;
  runId: string;
  /** The fixture page every provisioning entry points at, so a stray verification run is harmless. */
  applicationUrl: string;
}

/** The `/v1/me` shape the provisioner reads. A subset — the full component is in the API's OpenAPI. */
export interface MeView {
  accountId: number;
  handle: string | null;
  role: "submitter" | "reviewer" | "admin";
  credentialKind: "session" | "api_key";
  scopes: string[];
  memberships: Array<{ slug: string; name: string; role: string; verified: boolean }>;
  canManageKeys: boolean;
  canReview: boolean;
  canAdmin: boolean;
}

/** Reads (and, on a fresh DID, creates) the account behind a credential. */
export async function me(client: ApiClient): Promise<MeView> {
  return (await client.expectOk({ path: "/v1/me" })) as MeView;
}

/**
 * Brings an actor's namespace into existence and makes the actor a verified publisher of it.
 *
 * Idempotent, deliberately: `E2E_RUN_ID` can be reused to re-run against a stack that is already
 * part-provisioned while debugging, and every step here is either create-only at the API
 * (the organisation stub) or an upsert (membership, verification).
 */
export async function ensureVerifiedPublisher(
  ctx: ProvisionContext,
  actor: ActorName,
  namespace: string,
): Promise<void> {
  const owner = ctx.clientFor(actor);
  const reviewer = ctx.clientFor("reviewer");
  const state = ctx.actors[actor];
  if (!state) throw new Error(`identities: no actor "${actor}" to provision`);

  // 1. The organisation stub, created the only way the product creates one: by submitting an entry
  //    that names it. The entry itself is a legitimate fixture, not a throwaway.
  //
  //    A REPEAT OF THIS STEP ANSWERS 409, and that is correct of the API rather than a problem to
  //    route around: the stored row is no longer byte-identical to what is being submitted — the
  //    server has stamped provenance onto it and decided its review status — so a differing document
  //    under an existing id must not silently overwrite. This function's contract is only that the
  //    organisation EXISTS afterwards, and a 409 says it does. Anything else is still a failure.
  //
  //    (This was found by the idempotence assertion in the acceptance setup, which re-runs
  //    provisioning against a live stack. The function had claimed idempotence in its own comment
  //    and did not have it.)
  const stub = await owner.request({
    method: "POST",
    path: "/v1/opportunities",
    body: seedDocument(`${namespace}:setup-${ctx.runId}`, namespace, ctx.applicationUrl),
  });
  const alreadyThere =
    stub.status === 409 && (stub.body as { error?: string } | undefined)?.error === "id_conflict";
  if (stub.status !== 201 && !alreadyThere) {
    throw new Error(
      `identities: could not create the organisation stub for "${namespace}" — POST /v1/opportunities → ${stub.status} ${stub.text.slice(0, 300)}`,
    );
  }

  // 2. Membership, granted by a reviewer over the real route.
  const accountId = state.accountId ?? (await me(owner)).accountId;
  await reviewer.expectOk({
    method: "POST",
    path: `/v1/review/organizations/${namespace}/members`,
    body: { accountId, role: "publisher" },
  });

  // 3. Verification, likewise. This is the step that turns a membership into publish authority.
  await reviewer.expectOk({
    method: "POST",
    path: `/v1/review/organizations/${namespace}/verify`,
  });

  state.accountId = accountId;
  state.namespace = namespace;
  state.verified = true;
}

/** Sets an account's global role through the admin route, and returns the resulting summary. */
export async function setRole(
  ctx: ProvisionContext,
  accountId: number,
  role: "submitter" | "reviewer" | "admin",
): Promise<{ id: number; globalRole: string }> {
  return (await ctx.clientFor("admin").expectOk({
    method: "POST",
    path: `/v1/admin/accounts/${accountId}/role`,
    body: { role },
  })) as { id: number; globalRole: string };
}

/**
 * A Standard-conformant fixture document, mirroring `packages/api/test/helpers/opportunity-fixture.ts`.
 *
 * Kept as a mirror rather than an import: that helper lives in the API package's TEST tree, which
 * is not an exported entry point, and reaching across a package's test boundary would couple this
 * suite to a file the API is free to reorganise. The shape is small and the drift is visible — a
 * document that stops validating fails the very first provisioning call, loudly.
 */
export function seedDocument(
  id: string,
  namespace: string,
  applicationUrl: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    specVersion: "1.0.0",
    id,
    fundingType: "grant",
    title: `E2E fixture ${id}`,
    description: "An end-to-end suite fixture entry.",
    status: "open",
    operatingOrganizations: [{ name: namespace, slug: namespace }],
    source: { publisher: namespace },
    ecosystems: ["M3E2E"],
    fundingDetails: { fundingType: "grant" },
    applicationUrl,
    ...over,
  };
}

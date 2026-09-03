/**
 * Which identity plays which part, and how each part is actually provisioned.
 *
 * `assignActors()` USED TO BE THE HARD PART. It mapped however many identities a third-party tenant
 * happened to contain onto the parts the specs need, with a branch per scarcity level: alias the
 * publisher onto the administrator at two identities, leave the plain submitter unfilled, record
 * which criteria were therefore CONDITIONAL, and guard every spec against actors that had silently
 * collapsed onto one another. All of that existed because identities were a scarce external
 * resource somebody had to provision by hand.
 *
 * THEY ARE NOT SCARCE ANY MORE. An identity is an address at a reserved domain and a code this run
 * writes to its own outbox, so the function asks for five and gets five, every time, offline. Every
 * scarcity branch, the alias groups, the rotation and the `UNBLOCKED_BY` skip strings are deleted
 * rather than kept "just in case" — a branch that can no longer be reached is a branch nobody will
 * maintain and everybody will trust.
 *
 * `provision()` is unchanged in spirit: promotions, organisation setup, memberships and
 * verifications all go **through the API's own routes**. Nothing here reaches into the database to
 * manufacture a state the product cannot produce — if a publisher cannot be made a publisher by the
 * documented sequence, that is a finding, not something to work around with an INSERT.
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
import { type Identity, addressFor, identityFor } from "./sessions.js";

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
  const base = `e2e-${runId.toLowerCase()}`;
  const shape = NAMESPACE_SHAPES[
    ((seed % NAMESPACE_SHAPES.length) + NAMESPACE_SHAPES.length) % NAMESPACE_SHAPES.length
  ] as readonly [string, string];
  return { publisher: `${base}-${shape[0]}`, other: `${base}-${shape[1]}` };
}

/**
 * The five parts, each its own identity.
 *
 * The BROWSER identity is the publisher, as it was before and for the same reason: `storageState`
 * belongs to exactly one identity, and every owner-only dashboard assertion reads entries that actor
 * created. Nothing else is negotiable either — there is no scarcity left to negotiate with.
 *
 * `conditional` and `blocked` are still returned, and are still written into the run state and the
 * report. They are expected to be empty now; keeping the fields means a future genuine limitation
 * has somewhere to be recorded, rather than being discovered as a silently-passing test.
 */
export const ACTOR_LABELS: Record<ActorName, string> = {
  admin: "admin",
  reviewer: "reviewer",
  publisher: "publisher",
  otherPublisher: "otherpub",
  submitter: "submitter",
};

export function assignActors(identities: Identity[], namespaces: Namespaces): ActorAssignment {
  const actors: Partial<Record<ActorName, ActorState>> = {};
  const conditional: RunState["conditional"] = [];
  const blocked: RunState["blocked"] = [];

  const byLabel = new Map(identities.map((identity) => [identity.email, identity]));
  const take = (name: ActorName): Identity => {
    const identity = [...byLabel.values()].find((candidate) =>
      candidate.email.includes(`-${ACTOR_LABELS[name]}@`),
    );
    if (!identity) {
      throw new Error(
        `actors: no identity was established for "${name}". The runner signs in as one address per part before Playwright starts; this is a bring-up bug, not a configuration one.`,
      );
    }
    return identity;
  };

  const admin = take("admin");
  actors.admin = { name: "admin", userId: admin.userId, email: admin.email };
  // The administrator performs reviewer duties: `requireRole("reviewer")` admits administrators, so
  // spending a whole identity on a part an admin already satisfies would buy nothing. Recorded as a
  // distinct actor pointing at the same identity so a reader of the state file can see it.
  actors.reviewer = {
    name: "reviewer",
    userId: admin.userId,
    email: admin.email,
    shared: true,
    aliasGroup: "privileged",
  };

  const publisher = take("publisher");
  actors.publisher = {
    name: "publisher",
    userId: publisher.userId,
    email: publisher.email,
    namespace: namespaces.publisher,
    isBrowserIdentity: true,
  };

  const other = take("otherPublisher");
  actors.otherPublisher = {
    name: "otherPublisher",
    userId: other.userId,
    email: other.email,
    namespace: namespaces.other,
  };

  const submitter = take("submitter");
  actors.submitter = { name: "submitter", userId: submitter.userId, email: submitter.email };

  return { actors, conditional, blocked };
}

/** The addresses this run signs in as, one per part. */
export function actorAddresses(runId: string): Record<ActorName, string> {
  return {
    admin: addressFor(runId, ACTOR_LABELS.admin),
    reviewer: addressFor(runId, ACTOR_LABELS.admin),
    publisher: addressFor(runId, ACTOR_LABELS.publisher),
    otherPublisher: addressFor(runId, ACTOR_LABELS.otherPublisher),
    submitter: addressFor(runId, ACTOR_LABELS.submitter),
  };
}

/**
 * Signs in as every part, in order, and returns what was established.
 *
 * The administrator and the reviewer share one address, so four sign-ins produce five parts.
 */
export async function establishIdentities(runId: string): Promise<Identity[]> {
  const wanted = [
    ACTOR_LABELS.admin,
    ACTOR_LABELS.publisher,
    ACTOR_LABELS.otherPublisher,
    ACTOR_LABELS.submitter,
  ];
  const established: Identity[] = [];
  for (const label of wanted) {
    established.push(await identityFor(addressFor(runId, label)));
  }
  return established;
}

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

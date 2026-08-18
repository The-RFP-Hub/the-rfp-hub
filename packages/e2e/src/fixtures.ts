/**
 * The suite's Playwright fixtures: everything a spec needs to talk to the running stack.
 *
 * A spec should say what it is asserting and nothing else. So the plumbing — which actor's token,
 * which database role, which browser context — lives here, and it obeys three rules:
 *
 *   1. **An unavailable actor is a SKIP WITH A REASON, never a silent pass.** `requireActor` names
 *      the environment variable that would make the actor exist. A criterion the run could not
 *      exercise has to look different from one it exercised and satisfied, in the report and in the
 *      test output, or the suite is a machine for producing false confidence.
 *   2. **Two database handles, and they are not interchangeable.** `db` is the OWNER role: it is how
 *      a spec ages a fixture backwards, reads `audit_log`, or asserts on `opportunity_duplicates`.
 *      `restrictedDb` is the same role the API itself runs on, and exists so a spec can prove what
 *      that role can and cannot do. Using the owner where the restricted role was meant would turn a
 *      least-privilege assertion into no assertion at all.
 *   3. **Everything minted is registered with the redactor**, so the end-of-run artifact scan is
 *      searching for the credentials this run actually created rather than a list from bring-up.
 */
import { test as base, expect } from "@playwright/test";
import pg from "pg";
import { ApiClient } from "./http.js";
import { seedDocument } from "./privy/identities.js";
import { UNBLOCKED_BY } from "./privy/preflight.js";
import { register } from "./redact.js";
import { type ActorName, type RunState, readState } from "./state.js";
import { tokenForDid } from "./tokens.js";

export { expect };

/** The default desktop User-Agent. Countable by the analytics hasher — the ordinary-visitor case. */
export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface WorkerFixtures {
  stack: RunState;
  db: pg.Pool;
  restrictedDb: pg.Pool;
}

export interface TestFixtures {
  /** A client carrying the named actor's own real session token. */
  api: (actor: ActorName) => Promise<ApiClient>;
  /** A client with no credential at all — the anonymous public reader. */
  anonApi: ApiClient;
  /** Mints an API key for an actor and hands back a client that uses it. */
  keyClient: (actor: ActorName, scopes: Array<"read" | "write" | "publish">) => Promise<KeyClient>;
  /** A Standard-conformant fixture document in the run's own namespace. */
  opportunityFixture: (
    namespace: string,
    suffix: string,
    over?: Record<string, unknown>,
  ) => Record<string, unknown>;
}

export interface KeyClient {
  client: ApiClient;
  token: string;
  keyId: number;
  keyPrefix: string;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  stack: [
    // Playwright inspects the source of a fixture function to work out which other fixtures it
    // depends on, and REQUIRES the first parameter to be an object destructuring pattern — a named
    // parameter is rejected at load time. This fixture depends on nothing (it reads the state file
    // the runner wrote), so the pattern is necessarily empty.
    // biome-ignore lint/correctness/noEmptyPattern: Playwright rejects a named first parameter here.
    async ({}, use) => {
      await use(readState());
    },
    { scope: "worker" },
  ],

  db: [
    async ({ stack }, use) => {
      const pool = new pg.Pool({ connectionString: stack.db.adminUrl, max: 4 });
      await use(pool);
      await pool.end();
    },
    { scope: "worker" },
  ],

  restrictedDb: [
    async ({ stack }, use) => {
      // The password is in the connection string, so it is registered before anything can print it
      // in a failed-query error message.
      register(new URL(stack.db.runtimeUrl).password, {
        label: "runtime-db-password",
        longLived: false,
      });
      const pool = new pg.Pool({ connectionString: stack.db.runtimeUrl, max: 2 });
      await use(pool);
      await pool.end();
    },
    { scope: "worker" },
  ],

  api: async ({ stack }, use) => {
    await use(async (actor: ActorName) => {
      const state = requireActor(stack, actor);
      const token = await tokenForDid(state.did);
      register(token, { label: "privy-access-token", longLived: false });
      return new ApiClient({ baseUrl: stack.urls.api, token, userAgent: DESKTOP_UA });
    });
  },

  anonApi: async ({ stack }, use) => {
    await use(new ApiClient({ baseUrl: stack.urls.api, userAgent: DESKTOP_UA }));
  },

  keyClient: async ({ stack, api }, use) => {
    const created: Array<{ owner: ApiClient; id: number }> = [];

    await use(async (actor, scopes) => {
      const owner = await api(actor);
      // `POST /v1/keys` is rate limited to 10/min. Specs that need many keys seed them through
      // `db`; this fixture is for the handful a spec actually mints through the product.
      const response = await owner.post<{ key: { id: number; keyPrefix: string }; token: string }>(
        "/v1/keys",
        { name: `e2e-${Date.now()}`, scopes },
      );
      if (response.status !== 201) {
        throw new Error(
          `keyClient: POST /v1/keys → ${response.status} ${response.text.slice(0, 300)}`,
        );
      }
      const { key, token } = response.body;
      // An API key outlives the run: it is stored hashed in a database that is destroyed at
      // teardown, but the token string itself would still be a live credential if it escaped into
      // an artifact. Long-lived, therefore, for the scan's purposes.
      register(token, { label: "api-key", longLived: true });
      created.push({ owner, id: key.id });
      return {
        client: new ApiClient({ baseUrl: stack.urls.api, token, userAgent: DESKTOP_UA }),
        token,
        keyId: key.id,
        keyPrefix: key.keyPrefix,
      };
    });

    // Revoked rather than left live: the database goes away at teardown, but a test that asserted
    // on a key count would otherwise see keys from a sibling test in the same run.
    for (const key of created) {
      await key.owner.delete(`/v1/keys/${key.id}`).catch(() => undefined);
    }
  },

  opportunityFixture: async ({ stack }, use) => {
    await use((namespace, suffix, over = {}) =>
      seedDocument(`${namespace}:${suffix}`, namespace, stack.urls.programme, over),
    );
  },
});

/**
 * The actor, or a failure that names what is missing.
 *
 * Specs call `skipUnlessActor` first and this second; the split exists because Playwright's
 * `test.skip` has to run before any fixture work, while the lookup itself is what produces the
 * message.
 */
export function requireActor(stack: RunState, actor: ActorName) {
  const state = stack.actors[actor];
  if (!state) {
    throw new Error(
      `no "${actor}" identity at ladder level ${stack.level}. ` +
        `Set ${UNBLOCKED_BY[stack.level].join(" and ") || "more distinct test accounts"} to provide one.`,
    );
  }
  return state;
}

/**
 * Declares a spec BLOCKED by missing external configuration.
 *
 * The reason string always names the environment variable that would unblock it, because a skipped
 * test whose reason is "not available" tells a reader nothing they can act on. These strings are
 * what the reporter turns into the report's BLOCKED column.
 */
export function skipUnlessActor(stack: RunState, ...actors: ActorName[]): void {
  const unblock = UNBLOCKED_BY[stack.level].join(", ") || "further distinct Privy test accounts";

  const missing = actors.filter((actor) => !stack.actors[actor]);
  if (missing.length > 0) {
    test.skip(
      true,
      `BLOCKED-by-missing-external-config: no ${missing.join(", ")} identity at ladder level ${stack.level}. ` +
        `Unblocked by: ${unblock}.`,
    );
    return;
  }

  // A spec that asked for two parts must GET two parts.
  //
  // `assignActors` no longer aliases anything except reviewer↔admin, which is sanctioned because the
  // two are capability-equivalent. This is the backstop for everything else: if a future assignment
  // ever points two requested names at one DID, the spec is silently testing a different situation
  // than it says it is — a "plain submitter" that is really the verified publisher will auto-publish,
  // and the test will assert, and report, the opposite of the rule. Skipping loudly is the only safe
  // response; passing is the dangerous one.
  const seen = new Map<string, ActorName>();
  for (const name of actors) {
    const did = stack.actors[name]?.did;
    if (!did) continue;
    const other = seen.get(did);
    // A collision is sanctioned only when BOTH actors declare the same alias group — the runner's
    // explicit statement that the sharing is deliberate and harmless. See `ActorState.aliasGroup`.
    const group = stack.actors[name]?.aliasGroup;
    const otherGroup = other ? stack.actors[other]?.aliasGroup : undefined;
    if (other && !(group !== undefined && group === otherGroup)) {
      test.skip(
        true,
        `BLOCKED-by-missing-external-config: "${name}" and "${other}" resolve to the same identity at ` +
          `ladder level ${stack.level}, so this criterion cannot distinguish them. Unblocked by: ${unblock}.`,
      );
      return;
    }
    seen.set(did, name);
  }
}

/**
 * For a spec that needs a signed-in browser, and needs it to be a PARTICULAR actor's session.
 *
 * The second half is what stops a whole class of quiet nonsense. `storageState` belongs to exactly
 * one identity, and every owner-only dashboard assertion reads entries created over HTTP by
 * `api("publisher")`. If the browser signed in as some other identity — easy to arrange by adding
 * extra test emails — those specs would load a signed-in dashboard that owns none of the data they
 * are about, and would fail for a reason that has nothing to do with the product. `assignActors`
 * makes the browser identity the publisher precisely so this holds; this is the assertion that it
 * did, checked where a spec can report it rather than where it would surface as a mystery.
 */
export function skipUnlessBrowserSession(stack: RunState, owner: ActorName = "publisher"): void {
  if (!stack.storageStatePath) {
    test.skip(
      true,
      "BLOCKED-by-missing-external-config: no browser session was established. " +
        "Unblocked by: E2E_PRIVY_TENANT_ACK, E2E_PRIVY_TEST_EMAIL, E2E_PRIVY_TEST_OTP.",
    );
    return;
  }

  const actor = stack.actors[owner];
  if (!actor || (stack.browserDid && actor.did !== stack.browserDid)) {
    test.skip(
      true,
      `BLOCKED-by-missing-external-config: the browser session does not belong to the "${owner}" actor, so an owner-only assertion would be driven by a session that owns nothing here. Unblocked by: E2E_PRIVY_TEST_EMAIL naming the identity that should hold the browser session.`,
    );
  }
}

/**
 * Waits for the analytics buffer to flush.
 *
 * `event-buffer.ts` flushes every 2 s, so a counter read immediately after the request that should
 * have moved it is a race the test would lose most of the time. Polling the assertion is honest
 * about that; a fixed sleep would be slower AND flakier.
 */
export async function pollUntil<T>(
  what: string,
  read: () => Promise<T>,
  holds: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (holds(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what}: never held within ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
}

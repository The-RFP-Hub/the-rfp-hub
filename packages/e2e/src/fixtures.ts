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
import type { BrowserContext } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import pg from "pg";
import { ApiClient } from "./http.js";
import { seedDocument } from "./identity/actors.js";
import { addressFor, identityFor, sessionFor } from "./identity/sessions.js";
import { register } from "./redact.js";
import { type ActorName, type RunState, readState } from "./state.js";

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
  /**
   * Makes room in the review queue for an account the pending cap applies to.
   *
   * See `PENDING_SUBMISSION_LIMIT` below for why this exists at all.
   */
  pendingHeadroom: (actor: ActorName, slots?: number) => Promise<void>;
  /**
   * A browser context signed in as somebody OTHER than the identity `storageState` holds.
   *
   * The project supplies one signed-in context, and it belongs to the publisher (see
   * `skipUnlessBrowserSession`). A criterion about what a DIFFERENT account sees — a submitter
   * reading the refusal on their own listing, an account that has no verified membership meeting
   * the pending cap — cannot be driven by it. This signs in over the API the way `api()` does and
   * seeds the token into a fresh context's storage, which is exactly what the frontend's own
   * sign-in leaves behind (`SESSION_STORAGE_KEY` in `lib/auth-client.ts`).
   *
   * NOT a second implementation of signing in: `00-acceptance.setup.ts` and the bring-up login
   * assert that the product's own form produces this state. This is how a spec ADOPTS that state
   * for an identity the run did not put in the browser.
   */
  contextAs: (who: ActorName | { email: string }) => Promise<BrowserContext>;
}

/**
 * How many entries an account with no verified membership may have awaiting review at once.
 *
 * `pendingSubmissionLimit` in the API's configuration, fixed in code at 5 — a product rule, not an
 * environment setting. THIS SUITE HAS TO KNOW IT because the queue is a shared resource and this
 * suite is a heavy user of it: the `submitter` actor is the run's general-purpose "some other
 * account", it holds no verified membership anywhere, and half a dozen specs across three files
 * use it to manufacture a pending entry. Past the fifth, the API answers 409
 * `pending_limit_reached` — correctly — and a spec that is about duplicate detection or audit
 * redaction fails on a rule it never meant to exercise.
 *
 * The cap itself is asserted deliberately and in one place (`m3-1-lifecycle.spec.ts`), against an
 * identity created for it, so that nothing else in the run has to care what order it ran in.
 */
export const PENDING_SUBMISSION_LIMIT = 5;

/** Where the frontend keeps the session token. `SESSION_STORAGE_KEY` in `lib/auth-client.ts`. */
const SESSION_STORAGE_KEY = "rfphub.session-token";

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
      const { token } = await sessionFor(state.email);
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

  /**
   * Frees review-queue slots THROUGH THE PRODUCT'S OWN ROUTE, never with an UPDATE.
   *
   * "A slot frees as soon as one of them is approved or rejected" is the API's own sentence, so a
   * reviewer deciding the account's oldest pending entries is the documented way to make room —
   * the same thing a person would do. Reaching into the table to flip `review_status` would
   * manufacture a state by a path the product does not have, and would skip the audit row that
   * makes the decision answerable.
   *
   * The OLDEST are decided first, and that is what makes this safe to call from any spec: files run
   * serially with one worker, so anything older than the caller's own fixtures has already been
   * asserted on. It is a no-op for an account with a verified membership, which the API exempts.
   */
  pendingHeadroom: async ({ api }, use) => {
    await use(async (actor, slots = 1) => {
      const owner = await api(actor);
      const mine = await owner.get<{
        total: number;
        items: Array<{ id: string; createdAt: string }>;
      }>("/v1/me/opportunities?reviewStatus=pending&limit=100");
      if (mine.status !== 200) {
        throw new Error(
          `pendingHeadroom: GET /v1/me/opportunities → ${mine.status} ${mine.text.slice(0, 200)}`,
        );
      }
      const surplus = mine.body.total + slots - PENDING_SUBMISSION_LIMIT;
      if (surplus <= 0) return;

      const reviewer = await api("reviewer");
      const oldestFirst = [...mine.body.items].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      for (const entry of oldestFirst.slice(0, surplus)) {
        const decided = await reviewer.post(
          `/v1/review/opportunities/${encodeURIComponent(entry.id)}/reject`,
          {
            reason:
              "e2e: decided to free a review-queue slot. The suite's shared submitter identity is capped like any account without a verified membership.",
          },
        );
        if (decided.status !== 200) {
          throw new Error(
            `pendingHeadroom: could not free a slot by rejecting ${entry.id} — ${decided.status} ${decided.text.slice(0, 200)}`,
          );
        }
      }
    });
  },

  contextAs: async ({ browser, stack }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (who) => {
      const email = typeof who === "string" ? requireActor(stack, who).email : who.email;
      const { token } = await sessionFor(email);
      const context = await browser.newContext({
        userAgent: DESKTOP_UA,
        storageState: {
          cookies: [],
          origins: [
            {
              origin: new URL(stack.urls.frontend).origin,
              localStorage: [{ name: SESSION_STORAGE_KEY, value: token }],
            },
          ],
        },
      });
      opened.push(context);
      return context;
    });
    for (const context of opened) await context.close().catch(() => undefined);
  },
});

/**
 * Signs in as an address this run has not used before, creating the identity by using it.
 *
 * There is no provisioning step and no ceiling — see `identity/sessions.ts`. A spec reaches for
 * this when the five named parts would all be the wrong shape for what it is asserting: the pending
 * cap is about an account's OWN queue, and running it against the shared `submitter` would make the
 * assertion depend on how many entries every earlier file happened to leave behind.
 */
export async function freshIdentity(
  stack: RunState,
  label: string,
): Promise<{ email: string; token: string; userId: string }> {
  return identityFor(addressFor(stack.runId, label));
}

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
      `no "${actor}" identity in this run. The runner signs in as one address per part before Playwright starts, and identities need no external provisioning — so this is a bring-up bug rather than a configuration one.`,
    );
  }
  return state;
}

/**
 * A skip locally, a FAILURE in CI: Playwright exits 0 on a skip, so a bring-up failure — which
 * skips every spec at once — would leave an evidence gate green having asserted nothing.
 */
function blocked(reason: string): void {
  if (process.env.CI) throw new Error(`${reason} In CI this is a failure, not a skip.`);
  test.skip(true, reason);
}

/**
 * Declares a spec unable to run, and says why.
 *
 * THIS USED TO BE THE MOST-CALLED FUNCTION IN THE SUITE. Identities came from a third-party tenant
 * in whatever quantity somebody had provisioned, so every spec had to ask permission first, and a
 * routine run reported dozens of criteria BLOCKED with a list of environment variables that would
 * unblock them. Identities are now created by using them, offline, so the answer is always yes.
 *
 * The function survives as a backstop rather than a gate: if a part is genuinely missing, or two
 * parts collapse onto one identity, a spec must skip loudly instead of quietly asserting something
 * other than what it claims — a "plain submitter" that is really the verified publisher would
 * auto-publish, and the test would report the OPPOSITE of the rule as satisfied. That failure mode
 * is worth keeping a guard for even when it should be unreachable.
 */
export function skipUnlessActor(stack: RunState, ...actors: ActorName[]): void {
  const missing = actors.filter((actor) => !stack.actors[actor]);
  if (missing.length > 0) {
    blocked(
      `BLOCKED: no ${missing.join(", ")} identity was established for this run. Identities need no external configuration, so this indicates a bring-up failure — see the runner's output.`,
    );
    return;
  }

  const seen = new Map<string, ActorName>();
  for (const name of actors) {
    const userId = stack.actors[name]?.userId;
    if (!userId) continue;
    const other = seen.get(userId);
    // Sanctioned only when BOTH declare the same alias group — the runner's explicit statement that
    // the sharing is deliberate. Only reviewer↔admin ever does, because the two are
    // capability-equivalent: `requireRole("reviewer")` admits administrators.
    const group = stack.actors[name]?.aliasGroup;
    const otherGroup = other ? stack.actors[other]?.aliasGroup : undefined;
    if (other && !(group !== undefined && group === otherGroup)) {
      blocked(
        `BLOCKED: "${name}" and "${other}" resolve to the same identity, so this criterion cannot distinguish them.`,
      );
      return;
    }
    seen.set(userId, name);
  }
}

/**
 * For a spec that needs a signed-in browser, and needs it to be a PARTICULAR actor's session.
 *
 * `storageState` belongs to exactly one identity, and every owner-only dashboard assertion reads
 * entries created over HTTP by `api("publisher")`. If the browser signed in as a different identity
 * those specs would load a signed-in dashboard that owns none of the data they are about, and would
 * fail for a reason that has nothing to do with the product. `assignActors` makes the browser
 * identity the publisher precisely so this holds; this is the assertion that it did, checked where a
 * spec can report it rather than where it would surface as a mystery.
 */
export function skipUnlessBrowserSession(stack: RunState, owner: ActorName = "publisher"): void {
  if (!stack.storageStatePath) {
    test.skip(true, "BLOCKED: no browser session was established during bring-up.");
    return;
  }

  const actor = stack.actors[owner];
  if (!actor || (stack.browserUserId && actor.userId !== stack.browserUserId)) {
    test.skip(
      true,
      `BLOCKED: the browser session does not belong to the "${owner}" actor, so an owner-only assertion would be driven by a session that owns nothing here.`,
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

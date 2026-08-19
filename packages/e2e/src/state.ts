/**
 * The run's shared state file — the only channel from the runner to the Playwright workers.
 *
 * Playwright spawns its own worker processes, so anything a spec needs to know about the stack has
 * to survive a process boundary. It goes through a JSON file in the run's 0700 temp directory
 * rather than through the environment because it is structured (ports, DIDs, account ids, a
 * capability report) and because the setup project ADDS to it: provisioning results computed in the
 * setup project have to reach the specs that depend on them.
 *
 * **No token, secret or OTP is ever written here.** Credentials are minted per call site from the
 * material the runner keeps in its own process (or, for a worker, re-minted through the provisioner
 * using the app secret it never receives — which is why worker-side minting goes through the
 * browser session or through an already-issued API key instead). What lands in this file is
 * identifiers and configuration: things that are useless without a credential.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The named parts a spec asks for. See `identities.ts` for how each is filled at each level. */
export type ActorName = "admin" | "reviewer" | "publisher" | "otherPublisher" | "submitter";

export interface ActorState {
  name: ActorName;
  /**
   * `auth_user.id` — the subject the account row joins on (`accounts.auth_user_id`).
   *
   * Named `userId` rather than the old `did`: it is no longer a decentralised identifier issued by
   * anybody, it is a row id in this run's own disposable database.
   */
  userId: string;
  /** The address this identity signs in with, and the outbox is keyed on. */
  email: string;
  /** Filled by the setup project, after the actor's first `/v1/me`. */
  accountId?: number;
  handle?: string | null;
  /** The namespace this actor publishes in, when it has one. */
  namespace?: string;
  /** True once the actor's organisation has been verified by a reviewer. */
  verified?: boolean;
  /**
   * True when this actor shares a DID with another actor.
   *
   * The ONLY sanctioned sharing is reviewer↔admin, which is safe because the two are
   * capability-equivalent (`requireRole("reviewer")` admits admins). Any other collision is a bug,
   * and `skipUnlessActor` refuses to let a spec run on one — see the comment there.
   */
  shared?: boolean;
  /**
   * Actors carrying the SAME non-empty group are knowingly one identity, and a spec asking for two
   * of them is not deceived by that.
   *
   * Only two groupings are ever sanctioned, and both are safe for a stated reason. `admin`+
   * `reviewer` share one because `requireRole("reviewer")` admits administrators, so the two are
   * capability-equivalent. At a single available identity, `publisher` joins them — because publish
   * authority is derived from a VERIFIED MEMBERSHIP and never from a global role
   * (`modules/shared/capabilities.ts`: "A reviewer/admin role is deliberately NOT on this list"), so
   * an administrator holding a membership publishes on exactly the same terms as anyone else. The
   * plain `submitter` is never grouped with any of them: its whole meaning is the absence of that
   * membership.
   */
  aliasGroup?: string;
  /**
   * True for the actor whose session the browser holds.
   *
   * Owner-only dashboard assertions read entries this actor created over HTTP, so the browser's
   * `storageState` and the "publisher" part must be the same identity or those specs drive a
   * session that owns none of the data they assert on.
   */
  isBrowserIdentity?: boolean;
}

export interface RunState {
  runId: string;
  startedAt: string;
  /**
   * Criteria this run could not execute, with what would unblock each.
   *
   * KEPT DELIBERATELY, AND EXPECTED TO BE EMPTY. The ladder that used to fill it is gone: there is
   * no external configuration left to be missing, so a run either does everything or has a bug. The
   * field survives so that a future genuine limitation has somewhere to be recorded rather than
   * being discovered as a silently-passing test — and so the reporter prints "0 blocked" instead of
   * losing the distinction between "nothing blocked" and "nobody looked".
   */
  blocked: Array<{ area: string; reason: string; unblockedBy: string[] }>;
  /** Criteria that execute but prove less than the full statement, with what is missing. */
  conditional: Array<{ area: string; reason: string }>;
  ports: {
    api: number;
    dashboard: number;
    fixture: number;
    postgres: number;
  };
  urls: {
    api: string;
    dashboard: string;
    fixture: string;
    /** The fixture page a verification run is expected to fetch. */
    programme: string;
  };
  db: {
    /** Owner role. Migrations, trigger assertions, fixture ageing. */
    adminUrl: string;
    /** The restricted role the API itself runs on. Least-privilege assertions use this. */
    runtimeUrl: string;
    runtimeRole: string;
  };
  /** Namespaces this run writes in. Everything created is prefixed with one of these. */
  namespaces: {
    publisher: string;
    other: string;
  };
  actors: Partial<Record<ActorName, ActorState>>;
  /**
   * The rotation this run used (`E2E_ACTOR_SEED`), and the assignment it produced.
   *
   * Recorded so a run is reproducible and so a later run can assert that the identity which held a
   * privileged part here comes back with nothing.
   */
  /**
   * How the run's administrator was made: `granted` on a fresh database (always, here), `unchanged`
   * if the account already held the role. Undefined when the run has no identity to promote.
   *
   * Recorded because the administrator is no longer a property of the API's configuration — it is an
   * event this run performed, and the report should say so rather than implying a standing list.
   */
  adminCeremony?: "granted" | "unchanged";
  actorSeed: number;
  /** actor name → DID, flattened for the report and for the cross-run comparison. */
  permutation: Record<string, string>;
  /**
   * The address that was the administrator in the PREVIOUS run, when one was recorded.
   *
   * Present only when an earlier run wrote an assignment record and this run rotated away from it.
   * See the cross-run assertion in `tests/00-acceptance.setup.ts` for what it can and cannot prove
   * now that the identity store is this run's own database rather than an external tenant.
   */
  previousAdminEmail?: string;
  /** `storageState` for the signed-in browser context, when one was established. */
  storageStatePath?: string;
  /** The user id that browser session belongs to. */
  browserUserId?: string;
  /** Where the API writes sign-in codes: inside this run's own 0700 directory, removed with it. */
  outboxDir: string;
  /** Where the API and dashboard child logs are, for a failure report. */
  logs: Record<string, string>;
}

export const STATE_ENV = "E2E_STATE_FILE";

export function writeState(path: string, state: RunState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Reads the state file a worker was pointed at. Throws loudly: a spec cannot proceed without it. */
export function readState(path = process.env[STATE_ENV]): RunState {
  if (!path) {
    throw new Error(
      `state: ${STATE_ENV} is not set. Specs are run through \`pnpm e2e\` (packages/e2e/src/run.ts), which boots the stack and points the Playwright child at this run's state file; \`playwright test\` on its own has no stack to talk to.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunState;
}

/**
 * Read–modify–write for the setup project, which discovers account ids and provisions organisations
 * and has to hand both to every dependent project.
 *
 * `workers: 1` and the setup project's `dependsOn` ordering mean there is exactly one writer at a
 * time, so this needs no locking — a claim worth writing down, because it stops being true the
 * moment somebody raises the worker count.
 */
export function updateState(
  mutate: (state: RunState) => void,
  path = process.env[STATE_ENV],
): RunState {
  if (!path) throw new Error(`state: ${STATE_ENV} is not set`);
  const state = readState(path);
  mutate(state);
  writeState(path, state);
  return state;
}

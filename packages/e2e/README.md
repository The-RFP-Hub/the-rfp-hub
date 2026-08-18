# @the-rfp-hub/e2e

End-to-end suite for the RFP Hub. This package is an external **runner**, not a bare Playwright
config: `src/run.ts` owns every out-of-process resource for the run — a disposable Postgres, the
API (running on a restricted database role), the dashboard, a fixture web server and a temporary
identity provider session — brings them up, drives Playwright as a child process, and tears
everything down in a `finally`, including on `SIGINT`/`SIGTERM`. Nothing here is meant to be run
as `vitest`; the root test run excludes this package (see `vitest.config.ts`).

## Running

```sh
pnpm --filter @the-rfp-hub/e2e exec playwright install chromium   # once, after pnpm install
pnpm e2e                                                           # full run, from the repo root
```

**This package needs Node 20 or newer**, and declares it in its own `engines`. The rest of the
repository still supports Node 18 and is unchanged — the requirement comes from Playwright, which
refuses to start on anything older. `src/run.ts` checks the running version first and says so in one
line, rather than letting it surface as a failure from inside a child process after a database and
two servers have already been started.

Other entry points:

```sh
pnpm --filter @the-rfp-hub/e2e e2e:check-m3   # boots the stack, then runs the milestone checker
                                               # (scripts/check-m3.mjs) against it with a real session
OPENAI_API_KEY=... pnpm --filter @the-rfp-hub/e2e e2e:openai
                                               # re-runs only the dedupe spec with a real embedding
                                               # provider — an extra signal, never the pass/fail gate
```

Every resource the runner creates is scoped to one run (`E2E_RUN_ID`, or 8 random hex if unset):
the Postgres compose project, its container, and the temp directory holding session state. Two
runs can execute concurrently without sharing or tearing down each other's database — the one
exception is `packages/dashboard/.next/`, a shared dev cache; a concurrent run is refused by a
lock file rather than silently corrupting it.

Nothing this suite creates needs to be cleaned up by hand: `docker compose down -v` happens in the
runner's `finally`, and the temp directory (session state, minted secrets) goes with it.

## What the operator must supply

The suite signs in through the same Privy application the API and dashboard already use for
this environment. It never receives a long-lived application secret — only short-lived,
purpose-scoped credentials — and it authenticates against your existing Privy test-account setup
rather than provisioning a new tenant.

| Variable | Required | Purpose |
|---|---|---|
| `E2E_PRIVY_TENANT_ACK` | yes | Must equal `PRIVY_APP_ID` exactly. This is a deliberate, explicit acknowledgment that the suite is about to sign in test accounts against that Privy application — there is no automatic tenant discovery. Absent or mismatched, the run degrades to L4 (see below). |
| `E2E_PRIVY_TEST_EMAIL` | for browser coverage | A test-account email address, configured under Privy Dashboard → *User management → Authentication → Advanced*. Needed for the real browser login the dashboard specs drive. |
| `E2E_PRIVY_TEST_OTP` | for browser coverage | The fixed one-time code paired with the test email above. Privy test accounts use fixed OTPs; arbitrary values or plus-addressed variants are rejected by design. |
| `E2E_PRIVY_TEST_PHONE` | optional | An additional test-account phone number, for identity-count coverage. Note that email and phone test credentials may resolve to the *same* underlying Privy identity — the suite dedupes by the token's `sub` claim, never by credential count. |
| `E2E_PRIVY_TEST_EMAILS` | optional | Additional test-account emails (comma-separated), for role-choreography scenarios that want more than two distinct identities. These are used for API-actor tokens only, which the provider issues from the address alone — no code is involved. |
| `E2E_PRIVY_TEST_OTPS` | optional | The codes belonging to those additional accounts (comma-separated). The suite does not need them — only the browser identity signs in — but any supplied here are registered with the redactor, so the end-of-run artifact scan searches for them as long-lived secrets. |
| `OPENAI_API_KEY` | optional | Only read for `e2e:openai`; threaded into the API child solely for that run. |

None of these are written to a file. `packages/api/.env` is read (never written) for the tenant's
`PRIVY_APP_ID` / `PRIVY_APP_SECRET` / `PRIVY_VERIFICATION_KEY`; a real environment variable of the
same name always wins over the file. The application secret is never handed to an API process —
only the runner/provisioner ever sees it.

## The fallback ladder

The suite does not fail outright when identity coverage is partial — it runs everything it safely
can and reports the rest honestly. The level actually reached, and exactly what is CONDITIONAL or
BLOCKED at that level, is written to `test-results/m3-e2e.json` and to the local report.

| Level | Condition | What's real |
|---|---|---|
| **L0 — full** | tenant ack present, at least 4 distinct identities, browser OTP login works | every criterion in the test matrix |
| **L1 — reduced identity** | tenant ack present, 2–3 distinct identities, browser OTP works | everything reachable through role transitions on fewer identities; scenarios needing a genuinely independent second publisher are CONDITIONAL |
| **L2 — API-only** | tenant ack present, at least 2 identities, no browser OTP | every API-level (HTTP/INT) criterion; every criterion needing a signed-in browser is BLOCKED |
| **L3 — browser-only** | tenant ack present, no server-side token minting available, browser OTP works | the one browser identity's full journey, using a Bearer harvested from its own session; multi-actor negatives needing a second real identity are BLOCKED |
| **L4 — no identity provider** | tenant ack absent, or no token obtainable, or the acceptance check itself gets a 401 | the stack still boots, and the administrator ceremony is simply not performed (there is no identity to grant); only the negative-auth and integration/runner-level checks run. No real-auth criterion is claimed as passing |

The level is decided once, at the start of a run, from what the environment above actually
provides — not asserted by a human, and not something a spec can talk its way around.

A criterion the current level cannot execute is reported as a SKIP whose reason begins with
`BLOCKED-by-missing-external-config` and names the variable that would unblock it. A criterion is
never quietly passed for want of a credential.

## The administrator is granted, not configured

The API does not promote anyone named in its environment. Bring-up runs the shipped ceremony —
`pnpm --filter @the-rfp-hub/api grant-admin -- --did <did> --create --yes`, with the **admin**
database URL in the child's environment — against whichever identity the rotation selected. That is
a one-off audited event (`actor_kind: "job"`, `action: "assign_role"`, `reason:
"operator_grant_admin"`), revocable afterwards over the ordinary admin route, rather than a standing
rule re-applied on every login.

Two consequences worth knowing. The administrator's account exists **before** its first request
(`--create`), which is why the just-in-time provisioning assertion deliberately watches a
non-administrator identity. And because the grant is per-run against a database destroyed with its
container, an identity that was an administrator in one run comes back with nothing in the next —
which the cross-run assertion in `tests/00-acceptance.setup.ts` checks rather than assumes.

## Other variables

| Variable | Effect |
|---|---|
| `E2E_RUN_ID` | Names every resource this run creates. Defaults to 8 random hex characters. |
| `E2E_TMP` | The PARENT directory to work under. The run's own private directory (mode `0700`) is always a fresh run-scoped child of it — holding the state file, the secret registry, `storageState` and the child logs — and only that child is ever removed, and only after its ownership marker is verified. Defaults to the OS temp location. Never inside the repository. |
| `E2E_KEEP_TMP` | Leaves that directory in place after the run. A debugging escape hatch, announced loudly on the way out, because the directory holds session material. |
| `E2E_EMBEDDING_PROVIDER` | `openai` switches the API child off deterministic embeddings for the optional `e2e:openai` run. Any other value leaves it deterministic. |
| `E2E_CHECK_M3_AUTH` | Forces `e2e:check-m3` into `real` or `ephemeral` mode instead of choosing by what the ladder provides. Requesting `real` without a real identity is an error rather than a silent downgrade. |

## `e2e:check-m3` and its two modes

The milestone checker needs credentials, and which kind it gets changes what its output means:

- **real** — provider-issued session tokens. The result means what the tool says it means.
- **ephemeral** — no provider is reachable, so the runner generates an ES256 key pair, boots a
  second API instance configured with that public key as its verification key, and signs its own
  tokens. This is **DOMAIN EVIDENCE ONLY**: it establishes that the write path, the audit trail,
  deduplication, verification, analytics and staleness behave correctly over real HTTP against a
  real database, and it establishes *nothing* about the identity provider. The mode is printed on
  the summary line and must never be quoted as if it were the real thing.

## Artifacts, and the residue this suite does not pretend away

Playwright's `test-results/` and `playwright-report/` are gitignored and excluded from the Docker
build context. After Playwright exits, the runner greps both — decompressing trace archives — for
every **long-lived** secret the run registered: the identity application secret, the one-time code,
and every `rfph_…` key any worker minted. A hit fails the run and is reported as a security defect.

That guarantee is deliberately worded as *no long-lived secret in any artifact*, not *no secrets*.
Playwright records request headers itself and offers no redaction hook, so short-lived (roughly an
hour) access tokens **do** appear inside failure traces. They are gitignored, kept out of the image,
and never leave the machine — but they are there, and saying otherwise would be false.

Two further residues, stated rather than papered over:

- a test-account login may persist a user record in the identity tenant, which teardown does not
  remove — test accounts are pre-existing tenant fixtures, not something this suite created;
- `packages/dashboard/.next/` is a shared dev cache, so concurrent runs are refused by
  `packages/dashboard/.e2e-next-lock` rather than supported.

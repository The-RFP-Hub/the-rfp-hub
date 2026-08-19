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

**Nothing.** That is the headline of this suite, and it is worth stating as a requirement rather than
a convenience: `pnpm e2e` runs on a laptop with no network, no accounts and no environment file.

There used to be a table here with seven variables — a tenant acknowledgement, an application id and
secret, a fixed test address, a fixed one-time code, and lists of extra addresses and codes — because
identities came from a third-party provider. A run's coverage depended on how many test accounts
somebody had created in a dashboard, and a laptop on a train could exercise almost none of it.

Identities are now created by using them. Each is an address at a reserved domain
(`e2e+<runid>-<part>@rfphub.invalid` — `.invalid` can never resolve, so a misconfigured run cannot
mail a live code to a real inbox), and the code is written by the API to a file inside the run's own
`0700` directory. There is no ceiling on how many a run may create and nothing to configure.

| Variable | When | What it does |
|---|---|---|
| `OPENAI_API_KEY` | optional | Only read for `e2e:openai`; threaded into the API child solely for that run. |
| `E2E_OIDC_STUB` | optional | Opt-in for the social-provider lane (see below). Not implemented yet. |

## The lanes

| Lane | Condition | A gate? | What is real |
|---|---|---|---|
| **email** | none | **yes, every run** | every criterion, end to end, offline |
| **social — stub** | `E2E_OIDC_STUB=1` | no | *not implemented; see below* |
| **social — real** | a live provider account | never | manual, scheduled, reported separately |

The ladder that used to live here — five rungs from *full* down to *no identity provider*, with each
spec consulting the level before deciding whether it was allowed to run — is **deleted**. It existed
to answer "how much of this suite can execute on this machine today", and the answer is now "all of
it". A degradation path that can no longer be reached is one nobody maintains and everybody trusts.

`BLOCKED` survives in the reporter with nothing to report, and that is deliberate: a future genuine
limitation needs somewhere to be recorded, and "0 blocked" is a different statement from a missing
field.

### The social lane is not implemented

The plan timeboxed a local OIDC stub to one focused pass, with a documented fallback if it did not
land. **It did not land, and the fallback is taken.** The obstacle is structural rather than fiddly:
the API registers `socialProviders.google` and nothing else, so a stub would require registering the
library's `genericOAuth` plugin in the API's auth instance — the object every other test in this
suite now depends on — behind a test-only environment flag. That is not a change to make in passing
on a branch where the email path has only just gone green.

What that leaves uncovered, stated plainly rather than buried:

* the social redirect, the callback and the account-linking rules;
* the one-time-token handoff at `/auth/complete`, and with it the back-button replay case;
* bearer storage on a foreign origin.

The fallback: drive the linking rules from an API integration test, supply `storageState` by hand for
any dashboard spec that needs a signed-in social browser, and keep a manual checklist run against
staging — never a pull-request gate, the posture `e2e:openai` already has.

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
| `E2E_ACTOR_SEED` | Rotates which identity plays which part. Deterministic; recorded in the run state. |
| `E2E_ASSIGNMENT_RECORD` | Where the cross-run assignment record is kept, for the "a fresh database grants nothing" assertion. Opt-in, outside the repository. |

## `e2e:check-m3`

One mode. It boots the same stack, signs in the way a person does, and runs the milestone checker
against it.

There used to be two. When no provider was reachable the runner generated a key pair, booted a second
API pinned to it, signed its own tokens and stamped the output `DOMAIN EVIDENCE ONLY` — an honest
label for a run that proved the domain and nothing about authentication. Signing in needs no third
party now, so that whole apparatus is gone along with `E2E_CHECK_M3_AUTH`.

The caveat narrows rather than disappearing: **this establishes nothing about any social provider.**
The email path it exercises is the real one.

## Artifacts, and the residue this suite does not pretend away

Playwright's `test-results/` and `playwright-report/` are gitignored and excluded from the Docker
build context. After Playwright exits, the runner greps both — decompressing trace archives — for
every **long-lived** secret the run registered: this run's `BETTER_AUTH_SECRET`, and every `rfph_…`
key any worker minted. A hit fails the run and is reported as a security defect.

That guarantee is deliberately worded as *no long-lived secret in any artifact*, not *no secrets*.
Playwright records request headers itself and offers no redaction hook, so short-lived session tokens
**do** appear inside failure traces. They are gitignored, kept out of the image, and never leave the
machine — but they are there, and saying otherwise would be false.

**One-time codes are not registered with the redactor, deliberately.** Six digits is below the
scanner's minimum length and a catastrophic thing to grep for — `\b\d{6}\b` matches timestamps, byte
counts and half the numbers in any log, so registering one would either redact the artifacts into
uselessness or train a reader to ignore the markers. A code is single-use, lives 300 seconds, belongs
to one address, and is deleted from the outbox the moment it is read; by the time anything is scanned
it has stopped being a credential.

Two further residues, stated rather than papered over:

- **nothing persists outside the run at all.** The identity store is this run's own database,
  destroyed with its container — the previous provider left user records in a tenant that teardown
  could not remove, and that residue is simply gone;
- `packages/dashboard/.next/` is a shared dev cache, so concurrent runs are refused by
  `packages/dashboard/.e2e-next-lock` rather than supported.

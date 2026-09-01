# Handoff guides

Four documents, each for one person doing one job. They link rather than duplicate: where a fact is
already written down inside a package, these guides point at it and say what the operator has to
decide, not what the code already decides for them.

| Guide | Who it is for | What it answers |
|---|---|---|
| [`deployment.md`](./deployment.md) | whoever owns the infrastructure | what runs where, what has to exist before the first deploy, which variables are required, how a release is cut and how it is rolled back |
| [`api-integration.md`](./api-integration.md) | a developer building against the public API | read it in five minutes, write to it in twenty, and know the contracts that would otherwise surprise you |
| [`publisher-onboarding.md`](./publisher-onboarding.md) | whoever operates the Hub | running a publisher application end to end, refusing one, and revoking verification |
| [`external-deploy-test.md`](./external-deploy-test.md) | an external tester, and whoever hands them the task | a two-hour protocol that proves an outsider can deploy a frontend against the public API from the published docs alone |

Related documents that are **not** here, because they belong to the thing they describe:

* [`packages/api/docs/deploy.md`](../packages/api/docs/deploy.md) — the API's own configuration,
  secrets and database-credential runbook. `deployment.md` is the top-down view; that is the detail.
* [`packages/api/docs/auth.md`](../packages/api/docs/auth.md) — credentials, scopes, tiers and the
  full route matrix.
* [`packages/api/docs/jobs.md`](../packages/api/docs/jobs.md) — the maintenance jobs, their
  schedule and their idempotency guarantees.
* [`PUBLISHERS.md`](../PUBLISHERS.md) — written for the publisher. `publisher-onboarding.md` is the
  other side of the same conversation.
* [`GOVERNANCE.md`](../GOVERNANCE.md) — editors, the decision rule, review windows and appeals.

---

## Shell blocks carry a marker, and the marker is a contract

Every fenced `sh` or `bash` block in this directory — and in the repository's root `*.md` files —
is marked on its info string with exactly one of three words. The marker says what running the
block would do, so a reader — or a checker — can tell an illustration from a live command without
reading the command:

| Marker | Meaning |
|---|---|
| ` ```sh no-run ` | **Do not paste this at a deployment.** It mutates infrastructure, publishes a package, rotates a credential, needs a checkout on the machine, or is an excerpt that would not run as written. Read it; do not let a checker run it. |
| ` ```sh safe-read ` | A public, unauthenticated `GET`. Safe against any deployment, any number of times, from anywhere. Nothing here carries a credential. |
| ` ```sh staging-write ` | It writes: mints a key, sends a sign-in code, submits an entry, decides a review, revokes something. **Point it at staging**, never at production, and clean up what it creates. |

The rule for anything automated that reads these files: **execute only `safe-read`**. A `no-run`
block is documentation of something a checker has no business doing, and a `staging-write` block
needs a credential and a target that a document cannot choose on the reader's behalf.

The marker sits on the info string (` ```sh safe-read `) rather than in a comment — that is the
only form, there is no preceding-comment alternative — so it survives copy-paste into a renderer
and is greppable.

What `pnpm check:m4` does with that, exactly:

* Every `sh`/`bash` block in `docs/**` **and in the repository's root `*.md`** must carry one of the
  three markers. A block with none, or with an unrecognized one, is a **hard failure** — a block the
  tool cannot tell is safe to run must not silently go unexercised.
* Every relative link in those same files is resolved, and a `#anchor` on it is checked against the
  target document's own headings. A link to a file that exists but to a heading that does not is a
  failure, which is the case a rename produces.
* **Absolute links and `safe-read` execution run only online.** `--offline` — what the CI
  `docs-links` job passes — keeps the marker and relative-link walk and drops those two, so CI
  proves structure and a human running `pnpm check:m4` proves the requests.

Two rules a `safe-read` block has to hold to, because the checker runs it for real:

* **Reference the API as `$API`, never a literal URL.** The checker injects `API=<--api>` into the
  block's environment, so a literal origin would send the run somewhere other than the deployment
  under test.
* **It must succeed.** The block runs under `set -eu` with `curl` shadowed as `curl -f`, so a `4xx`
  is a failure — a block that deliberately shows an error response has to swallow it (`|| true`)
  or be marked `no-run` instead.

`scripts/m4-compliance/README.md` documents the runner's exact shape, including the two things it
deliberately does not do (`pipefail`, and shimming `jq -e`) and the one gap that leaves open.

```sh no-run
# every marked block in the files the checker walks, one per line
grep -rn '^```\(sh\|bash\) ' docs/ *.md
```

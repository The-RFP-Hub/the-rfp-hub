# The two-hour external deploy test

A protocol for **one external developer** who has never seen this codebase, to answer one question
with evidence: *can somebody outside the project deploy a working frontend against the public API,
using only the published documentation?*

Two hours, timed, in six blocks. The deliverable is a report, not a working deployment — a tester
who gets stuck has produced the most valuable result in the whole exercise, provided they wrote
down where.

Shell blocks are marked `no-run`, `safe-read` or `staging-write` — see
[the convention](./README.md#shell-blocks-carry-a-marker-and-the-marker-is-a-contract).

---

## For whoever is running the test

### What you give the tester

* This page.
* The repository URL.
* The API origin: `https://api.ethrfps.app`.
* Nothing else. **Do not answer questions during the two hours.** Every question the tester wants
  to ask is a finding; answering it destroys the finding and inflates the result. Collect the
  questions at the end.

### Check this before you start the timer

```sh no-run
npm view rfphub-validate version      # must be >= 0.3.1
npm view @the-rfp-hub/standard version
```

**Block 2 is not runnable while `rfphub-validate` is 0.3.0** — the published tarball predates an
export the frontend imports, so the build fails with a `TS2305` that has nothing to do with the
tester or the documentation. Running the protocol before the release burns forty minutes of
somebody's time on a known defect and produces a finding you already have. Either wait for the
release, or hand the tester the protocol with block 2 struck out and say why.

### What the tester needs to have

Node 20 or newer, git, a free Vercel account, and a terminal. No AWS, no database, no credential of
ours. They will not sign in to anything of ours, and they will not need to.

### What you must not do

Do not pre-brief. Do not fix the docs mid-run — note the defect and fix it after the report is in,
so the report describes a state that actually existed. Do not sit with them.

---

## The protocol

Start a timer. Move on when a block's time is up, **finished or not** — an unfinished block with a
note about where it stopped is a result; a block that ran over and ate the next one is not.

| Block | Time | What you do | What you record |
|---|---|---|---|
| **0** | 5 min | Read **only** [`api-integration.md` §1](./api-integration.md#1-five-minute-quickstart) and run one `safe-read` command against the API | Did it work first try? If not, what did you have to guess? |
| **1** | 20 min | **Path A** — the Vercel Deploy Button from [`deployment.md` §9](./deployment.md#9-the-frontend-three-ways-to-deploy-a-copy), with `NEXT_PUBLIC_API_URL=https://api.ethrfps.app` | The deployment URL. Where it stalled, if it did |
| **2** | 40 min | **Path B** — copy only `packages/frontend`, swap the two workspace dependencies for the versions `npm view` reports, `npm install`, build **with the API URL set**, run the standalone server locally | The two versions used. Did the build pass? Did the server answer with data? What did you have to guess? |
| **3** | 20 min | Exercise whichever deployment you got: search, two filters, paging, a detail page, both deep-links, and `/publishers` | A screenshot of each |
| **4** | 15 min | Try to **sign in**. Confirm it fails, and confirm the documentation warned you it would | Where did you look for that warning, and was it there? |
| **5** | 20 min | Write the report | Every point at which you wanted to ask somebody a question, numbered |

### Block 0 — five minutes

```sh no-run
API=https://api.ethrfps.app        # the target for this whole protocol
```

```sh safe-read
curl -s "$API/v1/health" | jq
curl -s "$API/v1/opportunities?status=open&limit=3" | jq '.total'
```

Record: did the quickstart get you to a real response without reading anything else?

### Block 1 — Path A, the Deploy Button

Follow the button link in [`deployment.md` §9](./deployment.md#9-the-frontend-three-ways-to-deploy-a-copy).
It clones the repository into your own Vercel account with the root directory already set to
`packages/frontend`. Set `NEXT_PUBLIC_API_URL` to `https://api.ethrfps.app` when prompted.

Record the deployment URL. If the build fails, capture the **first** error in the log — not the
last — and move on when the time is up.

### Block 2 — Path B, the package on its own

The point of this block is that it uses no monorepo tooling at all: `npm`, and published packages
from the registry.

**Ask the registry what the current versions are — do not paste a version out of a document.** A
range written down here is a range that was true when it was written:

```sh no-run
npm view @the-rfp-hub/standard version
npm view rfphub-validate version
```

> **Gate on `rfphub-validate`.** This block is only runnable once `rfphub-validate` is at **0.3.1
> or higher**. The published 0.3.0 does not contain an export the frontend imports, so the build
> fails with `TS2305` through no fault of yours or of the docs. If `npm view` prints `0.3.0`, stop
> here, write down "blocked: rfphub-validate 0.3.0 predates the required export", and move to
> block 3 with whatever block 1 produced. **Whoever handed you this protocol should have checked
> that before starting the timer.**

```sh no-run
# copy ONLY the frontend package out of a clone
cp -r the-rfp-hub/packages/frontend ./rfphub-frontend && cd ./rfphub-frontend

# in package.json, replace the two workspace dependencies with the versions `npm view` just printed:
#   "@the-rfp-hub/standard": "^<version>"
#   "rfphub-validate":       "^<version>"     # must be >= 0.3.1

npm install

# NEXT_PUBLIC_API_URL is inlined at BUILD time. It belongs here and nowhere else — setting it in
# front of `node server.js` later does nothing, and the page renders "no API configured".
NEXT_PUBLIC_API_URL=https://api.ethrfps.app npm run build

# server.js is NOT at .next/standalone/server.js in a stand-alone copy — find it.
SERVER=$(find .next/standalone -name server.js)

# .next/static is not inside the standalone output either; copy it beside server.js.
mkdir -p "$(dirname "$SERVER")/.next" && cp -r .next/static "$(dirname "$SERVER")/.next/static"

node "$SERVER"
```

Then open the port it prints. **A build that produces `.next/standalone` is not the result** — the
result is a page that answers **with opportunities rendered in it**, which happens after hydration,
from a live request to the API. A `200` carrying an empty shell is a pass you should record as a
failure.

Record every step you had to work out yourself: an unstated Node version, a directory the docs did
not mention, a command that had to be run from somewhere other than where you were.

### Block 3 — exercise it

On whichever deployment you got working — Path A's URL or Path B's local server:

1. The list renders opportunities.
2. Search with a term; the result set changes.
3. Two different filters; the result set changes for each.
4. Page forward, then back.
5. Open a detail page; the title matches the one you clicked.
6. On the detail page, find the two link-outs — the application page and the source. **Inspect the
   `href` rather than clicking**, and confirm both point back at the API's redirect routes
   (`/v1/r/<id>/apply` and `/v1/r/<id>/source`) rather than at the program's site directly.
7. Open `/publishers`; it lists verified organizations.

One screenshot each, seven in total.

### Block 4 — sign-in, which is supposed to fail

Try to sign in from your deployment. It will not work, and that is the documented behavior: the API
keeps an exact allowlist of origins permitted to reach the sign-in routes, and your deployment's
origin is not on it. Reading works from anywhere; writing does not.

The thing being tested here is **not** whether it fails. It is whether the documentation told you
it would, **before** you spent time on it. Record:

* Where did you look for that warning?
* Was it there, or did you find it somewhere else, or not at all?
* When you hit the failure, did you know why within a minute?

### Block 5 — the report

Twenty minutes, and the numbered list of questions is the most important part.

---

## Report template

Copy this, fill it in, and hand it back. **It will be published**, so see the rules below it.

```text
RFP HUB — EXTERNAL DEPLOY TEST
Date:                     YYYY-MM-DD
Total time spent:         __ minutes
Docs read (list them):

BLOCK 0 — quickstart (5 min)
  Worked first try?           yes / no
  Time to first real response: __ min
  Had to guess:

BLOCK 1 — Path A, Deploy Button (20 min)
  Outcome:                    deployed / failed / ran out of time
  Deployment URL:
  First error (verbatim):
  Where it stalled:

BLOCK 2 — Path B, package copy (40 min)
  Versions used:              @the-rfp-hub/standard __._._  rfphub-validate __._._
  npm install:                ok / failed —
  npm run build:              ok / failed —
  standalone server answered: yes / no —
  Steps I had to work out myself:
    1.
    2.

BLOCK 3 — exercising it (20 min)
  list renders                yes / no
  search changes the set      yes / no
  filter 1 (which:      )     yes / no
  filter 2 (which:      )     yes / no
  paging                      yes / no
  detail page                 yes / no
  apply link points at the API redirect    yes / no
  source link points at the API redirect   yes / no
  /publishers renders         yes / no
  Screenshots attached:       __ of 7

BLOCK 4 — sign-in (15 min)
  Failed as documented?       yes / no
  Where I looked for the warning:
  Was it there?               yes / no / found elsewhere:
  Understood the cause within a minute?   yes / no

BLOCK 5 — EVERY POINT I WANTED TO ASK A QUESTION
  1.
  2.
  3.

WHAT I WOULD FIX FIRST IN THE DOCS
  1.
  2.
  3.

OVERALL
  Could an outside developer deploy a frontend against this API from the docs alone?
    yes / yes with effort / no
  One sentence on why:
```

### Report rules — no personal data

The report is published in the repository. Before it is committed:

* **No email addresses, account names, handles or real names** — the tester's own included. The
  report is about the documentation, not about who read it.
* **No tokens, keys, cookies or `Authorization` headers**, in text or inside screenshots. Nothing
  in this protocol requires a credential of ours; if one appears, something went off-script.
* **Screenshots are cropped** to the page content, with browser profile names, bookmark bars and
  notification popups out of frame.
* **Scan before committing**, not after:

  ```sh no-run
  grep -rniE 'rfph_|bearer |authorization:|@[a-z0-9.-]+\.[a-z]{2,}' report/
  ```

* Deployment URLs are fine — they are public anyway — provided the deployment holds nothing
  personal. Delete the test deployment afterwards.

---

## When no external human is available

Say so, and say it in those words. Two things stand in, and **neither is a substitute** — they are
narrower, and the report has to declare which evidence it is:

**1. The clean-room CI job** (`.github/workflows/external-deploy-smoke.yml`, whose whole body is
an invocation of `scripts/frontend-clean-room.mjs` — `pnpm frontend:clean-room`). A container with
no monorepo: it copies `packages/frontend` alone, rewrites the two workspace dependencies to
published ranges or a local tarball, `npm install`, the package's own `npm run build`, finds and
starts the standalone server, and makes real requests against the public API. It runs with
`--browser`, which is the part that matters: a headless Chromium drives `/` and `/?q=<term>` and
waits for a row to actually render from a live fetch, because the plain HTTP check would pass on a
`200` shell whose client-side request never reached the API. It asserts that the build completes
and the server **answers with data**, deliberately not a fixed route count: a number would fail
exactly when a new page was added.

This is strong evidence for **Path B**, and it is the only regression guard on portability — it is
the exact scenario that failed twice before the three packaging fixes landed. It proves nothing
about Path A, about the Deploy Button, or about whether a human can follow the prose.

**2. An agent-run simulation of the protocol.** An agent with no prior context executes the blocks
above from the published docs alone and files the same report. It catches missing steps, wrong
commands and dead links. It cannot catch the thing the exercise exists for: a person forming the
wrong expectation from a sentence that is technically accurate. An agent that reads the whole
repository is not an outsider, and its report must say which files it opened.

**What neither covers.** The two-hour test measures a frontend deploy and nothing else. Neither it
nor the substitutes exercise [`deployment.md`](./deployment.md) — nobody outside the project has an
AWS account to deploy the API into — or
[`publisher-onboarding.md`](./publisher-onboarding.md), which needs a reviewer credential and a
real applicant. Those two guides are validated by **critical internal reading**, and that is a
weaker form of evidence. Recording it as such is the point: an unverified guide labeled unverified
is a known risk, and one labeled verified is a surprise waiting for whoever inherits the
deployment.

# M4 compliance checker

Mechanically verifies the M4 completion criteria against a **live, public deployment**. Entry
point: [`scripts/check-m4.mjs`](../check-m4.mjs).

```sh no-run
node scripts/check-m4.mjs --site https://ethrfps.app --api https://api.ethrfps.app --browser
```

Pass/fail per criterion on stdout, a JSON report alongside, non-zero exit on any failure **or on
any criterion whose requirements were not all exercised**. The report defaults to a unique filename
under `os.tmpdir()` (`m4-compliance-report-<pid>-<timestamp>.json`), never the repo root — a
read-only tool that writes into the caller's checkout on every run would not really be read-only,
and a constant name lets two concurrent runs overwrite each other's evidence. Its path is always
printed. Pass `--json <path>` to choose one, or `--json -` for stdout.

---

## It is read-only. That is the whole difference from check-m3.

`check-m3` writes: it submits entries, mints a key, generates traffic. This checker does none of
that. It never mints a real credential, never submits a real entry, and never asks a reviewer to do
anything. The one thing that looks like a write — `submit_opportunity`'s fail-closed behavior under
M4-4 — is exercised against a **local recording HTTP server this checker starts itself**, never
against `--api`. That is what lets it default to production: reading a live deployment costs it
nothing, same reasoning as `check-m2.mjs`.

Documentation `safe-read` blocks are executed, and that is the one place a read-only claim could
have been false. They are parsed and spawned directly, never handed to a shell — see
[the marker convention](#the-sh-block-marker-convention) below.

## Exit codes, and what a criterion has to do to be green

| exit | result | meaning |
|---|---|---|
| 0 | `PASS` | every criterion was exercised and held |
| 1 | `FAIL` | a criterion was exercised and did not hold |
| 1 | `INCOMPLETE` | nothing failed, but a criterion's requirements were not all exercised |
| 2 | — | the run could not be made (a bad argument) |

Each check is **required** or **optional**. A required check that could not be performed — no
`--browser` for a check that needs a rendered page, `--mcp-spec local` standing in for a published
package, a corpus too small to exercise pagination — is recorded as *unmet*, which makes its
criterion `INCOMPLETE` and the run non-zero. It is never a quiet warning on an otherwise-green run,
because the plan's rule is that no evidence is satisfied by a skip. `warn` keeps its narrow M2
meaning (the check HELD, but something should be seen — a certificate near expiry), and
`skipOptional` covers the handful of checks a criterion genuinely does not depend on, such as TLS
against a loopback origin.

A run narrowed by `--only`, `--skip` or `--offline` prints **`RESULT: SCOPED PASS/FAIL`** naming
what it covered, and its JSON carries `signOff: false`. `--only docs --offline` is a docs lint; it
must never be readable as an M4 sign-off.

## The checks

| id | Criterion | Establishes |
|---|---|---|
| `governance` | M4-1 Governance framework published and linked | The four governance docs exist and their GitHub URLs answer 200; the home page and `/how-it-works` each carry an anchor whose `href` is each of the four exact canonical URLs (read from `packages/frontend/src/lib/links.ts`); at least one of them on the home page is outside `<footer>` |
| `publishers` | M4-2 Public `/publishers` page | The route answers 200; `GET /v1/publishers` has the shape it promises (items array, integer `total` equal to `items.length`, unique non-empty slugs); rendered, the page shows exactly those slugs — or the empty state when there are none — and the browser's own request carries no `Authorization` header |
| `frontend` | M4-3 Reference frontend live and behaving | TLS (a non-loopback plaintext site FAILS); liveness; `robots.txt` reported, or required with `--expect-indexable`; rendered: `q`, an ecosystem filter, a funding-type filter and `page=2` each change **which** entries are shown, and the two filters match what the API returns for the same filter; the detail page's visible `<h1>` is the title; both deep-link hrefs are exact; three viewports have no horizontal overflow, and at the two touch viewports (built with `isMobile`, so `(pointer: coarse)` matches the way it does on a real phone) no control is under 44 px tall — the same measure `packages/e2e/tests/m4-responsive.spec.ts` asserts, text links excepted |
| `mcp` | M4-4 MCP server installable and callable | `npx` resolves `@the-rfp-hub/mcp` from the real npm registry and runs; **exactly** two tools without `RFPHUB_MCP_ENABLE_SUBMIT` and **exactly** three with it, each with an `outputSchema` and boolean annotation hints; `search_opportunities` returns `structuredContent` that validates against its own advertised schema and matches the API page for page, envelope field for envelope, across two pages of a query derived from the live corpus; no `rfph_` substring anywhere, including after the process exits; phase 1 answers `pending` and makes no network write |
| `mcp` | M4-4b MCP server published | `npm view` resolves the selected spec to an exact version whose published `mcpName` matches the manifest; the official MCP Registry carries that server at that version with the same npm package identifier; every `npx` configuration snippet in `packages/mcp/README.md` pins an exact version (never `@latest`, never a dist-tag) |
| `skill` | M4-5 Agent skill published correctly | Every file the documented install channels need is on GitHub `main` with the same sha256 as the audited local copy; the repository's own `scripts/check-skill.mjs` passes against that fetched copy; the fetched `scripts/search.mjs`, run against a corpus whose every prose field carries an injected instruction, emits neither the instruction nor a `description` field |
| `docs` | M4-6 Handoff documentation | The four `docs/*.md` guides exist; every link and `#anchor` in them — and in the root markdown, `skills/**` and `packages/mcp/README.md` — resolves; only `safe-read` `sh` blocks are ever executed, and those succeed |

Skip any of them with `--skip <id>` (repeatable) — which still registers the criterion as unmet, so
the run reports incomplete. `--only <id>` does not register the others at all, and marks the run
scoped.

## `--browser`

The frontend and `/publishers` are client-rendered, so a plain `fetch` of the HTML sees an (almost)
empty shell. `--browser` resolves Playwright **through `packages/e2e`'s own `node_modules`** (see
`browser.mjs`) rather than adding a second copy of the dependency at the repo root, and launches
Chromium for the rendered governance anchors, the `/publishers` slug comparison and its
network-header check, and every frontend check that needs to see the result set change.

Without `--browser` those requirements are reported **unmet**, which makes their criterion
`INCOMPLETE` and the run exit non-zero. They were WARNs, and a WARN was green — a full run without
a browser could print `RESULT: PASS` having looked at none of them.

## `--offline`

Applies to the **`docs` criterion only**: it skips the absolute-link 2xx/3xx requests and the
execution of `safe-read` blocks. Every other criterion still uses the network, so the only
combination that means anything is `--only docs --offline`, which is what the CI `docs-links` job
runs. Everything else in the docs check — file existence, relative links, `#anchor` resolution,
marker presence — still runs, because none of it needs the network.

## `--expect-indexable`

Index state is **reported**, not held to a contract, because the decision is the operator's. Pass
`--expect-indexable` when the deployment is meant to be indexed and the row becomes a requirement:
a `robots.txt` that disallows `/` for every user-agent, or a home page carrying
`<meta name="robots" content="…noindex…">`, then fails instead of being noted.

## `--mcp-spec`

Accepts a dist-tag (`next`), an exact version (`0.1.0`), `local`, or a full `@the-rfp-hub/mcp@<x>`
normalized to `<x>` — the operator runbook spells it that last way, and concatenating it produced
`@the-rfp-hub/mcp@@the-rfp-hub/mcp@next`, an npm ENOENT nobody could read back to the flag. A range
(`^1.0.0`, `1.x`, `*`) is refused: this criterion is about one immutable published artifact, and a
range does not name one.

1. Default (`next`) → `npx -y @the-rfp-hub/mcp@<spec>`, the real npm registry, which is what
   "installable" has to mean for the criterion's own name to be true. Before the package is
   published this FAILS by name, and the remaining behavior checks are skipped rather than each
   failing with a copy of the same npm error.
2. `--mcp-spec local` → the EXPLICIT opt-out: `node <repo-root>/packages/mcp/dist/cli.js`, for
   developing `packages/mcp` (or this checker) before publish. M4-4 is renamed to "MCP server
   callable from a local build", and **M4-4b is INCOMPLETE** — a local build is not evidence of
   publication, and the run cannot go green.

The local path resolves `dist/cli.js` through `fs.realpathSync` before spawning it. `cli.ts`'s own
entrypoint guard compares `fileURLToPath(import.meta.url)` (which Node resolves through symlinks)
against `path.resolve(process.argv[1])` (which does not), and a `--repo-root` under `os.tmpdir()` —
`/tmp` → `/private/tmp` on macOS — made the two disagree: the CLI silently did nothing and exited 0,
indistinguishable from "hung" until this checker's timeout fired.

`RFPHUB_API_BASE` is handed to the server as a **bare origin** — the server requires https off
loopback and rejects any path, query, fragment or userinfo at startup — so a `--api` carrying a
path is trimmed (and said so), and a plaintext non-loopback `--api` fails by name rather than as an
opaque startup error inside "tools/list succeeds".

Every server process gets its own disposable `RFPHUB_MCP_HOME`, removed afterwards: a real server's
`guard()` writes an audit line for every tool call, so without it even the read-only cases would
leave entries in whoever runs this checker's own `~/.rfphub/audit.log`, and the submit-enabled
case's preview would land in `~/.rfphub/pending/` indistinguishable from a real one.

## The `sh`-block marker convention

Defined by the docs stream itself (`docs/README.md`), not by this checker. Every fenced ` ```sh `
(or `bash`) block in `docs/**` carries the marker as **the second word of the info string**:

~~~
```sh safe-read
curl -s "$API/v1/health"
```
~~~

- **`safe-read`** — a `GET` against a public endpoint, no credential. The **only** kind this checker
  ever executes, and it must succeed.
- **`staging-write`** — mints a key, requests an OTP, submits/reviews/revokes. Never executed.
- **`no-run`** — a deployment or infrastructure mutation. Never executed, ever.

**The marker requirement applies to `docs/**` only.** There, an unmarked `sh`/`bash` block is a hard
failure: a block this tool cannot tell is safe to run would otherwise go unexercised without anyone
noticing. In the root `*.md` files, `skills/**` and `packages/mcp/README.md` — markdown that predates
the convention and is owned by other streams — an unmarked block is reported as "not executed" and
never fails, while a marker is honored wherever it appears. Their links and `#anchors` are held to
exactly the same standard as the guides': a broken relative link in the root README is as broken for
a reader as one in `docs/`.

### What a `safe-read` block may contain

Blocks are **parsed and spawned directly. There is no shell.** The previous implementation passed
each block to `bash -c` with the operator's full `process.env`, so a checker advertised as read-only
executed arbitrary commands chosen by a markdown file, with whatever npm or cloud credentials the
shell had exported. The grammar now is:

- stage 0 is `curl` with GET/HEAD semantics: no `-d`/`--data*`/`-F`/`-T`, no `Authorization` or
  `Cookie` header, no `-u`, no `-X` other than GET/HEAD, and `--fail` is added when the block did
  not ask for it;
- later pipeline stages may only be `jq`, `head`, `sed -n`, or `python3 -m json.tool`;
- command substitution exists in exactly one form, `NAME=$(<pipeline>)`, whose inside must satisfy
  the same grammar — that is what the guides use to pick a sample id;
- backticks, redirection, `;`, `&`, `&&` and any `||` other than a trailing `|| true` are refused;
- every URL must expand to the `--api`/`--site` origin under test, and a `/v1/r/` link-out must
  carry `DNT: 1` or the block is refused before it can record a click;
- the child environment is an allowlist (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`), never
  `process.env`;
- `$API` (and `$SITE`) are the documented placeholders; any other undefined variable is refused.

A block outside the grammar FAILS by name, with the reason. Documentation staying simple enough to
run is a feature, not a limitation.

Running the stages ourselves also closes the gap the previous design documented as open: under bash,
`curl -f … | jq` reported only `jq`'s status, and plain `jq` on the empty body `-f` leaves behind
exits 0 — so a 404 "succeeded". Adding `set -o pipefail` instead broke `curl … | head -40`, because
`head` closing the pipe makes curl's own write fail. Buffering between stages removes the conflict:
`head` reads a completed capture, and curl's exit code is examined directly.

Blocks run in a fresh temporary working directory, never `--repo-root`: a real block does
`curl … -o dataset.json`, and running that in the caller's checkout left the file behind.

## `accept-m4.mjs` — the write half

Separate tool, staging only, and **no flag forces production**. `--api` must be loopback or one of
this project's own staging origins (`https://staging.ethrfps.app`, `https://api-staging.ethrfps.app`,
from the deploy workflows); non-loopback must be `https:`; and the redirect chain the API answers
with must end inside that allowlist too, because a staging-looking CNAME pointed at production
passes every hostname rule there is. One more origin may be opted in through
`RFPHUB_ACCEPT_EXTRA_STAGING_ORIGIN`, which must be https and carry a `staging` label that does not
also say `prod`.

It asserts the interlock, not just the happy path: an owner snapshot before anything, exactly three
tools, an exact `status: "pending"` with the snapshot proved unchanged, a phase-3 commit with an
invalid approval that must be refused with the snapshot still unchanged, then the approval, the
commit, and a teardown that is only done when the entry is gone from the owner listing **and** the
public route.

The approval is labeled for what it is. By default the CLI is driven non-interactively and the
report says `approval: SIMULATED (non-interactive)` — that automates the CLI, it does not
demonstrate a human decision. `--interactive-approval` prints the exact `rfphub-mcp approve <id>`
command for an operator to run in another terminal and waits for it, and the report says
`approval: HUMAN`.

## Layout

```
scripts/check-m4.mjs               entry point, ordering, report writing
scripts/accept-m4.mjs              the staging write-acceptance tool
scripts/m4-compliance/
  options.mjs           argument parsing, --mcp-spec normalization, scope labeling
  report.mjs            the M2 report plus required/optional check classification
  browser.mjs           Playwright resolved through packages/e2e
  mcp-client.mjs        a hand-rolled newline-delimited JSON-RPC stdio client
  mock-server.mjs       the local recording HTTP server used only by the MCP submit case
  links.mjs             markdown links, GitHub heading slugs        (test/links.test.mjs)
  markers.mjs           sh-block marker parsing                     (test/markers.test.mjs)
  safe-read.mjs         the safe-read grammar and executor          (test/docs-safe-read.test.mjs)
  checks/*.mjs          one file per check
  accept/*.mjs          the write-acceptance options and flow
  test/*.test.mjs       unit tests; the ones that spawn a process use local fixtures, never the network
```

## What it cannot establish

- That a human reviewer's actual approval flow works end to end against a real, writable
  deployment — that is `scripts/accept-m4.mjs --interactive-approval`, staging only.
- SEO/indexability beyond `--expect-indexable`'s two mechanical checks: whether the deployment
  *should* be indexed is the operator's decision, not a contract.

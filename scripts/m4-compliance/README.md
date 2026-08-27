# M4 compliance checker

Mechanically verifies the M4 completion criteria against a **live, public deployment**. Entry
point: [`scripts/check-m4.mjs`](../check-m4.mjs).

```sh
node scripts/check-m4.mjs --site https://ethrfps.app --api https://api.ethrfps.app --browser
```

Pass/fail per criterion on stdout, a JSON report alongside, non-zero exit on any failure **or on
any criterion that was never exercised**. The report defaults to `os.tmpdir()`, not the repo
root — a read-only tool that writes into the caller's own checkout on every run would not really be
read-only — and its path is always printed. Pass `--json <path>` to choose one, or `--json -` for
stdout.

---

## It is read-only. That is the whole difference from check-m3.

`check-m3` writes: it submits entries, mints a key, generates traffic. This checker does none of
that. It never mints a real credential, never submits a real entry, and never asks a reviewer to do
anything. The one thing that looks like a write — `submit_opportunity`'s fail-closed behaviour under
M4-4 — is exercised against a **local recording HTTP server this checker starts itself**, never
against `--api`. That is what lets it default to `https://ethrfps.app` / `https://api.ethrfps.app`
with no `--allow-production` flag at all: reading a live deployment costs it nothing, same
reasoning as `check-m2.mjs`.

## The checks

| id | Criterion | Establishes |
|---|---|---|
| `governance` | Governance framework published and linked | The four governance docs (`GOVERNANCE.md`, `REVIEW-CRITERIA.md`, `packages/standard/PROCESS.md`, `PUBLISHERS.md`) exist, their GitHub URLs answer 200, and the site links to `GOVERNANCE.md` from the home page and `/how-it-works` |
| `publishers` | Public `/publishers` page | The route answers 200; rendered, its slugs equal `GET /v1/publishers`'s, requested with no `Authorization` header |
| `frontend` | Reference frontend live and behaving | TLS, liveness, `robots.txt` (reported, not failed); rendered: `q` search, a `type` filter and `page=2` each change the result set, and an EMPTY result is never accepted as proof of that; the detail page shows the title; both deep-link hrefs (`apply`/`source`) are correct; three viewports have no horizontal overflow |
| `mcp` | MCP server installable and callable | By default, `npx` actually resolves `@the-rfp-hub/mcp` from the npm registry and runs (fails, by name, before publish — see `--mcp-spec`); `tools/list` has the two read tools and not `submit_opportunity` without the env; `search_opportunities` matches the API in ids; no `rfph_` substring anywhere; with the submit env on, phase 1 answers `pending` and makes no network write |
| `skill` | Agent skill published correctly | `.claude-plugin/marketplace.json` and the skill's `SKILL.md` are published on GitHub (`main`, fetched via raw — see `--mcp-spec`'s sibling reasoning); the local `SKILL.md` frontmatter is spec-valid, the file is under 500 lines, and `scripts/search.mjs` — run for real against `--api` — never emits a `description` field |
| `docs` | Handoff documentation | The four `docs/*.md` guides exist, every link resolves, and only `safe-read` `sh` blocks are ever executed |

Skip any of them with `--skip <id>` (repeatable).

## `--browser`

The frontend and `/publishers` are client-rendered, so a plain `fetch` of the HTML sees an
(almost) empty shell. `--browser` resolves Playwright **through `packages/e2e`'s own
`node_modules`** (see `browser.mjs`) rather than adding a second copy of the dependency at the repo
root, and launches Chromium for:

- the rendered governance-link check (home + `/how-it-works`)
- the rendered `/publishers` slug comparison and its network-header check
- every frontend check that needs to see the result set change: search, filter, pagination, the
  detail page, both deep-link hrefs, and the three responsive viewports

Without `--browser`, all of the above report **WARN** — "needs `--browser`" — never a silent pass
and never a fail for something the tool did not actually look at. The three responsive viewports
have no non-browser fallback at all; there is nothing to check without a real layout.

## `--offline`

Used by the CI `docs-links` job, which has no deployment to talk to. Skips every network request
the `docs` check would otherwise make: absolute-link 2xx/3xx checks, and executing `safe-read`
blocks (which are themselves `curl`s against a live API). Everything else in the `docs` check —
file existence, relative-link resolution, marker presence — still runs, because none of it needs
the network.

## `--mcp-spec`

Controls what `mcp.mjs` spawns, and it defaults to testing the REAL thing:

1. No `--mcp-spec`, or `--mcp-spec <version>` / `--mcp-spec next` → `npx -y
   @the-rfp-hub/mcp@<spec>` (default spec `next`) — the npm registry, which is what
   "installable" has to mean for the criterion's own name to be true. A dedicated check
   (`npx resolves @the-rfp-hub/mcp@<spec> from the npm registry and runs`, via `npx ... --version`)
   runs first and FAILS, by name, before the package is published — it is never downgraded to a
   note, and the rest of the criterion's checks are cleanly skipped rather than each failing with
   a redundant copy of the same npm error.
2. `--mcp-spec local` → the EXPLICIT opt-out: `node <repo-root>/packages/mcp/dist/cli.js`. For
   developing `packages/mcp` (or this checker) before publish. The criterion is renamed to "MCP
   server callable from a local build" and its own description says plainly that this mode is not
   evidence of publication.

An earlier revision of this file did the opposite: it silently preferred a local build whenever one
existed, with the registry only a last resort — so "MCP server installable and callable" could PASS
without npm ever being involved. That was the over-claim; this is the fix.

The local-build path resolves the `dist/cli.js` path through `fs.realpathSync` before spawning it,
not merely `path.join`. Found by actually spawning a real built `packages/mcp` for the first time:
`cli.ts`'s own entrypoint guard compares `fileURLToPath(import.meta.url)` (which Node resolves
through any symlink) against `path.resolve(process.argv[1])` (which does not), and a `--repo-root`
under `os.tmpdir()` — `/tmp` → `/private/tmp` on macOS — made the two disagree. `isEntrypoint` came
back false, `main()` never ran, and the process exited 0 having done nothing at all: no banner, no
error, no response, indistinguishable from "hung" until this checker's own timeout fired. Not
specific to this one package — any CLI using that common idiom hits the same thing under a
symlinked repo root.

Every server process this check spawns also gets its own disposable `RFPHUB_MCP_HOME` (an
`mkdtemp` directory, removed afterward): a real server's `guard()` wrapper writes an audit-log line
for every tool call — read or write — so without the override, even the read-only cases would leave
entries in whoever is running this checker's own `~/.rfphub/audit.log`, and the submit-enabled
case's preview would land in `~/.rfphub/pending/`, indistinguishable from a real pending submission.

## The `sh`-block marker convention (`docs/**`)

Defined by the docs stream itself (`docs/README.md` on `brunodmsi/m4-handoff-docs`), not by this
checker — an earlier revision of this file spoke for a convention it hadn't seen yet and got the
syntax wrong; this is the corrected version, read against the real doc. Every fenced ` ```sh ` (or
`bash`) block in `docs/**` carries the marker as **the second word of the info string**, and that is
the only form there is — no preceding-comment alternative:

~~~
```sh safe-read
curl -s "$API/v1/health"
```
~~~

- **`safe-read`** — a `GET` against a public endpoint, no credential. The **only** kind this
  checker ever executes, and it must succeed.
- **`staging-write`** — mints a key, requests an OTP, submits/reviews/revokes. Never executed.
- **`no-run`** — a deployment or infrastructure mutation. Never executed, ever.

`docs/**` blocks reference the API as `$API` (never a literal URL), so a `safe-read` block runs with
`API=<--api>` injected into the child's environment, under plain `set -eu` with `curl` shadowed as
`curl() { command curl -f "$@"; }`. **Not** `pipefail`, and **not** a `jq` shim either — both were
tried against the real docs and each broke a legitimate block that is actually there:
`pipefail` failed a `curl ... | head -40` (head closing the pipe early makes curl's own write
"fail"), and shimming `jq` with `-e` on top of `curl -f` failed a `curl ... | jq 'select(...)'`
whose example organization legitimately doesn't exist in production — `-e` cannot tell "upstream
failed" apart from "my own filter matched nothing". What ships catches a BARE failing
`curl -f ... -o file` (the doc's export block) via plain `set -e`, and leaves one gap open
honestly: a `curl -f ... | jq` (no `-e`) whose request fails still exits 0, because unmodified `jq`
on an empty body is silent success. See the `SAFE_READ_PREAMBLE` docstring in `checks/docs.mjs` for
all three designs and the real doc content each was verified against.

A `sh`/`bash` block with **no marker, or an unrecognized one,** is a hard failure: an unmarked block
is one this checker cannot tell is safe to run, and treating "unmarked" as "don't run" silently
would let a real `safe-read` command go unexercised without anyone noticing. See `markers.mjs`
(unit tested in `test/markers.test.mjs`) for the parser.

## What SKIP means here, and why it is never a pass

Inherited from the M2 report, whose `Report` class this subclasses (`report.mjs`) precisely so the
rule has one implementation: a criterion nothing could be checked in is `skip`, and a run containing
one is **`incomplete`** — not green, and not exit 0. `--skip <id>` produces exactly this: an
intentional skip is still visible in the headline, never silently absent from the report.

## Layout

```
scripts/check-m4.mjs               entry point, ordering, report writing
scripts/m4-compliance/
  options.mjs         argument parsing (no credentials, no --allow-production — read-only)
  report.mjs           the M2 report with M4's identity
  browser.mjs           Playwright resolved through packages/e2e
  mcp-client.mjs         a hand-rolled newline-delimited JSON-RPC stdio client (see its docstring
                         for why this isn't pulled from an SDK)
  mock-server.mjs        the local recording HTTP server used only by the MCP submit case
  frontmatter.mjs       Agent Skills frontmatter parsing/validation      (test/frontmatter.test.mjs)
  links.mjs             markdown link extraction                        (test/links.test.mjs)
  markers.mjs           sh-block marker parsing                         (test/markers.test.mjs)
  checks/*.mjs          one file per check (governance, publishers, frontend, mcp, skill, docs)
  test/*.test.mjs        unit tests for the pure helpers above — no network, no filesystem
```

## What it cannot establish

- That the MCP package is actually **published** to npm and the MCP Registry (§4.4 row "4b" in the
  plan) — this checker verifies the server's *behaviour*, wherever it runs from; publication status
  is a manual step documented in `docs/deployment.md`.
- That a human reviewer's actual approval flow (`rfphub-mcp approve <id>`) works end to end against
  a real, writable deployment — that is `scripts/accept-m4.mjs`, which runs against staging only.
- SEO/indexability beyond reporting `robots.txt` — the plan is explicit that index state is
  **reported**, not held to a pass/fail contract, because the `robots` decision was still open when
  this checker was written.

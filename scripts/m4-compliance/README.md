# M4 compliance checker

Mechanically verifies the M4 completion criteria against a **live, public deployment**. Entry
point: [`scripts/check-m4.mjs`](../check-m4.mjs).

```sh
node scripts/check-m4.mjs --site https://ethrfps.app --api https://api.ethrfps.app --browser
```

Pass/fail per criterion on stdout, a JSON report alongside, non-zero exit on any failure **or on
any criterion that was never exercised**.

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
| `frontend` | Reference frontend live and behaving | TLS, liveness, `robots.txt` (reported, not failed); rendered: `q` search, a `fundingType` filter and `page=2` each change the result set; the detail page shows the title; both deep-link hrefs (`apply`/`source`) are correct; three viewports have no horizontal overflow |
| `mcp` | MCP server installable and callable | `tools/list` has the two read tools and not `submit_opportunity` without the env; `search_opportunities` matches the API in ids; no `rfph_` substring anywhere; with the submit env on, phase 1 answers `pending` and makes no network write |
| `skill` | Agent skill published correctly | `SKILL.md` frontmatter is spec-valid, the file is under 500 lines, and `scripts/search.mjs` — run for real against `--api` — never emits a `description` field |
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

Controls what `mcp.mjs` spawns:

1. `--mcp-spec <spec>` → `npx -y @the-rfp-hub/mcp@<spec>` (an exact npm version, or `next`).
2. Otherwise, if `packages/mcp/dist/cli.js` exists in this checkout → `node <that file>`. This is
   what makes the check runnable **before the package is ever published** — `packages/mcp` is built
   by a different stream, concurrently with this checker.
3. Otherwise, `npx -y @the-rfp-hub/mcp@next` as a last resort. Before the package is published this
   fails loudly (`npm error 404 ...`) and the check reports that verbatim — it does not swallow it.

## The `sh`-block marker convention (`docs/**`)

This checker is the first consumer of the marker rule in the M4 plan (§3.6), so it also defines the
syntax. Every fenced ` ```sh ` (or `shell`/`bash`/`console`) block in `docs/**` must carry one of:

- **`safe-read`** — a `GET` against a public endpoint, no credential. The **only** kind this
  checker ever executes, and it must succeed.
- **`staging-write`** — mints a key, requests an OTP, submits/reviews/revokes. Never executed.
- **`no-run`** — a deployment or infrastructure mutation. Never executed, ever.

Two ways to mark a block:

~~~
```sh safe-read
curl -s https://api.example.org/v1/health
```
~~~

or, when the fence itself can't carry a second token, an HTML comment on its own line immediately
before it (one blank line is tolerated):

~~~
<!-- marker: staging-write -->
```sh
curl -X POST https://api.example.org/v1/keys ...
```
~~~

A `sh` block with **neither** is a hard failure: an unmarked block is one this checker cannot tell
is safe to run, and treating "unmarked" as "don't run" silently would let a real `safe-read` command
go unexercised without anyone noticing. See `markers.mjs` (unit tested in `test/markers.test.mjs`)
for the parser.

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

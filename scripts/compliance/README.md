# Deployment compliance

Two binaries, one directory of criteria. The split between them is a safety property rather than a
convention, so it is the first thing to understand about this code.

| | [`scripts/check-deployment.mjs`](../check-deployment.mjs) | [`scripts/accept-writes.mjs`](../accept-writes.mjs) |
|---|---|---|
| pnpm script | `pnpm check:deployment` | `pnpm accept:writes` |
| what it does | fetches public documents and holds them to the contract they publish | submits entries, mints a credential, generates traffic, asks a reviewer to close things |
| default target | production | none — there is no default, and no flag that reaches production |
| credentials | **none**: no flag, no environment fallback, no code path that writes | required, including a reviewer credential |
| report says | `signOff: true` on a clean unscoped run | `write acceptance — NOT a deployment sign-off`, always |

A tool whose defaults point at production cannot write, because it holds no code path that writes
and no flag that supplies something to write with. A tool that writes has no default target at all.
Neither property survives merging them, which is why they are two files.

```bash
pnpm install && pnpm build      # both tools use the repo's own validator, from its build output

pnpm check:deployment --milestone m2 \
  --api        https://api.example.org \
  --export-url https://data.example.org

pnpm accept:writes --milestone m3 \
  --api https://api-staging.example.org \
  --namespace my-org --session-token "$SESSION" --admin-token "$ADMIN"
```

`--help` on either lists every flag. Human-readable pass/fail per criterion goes to stdout, a
machine-readable report to a unique file under the system temporary directory (`--json <path>`, or
`-` for stdout).

**Exit codes**, both: `0` every selected criterion was exercised and held · `1` a criterion failed,
or a required check was never exercised · `2` the run could not be made at all.

Neither is wired into CI. They answer "does the definition of done hold against this deployment",
which is a question someone asks, not a monitor — and CI has no deployment to write to.

## Selecting criteria

Criteria are named for the capability they verify, never for a contract milestone: the repository
outlives the contract, and a report that says `openapi` means something to a reader who has never
seen the contract.

- `--only <key>` (repeatable) registers *only* those criteria, so a green scoped run is a clean
  pass rather than a report full of holes. A hard prerequisite is pulled in automatically and
  announced in the header.
- `--skip <key>` (repeatable) registers the criterion as **unmet**, which makes the run
  `INCOMPLETE`. Refused together with `--only`: the combination has no single meaning.
- `--milestone <id>` runs the criteria a contract milestone maps to, and stamps the mapping into the
  console header and into `criteria[].contractId` in the JSON. Without it, no `contractId` appears
  anywhere. `accept:writes` requires one; `check:deployment` runs everything registered without it.

`accept:writes --only audit` registers `lifecycle` too, because `audit` reads the fixture
`lifecycle` creates and on its own could only report that it had none. `--skip lifecycle` while a
dependent is selected is refused rather than run: the dependent would report an unmet requirement
the operator chose, which reads as a finding about the deployment and is not one.

`--milestone m3` on `check:deployment` is an error naming `accept:writes`, and `--milestone m2` on
`accept:writes` is an error naming `check:deployment`. A milestone whose criteria are not registered
is an error too, rather than a run that quietly checks fewer things than the milestone has.

## The criteria

| Milestone | Contract criterion | `--only` key | tool |
|---|---|---|---|
| M2 | M2-1 API liveness | `liveness` | `check:deployment` |
| M2 | M2-2 OpenAPI conformance | `openapi` | `check:deployment` |
| M2 | M2-3 Dataset | `dataset` | `check:deployment` |
| M2 | M2-4 Export freshness | `export` | `check:deployment` |
| M3 | M3-1 Publisher lifecycle | `lifecycle` | `accept:writes` |
| M3 | M3-2 Namespace review queue | `namespace` | `accept:writes` |
| M3 | M3-3 Audit trail | `audit` | `accept:writes` |
| M3 | M3-4 Duplicate detection | `duplicates` | `accept:writes` |
| M3 | M3-5 Source verification & snapshot | `verification` | `accept:writes` |
| M3 | M3-6 Publisher analytics | `analytics` | `accept:writes` |
| M3 | M3-7 Staleness job | `staleness` | `accept:writes` |
| M3 | — hygiene, not a completion criterion | `teardown` | `accept:writes` |
| M4 | M4-1 Governance framework published and linked | `governance` | `check:deployment` |
| M4 | M4-2 Public `/publishers` page | `publishers` | `check:deployment` |
| M4 | M4-3 Reference frontend live and behaving | `frontend` | `check:deployment` |
| M4 | M4-4 MCP server installable and callable | `mcp` | `check:deployment` |
| M4 | M4-4b MCP server published | `mcp-publication` | `check:deployment` |
| M4 | M4-5 Agent skill published correctly | `skill` | `check:deployment` |
| M4 | M4-6 Handoff documentation | `docs` | `check:deployment` |
| M4 | M4-ACCEPT Real 3-phase MCP submission interlock | `submission-cycle` | `accept:writes` |

`teardown` is not selectable: a write run appends it, last, in a `finally`, and its `contractId` is
`null` in every profile.

`mcp` and `mcp-publication` are two criteria, not one: a server behaves identically whether it came
from npm, the Registry or a local build, so whether it is PUBLISHED needs its own evidence. `--only
mcp` therefore registers the behavior half alone, and `--skip mcp` leaves publication running.

### What each one asserts

| key | What is actually asserted |
|---|---|
| `liveness` | `GET {api}/v1/health` is `200` **and** the body reports `status: ok`, `db: up` — the service's own definition of healthy, so a `200` saying `degraded` is a failure. TLS certificate validity, issuer and remaining lifetime are probed and reported (under three weeks from expiry is a warning). Round trip timed over three samples. |
| `openapi` | The document served at `{api}/v1/docs/json` is the input. Every operation it declares is executed against the live URL and held to *its own* declared status, media type and response schema (ajv, draft 2020-12) — or, where the declared media type is not JSON (the Atom and RSS feeds), to the documented status, the declared content type, a non-empty body and, for XML, that the document is well-formed, with the report saying the schema half did not apply. Where the document declares a **security requirement**, the credential-less checker is held to the promise addressed to it instead: a `401`, in a declared media type, whose body validates against the error schema declared for that status. Then the negative half: an undocumented query parameter, and a value violating every documented enum, pattern, format and numeric bound, must each be a `400` whose body validates against the declared error schema; a path template documenting a `404` must answer `404`. |
| `dataset` | `/v1/stats` total is at or above the floor; the list endpoint pages through the whole dataset with a stable total and no repeats; every list item conforms to the published `OpportunitySummary`; **every** listed document is then fetched from the detail endpoint and validated against the Standard with `packages/validate`; and filtered counts agree with `/v1/stats`, partition the dataset, and OR correctly when combined. |
| `export` | `latest.json` and `latest.csv` download and parse; the envelope is CC0-marked and its `generatedAt` is inside the freshness window; a CC0 rights notice sits at the export root; a sample of the exported documents validates against the Standard; and the two aliases describe the same **dataset** — same record count, same id set, identical field values on a sample. Where `latest.manifest.json` is published, the same **run** as well: every artifact it names is verified against the full sha256 it records. |
| `lifecycle` | `/v1/me` resolves the credential; a scoped key is minted and its secret returned once; an entry is submitted and then replaced through the API; the server owns `source.publisher`/`submittedAt`; `PUT` refuses a rename. |
| `namespace` | A submission into a namespace the credential does not hold is **accepted**, lands `pending`, is absent from the public detail route and the public list, and is still readable by its own submitter. |
| `audit` | Every mutation recorded with action, actor kind and a parseable timestamp; the **public** view redacted to field names, the **owner's** carrying the full patch; a non-public entry's trail 404s. |
| `duplicates` | A reworded resubmission surfaces the original, and the pair is retrievable afterwards from `/v1/me/duplicates`. |
| `verification` | A run is recorded, timestamped, names the URL it fetched, decides `existsAtSource`, and — when a page was retrieved — carries a sha256 of the bytes; the entry's own flag agrees with the run. |
| `analytics` | Real reads and a link-out click are counted and served back to the publisher **the same day, before any rollup**; another reader cannot see them. |
| `staleness` | An entry whose fixed deadline has passed is closed by the job, attributed to `actorKind: "job"` with `reason: "past_due"`, and a second run writes no second closure. |
| `teardown` | Fixtures are rejected and unlisted, and the minted key is revoked. For the `m4` profile, the one entry it submitted is rejected and then proved gone from the owner listing **and** the public route. |
| `governance` | The four governance documents exist and their GitHub URLs answer 200; `/how-it-works` carries an anchor whose `href` is each of the four exact canonical URLs (read from `packages/frontend/src/lib/links.ts`); and the home page carries at least one of those same four exact hrefs **outside** `<footer>` — a link the global chrome puts on every page is not the home page linking to the framework. |
| `publishers` | The route answers 200; `GET /v1/publishers` has the shape it promises (items array, integer `total` equal to `items.length`, unique non-empty slugs); rendered, the page shows exactly those slugs — or the empty state when there are none — and the browser's own request carries no `Authorization` header. |
| `frontend` | TLS (a non-loopback plaintext site FAILS); liveness; `robots.txt` reported, or required with `--expect-indexable`; rendered: `q`, an ecosystem filter, a funding-type filter and `page=2` each change **which** entries are shown, and the two filters — values chosen from live data for actually NARROWING the corpus, never a dominant value whose first page is the unfiltered one — match what the API returns for the same filter; the detail page's visible `<h1>` is the title; both deep-link hrefs are exact; three viewports have no horizontal overflow, and at the two touch viewports (built with `isMobile`, so `(pointer: coarse)` matches the way it does on a real phone) no **form control** (`input`, `select`, `textarea`, `button`, `[role="button"]`) and no **nav link** (`nav a`) is under 44 px tall — the scope `packages/e2e/tests/13-responsive.spec.ts` asserts. A text link outside a nav is not measured whatever its `display`: its hit area is the line box, and widening it would break the sentence around it. |
| `mcp` | `npx` resolves `@the-rfp-hub/mcp` from the real npm registry and runs; **exactly** two tools without `RFPHUB_MCP_ENABLE_SUBMIT` and **exactly** three with it, each with an `outputSchema` and boolean annotation hints; `search_opportunities` returns `structuredContent` that validates against its own advertised schema and matches the API page for page, envelope field for envelope, across two pages of a query derived from the live corpus; no `rfph_` substring anywhere, including after the process exits; phase 1 answers `pending` and makes no network write — against a **local recording server this checker starts itself**, never against `--api`. |
| `mcp-publication` | `npm view` resolves the selected spec to an exact version whose published `mcpName` matches the manifest; the official MCP Registry carries that server at that version with the same npm package identifier; every `npx` configuration snippet in `packages/mcp/README.md` pins an exact version (never `@latest`, never a dist-tag). |
| `skill` | Every file the documented install channels need is on GitHub `main` with the same sha256 as the audited local copy; the repository's own `scripts/check-skill.mjs` passes against that fetched copy; the fetched `scripts/search.mjs`, run against a corpus whose every prose field carries an injected instruction, emits neither the instruction nor a `description` field. |
| `docs` | The four `docs/*.md` guides exist; every link and `#anchor` in them — and in the root markdown, `skills/**` and `packages/mcp/README.md` — resolves; only `safe-read` `sh` blocks are ever executed, and those succeed. |
| `submission-cycle` | The real MCP `submit_opportunity` interlock end to end against staging: an owner snapshot before anything, exactly three tools, an exact `status: "pending"` with the snapshot proved unchanged, a phase-3 commit with an invalid approval that must be refused with the snapshot still unchanged, then the approval, the commit, and the fixture verified pending through `GET /v1/me/opportunities`. |

The e2e suite covers what only a browser can prove, and its own report numbers those areas
differently: it splits the audit trail and source verification into one `provenance-verification`
spec, and adds `public-browse`, `organization` and `back-links`, which have no HTTP-only
equivalent. Neither numbering is wrong; a report cites the one belonging to the tool that produced
it, and `criteria[].contractId` always means the first column of the table above.

## Behavior flags

### `--browser`

The frontend and `/publishers` are client-rendered, so a plain `fetch` of the HTML sees an (almost)
empty shell. `--browser` resolves Playwright **through `packages/e2e`'s own `node_modules`** (see
`browser.mjs`) rather than adding a second copy of the dependency at the repo root, and launches
Chromium for the rendered governance anchors, the `/publishers` slug comparison and its
network-header check, and every frontend check that needs to see the result set change.

Without `--browser` those requirements are reported **unmet**, which makes their criterion
`INCOMPLETE` and the run exit non-zero. They were WARNs, and a WARN was green — a full run without
a browser could print `RESULT: PASS` having looked at none of them.

### `--offline`

Applies to the **`docs` criterion only**: it skips the absolute-link 2xx/3xx requests and the
execution of `safe-read` blocks. Every other criterion still uses the network, so the only
combination that means anything is `--only docs --offline`, which is what the CI `docs-links` job
runs. Everything else in the docs check — file existence, relative links, `#anchor` resolution,
marker presence — still runs, because none of it needs the network.

### `--expect-indexable`

Index state is **reported**, not held to a contract, because the decision is the operator's. Pass
`--expect-indexable` when the deployment is meant to be indexed and the row becomes a requirement:
a `robots.txt` that disallows `/` for every user-agent, or a home page carrying
`<meta name="robots" content="…noindex…">`, then fails instead of being noted.

### `--mcp-spec`

Accepts a dist-tag (`next`), an exact version (`0.1.0`), `local`, or a full `@the-rfp-hub/mcp@<x>`
normalized to `<x>` — the operator runbook spells it that last way, and concatenating it produced
`@the-rfp-hub/mcp@@the-rfp-hub/mcp@next`, an npm ENOENT nobody could read back to the flag. A range
(`^1.0.0`, `1.x`, `*`) is refused: this criterion is about one immutable published artifact, and a
range does not name one.

1. Default (`next`) → `npx -y @the-rfp-hub/mcp@<spec>`, the real npm registry, which is what
   "installable" has to mean for the criterion's own name to be true. Before the package is
   published this FAILS by name, and the remaining behavior checks are reported unmet rather than
   each failing with a copy of the same npm error.
2. `--mcp-spec local` → the EXPLICIT opt-out: `node <repo-root>/packages/mcp/dist/cli.js`, for
   developing `packages/mcp` (or this checker) before publish. `mcp` is renamed to "MCP server
   callable from a local build", and **`mcp-publication` is INCOMPLETE** — a local build is not
   evidence of publication, and the run cannot go green.

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

## Transient GitHub errors

The probes that ask whether a document is published — the four governance URLs, the skill files and
the marketplace manifest — get **one** retry after 2 s on a transport failure or a 5xx from
`github.com` / `raw.githubusercontent.com`, and the four governance requests are issued one at a
time rather than concurrently. A sign-off run failed the governance criterion with HTTP 502 on all
four URLs, every one of which answered 200 moments later; a gateway error is not evidence that a
document is unpublished. A **4xx is never retried** — a 404 is the answer, and asking twice would
only make an honest red run slower.

## The write target guard

There is no `--allow-production`, and no other flag that reaches production. `accept:writes` accepts

- **loopback**, plaintext included: that traffic never leaves the machine;
- **https to an explicitly allowlisted staging origin**;
- **one extra https origin** whose hostname carries a `staging` label and no `prod` label, named by
  `RFPHUB_ACCEPT_EXTRA_STAGING_ORIGIN`.

The redirect chain the target answers with is followed to five hops and every hop re-checked, because
an allowlisted origin that 302s elsewhere still receives the request carrying the credential.

The rule this replaced asked whether any hostname segment read like a non-production environment,
which admits `not-staging-anymore.example.org`, `production-staging.example.org` and any CNAME
whoever controls DNS points wherever they like. Hostname text cannot prove which deployment answers.

Three more refusals, all decided before a single request is made:

| Refusal | Why |
|---|---|
| no `--namespace`, no publisher credential (`m3`) | A run that quietly performed the criteria it could and reported an acceptance would be worse than no tool. |
| no reviewer token, no write key (`m4`) | The submission profile drives the MCP server, so those are the two credentials it needs; both may also arrive as `COMPLIANCE_REVIEWER_TOKEN` / `COMPLIANCE_WRITE_KEY`, or under the `RFPHUB_` names the MCP server's own documentation spells. |
| no reviewer credential | The teardown rejects and unlists everything the run creates. A run that cannot clean up after itself must not write in the first place. |
| `--keep-fixtures` | Permitted, but it records an **unmet** requirement, so the run reports `INCOMPLETE` rather than exiting 0 with rows left behind. |

Everything a write run creates is named `<namespace>:compliance-<runstamp>-<what>`, so a leftover
fixture is identifiable months later as a compliance artifact rather than a listing somebody has to
investigate. The `m4` profile's single entry is `compliance:compliance-<runtoken>`, whose token
carries the pid and random bytes as well as the timestamp: two runs started in the same minute
shared an id, and the second one then "found" the first one's entry.

### `--milestone m4`: the approval is labeled for what it is

By default the CLI is driven non-interactively and the report says
`approval: SIMULATED (non-interactive)` — that automates the CLI, it does not demonstrate a human
decision. `--interactive-approval` prints the exact `rfphub-mcp approve <id>` command for an
operator to run in another terminal and waits for it (`--approve-timeout` rises to five minutes,
because waiting on a person is not waiting on a process), and the report says `approval: HUMAN`.

## `skip`, `unmet` and why neither is a pass

Six check outcomes, and the two that could be confused are the ones that matter:

- **`skip`** — the check could not be performed, and the criterion does **not** depend on it. Stays
  green. A plaintext loopback origin has no transport to inspect; an API-key run cannot exercise
  session-only key management. Counted in the headline either way, so a pass never hides it.
- **`unmet`** — the check could not be performed and the criterion **does** depend on it. Renders as
  a warning, names itself, and makes the criterion `INCOMPLETE`, so the run exits non-zero.

One level up: a criterion in which every check was skipped — or in which none ran at all — is
`INCOMPLETE` too. Nothing failed, but nothing was established either, and those are not the same
answer. A sign-off tool that quietly reports "I could not check this" as "this is fine" is worse
than no tool.

Several skips are *correct outcomes* rather than gaps, and each says which: `duplicateCheck:
"disabled"` (no embedding provider, and the API is telling the truth about a capability nobody
enabled); a published non-`GET` operation, which a read-only probe will not issue; no
`--admin-token`, since starting a job on demand is a session-only capability.

## The two user-agents

The API excludes its own automation from analytics **by name**, and the compliance client's agent is
on that list — otherwise this tool, run against a deployment, would be most of every publisher's
view count. So the `analytics` criterion generates its traffic under a plain agent and reads the
numbers back under the compliance agent: measuring must not change the measurement.

Those agent strings are the one milestone-named thing left in this directory. They are a contract
with the *deployed* API, and renaming the client before the API accepts the new name would make
every compliance run count as real publisher traffic.

## What these tools cannot establish

- **The dashboard rendering the analytics.** They prove the API counts real traffic and serves it to
  the publisher; that the numbers reach a screen is the dashboard's own render test and the e2e
  suite. The report says this in the criterion rather than implying more.
- **A human reviewer's actual approval flow, unless it is driven.** That is
  `pnpm accept:writes --milestone m4 --interactive-approval`, staging only.
- **SEO/indexability beyond `--expect-indexable`'s two mechanical checks.** Whether a deployment
  *should* be indexed is the operator's decision, not a contract.
- **Anything about a particular host being the right one.** Nothing about a host, domain or dataset
  size is hard-coded. The operations executed, their parameters, the accepted values and the error
  contract are read out of the OpenAPI document the deployment publishes; the only numbers carried
  are the milestone's own floors, and those are flags.

## Layout

```
scripts/check-deployment.mjs   read-only entry point
scripts/accept-writes.mjs      write-acceptance entry point
scripts/compliance/
  criteria.mjs         the two registries, selection, prerequisite auto-inclusion
  options.mjs          the read-only parser        (test/options-scope.test.mjs)
  accept-options.mjs   the write parser + refusals (test/options-write-refusals.test.mjs)
  target-guard.mjs     the write allowlist         (test/target-guard.test.mjs)
  report.mjs           criteria, outcomes, rendering, JSON
  http.mjs             the HTTP client both tools share
  client.mjs           HTTP with credentials and the two agents
  csv.mjs xml.mjs schema.mjs   parsing and validation helpers
  fixtures.mjs         the documents a write run creates
  cleanup.mjs          the m3 profile's teardown, behind checks/teardown.mjs
  browser.mjs          Playwright resolved through packages/e2e
  mcp-client.mjs       a hand-rolled newline-delimited JSON-RPC stdio client
  mock-server.mjs      the local recording HTTP server the MCP submit case uses
  links.mjs            markdown links, GitHub heading slugs        (test/links.test.mjs)
  markers.mjs          sh-block marker parsing                     (test/markers.test.mjs)
  safe-read.mjs        the safe-read grammar and executor          (test/docs-safe-read.test.mjs)
  retry.mjs            one retry for the GitHub publication probes (test/retry.test.mjs)
  checks/*.mjs         one file per criterion, each exporting meta + run(ctx)
  accept/*.mjs         the MCP submission flow and its criterion
  test/*.test.mjs      collected by the root `pnpm test`
```

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

`teardown` is not selectable: a write run appends it, last, in a `finally`, and its `contractId` is
`null` in every profile.

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
| `teardown` | Fixtures are rejected and unlisted, and the minted key is revoked. |

The e2e suite covers what only a browser can prove, and its own report numbers those areas
differently: it splits the audit trail and source verification into one `provenance-verification`
spec, and adds `public-browse`, `organization` and `back-links`, which have no HTTP-only
equivalent. Neither numbering is wrong; a report cites the one belonging to the tool that produced
it, and `criteria[].contractId` always means the first column of the table above.

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
| no `--namespace`, no publisher credential | A run that quietly performed the criteria it could and reported an acceptance would be worse than no tool. |
| no reviewer credential | The teardown rejects and unlists everything the run creates. A run that cannot clean up after itself must not write in the first place. |
| `--keep-fixtures` | Permitted, but it records an **unmet** requirement, so the run reports `INCOMPLETE` rather than exiting 0 with rows left behind. |

Everything a write run creates is named `<namespace>:compliance-<runstamp>-<what>`, so a leftover
fixture is identifiable months later as a compliance artifact rather than a listing somebody has to
investigate.

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
  cleanup.mjs          teardown, behind checks/teardown.mjs
  checks/*.mjs         one file per criterion, each exporting meta + run(ctx)
  test/*.test.mjs      collected by the root `pnpm test`
```

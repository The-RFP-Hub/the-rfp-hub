# M3 compliance checker

Mechanically verifies the M3 completion criteria against a **live deployment**. Entry point:
[`scripts/check-m3.mjs`](../check-m3.mjs).

```sh
node scripts/check-m3.mjs \
  --base-url https://api.staging.example.org \
  --namespace my-org \
  --session-token "$SESSION" \
  --admin-token "$ADMIN_SESSION"
```

Pass/fail per criterion on stdout, a JSON report alongside, non-zero exit on any failure **or on
any criterion that was never exercised**.

---

## It writes. That is the whole difference from check-m2.

`check-m2` is a read-only probe: it fetches public documents and holds them to a published
contract, so running it anywhere, twice, from anywhere, costs nothing.

This one **submits entries, mints an API key, generates analytics traffic and asks a reviewer to
close things**, because five of the seven criteria are about the write surface. So it refuses to
start in two situations, and both refusals are tested (`options.test.mjs`):

| Refusal | Why |
|---|---|
| No `--session-token` / `--api-key`, or no `--namespace` | A run that quietly performed the two read-only criteria and reported a passing M3 sign-off would be worse than no tool at all. |
| A `--base-url` that does not look like staging or loopback, without `--allow-production` | **Default-deny.** A blocklist of production hostnames has to be right about a name nobody remembered to add, and the failure mode is fixture rows in the live dataset. |

Everything it creates is named `<namespace>:m3check-<runstamp>-<what>`, so a leftover fixture is
identifiable months later as a compliance artifact rather than a listing somebody has to
investigate.

**It is not wired into CI**, deliberately. CI has no deployment to write to, and a sign-off tool
that required a standing publisher credential in repository secrets would be a worse thing to have
than a tool somebody runs.

---

## The criteria

| | Criterion | Establishes |
|---|---|---|
| **M3-1** | Publisher lifecycle | `/v1/me` resolves the credential; a scoped key is minted and its secret returned once; an entry is submitted and then replaced through the API; the server owns `source.publisher`/`submittedAt`; `PUT` refuses a rename |
| **M3-2** | Namespace review queue | A submission into a namespace the credential does not hold is **accepted**, lands `pending`, is absent from the public detail route and the public list, and is still readable by its own submitter |
| **M3-3** | Audit trail | Every mutation recorded with action, actor kind and a parseable timestamp; the **public** view redacted to field names, the **owner's** carrying the full patch; a non-public entry's trail 404s |
| **M3-4** | Duplicate detection | A reworded resubmission surfaces the original, and the pair is retrievable afterwards from `/v1/me/duplicates` |
| **M3-5** | Verification & snapshot | A run is recorded, timestamped, names the URL it fetched, decides `existsAtSource`, and — when a page was retrieved — carries a sha256 of the bytes; the entry's own flag agrees with the run |
| **M3-6** | Publisher analytics | Real reads and a link-out click are counted and served back to the publisher **the same day, before any rollup**; another reader cannot see them |
| **M3-7** | Staleness job | An entry whose fixed deadline has passed is closed by the job, attributed to `actorKind: "job"` with `reason: "past_due"`, and a second run writes no second closure |
| **M3-T** | Teardown | Fixtures are rejected and unlisted and the minted key is revoked. A hygiene criterion, reported at the same level on purpose so a run that left rows behind cannot be green |

## What SKIP means here, and why it is never a pass

Inherited from the M2 report, whose `Report` class this subclasses precisely so the rule has one
implementation: a criterion nothing could be checked in is `skip`, and a run containing one is
**`incomplete`** — not green, and not exit 0.

Several skips are *correct outcomes* rather than gaps, and each says which:

* `duplicateCheck: "disabled"` / `"unavailable"` — no embedding provider, or it did not answer.
  The API is telling the truth about a capability nobody enabled.
* The M3-1 fixture landed `pending` — a submitter's duplicate candidate search is restricted to the
  public set on purpose, and a pending entry has no public reads to count. Both criteria say so and
  tell you to supply a credential for a **verified member** of `--namespace`.
* No `--admin-token` — starting a job on demand is a T4, session-only capability, and a compliance
  run cannot wait for 01:05 to see whether a cron fired.
* No `--session-token` — key management is session-only by design, so an API-key run cannot exercise
  it.

## The two user-agents

The API excludes its own automation from analytics **by name**, and `rfphub-m3-compliance` is on
that list — otherwise this tool, run against a deployment, would be most of every publisher's view
count. So M3-6 generates its traffic under a plain agent and reads the numbers back under the
compliance agent: measuring must not change the measurement.

## What it cannot establish

The dashboard **rendering** the analytics. This tool proves the API counts real traffic and serves
it to the publisher; that the numbers reach a screen is covered by the dashboard's own render test
and by the manual acceptance checklist with its screenshot. The report says this in the criterion
itself rather than implying more.

## Layout

```
scripts/check-m3.mjs              entry point, ordering, report writing
scripts/m3-compliance/
  options.mjs        argument parsing + the two refusals   (options.test.mjs)
  client.mjs         HTTP with credentials and the two agents
  fixtures.mjs       the documents this run writes
  report.mjs         the M2 report with M3's identity
  cleanup.mjs        teardown
  checks/*.mjs       one file per criterion
```

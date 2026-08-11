# M2 sign-off compliance checker

Mechanically verifies the four M2 completion criteria against a **live deployment**. Entry point:
[`scripts/check-m2.mjs`](../check-m2.mjs); the criteria live in [`checks/`](./checks).

```bash
pnpm install && pnpm build          # the checker uses the repo's own validator, from its build output
node scripts/check-m2.mjs \
  --base-url   https://api.example.org \
  --export-url https://data.example.org
```

Human-readable pass/fail per criterion goes to stdout, a machine-readable report to
`m2-compliance-report.json` (`--json <path>`, or `-` for stdout), and the process exits non-zero if
any criterion failed. `node scripts/check-m2.mjs --help` lists every flag.

There is also a `workflow_dispatch` runner —
[`.github/workflows/m2-compliance.yml`](../../.github/workflows/m2-compliance.yml) — taking the two
URLs as inputs and keeping the JSON report as a run artifact. No cron: this answers "does the
milestone's definition of done hold", which is a question someone asks, not a monitor.

## What each criterion checks

| # | Criterion | What is actually asserted |
|---|---|---|
| 1 | **API liveness** | `GET {base}/v1/health` is `200` **and** the body reports `status: ok`, `db: up` — the service's own definition of healthy, so a `200` that says `degraded` is a failure. TLS certificate validity, issuer and remaining lifetime are probed and reported (a certificate under three weeks from expiry is a warning). Round trip timed over three samples. |
| 2 | **OpenAPI conformance** | The document served at `{base}/v1/docs/json` is the input. Every operation it declares is executed against the live URL and held to *its own* declared status, media type and response schema (ajv, draft 2020-12). Then the negative half: an undocumented query parameter, and a value violating every documented enum, pattern, format and numeric bound, must each be a `400` whose body validates against the declared error schema; a path template documenting a `404` must answer `404`. |
| 3 | **Dataset** | `/v1/stats` total is at or above the floor; the list endpoint pages through the whole dataset with a stable total and no repeats; every list item conforms to the published `OpportunitySummary`; **every** listed document is then fetched from the detail endpoint and validated against the Standard with `packages/validate`; and filtered counts agree with `/v1/stats`, partition the dataset, and OR correctly when combined. |
| 4 | **Export freshness** | `latest.json` and `latest.csv` download and parse; the envelope is CC0-marked and its `generatedAt` is inside the freshness window; a CC0 rights notice sits at the export root; the exported documents validate against the Standard; and the two aliases describe the **same run** — same record count, same id set, and identical field values on a sample. |

## Two things worth knowing about how it is built

**Nothing about the deployment is hard-coded.** Paths, parameters, accepted values and the error
contract are all read out of the OpenAPI document the deployment publishes; the status and funding
type value sets come from the schema the service serves; the page size comes from the documented
maximum. The only numbers the tool carries are the milestone's own floors (`--min-total`,
`--freshness-hours`), and those are flags. That is what makes it runnable against a local instance
today and against the deployment on the day it exists.

**"Every document validates against the Standard" needs both endpoints.** The list endpoint serves
`OpportunitySummary`, a server-controlled projection that deliberately omits `fundingDetails` —
which the Standard *requires*. So a list item is held to the projection the service publishes for
it, and the full document behind every listed id is fetched from the detail endpoint and validated
against the Standard itself. Validating only the summaries would be validating a shape the Standard
never describes.

## What it deliberately does not do

- **It issues read-only requests.** A published non-`GET` operation is reported as `skip` with that
  reason, never as a pass. The `/v1/` surface is read-only today, so nothing is skipped in practice.
- **It does not grade the published document's own style**, only whether live responses conform to
  it. A relative `servers[0].url` (what an unset `PUBLIC_BASE_URL` leaves behind) is a warning
  rather than a failure, because it is correct wherever the document is fetched from — but a
  deployed service should publish its own absolute origin.
- **It does not require a particular export layout.** Where the export publishes per-run archives
  named after a digest of their own bytes, the alias bytes are hashed and the matching archive is
  probed — direct evidence of which run each alias sits on. Where it does not, that probe reports
  as informational and the pair invariant is asserted from the record sets alone.
- **`skip` is never a `pass`.** A check the run could not perform says so, with the reason, and the
  summary counts it separately. A sign-off tool that quietly reports "I could not check this" as
  "this is fine" is worse than no tool.

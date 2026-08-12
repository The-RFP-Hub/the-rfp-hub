# M2 sign-off compliance checker

Mechanically verifies the four M2 completion criteria against a **live deployment**. Entry point:
[`scripts/check-m2.mjs`](../check-m2.mjs); the criteria live in [`checks/`](./checks).

```bash
pnpm install && pnpm build          # the checker uses the repo's own validator, from its build output
pnpm check:m2 \
  --base-url   https://api.example.org \
  --export-url https://data.example.org
```

Human-readable pass/fail per criterion goes to stdout, a machine-readable report to
`m2-compliance-report.json` (`--json <path>`, or `-` for stdout), and the process exits non-zero if
any criterion failed **or could not be exercised**. `node scripts/check-m2.mjs --help` lists every flag.

This is a script, run by hand (or from any external runner) against whichever deployment someone
wants an answer about — a preview environment, staging, production. It is not wired into CI: this
answers "does the milestone's definition of done hold", which is a question someone asks, not a
monitor.

## What each criterion checks

| # | Criterion | What is actually asserted |
|---|---|---|
| 1 | **API liveness** | `GET {base}/v1/health` is `200` **and** the body reports `status: ok`, `db: up` — the service's own definition of healthy, so a `200` that says `degraded` is a failure. TLS certificate validity, issuer and remaining lifetime are probed and reported (a certificate under three weeks from expiry is a warning). Round trip timed over three samples. |
| 2 | **OpenAPI conformance** | The document served at `{base}/v1/docs/json` is the input. Every operation it declares is executed against the live URL and held to *its own* declared status, media type and response schema (ajv, draft 2020-12) — or, where the declared media type is not JSON (the Atom and RSS feeds), to the documented status, the declared content type, a non-empty body and, for XML, that the document is well-formed, with the report saying that the schema half did not apply. Then the negative half: an undocumented query parameter, and a value violating every documented enum, pattern, format and numeric bound, must each be a `400` whose body validates against the declared error schema; a path template documenting a `404` must answer `404`. |
| 3 | **Dataset** | `/v1/stats` total is at or above the floor; the list endpoint pages through the whole dataset with a stable total and no repeats; every list item conforms to the published `OpportunitySummary`; **every** listed document is then fetched from the detail endpoint and validated against the Standard with `packages/validate`; and filtered counts agree with `/v1/stats`, partition the dataset, and OR correctly when combined. |
| 4 | **Export freshness** | `latest.json` and `latest.csv` download and parse; the envelope is CC0-marked and its `generatedAt` is inside the freshness window; a CC0 rights notice sits at the export root; the exported documents validate against the Standard; and the two aliases describe the same **dataset** — same record count, same id set, and identical field values on a sample. Where the export publishes `latest.manifest.json`, the same **run** as well: the manifest is resolved once, every artifact it names is verified against the full sha256 it records, and the alias bytes are hashed against those digests. Without a manifest, run identity cannot be established at all — no run identifier is served, so two same-day runs carrying the same records are indistinguishable — and the check says so rather than inferring it. |

## Two things worth knowing about how it is built

**Nothing about a particular host, domain or dataset size is hard-coded.** The operations executed,
their parameters, the accepted values and the error contract are all read out of the OpenAPI
document the deployment publishes, and the status/funding-type value sets out of the schema it
serves; the page size comes from the documented maximum. The only numbers carried are the
milestone's own floors (`--min-total`, `--freshness-hours`), and those are flags. The well-known
entry points the milestone itself names — `/v1/health`, `/v1/docs/json`, `/v1/stats`,
`/v1/opportunities` (+ `/schema`, + `/{id}`) and `latest.json` / `latest.csv` /
`latest.manifest.json` / `LICENSE` under the export root — are fixed: they are the bootstrap that
finds the published document in the first place, and one of them cannot be discovered from itself.
That is what makes the tool runnable against a local instance today and against the deployment on
the day it exists.

**"Every document validates against the Standard" needs both endpoints.** The list endpoint serves
`OpportunitySummary`, a server-controlled projection that deliberately omits `fundingDetails` —
which the Standard *requires*. So a list item is held to the projection the service publishes for
it, and the full document behind every listed id is fetched from the detail endpoint and validated
against the Standard itself. Validating only the summaries would be validating a shape the Standard
never describes.

## What it deliberately does not do

- **It issues read-only requests.** A published non-`GET` operation is reported as `skip` with that
  reason, never as a pass. The `/v1/` surface is read-only today, so nothing is skipped in practice.
- **It does not schema-validate an XML response, and does not pretend to.** A JSON Schema describes
  a JSON value, and Atom and RSS are defined by RFC 4287 and the RSS 2.0 specification rather than
  by anything this API publishes. Those responses are held to everything that still applies —
  documented status, declared content type, non-empty body, and a well-formedness parse, which is
  what catches the failure that actually happens (an escaping bug still answers `200` with the right
  content type) — and the check reports which half it verified and which did not apply.
- **It does not grade the published document's own style**, only whether live responses conform to
  it. A relative `servers[0].url` (what an unset `PUBLIC_BASE_URL` leaves behind) is a warning
  rather than a failure, because it is correct wherever the document is fetched from — but a
  deployed service should publish its own absolute origin.
- **It does not require a particular export layout.** A published `latest.manifest.json` is what
  lets run identity be *verified* — one run id over immutable, digest-recorded artifacts. Where the
  export root has none, the run reports a named limitation (a pre-manifest deployment) rather than
  inferring identity it cannot have, and falls back to the digest-named-archive probe. That probe
  establishes only that each alias's bytes name a published archive stamped with the envelope's own
  date, which rules out a cross-day mixed pair; it cannot distinguish two runs on the same date, and
  under an exporter whose CSV is byte-stable across same-day reruns the CSV half cannot distinguish
  them even in principle.
- **`skip` is never a `pass`, and a criterion nothing could be checked in is never a sign-off.** A
  check the run could not perform says so, with the reason, and the summary counts it separately. A
  criterion in which *every* check was skipped — or in which none ran at all — is reported as
  `INCOMPLETE` and exits non-zero: nothing failed, but nothing was established either, and those are
  not the same answer. A skipped check inside a criterion that *was* exercised stays green (the
  loopback TLS probe is the real case) but is still counted in the headline, so a pass never hides
  it. A sign-off tool that quietly reports "I could not check this" as "this is fine" is worse than
  no tool.

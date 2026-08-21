---
"@the-rfp-hub/api": minor
---

Milestone 3: the authenticated write surface, and the machinery that keeps it honest.

**Identity and credentials.** Sign-in is an email one-time code; the session it mints is an opaque
token signed with an HMAC that is checked before any database read, and stored as a ROW — so
revocation is real and immediate, and accounts hang off the auth identity rather than anything a
request self-asserts. API keys are
`rfph_<prefix>_<secret>`, SHA-256 hashed, shown once, soft-revoked, rotated by create-then-revoke.
A global role never elevates an API key: publication always needs the `publish` scope, and key
management, `PATCH /v1/me`, review and administration are session-only.

**Writes.** `POST`/`PUT /v1/opportunities` validate with the Standard's own reference
implementation and return humanized errors; the server owns every provenance attribution field;
`<namespace>:<local>` ids are enforced; an identical repeat returns the original rather than a
conflict. A submission may create an organisation directory stub but can never overwrite a verified
one's branding.

**Claims, review and administration.** `/v1/opportunities/:id/claim` grants immediately only to a
verified organisation that OPERATES the entry — sponsorship is not operation — and queues otherwise.
Reviewers approve, reject, verify organisations, manage memberships and merge duplicates;
administrators assign roles, grant direct-create and start maintenance jobs.

**Provenance.** One generalized append-only `audit_log`, enforced by a database trigger rather than
by convention, recording which key acted and not merely which account. Semantic duplicate detection
over pgvector with an injectable provider, so the tests run in CI without a vendor key. An
SSRF-hardened source verifier that pins the validated address through the connection and stores the
extracted text plus a digest of the original bytes.

**Insights.** Server-side capture only — there is no public beacon, because an unauthenticated event
endpoint lets anyone fabricate a publisher's numbers. Hashes are keyed HMACs whose input includes
the UTC date, this project's own automation is excluded by name, and the numbers are labelled
best-effort everywhere they appear.

**Maintenance jobs.** Five jobs behind one catalogue and one result shape, run as one-off container
tasks by a scheduled workflow — no public job endpoint and no shared job token. `staleness` closes
past-due entries and long-inactive ones, including rolling-only listings nobody has re-asserted for
ninety days. Concurrency is excluded by `pg_try_advisory_lock` on a dedicated connection, and the
open-data export is designed to chain on the maintenance run's success rather than on a clock
seventeen minutes behind it — a flip that lands once every deployed image carries the jobs runner,
so the publication never gates on a task the older image cannot start.

New public surfaces: `GET /v1/publishers`, `GET /v1/r/:id/apply|source`, and the entry sub-resources
`/audit`, `/duplicates` and `/verification`.

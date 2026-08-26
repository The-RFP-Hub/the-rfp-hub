# 0010. Centralize outbound email and dispatch duplicate notifications

- **Status:** accepted
- **Deciders:** project maintainers
- **Date:** 2026-08-26
- **Supersedes:** the email deferral in [0009](./0009-land-duplicate-notifications-in-app-first.md)

## Context and problem statement

ADR 0009 persisted privacy-filtered duplicate notifications and provisioned delivery timestamps,
but deferred email. Milestone 3 now requires email. The API already had seven email transports for
Better-Auth OTP messages, owned by an auth-specific module and called directly. A dispatcher also
needs an identity-table address join, absolute frontend links, retry behavior, and a durable
backstop for an immediate best-effort trigger.

## Decision drivers

- Provider and local-test transport behavior must have one owner for every sender.
- Domains must own their language and preserve the privacy decision already stored in the payload.
- Provider I/O must not block duplicate mutation and sign-in response paths.
- Expected provider failures must be retryable, bounded, observable, and migration-free.
- Expected email-provider refusals must be recorded without failing the nightly export chain.

## Considered options

1. **Central port, domain composer, cursor dispatcher** — reuse the notification row as the queue.
2. **Call transports directly from each domain** — let auth and notifications build parallel paths.
3. **Trigger after duplicate mutations commit** — enqueue immediate best-effort provider I/O.
4. **Add an attempts column or delivery table** — migrate explicit retry state into the schema.

### Option 1 — central port, domain composer, cursor dispatcher

- Good, because transport choice, envelope sender and failure mapping have one implementation.
- Good, because duplicate copy can consume the emission-time privacy-filtered payload unchanged.
- Good, because existing timestamps and JSON can hold bounded delivery state without a migration.
- Bad, because send and database stamp cannot share one transaction, leaving a narrow duplicate-send
  window if the process exits after provider acceptance and before the success update.

### Option 2 — direct transport calls

- Good, because it adds fewer abstractions to the first notification sender.
- Bad, because every future domain would relearn provider selection, expected failures and test
  transports, while OTP would remain a privileged parallel path.

### Option 3 — post-commit in-process trigger

- Good, because ordinary delivery begins when the duplicate event happens rather than waiting for a
  scheduled process.
- Good, because a bounded fire-and-forget queue keeps provider latency and failure out of the
  response while the committed notification remains the retry state.
- Bad, because process loss or queue overflow can defer an attempt until the nightly backstop.

### Option 4 — new retry schema

- Good, because attempts and errors would have dedicated columns or rows.
- Bad, because three bounded attempts need only the already-existing timestamps plus internal JSON,
  and a new table would create migration and retention policy without improving this delivery scale.

## Decision outcome

Choose the layered design in option 1 with the immediate trigger topology in option 3.
`OutboundEmailPort.send({to, subject, text})` is the application seam and returns
`sent` or `failed`; `EmailService` alone constructs and calls the configured transport. Better-Auth's
OTP callback now uses that port while retaining its deliberately detached send and redacted failure
logging. Duplicate email is composed in the notifications domain and sent through the same port.

The composer trusts the stored payload's privacy boundary: it names `otherListing` only when that
member already exists and calls any actor only `reviewer`. Copy describes possible matches and
review workflow state, never treats similarity as proof. Links use a required production
`APP_BASE_URL`, distinct from the API's `PUBLIC_BASE_URL` and the multi-origin `TRUSTED_ORIGINS`.

`notification-dispatch` joins `notifications.account_id -> accounts.auth_user_id -> auth_user.email`
at send time; no second address copy is stored. It selects undelivered rows in batches. A provider
failure stamps `email_failed_at` and private payload state `{attempts, failure}`. It retries after a
five-minute floor, up to three attempts total. A missing identity email is stamped once with
`recipient_unavailable` and made terminal. Success stamps `email_dispatched_at`, clears the failure
timestamp and removes retry metadata. Account-facing notification serialization strips that
operational member.

After the transaction that inserts notification rows commits, the API enqueues those newly inserted
ids into a bounded, reject-newest in-process queue. Its worker calls the same dispatcher logic with
an id scope and never blocks or throws into the request. If email is not configured, it takes the
same skipped/no-op path as the job. The database columns remain the source of truth: process loss or
queue overflow leaves rows undispatched rather than losing the event.

The dedicated hourly workflow is removed. `notification-dispatch` remains a cursor job with its own
advisory lock and now runs once daily in the independent matrix of `jobs-nightly.yml`, alongside the
other bounded 30-minute nightly lanes. It is a backstop for missed immediate attempts and preserves
the three-attempt cap and five-minute retry floor. Expected provider refusals are recorded as row
state, not thrown as workflow failures.

## Consequences

- **Good:** OTP and notification domains share one sending seam and all local transports.
- **Good:** a rerun after a normal success sends nothing, while temporary failures retry within a
  documented bound and orphans cannot crash or spin the job.
- **Good:** ordinary notification email is attempted at event time without provider I/O becoming
  part of request latency; the nightly family supplies the durable catch-up path without another
  schedule or runner.
- **Good:** email cannot widen an in-app payload's counterpart or reviewer visibility.
- **Bad:** delivery is at-least-once around the provider/stamp boundary; a crash in that narrow gap
  may send the same notification again on retry. Exactly-once external email is not available from
  a database transaction.

  *Annotation (2026-08-26).* Two things sharpen this. **First, `transport_failure` is ambiguous.**
  A refusal we can name is one thing; a timeout is another — the provider may have accepted the
  message and answered too slowly, so the retry that follows is a second delivery of mail that
  already went out. The retry bound is therefore a bound on *duplicates*, not only on wasted
  attempts, and nothing short of a provider-side idempotency key changes that. **Second, the gap
  is now narrow on purpose rather than by luck.** A dispatcher leases its rows in the statement
  that selects them (`UPDATE … FOR UPDATE SKIP LOCKED`, attempt counted and `email_failed_at`
  stamped before the send), so concurrent dispatchers — the in-process queue and the nightly job —
  can no longer both claim one row. The claim is an OWNERSHIP TOKEN as well as a deadline, renewed
  immediately before each send and required by every stamp, because a batch that sends serially can
  outlive its own five-minute floor; and `ses` and `resend` abandon a single call after 30 seconds,
  as `mailgun` already did, so one hung provider cannot be what makes it happen. What remains is
  exactly the crash-in-the-gap case named above, and a lost dispatcher now spends one of the three
  attempts instead of holding the row forever.
- **Bad:** retry metadata is internal JSON rather than a query-friendly column. A future delivery
  analytics product should introduce a dedicated attempt table instead of growing that object.
- **Neutral:** dispatch timestamps remain operational telemetry and do not add an audit enum value.

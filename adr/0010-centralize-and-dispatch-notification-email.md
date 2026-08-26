# 0010. Centralize outbound email and dispatch duplicate notifications

- **Status:** accepted
- **Deciders:** project maintainers
- **Date:** 2026-08-26
- **Supersedes:** the email deferral in [0009](./0009-land-duplicate-notifications-in-app-first.md)

## Context and problem statement

ADR 0009 persisted privacy-filtered duplicate notifications and provisioned delivery timestamps,
but deferred email. Milestone 3 now requires email. The API already had seven email transports for
Better-Auth OTP messages, owned by an auth-specific module and called directly. A dispatcher also
needs an identity-table address join, absolute frontend links, retry behavior, and isolation from
the nightly export gate.

## Decision drivers

- Provider and local-test transport behavior must have one owner for every sender.
- Domains must own their language and preserve the privacy decision already stored in the payload.
- Provider I/O must remain off duplicate mutation and sign-in response paths.
- Expected provider failures must be retryable, bounded, observable, and migration-free.
- An email outage must not stop open-data publication.

## Considered options

1. **Central port, domain composer, cursor dispatcher** — reuse the notification row as the queue.
2. **Call transports directly from each domain** — let auth and notifications build parallel paths.
3. **Send during duplicate mutations** — make the request wait for the provider.
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

### Option 3 — request-path delivery

- Good, because the initiating request immediately knows whether the provider accepted the send.
- Bad, because provider latency and failure would enter both duplicate mutations and the OTP
  anti-enumeration boundary; a committed notification still needs later retry state.

### Option 4 — new retry schema

- Good, because attempts and errors would have dedicated columns or rows.
- Bad, because three bounded attempts need only the already-existing timestamps plus internal JSON,
  and a new table would create migration and retention policy without improving this delivery scale.

## Decision outcome

Choose option 1. `OutboundEmailPort.send({to, subject, text})` is the application seam and returns
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

The dispatcher has its own advisory lock and hourly workflow. It is not part of
`jobs-nightly.yml`, whose success gates the dataset export.

## Consequences

- **Good:** OTP and notification domains share one sending seam and all local transports.
- **Good:** a rerun after a normal success sends nothing, while temporary failures retry within a
  documented bound and orphans cannot crash or spin the job.
- **Good:** email cannot widen an in-app payload's counterpart or reviewer visibility.
- **Bad:** delivery is at-least-once around the provider/stamp boundary; a crash in that narrow gap
  may send the same notification again on retry. Exactly-once external email is not available from
  a database transaction.
- **Bad:** retry metadata is internal JSON rather than a query-friendly column. A future delivery
  analytics product should introduce a dedicated attempt table instead of growing that object.
- **Neutral:** dispatch timestamps remain operational telemetry and do not add an audit enum value.

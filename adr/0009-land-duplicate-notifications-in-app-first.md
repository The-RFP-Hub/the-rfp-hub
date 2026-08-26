# 0009. Land duplicate notifications in-app first

- **Status:** accepted; email deferral superseded by [0010](./0010-centralize-and-dispatch-notification-email.md)
- **Deciders:** project maintainers
- **Date:** 2026-08-26
- **Supersedes:** —

## Context and problem statement

Duplicate detection already returned possible matches to the client that submitted a listing, and
reviewers could later confirm, dismiss, merge, or reopen a pair. That synchronous response was
temporary: an owner who left the request had no durable place to learn that a pair was created or
that a reviewer later acted on it. Milestone 3 therefore requires a duplicate submission to trigger
a notification flow.

The event carries a privacy boundary. A pair may contain a pending or unlisted submission that an
unrelated owner must not be able to identify. Reviewer identities are also editorial information,
while the useful fact for an owner is that a reviewer acted. Email was requested as a possible
delivery channel, but its recipient-policy and failure-handling decisions have not yet been made.
Webhooks would add a third-party delivery contract that this milestone does not need.

## Decision drivers

- Owners need a durable inbox for both detection and later reviewer actions.
- A mutation and the notification describing it must commit or roll back together.
- Re-detection and repeated reviewer requests must not produce duplicate messages.
- Notification payloads must not disclose pending or unlisted counterpart titles or reviewer
  identities.
- A later email dispatcher should not require another production schema migration.
- This milestone has no consumer asking for a webhook contract or its delivery guarantees.

## Considered options

1. **In-app first** — persist account-scoped events now; defer email policy and reject webhooks.
2. **In-app and email together** — define both delivery channels in one release.
3. **Webhook/outbox delivery** — publish duplicate events to owner-configured endpoints.
4. **Keep response-only feedback** — continue returning matches only to the submitting request.

### Option 1 — in-app first

- Good, because it satisfies the durable notification criterion without depending on mail-provider
  configuration or unresolved email policy.
- Good, because the database transaction can cover both the domain mutation and inbox insert.
- Good, because structured payloads can enforce one privacy rule before any presentation layer sees
  the event.
- Bad, because owners receive no off-site prompt and must visit the Hub to see an update.

### Option 2 — in-app and email together

- Good, because an owner can learn about an event without returning to the Hub.
- Good, because both channels could begin with one shared event vocabulary.
- Bad, because recipient batching, retry behavior, opt-out policy, and what an email may reveal are
  unresolved maintainer decisions. Guessing them here would make the in-app criterion wait on a
  different product decision.
- Bad, because provider I/O cannot participate in the database transaction; reliable delivery would
  require a separate dispatcher and retry contract.

### Option 3 — webhook/outbox delivery

- Good, because organizations could route events into their own systems.
- Bad, because endpoint authentication, signing, retries, ordering, secret rotation, and delivery
  observability become a public integration contract.
- Bad, because no milestone requirement or identified consumer justifies that operational surface.

### Option 4 — keep response-only feedback

- Good, because it adds no storage or account surface.
- Bad, because it cannot report decisions made after submission and disappears when the request
  ends, so it does not satisfy the notification criterion.

## Decision outcome

**Chosen: Option 1 — persist duplicate notifications in-app first.** The pair insert, decision,
merge, or reopen and every corresponding notification are written in the same database transaction.
Only a newly inserted suspected pair emits: `INSERT … ON CONFLICT DO NOTHING RETURNING` expresses
that intent, while a unique key on `(account_id, kind, subject_kind, subject_id)` is the final
idempotency guard.

Recipients are accounts that own either side by direct submission or by membership in its stored
publisher namespace. Recipient sets are collapsed, so an account that owns both sides—or a reviewer
who also owns a side—receives one event of a given kind for the pair. Review capability by itself is
not a reason to receive owner notifications.

Payloads store facts, not sentences. They name the recipient's listing, the pair and similarity,
the available action and relative link, and coarsen an acting account to `decidedBy: "reviewer"`.
The other side's id and title are included only when it is both approved and listed at emission
time; otherwise presentation says only “another submission.” Cautious language such as “looked
similar to” lives in the frontend vocabulary layer, not in persisted JSON.

Email dispatch is deferred. `email_dispatched_at` and `email_failed_at` are provisioned now so the
event table does not need another migration when maintainers decide the email recipient and retry
policy. No code in this decision sends email. Webhooks are rejected for this scope.

## Consequences

- **Good:** owners can read and settle a newest-first inbox, and the signed-in chrome can show an
  unread count without polling.
- **Good:** a committed mutation cannot be missing its notification, and a rolled-back mutation
  cannot leave a false notification behind.
- **Good:** privacy is fixed at emission time; a non-public counterpart cannot leak through stored
  notification data or later copy changes.
- **Bad:** notification writes add recipient-resolution queries and inserts to duplicate mutations,
  increasing their transactional work.
- **Bad:** the unique event key intentionally permits only one row per account/kind/pair. If a future
  product wants a chronological message for every repeated transition, it will need a different
  event identity rather than weakening this key silently.
- **Bad:** the pre-provisioned email timestamps are unused until the follow-up lands and do not by
  themselves define whether a null value means pending, ineligible, or deliberately suppressed.
- **Neutral:** notification rows cascade with their account; they are operational inbox state, not
  the append-only audit trail.

## Follow-ups

- Maintainers must settle email recipient/eligibility and dispatch/retry semantics before a second
  PR writes either email timestamp.
- If a real webhook consumer emerges, make its authentication and delivery guarantees a separate
  ADR rather than treating the in-app table as an implicit public outbox.

# 0011. Make repositories own all database access

- **Status:** accepted
- **Deciders:** project maintainers
- **Date:** 2026-08-26
- **Supersedes:** —

## Context and problem statement

Database access has accumulated directly in API services and one controller. Those files import
Drizzle operators and schema tables, compose queries, and open transactions alongside business
rules. Review has not kept that boundary stable: the current tree contains a large, explicit set of
such call sites across unrelated domains.

That drift also produced a connection-pool deadlock class. A service opened a transaction with the
pool-backed client, then called a helper bound to that same client. The transaction held one pooled
connection while the helper requested another. Enough concurrent callers can hold every bounded
pool connection and wait forever for the extra reads; the pool has no connection-acquisition
timeout by default. Passing the transaction to the two known helpers fixes those instances, but it
does not make future nested pool reads structurally impossible.

The API was already shipped and the migration spanned many domains, so the boundary became
enforceable before all existing query sites moved. The incremental ratchet has now reached its
final dependency shape: zero production offenders outside repositories and the permanent database
implementation locations.

## Decision drivers

- A service must be unable to import Drizzle, import a schema table as a value, or open a database
  transaction without a database-independent test failing.
- Every query inside an atomic operation must use the executor for the connection that operation
  already holds.
- Transaction scope must be visible in composition and testable without process-local hidden state.
- Existing domains must be migratable in small changes while new database-access drift is blocked
  immediately.
- Repository ownership must remain legible when one query joins more than one aggregate.

## Considered options

1. **Repository bundle plus unit of work** — bind lazy repositories to a pool or transaction
   executor, and expose only the bundle to transaction callbacks.
2. **Explicit executor as the first repository-method parameter** — callers pass `db` or `tx` on
   every query method call.
3. **AsyncLocalStorage executor** — store the active transaction executor in asynchronous context.
4. **Status quo plus review** — continue querying from services and rely on reviewers to preserve
   transaction affinity.

### Option 1 — repository bundle plus unit of work

- Good, because the bundle makes data dependencies explicit and gives services one stable shape in
  and out of transactions.
- Good, because `withTransaction(db, run)` can expose repositories bound to `tx` without ever
  exposing `tx`, closing the nested pool-read bug class by construction.
- Good, because lazy getters avoid constructing every domain repository for a service that needs
  only one.
- Bad, because it adds a repository call between service policy and Drizzle and requires repository
  ownership decisions for cross-aggregate joins.

### Option 2 — explicit executor-first repository methods

- Good, because the executor is visible at every call site and repository instances can be
  stateless.
- Bad, because services still receive and choose between the pool and transaction handles. A nested
  call can pass `this.db` instead of `tx`, so this does not close the pool-read bug class.
- Bad, because database execution details remain threaded through business APIs.

### Option 3 — AsyncLocalStorage executor

- Good, because existing method signatures need little transaction plumbing.
- Bad, because transaction behavior depends on invisible process-local context rather than an
  explicit dependency.
- Bad, because detached work and tests must reproduce context propagation correctly, and a missing
  context silently falls back to the most dangerous executor.

### Option 4 — status quo plus review

- Good, because it adds no layer or migration work.
- Bad, because this is the process that produced both widespread boundary drift and the confirmed
  transactional pool-read defect.
- Bad, because reviewers must rediscover a non-local connection-affinity invariant at every helper
  call.

## Decision outcome

**Chosen: Option 1 — repository bundle plus unit of work.** Repositories own all database reads,
writes, Drizzle imports, schema-table value imports, and transaction composition. Services compose
repositories and enforce domain rules; controllers own HTTP; mappers remain pure.

`repositories(exec)` returns a lazy `Repositories` bundle bound to either the shared pool client or
one transaction executor. `withTransaction(db, run)` opens the transaction and calls `run` with
only that executor-bound bundle, never the raw transaction. A service therefore cannot escape to a
pool read while an atomic operation holds a connection unless it violates the guarded import
boundary first.

The filesystem guard permanently permits database implementation details only in `src/db/**`,
`src/modules/repositories/**`, the Better-Auth adapter configuration, the two database bootstrap
scripts, Drizzle configuration, and tests. The temporary allowlist is empty and its ceiling is
zero. Any production offender outside those permanent locations fails the guard.

The completed bundle contains 14 lazy repositories: accounts, API keys, audit, analytics, claims,
duplicate pairs, embeddings, membership invites, memberships, notifications, opportunities,
organizations, system operations, and verification runs. Services contain zero Drizzle imports,
runtime schema-table imports, or transaction calls.

Each cross-aggregate join has one repository owner: the aggregate whose result or invariant the
query serves. If ownership is ambiguous, the implementing change must document the choice instead
of creating an unowned shared-query bucket.

## Consequences

- **Good:** transaction callbacks can reach the database only through repositories bound to their
  held connection, eliminating the known nested pool-acquisition pattern.
- **Good:** a filesystem-only unit test enforces the dependency direction without `DATABASE_URL`.
- **Good:** services become testable against domain-shaped repository fakes rather than Drizzle
  builder-shaped database fakes.
- **Bad:** the completed migration introduced 14 repository files and moved existing query code;
  that was real review surface even where SQL behavior remained identical.
- **Bad:** every database operation gains one indirection through a repository method.
- **Bad:** cross-aggregate joins require an explicit owner, and maintainers must resolve genuinely
  ambiguous cases rather than placing them in whichever service first needs them.
- **Neutral:** the R0 scaffold and ratchet changed no endpoint behavior; the exact allowlist was
  reduced to zero as each domain migrated.

## Completion

- The temporary allowlist was migrated domain by domain without changing service behavior.
- All 14 domain and system repositories are present in the lazy bundle.
- `TEMPORARY_ALLOWLIST` is empty and `TEMPORARY_CEILING` is zero; the ratchet is now the permanent
  invariant.
- Cross-aggregate queries have explicit repository owners, including system ownership of readiness
  and dataset-snapshot bookkeeping.

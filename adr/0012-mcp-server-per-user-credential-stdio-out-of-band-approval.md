# 0012. Ship the MCP server as stdio, on the user's own credential, with the write approval out of band

- **Status:** accepted
- **Deciders:** project maintainers
- **Date:** 2026-08-27
- **Supersedes:** —

## Context and problem statement

The project ships an MCP server so that an agent can search the funding corpus and, when a person
wants it to, submit an opportunity. Three things about that make it a security decision rather than
a packaging one.

First, **who the credential belongs to**. The write endpoints authenticate an account. An MCP
server that writes therefore has to hold, or be able to obtain, a credential — and the answer to
"whose?" determines everything downstream. A hosted server holding one shared credential makes
every submission indistinguishable at the API and gives one compromise the whole corpus. A hosted
server holding *each user's* credential needs an authorization service, a token store, and a
revocation story — a new, long-lived, high-value surface.

Second, **the content is untrusted and the tool set contains a write**. Every title, summary and
description in the corpus was written by somebody else. An agent that reads a poisoned record and
holds a tool that can publish closes the loop between untrusted input and an outbound effect. That
is the whole of the risk, and it does not require anybody to be careless: the record looks like
data right up until the model treats it as an instruction.

Third, **the protocol moved under us**. The `2026-07-28` revision is a rewrite: stateless, no
`initialize` handshake, no session id, and elicitation replaced by multi-round-trip requests.
Client support for the interactive parts is inconsistent — several major clients do not implement
the confirmation primitive at all. Any design that put the human confirmation on an optional
protocol feature would fail *open* on the clients that do not have it, which is the worst possible
failure direction for the one tool that writes.

The constraint that shaped the answer: this is an eight-day milestone on an already-shipped API,
with a runtime container image that copies three packages and a public CORS policy that allows two
headers. Nothing here had the room to grow an authorization service.

## Decision drivers

- A submission must be attributable to a real account, and revoking one person's access must not
  affect anybody else's.
- A poisoned search result must not be able to produce a published entry without a person having
  seen where it was going.
- Reads are public data and must not require, or transmit, any credential.
- The human confirmation must not depend on an optional client feature: a client that lacks it must
  fail closed, not silently skip the step.
- The write tool must be absent, not merely refusing, for anyone who has not turned it on.
- Whatever is claimed about the interlock must be *true* under the threat model actually in play,
  where an agent commonly holds a shell as the same user.
- The transport choice must not force a change to the runtime image, the CORS policy or the deploy
  checker inside this milestone.

## Considered options

1. **stdio, per-user credential from the environment, human approval out of band** — the server
   runs on the user's machine, reads the key from the client's env block, and the write is unlocked
   by a file a person creates from a terminal.
2. **Hosted HTTP server with a shared credential** — one deployment, one key, everybody's writes.
3. **Hosted HTTP server with per-user authorization** — a separate OAuth/OIDC service issuing
   scoped tokens, with dynamic client registration and a scope for writes.
4. **stdio, but with the confirmation inside the MCP channel** — a preview mints a confirmation
   token bound to a hash of the input and returns it to the caller; the commit presents it back.

### Option 1 — stdio, per-user credential, out-of-band approval

- Good, because the credential never leaves the machine of the person it belongs to. There is no
  server to breach and no store to leak.
- Good, because attribution is exact: the API sees the account whose key it is.
- Good, because `npx` is the whole installation, on every client that speaks stdio.
- Good, because the approval does not depend on any protocol feature, so it behaves identically on
  a client that implements nothing beyond tools.
- Good, because the write tool is *not registered* without an explicit flag, so a poisoned result
  has no write tool to reach for rather than a write tool that says no.
- Bad, because the approval is not isolated from an agent that holds a shell as the same user. See
  the trust assumption below; this is the cost, and it is real.
- Bad, because each user has to mint and configure their own key.
- Bad, because there is no central place to observe or throttle usage — the caps are local files.

### Option 2 — hosted, shared credential

- Good, because there is nothing for a user to configure.
- Bad, because every submission is attributed to one account, so the API cannot tell whose it was,
  cannot rate-limit one abuser without limiting everyone, and cannot revoke one.
- Bad, because one credential compromise is a corpus-wide compromise.
- Bad, because the threat model for this project explicitly lists a shared MCP credential among the
  things not to build.

### Option 3 — hosted, per-user authorization service

- Good, because it is the right shape for a genuinely multi-tenant remote server.
- Bad, because it solves *remote multi-tenant authorization* — a problem this design does not have.
  With the user's own key in their own environment there is no tenant to authorize.
- Bad, because it is weeks of work and a new long-lived credential surface, and the milestone has
  eight days.
- Bad, because it would additionally require changing the runtime image, the public CORS policy and
  the deploy checker to mount an HTTP MCP endpoint at all.

### Option 4 — confirmation token inside the MCP channel

- Good, because binding the commit to a hash of the previewed input is genuinely valuable: the
  commit cannot execute a different input than the one that was shown. That property is kept.
- Bad, because it is not consent. The token comes back in the tool's own response, which puts it in
  the model's context, and the same model can spend it in the same turn. Nobody outside the loop
  ever saw anything. Calling that "human in the loop" would be the kind of claim that gets believed
  and then relied on.

## Decision outcome

**Chosen: Option 1** — stdio only, the credential read from the environment and never from a tool
argument, reads anonymous, the write tool unregistered unless explicitly enabled, and the write
unlocked only by an approval created outside the MCP channel.

Option 4's input-binding is **kept and strengthened**, because it is necessary but not sufficient.
The identifier is a hash over **five** components rather than over the document alone:

| Component | Why it is bound |
|---|---|
| Destination origin | An approval given against staging must not spend against production. |
| Credential fingerprint | A non-reversible 8-hex prefix of the key's SHA-256. An approval given under one key must not spend under another. It is a hash prefix, not a key prefix, so no key material reaches the file, the terminal or the log. |
| Operation | So one operation's approval cannot unlock another. |
| Protocol revision | So an approval granted by one build cannot be spent by a build speaking a different revision. |
| Document hash | SHA-256 over the canonical (sorted-key) form, so the same document round-tripped through a different client still matches. |

The identifier is **public** and no secret is ever returned to the caller. The terminal prints all
five before asking. The approval is claimed by an atomic `rename()` **before** the request, so it
is single-use even when the response never arrives, and it is **never restored** afterwards — after
a timeout the honest state is "may have been written", and restoring the approval would invite a
second write.

The transport stays **stdio**, and the internal structure keeps it replaceable: tool registration,
policy and execution live in modules that know nothing about a transport, so an HTTP entry point is
a new file rather than a refactor. Discovery documents and the precedence-ordered auth chain are
deferred with it — both only mean anything over HTTP.

### A fourth, internal rate-limit kind: `attempt`

The metered kinds a caller can reason about are `read`, `preview` and `commit`, one per phase of
work that actually happened, and only an executed `POST` spends `commit`. That leaves the refusal
path unmetered: a caller can send a thousand bogus approval ids, a thousand oversized documents or
a thousand malformed argument objects, and each is refused after a walk through local validation
and the filesystem without spending anything.

`attempt` closes that. It is **not a phase** and it is not part of the contract a client reads: it
is an internal abuse-control meter, charged once on every invocation of the write tool — including
one rejected by argument validation before the handler runs — at 20 per minute and 400 per day,
looser than `preview` and far tighter than `read`. Running out of it never masks the real error:
the caller's arguments are still wrong, and answering `rate_limited` would send them to fix the
wrong thing, so the charge is best-effort and the original refusal is what comes back.

It is recorded here, and in the package README, because it appears in the audit log's `kind` field
and in the counter file, so anyone reading either would otherwise find a kind no document explains.
The invariant it must not disturb — and a test asserts this — is that a refused commit spends
`attempt`, never `commit`.

### The trust assumption, stated explicitly

**The approval is outside the MCP channel. It is not isolated from an agent holding a shell and a
filesystem as the same operating-system user.** Coding agents commonly hold both. Such an agent can
run the approval command in a pseudo-terminal, or write the file directly. `0600` and `0700`
permissions do not prevent that, because it *is* that user.

What the design does buy is that approving leaves the tool channel and becomes a deliberate act at
a terminal, in front of a screen showing where the write is going and under which credential — and
that no response the model receives ever carries a spendable secret.

Nothing in this repository — code, README or this ADR — may state or imply that the model cannot
approve. The boundaries that would genuinely be separate are all outside this package: an approval
UI provided by the host application, a distinct OS identity for the agent's process, a signing key
the agent's process cannot reach, or the protocol's own multi-round-trip confirmation once clients
converge on it. Those are post-milestone work, recorded here so the gap is a known one.

## Consequences

- **Good:** no shared credential, no hosted credential store, no new authorization service. One
  user's compromise is one user's compromise.
- **Good:** search works with no configuration at all, because reads send nothing.
- **Good:** the write tool is absent from `tools/list` for anyone who has not enabled it, which is
  a stronger property than a registered tool that refuses.
- **Good:** an approval cannot be moved between destinations or credentials, and a refusal names
  which component moved rather than saying only "no".
- **Bad:** the interlock's strength depends on the agent's process not being able to act as the
  user — an assumption that is false for many agents today. Everyone who relies on this needs to
  understand that, which is why it is written in the README as well as here.
- **Bad:** each publisher must mint and configure their own key, and support questions about
  configuration land on the maintainers.
- **Bad:** rate-limit counters are per-machine files. They fail closed, but they are not a
  server-side control and they do not aggregate across machines.
- **Neutral:** the server keeps ephemeral local state (approvals, counters, an audit line per
  call). It is not "stateless", and this ADR deliberately avoids that word for it. Because that
  state carries security decisions, its container is verified rather than assumed: the home must be
  a real directory at `0700`, state files must be regular files at `0600` with no second hard link,
  and approvals and counters refuse when that cannot be established.
- **Neutral:** a fourth rate-limit kind, `attempt`, exists for abuse control. See above.
- **Neutral:** no remote transport means no discovery documents and no `WWW-Authenticate`
  challenge — they would be answering questions nobody can currently ask.

## Follow-ups

- Streamable HTTP transport, with its own ADR, covering the runtime image, the CORS policy and the
  deploy checker — none of which this decision touches.
- Discovery documents and precedence-ordered authentication, alongside that transport.
- Multi-round-trip confirmation offered **in addition to** the terminal path once client support is
  consistent enough that it can be relied on. Never instead of it: an interlock that depends on an
  optional feature fails open where the feature is missing.
- A shared rate-limit store, if the local per-machine counters ever prove insufficient.
- Confirm the registry namespace casing (`io.github.the-rfp-hub`, lowercase, against a GitHub
  organization spelled `The-RFP-Hub`) with `mcp-publisher` before the first publish. The manifest
  itself is no longer an open question: the registry's published schema (2025-12-11) is vendored
  under `packages/mcp/test/fixtures/` and `server.json` is validated against it in CI, which is
  also what settled that the publisher-defined `_meta` key is permitted.

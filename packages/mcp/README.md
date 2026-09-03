# @the-rfp-hub/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[RFP Hub](https://github.com/The-RFP-Hub/the-rfp-hub) — search Ethereum-ecosystem funding
opportunities (grants, hackathons, bounties, accelerators, VC funds, RFPs) from any MCP client, and
optionally submit one, with a human approval step that lives outside the tool channel. MIT licensed.

Search is **anonymous**: no credential, no account, nothing to configure beyond the client entry.
A credential is needed only to submit, and only when submitting is explicitly turned on.

---

## Install

Every example below pins an **exact version**. An npm version is immutable; `@latest` is not, and
an MCP server is code your agent runs with your permissions. Pin it, and bump it deliberately.

### Claude Code

```sh
claude mcp add --transport stdio rfp-hub -- npx -y @the-rfp-hub/mcp@0.1.0

# project-scoped instead of user-scoped — writes .mcp.json in the repo
claude mcp add --scope project --transport stdio rfp-hub -- npx -y @the-rfp-hub/mcp@0.1.0
```

### Claude Desktop and Cursor

Root key `mcpServers`, in `claude_desktop_config.json` or `.cursor/mcp.json`:

```jsonc
{
  "mcpServers": {
    "rfp-hub": {
      "command": "npx",
      "args": ["-y", "@the-rfp-hub/mcp@0.1.0"]
    }
  }
}
```

### VS Code

Root key `servers`, in `.vscode/mcp.json`:

```jsonc
{
  "servers": {
    "rfp-hub": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@the-rfp-hub/mcp@0.1.0"]
    }
  }
}
```

### Codex CLI

```sh
codex mcp add rfp-hub -- npx -y @the-rfp-hub/mcp@0.1.0
```

---

## Companion skill

`funding-search` is a **read-only** agent skill that teaches a client how to use this server's
search and fetch tools well. It is **not shipped inside this npm package** — it installs from the
repository, through whichever of these channels your client supports:

```sh
npx skills add The-RFP-Hub/the-rfp-hub --skill funding-search
```

```sh
claude plugin marketplace add The-RFP-Hub/the-rfp-hub
```

Or copy the skill directory manually into `.claude/skills/`, `.agents/skills/` (Codex), or
`.gemini/skills/`.

---

## Configuration

Two environment variables and one flag. A variable is for a **secret** — which must never sit on
`argv`, where every process on the machine can read it — or for the **identity of the deployment**.
Everything else is a flag or a fixed constant, so that running this server needs nothing from
whoever administers your environment.

| Variable | Default | What it does |
|---|---|---|
| `RFPHUB_API_BASE` | `https://api.ethrfps.app` | Which deployment to talk to. A **bare origin**, `https` unless it is loopback. The origin is bound into every write approval. |
| `RFPHUB_API_KEY` | *(none)* | Credential, needed **only** to submit. Never sent on a read. **Setting it is what registers the write tool**: without it, `tools/list` returns two tools and there is no write tool for a poisoned search result to reach for. |

| Flag | Default | What it does |
|---|---|---|
| `--state-dir <dir>` | `~/.rfphub` | Where approvals, rate-limit counters and the audit log live. Must be **writable**. Accepted in every mode, and the server and `rfphub-mcp approve` must be given the **same** directory. |

The per-request deadline is a fixed 20 seconds, headers and body together. It is not configurable:
a deadline an operator can raise is a deadline a stalled destination can hold a tool call open
behind.

`RFPHUB_API_BASE` is checked at startup, before any preview can exist, and four shapes are
refused outright:

- **plain `http:` for anything but `127.0.0.1`, `[::1]` or `localhost`** — the write request
  carries a bearer credential, and a human approving an origin does not make cleartext safe;
- **a username or password in the URL** — it would end up in every diagnostic this server writes
  (no error message ever repeats the value of this variable, for the same reason);
- **a path, query or fragment** — the approval binds the *origin*, so two bases that differ only
  after the host would produce the same approval and reach different endpoints;
- **anything that is not an absolute `http`/`https` URL.**

`https://api.ethrfps.app`, `https://api.ethrfps.app/`, `https://api.ethrfps.app:443` and
`https://API.ethrfps.app` are one destination and produce one approval id. Port 444, or a
different host, is a different destination and a different id.

**Rotating the key means restarting the server.** Configuration is read once, at startup, and the
credential's fingerprint is one of the five things an approval binds to. A key swapped in the
client's `env` block reaches this process only on its next start; until then previews are still
bound to the old fingerprint, and a commit under the new one is refused as a mismatch. Restart
before previewing under a new key.

**The key goes in the client's `env` block. Never in a prompt, and never as a tool argument** —
there is no parameter on any tool through which one could be passed, and a test asserts that.

```jsonc
{
  "mcpServers": {
    "rfp-hub": {
      "command": "npx",
      "args": ["-y", "@the-rfp-hub/mcp@0.1.0"],
      "env": {
        "RFPHUB_API_KEY": "rfph_…"
      }
    }
  }
}
```

Use a **`write`-scoped** key, not a `publish`-scoped one. With `write` alone, a submission lands
pending a reviewer's decision by construction — the safe mode needs no extra configuration.

---

## Tools

### `search_opportunities` *(read)*

Filters: `q`, `fundingType[]`, `status[]`, `ecosystem[]`, `category[]`, `organization`, `minAward`,
`maxAward`, `deadlineAfter`, `deadlineBefore`, `sort`, `order`, `page`, `limit` (max 25). An
unknown parameter is an error, never a filter that silently does nothing.

Each result row carries the id, namespace, title, funding type, status, operating organizations,
ecosystems, a rendered award line, the next fixed deadline, and two link-out URLs.

**It does not return `description` or `summary`.** That is deliberate and it is the main safety
property of this server: those are the longest free-text fields a publisher controls, they are
where an instruction addressed to your agent would live, and twenty of them would dominate the
context window. Ask for a full record by id when you actually need the prose.

### `fetch_opportunity` *(read)*

One record in full, as an RFP Hub Standard document, inside an envelope of
`{ notice, opportunity, links }`. The document is **structurally unmodified** — no field removed,
none added, no value changed. Not byte-identical: it is parsed and re-serialized on the way
through, so key order and whitespace are the transport's business.

### `submit_opportunity` *(write — registered only when a key is configured)*

Two calls with a person in between. See the next section.

---

## Submitting, and the approval step

```
1. call submit_opportunity { document }
     → validates locally, writes nothing, returns:
       { status: "pending", approvalId: "<64 hex>", preview: {...}, instruction: "..." }

2. a person runs, in their own terminal:
     npx @the-rfp-hub/mcp@0.1.0 approve <approvalId>
     → prints the destination, the credential fingerprint, the operation, the protocol
       revision and the whole document, then asks for confirmation

3. call submit_opportunity { document, approvalId }
     → claims the approval (single-use), POSTs, returns the result
```

`rfphub-mcp pending` lists what is waiting. `rfphub-mcp revoke <id>` deletes one.

### What the approval binds to

An approval is not merely "this document was approved". Its id is a hash over **five** things, and
`approve` prints all five before asking:

| | |
|---|---|
| **destination** | the canonical origin of `RFPHUB_API_BASE` |
| **credential** | the first 8 hex characters of the key's SHA-256 — never the key, and not a prefix of it |
| **operation** | `submit_opportunity` |
| **protocol** | the MCP revision this server speaks |
| **document** | SHA-256 over the document's canonical form |

Change any one of them and the approval no longer applies, and the refusal names which one moved.
An approval granted against staging cannot be spent against production; one granted under a key
you have since rotated cannot be spent under the new one.

The approval is **single-use**, claimed by an atomic rename *before* the request goes out, and it
is **never restored** — including after a timeout. If a submission's outcome is ambiguous, check
`GET /v1/me/opportunities` (the public read hides entries awaiting review) before doing anything
else. Approvals expire 15 minutes after the preview.

### What this does — and what it does not

**What it does.** Approving leaves the MCP channel entirely. No tool response ever carries an
approval secret, so a model cannot read one out of its own context and spend it in the same turn.
Approving becomes a deliberate act at a terminal, in front of a screen showing exactly where the
write is going and with which credential.

**What it does not do.** This is *not* a boundary against an agent that holds a shell and a
filesystem as the same operating-system user. Coding agents routinely hold both. Such an agent can
run this CLI in a pseudo-terminal, or write the approval file directly; the `0600`/`0700`
permissions do not stop it, because it *is* that user. Nothing here should be read as "the model
cannot approve".

If you need a boundary that really is separate, the options are outside this package: an approval
UI provided by the host application, a distinct OS identity for the agent's process, or a signing
key the agent cannot reach. See
[`adr/0012`](https://github.com/The-RFP-Hub/the-rfp-hub/blob/main/adr/0012-mcp-server-per-user-credential-stdio-out-of-band-approval.md).

---

## Errors

Every failure carries one of seven codes.

| Code | Means |
|---|---|
| `tool_not_found` | No such tool. With submitting disabled, the write tool is genuinely not registered. |
| `invalid_input` | The arguments or the document did not validate. A schema failure is reported field by field. |
| `policy_denied` | Refused by configuration or by the API's authorization: no credential, a missing scope, or the pending-submission ceiling. |
| `rate_limited` | A local per-kind budget, or the API's own limiter. |
| `confirmation_required` | The document was previewed but not approved. Nothing was sent. |
| `confirmation_invalid` | The approval does not apply: expired, already used, or bound to a different destination, credential, protocol or document. Nothing was sent. |
| `exec_failed` | The API failed, was unreachable, answered with something that is not JSON, or answered with more than 1 MB. |

A response over **1 MB fails rather than truncating**, and the cap is applied while the body is
being read, so an enormous response costs bounded memory. Half a JSON document is not a smaller
answer, it is a wrong one; narrow the request instead.

**A submission whose outcome cannot be known says so.** Once the request has left, the only clean
answer is a coded `4xx` — the API read it, decided, and the answer was no. Everything else is
reported as *may have landed*, never as a plain failure, and points at `GET /v1/me/opportunities`:

- a dropped connection, or a body that stops mid-stream;
- a body that is not JSON, or is over the cap;
- a `5xx`, however well-formed its body — the API commits the row and *then* does more work, so a
  server error while answering is entirely consistent with a row that exists;
- a `2xx` whose body is not a submission result — an empty `200`, a `{}`, an answer from something
  that is not this API;
- a `3xx` (see below).

The approval is spent in every one of those cases.

**A submission never follows a redirect — and an unfollowed redirect is still ambiguous.** The
document and the credential are never re-sent to a host this server did not resolve and nobody
approved; an approval binds the destination origin, so continuing elsewhere would spend a decision
made about somewhere else. But *not followed* is not *not written*: POST/Redirect/GET is the
ordinary way a server acknowledges something it has just created, so a `3xx` is reported as *may
have landed*, with the destination named so you can see where you were being sent.

**Arguments are validated against the published schema**, and a malformed call comes back with the
same codes as everything else. An unknown parameter is an error rather than a filter that silently
does nothing.

---

## Local state

Everything lives under the state directory — `--state-dir`, default `~/.rfphub` — with the
directory at `0700` and files at `0600`.

**`--state-dir` takes precedence over the operating system's idea of this user's home directory.**
Pass it wherever that idea is unreliable: a container, a service account, a `systemd` unit or a
launch agent may have no home directory, may have one that is read-only, or may share one with
another identity. This server refuses rather than guesses — see below.

```jsonc
{
  "mcpServers": {
    "rfp-hub": {
      "command": "npx",
      "args": ["-y", "@the-rfp-hub/mcp@0.1.0", "--state-dir", "/var/lib/rfphub"]
    }
  }
}
```

**Pass the same directory to the approval commands.** The server writes the preview there and
`rfphub-mcp approve` reads it back; given different directories, `pending` shows nothing while a
real preview waits somewhere else. Every command this server prints for a person to run already
carries the flag when one was given — the preview's `instruction`, the refusal when a commit
arrives unapproved, and the `approve` line in `rfphub-mcp --state-dir /var/lib/rfphub pending` —
shell-quoted, so a path with a space survives the paste.



| Path | Contents |
|---|---|
| `pending/<id>.json` | A preview awaiting approval, with the document so the terminal can print it |
| `approvals/<id>.json` | A granted approval |
| `approvals/claimed/<id>.json` | A spent approval. Never reusable. |
| `pending/claimed/<id>.json` | A preview a person has already turned into an approval |
| `policy-counters.json` | Per-kind rate counters |
| `policy-counters.lock` | Held only while a counter is being updated |
| `policy-counters.lock.stale.*` | A lock abandoned by a crashed process, on its way out |
| `audit.log` | One JSON line per call, rotated at 5 MiB |
| `audit.log.1` | The one previous generation of the log |
| `audit.lock` | Held only while the log is being rotated |

**The modes are checked, not merely requested.** On every use the home is `lstat`ed and must be a
real directory — not a symlink, not a file — and every state file must be a regular file with no
second hard link. A path this server is about to **write** is `chmod`ded to `0700`/`0600` and the
mode is then read back, because a `chmod` that reports success on a filesystem without POSIX modes
has established nothing.

A file this server is about to **trust** is verified instead, and never repaired: an approval or a
counter file that is already world-readable, or that has a second hard link, has already been
exposed to whatever holds it, and tightening the mode afterwards neither un-exposes it nor makes
the decision inside it yours. Those reads refuse — `policy_denied` — and go on refusing until the
file is removed. `rfphub-mcp pending` simply omits a record it cannot vouch for. The audit log is
written rather than trusted, so it is repaired; it still declines to write into a path it could not
secure, and it is opened and judged through one descriptor so a rotation cannot slip a fresh
default-mode file under the append. A log path that is a symlink, or anything but a regular file,
is declined rather than followed — `O_NOFOLLOW` where the platform has it, and an `lstat` before
the open everywhere, which is the only guard on a platform that does not (a small window between
the two, failing closed into dropping a line rather than into writing through the link).

**The audit log is bounded.** At 5 MiB it is rotated to `audit.log.1` under a lock, keeping exactly
one previous generation at `0600`. A rotation that fails costs the rotation, never the call and
never the line.

**A clock that moves backwards buys nothing.** If a counter window on disk is *ahead* of the
current one — an NTP correction, a resumed snapshot, a hand-set clock — the stored count is kept
and counted in rather than reset, and an approval stamped in the future reads as outside its
window. Budget stays spent until real time catches up, which is the safe direction for a limiter.

**Rate limits fail closed.** If the counter store cannot be read or written, calls are refused — a
budget that cannot be counted cannot be enforced. Keep the state directory writable.

**The counters are correct across processes.** Check-and-increment runs under a lock directory
(`policy-counters.lock`), because an MCP client and a terminal running this same package share one
home directory by design, and an unlocked read-modify-write lets two processes through a cap of
one. A lock left behind by a process that died is broken after five seconds — by renaming it aside,
so that two processes breaking the same abandoned lock cannot end up deleting a live one.

**The write budget is reserved before the approval is claimed.** A local refusal — an exhausted
daily budget, a lost race for the approval — gives the budget back and leaves the approval intact,
so nobody has to be asked to approve the same submission twice.

**Approving is decided at the moment you answer, not when the preview was printed.** The preview is
claimed by an atomic rename after your confirmation, so two terminals approving the same id produce
one approval, and a preview that was revoked or expired while it sat on screen is refused.

**Refused submissions are metered too.** The three kinds a caller can reason about are `read`,
`preview` and `commit` — one per phase of work that actually happened. `attempt` is a **fourth,
internal kind**: an abuse-control meter, not a phase. Every invocation of the write tool spends one
(20/minute, 400/day) before any work — including a call whose arguments are rejected before the
handler runs, which is the cheapest thing to repeat. A loop of bogus approval ids, malformed
arguments or oversized documents cannot run unmetered. Running out of `attempt` never masks the
real error: bad arguments still come back as bad arguments.

**The audit log records argument key names and byte counts, never values.** A log that stored
values would be a second copy of every document and every search term. Failing to write it never
fails a call.

Defaults: `read` 60/minute, `preview` 10/minute, `commit` 2/minute and **5 per day**, `attempt`
20/minute and 400/day.

---

## Security notes

- **The credential is environment-only.** No tool takes one; reads never send one.
- **A key-shaped string anywhere in a submitted document is refused before any request is made.**
  The API stores the text it is given, so a key inside `description` would be persisted and only
  then redacted out of the reply — redaction of output cannot help with that.
- **Redaction is a backstop, not the control.** Every outbound surface — text, structured content,
  error messages, the audit log — is scanned recursively for key-shaped strings.
- **URLs are inert.** This server never follows a URL from any record, and the notice attached to
  every result says the client should not either.
- **Every third-party string is bounded.** Titles are cut at 140 characters, ecosystem labels at
  40 characters and 8 values (the row says how many were dropped). `ecosystems` is an open list in
  the standard — no registry, no enum — so leaving it unbounded would have made it the obvious
  place to park a payload.
- **Residual risk, stated plainly:** `title`, organization names and ecosystem labels are
  third-party text and they do reach the model. They are delimited and labeled. Labeling is a
  hint, not a control, and a hostile title is not made harmless by it. The projection — the missing
  `description` — is the control.
- **A preview refuses what the API would refuse.** The API's admission limits (title 256, summary
  1 000, description 50 000, top-level arrays 100 entries, body 256 KiB) are checked locally, so
  nobody is asked to approve a submission that could never have been accepted. The array cap is
  top-level only, exactly as the API applies it — checking more here would refuse documents the API
  would have taken.
- **Suspected-duplicate titles are third-party text too.** They come back truncated to 140
  characters, delimited, and labeled — the write path is where a caller is most primed to act, so
  it gets the same treatment the search results get.
- **`structuredContent` is not a safety boundary.** It is delivered to the model like any other
  output. It exists here for contract and validation.
- **Every request has a deadline.** A peer that accepts a connection and then says nothing, or
  sends half a body and stops, is abandoned after 20 seconds. A read reports that and
  is not retried. A write reports it as an ambiguous outcome, because the request had already left.
- **A `2xx` is not believed until its body has been checked.** A read whose body is not the shape
  this build knows fails rather than returning a plausible empty record; a write whose body is not
  a submission result — including a `204`, or a `duplicateCheck` value this build predates — is
  reported as "may have landed", with `GET /v1/me/opportunities` named as the place to find out.
  Unknown extra members are always allowed: this client does not own the contract.
- **Pin exact versions**, as every example above does. That is the only real defense against a
  future version of any npm package behaving differently from the one you reviewed.

---

## Development

```sh
pnpm --filter @the-rfp-hub/mcp build   # required before the test suite: it drives dist/cli.js
pnpm --filter @the-rfp-hub/mcp test
```

The transport is chosen in `src/cli.ts`; `src/server.ts` registers the tools and knows nothing
about it. Adding an HTTP entry point is a new file, not a refactor.

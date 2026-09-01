---
"@the-rfp-hub/mcp": minor
---

Add `@the-rfp-hub/mcp`, a Model Context Protocol server for the funding corpus. It runs over stdio
(`npx -y @the-rfp-hub/mcp`), needs no credential to search, and exposes three tools:
`search_opportunities`, `fetch_opportunity`, and — only when explicitly enabled —
`submit_opportunity`.

The search tool's output is a deliberate projection: `description` and `summary` do not appear in
it. Those are the longest free-text fields a publisher controls, they are where an instruction
aimed at an agent would live, and a field that is not returned cannot be acted on. Titles and
organization names remain, they remain third-party text, and the package says so rather than
claiming otherwise.

Submitting takes two calls with a person in between. The first validates locally, writes nothing,
and returns a public digest bound to five things: the destination origin, a non-reversible
fingerprint of the credential, the operation, the protocol revision, and the document. A person
then runs `rfphub-mcp approve <id>` in their own terminal, where all five are printed before the
question. Only a second call carrying that digest submits — after an atomic claim that happens
before the request, so the authorization is spent exactly once even when the response never
arrives, and is never restored afterwards. No approval secret is ever returned to the caller.

What that interlock does not do is written down in the package and in ADR 0012: it takes the
approval out of the tool channel, but it is not isolated from an agent holding a shell as the same
user, and file permissions do not change that.

The credential is read from the environment only — no tool accepts one — reads never send it, and
a key-shaped string anywhere in a submitted document is refused before any request is made.

Everything a caller can reach is bounded and coded. Argument validation runs through the same error
map, audit line and redactor as every other failure, so a malformed call cannot echo an unknown
property name back unredacted; redaction also sits on the transport, covering the error paths the
SDK words itself. Rate counters are updated under a cross-process lock, because a client and a
terminal share one home directory by design and an unlocked read-modify-write lets two processes
through a cap of one. The write budget is reserved before the human's approval is claimed, so a
local refusal never burns an approval. Third-party ecosystem labels are capped like every other
untrusted string, the response cap is enforced while streaming, deadlines are compared as instants
rather than as strings, a merged entry's 404 carries the id it was merged into, the preview mirrors
the API's admission limits so nobody approves an impossible request, and any submission failure
after the request left is reported as "may have landed" rather than as a plain error.

The destination is checked before anything can be approved against it: `RFPHUB_API_BASE` must be a
bare origin, and `https` unless it names a loopback host, because the write request carries a
bearer credential and a human approving an origin does not make cleartext safe. Every request runs
under a deadline (`RFPHUB_MCP_TIMEOUT_MS`, 20 s by default) that covers the body as well as the
headers, and a `2xx` body is validated before it is believed — a read gets a contract failure
instead of a plausible empty record, a write gets "may have landed" instead of a crash after the
row was created. Local state is verified rather than assumed: the home must be this user's own
`0700` directory, state files regular `0600` files, and approvals and counters refuse when that
cannot be established. The counter file is parsed strictly, so a corrupt one denies calls instead
of granting them, a clock moved backwards buys no budget, and the audit log rotates at 5 MiB.

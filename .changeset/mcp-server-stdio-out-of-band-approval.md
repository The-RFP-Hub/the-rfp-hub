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

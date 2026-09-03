---
"@the-rfp-hub/mcp": patch
---

`mcpName` is `io.github.The-RFP-Hub/rfp-hub`, in the organization's own case. The MCP Registry
grants `io.github.<login>/*` spelled exactly as the GitHub login, matches it as a case-sensitive
prefix, and compares the npm package's `mcpName` to the server name character for character, so the
lowercase name 0.1.0 and 0.1.1 carried could be published by nobody. `server.json` follows, the
server reports `package.json`'s version instead of a constant that had to be bumped by hand, and a
workflow publishes the manifest to the Registry with the repository's OIDC identity, which needs no
organization Owner.

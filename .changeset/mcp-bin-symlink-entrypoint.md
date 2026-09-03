---
"@the-rfp-hub/mcp": patch
---

The CLI runs when started through its bin. `npx @the-rfp-hub/mcp` and every installer's
`node_modules/.bin/rfphub-mcp` are symlinks to `dist/cli.js`, and the entrypoint guard compared that
unresolved symlink path against the module's own, so through them the process exited 0 having
served nothing — which is how 0.1.0 shipped. The guard now resolves both paths, a test starts the
built CLI through a symlink, and the deployment checker's install preflight fails on a `--version`
that prints nothing instead of reporting it as resolved.

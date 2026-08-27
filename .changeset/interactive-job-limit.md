---
"@the-rfp-hub/api": patch
---

Bound an HTTP-triggered maintenance pass so a paced job cannot hold a reviewer's socket.
`verification-backfill` spaces its fetches per host, so one pass over its scheduled selection of 500
entries is minutes of wall clock in the clustered-corpus case the pacer exists for — longer than any
browser or proxy will wait for `POST /v1/admin/jobs/{job}/run`. A job may now declare an
`interactiveLimit`, used when that route is called with no `limit` of its own; a named `limit` is
still honoured exactly. The per-host gap becomes `VERIFY_HOST_MIN_GAP_MS` (default `1000`,
unchanged behaviour for every deployment), so a stack whose only source host is its own fixture
server can turn pacing off.

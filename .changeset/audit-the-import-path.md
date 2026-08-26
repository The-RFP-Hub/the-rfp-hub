---
"@the-rfp-hub/api": patch
"@the-rfp-hub/frontend": patch
---

Audit the corpus import path, which was the only mutation that wrote no history. A seed or import
upsert now appends an `audit_log` row inside the same transaction, attributed to the system and
carrying the source system in its patch — `create` on the first sighting, `update` on a
content-changing re-import, and nothing at all when the document is unchanged. Entries loaded before
this are backfilled by an idempotent, insert-only migration that stamps each row with its own
creation time.

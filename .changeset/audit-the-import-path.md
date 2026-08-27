---
"@the-rfp-hub/api": patch
"@the-rfp-hub/frontend": patch
---

Audit the corpus import path, which was the only mutation that wrote no history. A seed or import
upsert now appends an `audit_log` row inside the same transaction, attributed to the system —
`create` on the first sighting, `update` when the re-import changed either the document or one of
the three things the import decides for itself (review status, listing visibility, source system),
and nothing at all when it changed neither. Entries loaded before this are backfilled by an
idempotent, insert-only migration that stamps each row with its own creation time.

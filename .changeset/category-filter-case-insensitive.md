---
"@the-rfp-hub/api": patch
---

Fix `GET /v1/opportunities?category=...` to match case-insensitively, like `ecosystem` already
does. `categories[]` is explicitly "Free text" in the Standard, not a closed, validated
vocabulary — the repository's own comment claiming otherwise was wrong — so the corpus holds
`Infrastructure` and `infrastructure` side by side just like an ecosystem name does, and the
previous case-sensitive `&&` silently answered one spelling with a fraction of the matching rows.
Uses the same `arrayMatchesInsensitive` helper `ecosystem` and `organization` already rely on.

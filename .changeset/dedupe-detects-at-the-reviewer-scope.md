---
"@the-rfp-hub/api": patch
---

Run duplicate detection over every candidate and apply the caller's scope to the matches it returns
rather than to the rows it searches, so two entries that are both pending are paired in the review
queue instead of being paired by nothing at all. The submission response is unchanged: it still
names only counterparts that are approved and listed.

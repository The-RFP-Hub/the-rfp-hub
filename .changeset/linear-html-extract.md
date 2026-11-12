---
"@the-rfp-hub/api": patch
---

Read fetched pages in linear time and off the event loop. The verifier's HTML extraction no longer uses backtracking regular expressions, which took seconds to minutes on a page that opens a comment, tag or script and never closes it; it now runs in a worker thread with a deadline (`VERIFY_EXTRACT_TIMEOUT_MS`, default 2000), and a page that overruns it is recorded as `extraction_interrupted` and applied as unmatched.

---
"@the-rfp-hub/api": patch
---

Keep imported listings unattributed when a reviewer edits them. A reviewer's save no longer records the id's prefix (such as `curated`) as the listing's publisher or gives it a submission date, so saving an imported listing without changes keeps it approved and resets its inactivity clock instead of sending it back to review.

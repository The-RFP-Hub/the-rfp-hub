---
"@the-rfp-hub/frontend": minor
---

Expose the directory filters the API already accepted but the UI didn't: category, organization
(a slug — matching any operating OR sponsoring organization, stated in the field's own hint), and
an award and deadline range. All of them are URL query params like the existing filters, so a
filtered view is still shareable and survives a reload or the back button. A 400 from the list
route — an invalid filter combination the endpoint's `additionalProperties: false` rejects — now
gets its own panel naming the parameter from the API's own message, instead of the generic
"couldn't load" failure a retry cannot fix.

Also fixes two responsive bugs a new mobile e2e spec caught by measuring rendered boxes: the
filter bar's own CSS was beating the `(pointer: coarse)` touch-target rule on specificity, so its
controls sat at the desktop 40px height on an actual touch device; and the "Programme site" link
next to "Apply" on an entry page had no minimum tap height at all. Award inputs also accept
fractional values (`step="any"`, a decimal keypad on mobile), and a deadline control given a full
timestamp from a shared link (rather than the bare day it can display) now shows the right day
instead of going blank, with the exact retained value shown as text alongside it.

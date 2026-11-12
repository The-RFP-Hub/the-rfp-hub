---
"@the-rfp-hub/api": patch
---

`GET /v1/opportunities/:id` now holds its querystring to the same strict contract as every other public read: a parameter the OpenAPI document does not declare (anything but `count`) is a `400` in the `ErrorResponse` envelope instead of being silently ignored, and the `400` is documented on the operation. A refused read records no detail view. This is what the published compliance check (M2-2, "an undocumented query parameter is a 400") already asserted; it had been failing the nightly open-data export since `count` was declared on 2026-10-30.

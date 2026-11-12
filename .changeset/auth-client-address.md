---
"@the-rfp-hub/api": patch
---

Key the auth library's rate limits on the client address the API resolved. The `/api/auth` mount no longer forwards the caller's `X-Forwarded-For`, `X-Real-IP` or `Forwarded` to the library, and passes `request.ip` in a header only the mount writes, so a forged header can neither pick a fresh bucket nor push callers into one shared bucket. The library's limiter is now declared explicitly and on in every environment (`AUTH_RATE_LIMIT_ENABLED`, refused as false in production): 3 sign-in codes sent and 10 code checks per 5 minutes per address.

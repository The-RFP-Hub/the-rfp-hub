---
"@the-rfp-hub/api": patch
---

Close two authorization gaps around ownership claims. Filing a claim now requires the `write` scope
on an API-key credential — the queue path had no scope check at all, so a `read`-only key could put
a reviewer decision over somebody else's entry in flight; an immediate grant still additionally
requires `publish`, and either absence is a 403 naming the scope. And a granted claim now really
moves `PUT` with it: the original submitter kept write access to an entry forever, including after
`source.publisher` had moved to the claiming organization, so the arm now holds only while the entry
has no publisher or the submitter is a member of the organization that publishes it. A submitter who
is also a member of the claiming organization — the ordinary case — is unaffected.

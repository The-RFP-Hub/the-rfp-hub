---
"@the-rfp-hub/api": minor
---

Link-outs vouch only for destinations a reviewer saw. `GET /v1/r/:id/apply` and `/source` still count the click and answer `302`, but go straight to the stored link only when it is exactly the link a reviewer last approved or saved; otherwise they redirect to the frontend's leaving page, `APP_BASE_URL/leaving/{id}?link=apply|source&reason=closed|unreviewed|landing_changed`. Closed and archived listings always get the leaving page. A verified publisher's own new listing or changed link gets it until a reviewer saves the listing, and the nightly source check flags an apply link that starts landing on a different site. Migration `0017` adds `reviewed_application_url`, `reviewed_website` and `link_landing_changed_at`, and pins every approved listing's current links, so on deploy day only closed and archived listings change behavior.

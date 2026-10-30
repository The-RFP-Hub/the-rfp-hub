---
"@the-rfp-hub/frontend": minor
---

Add a "You're leaving RFPSear.ch" page at `/leaving/[id]` (`?link=apply|source&reason=closed|unreviewed|landing_changed`). It reads the public listing by id and shows where its application link (or program site) goes: the host, the full URL as text, the reason, a "Continue to {host}" link to the stored URL, and the way back to the listing. The destination is never taken from the page's address, and the page offers no link when the listing is not published, carries no such link, or stores something other than an `https://` URL. The page is `noindex`, disallowed in `robots.txt` and absent from the sitemap. Nothing links to it yet; the API's link-out redirect will send readers there for links it should not follow silently.

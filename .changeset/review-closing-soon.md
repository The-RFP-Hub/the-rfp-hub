---
"@the-rfp-hub/frontend": minor
---

The review page has a "Closing soon" tab: live listings the staleness job will close for inactivity in the next 30 days, each with its application link and website, the date it closes and a "Confirm still open" action (with an optional note for the listing's history) that keeps it open for another full period and refreshes the list. A listing that closes at its final deadline shows that confirming can't extend it and links to editing its deadlines instead of offering the confirm action. If the API reports the list incomplete, the tab says so and never claims that nothing closes. The leaving page now reads the listing with `?count=false`, so a reader sent through the security notice is no longer counted as an extra detail view on top of the click the redirect already counted.

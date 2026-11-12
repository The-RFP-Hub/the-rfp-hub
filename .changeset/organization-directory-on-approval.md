---
"@the-rfp-hub/api": patch
"@the-rfp-hub/frontend": patch
---

Stop unreviewed submissions from writing organization directory details. A submission that is not approved now creates only a slug-and-name stub for an organization the directory does not know, and may add at most 10 such organizations; website, logo, description, links and contacts are filled only when an entry naming the organization is approved, only into empty fields, and never on a verified organization. Verifying an organization (directly or by approving a claim) now shows the reviewer the directory entry, and accepts its `directoryDigest` to refuse the verification with `409 organization_directory_changed` if the entry changed after it was shown. A new `orgs:cleanup-rejected` script reports, and with `--apply` deletes, organizations named only by rejected entries.

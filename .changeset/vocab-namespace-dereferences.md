---
"@the-rfp-hub/standard": minor
---

The vocabulary namespace dereferences: `ns/rfp.jsonld` joins the package (a new `./ns/*` export
and `files` entry) as the landing document `https://ethrfps.app/ns/rfp#` resolves to. Its term set
is the context's own `@vocab` expansion — every definition whose effective target is relative —
with each term's comment quoting the schema's field definition. Minor on the package axis: a new
public artifact and a new export subpath, no change to any type or validation behaviour.

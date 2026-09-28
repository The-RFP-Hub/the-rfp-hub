// Which spec identifiers a URL may carry: the current identity, or an earlier one
// (`identityMigrations`) for the versions published under it. Shared by check-spec and check-neutral.
const isVocab = (url, iri) => url.startsWith(iri) || `${url}#` === iri;

export function identityRules(spec) {
  const former = (spec.identityMigrations ?? []).map((m) => m.from);
  return {
    hosts: [spec.baseUrl, ...former.map((f) => f.baseUrl)].map((u) => new URL(u).host),
    schemaUrlAllowed: (url) =>
      url.startsWith(`${spec.baseUrl}/schemas/v`) ||
      former.some((f) => f.versions.some((v) => url.startsWith(`${f.baseUrl}/schemas/v${v}/`))),
    vocabAllowed: (url) =>
      isVocab(url, spec.vocabIri) || former.some((f) => isVocab(url, f.vocabIri)),
  };
}

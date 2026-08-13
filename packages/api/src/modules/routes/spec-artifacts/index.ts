import type { FastifyInstance } from "fastify";
import { canonicalDocuments } from "../../shared/canonical-documents.js";
import {
  assertPublicationTreeCoversIdentifiers,
  specArtifacts,
} from "../../shared/spec-artifacts.js";
import { sendCanonical } from "../canonical/index.js";

/** The five paths `routes/canonical` already owns; registering them twice is a boot error. */
const identifierPaths: ReadonlySet<string> = new Set(canonicalDocuments.map((doc) => doc.path));

/**
 * THE STANDARD'S PUBLISHED DIRECTORIES, MIRRORED READ-ONLY AT THE HOST ROOT.
 *
 * `routes/canonical` serves the five documents an `$id` or a `@context` names. This module serves
 * everything else in the same three directories — the version directory's informative documents and
 * its examples, the `FROZEN` marker, the registry vocabularies — so that
 * `https://ethrfps.app/schemas/v1.0.0/…` is a directory a consumer can walk, not a shortlist of
 * five. See `modules/shared/spec-artifacts.ts` for why the whole tree and not just the identifiers.
 *
 * Mounted at the ROOT for the same reason the canonical documents are: these paths mirror the
 * Standard's own layout, and a spec artifact must not carry an API version.
 *
 * ONE ROUTE PER FILE, from a directory walked at boot. That is the security property — a request
 * path is matched against the router, never joined onto a filesystem path — and it is also what
 * lets every file reuse `sendCanonical` unchanged: same `Cache-Control` (`immutable` under the
 * frozen version directory, revalidating where the URL names no version), same strong `ETag`, same
 * `If-None-Match` handling, same verbatim bytes. `HEAD` comes from Fastify's own head-route
 * exposure, and `Access-Control-Allow-Origin: *` from the app-wide CORS registration — JSON-LD
 * processors and schema validators fetch these cross-origin from browsers.
 *
 * DELIBERATELY ABSENT FROM THE OPENAPI DOCUMENT (`schema.hide`). The five identifiers are in it
 * because the spec itself names them and a client generator has a reason to know them; the other
 * thirty-seven are the same document repeated, they would outnumber the API's real operations four
 * to one in the docs UI and in every generated client, and they describe files served under a
 * `servers[0]` base that is the API's origin rather than the identifier authority they belong to.
 * They are documented in `packages/api/README.md` instead.
 *
 * NO DIRECTORY LISTING. `GET /schemas/v1.0.0/` 404s. The package ships no index for that directory,
 * and synthesising one would put an API-shaped document, whose format could change, inside a
 * directory whose entire promise is that its bytes cannot — served, by the path rule, as
 * `immutable`. The machine-readable entry point is the one the package actually ships and this API
 * already serves: `/schemas/index.json`.
 */
export const specArtifactMirror = async (router: FastifyInstance): Promise<void> => {
  assertPublicationTreeCoversIdentifiers();

  for (const artifact of specArtifacts) {
    if (identifierPaths.has(artifact.path)) continue;
    router.get(artifact.path, { schema: { hide: true } }, async (req, res) =>
      sendCanonical(artifact, req, res),
    );
  }
};

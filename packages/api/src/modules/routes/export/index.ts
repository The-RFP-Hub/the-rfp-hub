import type { FastifyInstance } from "fastify";
import { exportController } from "./export.controller.js";
import { noQuerySchema } from "./types.js";

/**
 * The two full-dataset download operations, documented through `response.content` keyed by the
 * media type actually served — the shape every non-envelope route in this API uses (the feeds, and
 * `/v1/opportunities/schema` for `application/schema+json`).
 *
 * The JSON operation declares its envelope for real rather than as an opaque `type: "string"`: it
 * IS JSON, so a consumer generating a client from this document should get the envelope, and a
 * conformance checker validating a live response against the published schema should be able to.
 * It is declared as a NAMED component (`DatasetExport`) rather than inline, like every other JSON
 * response here: an inline schema carrying a `$ref` is not rebasable by a consumer that pulls one
 * operation's schema out of the document, and the envelope's `opportunities` refs the same
 * `Opportunity` component `/v1/opportunities/{id}` serves — so the records in a download are
 * documented as, and are, the records in the API. Nothing is serialized through the schema: the
 * handler sends a `Buffer`, which bypasses the serializer, and that is what keeps the bytes
 * identical to the published archive's.
 *
 * The CSV operation declares `type: "string"`: a tabular projection has no JSON Schema, so the
 * description names its columns and the media type carries the rest.
 */
const SHARED_DESCRIPTION = [
  "The ENTIRE public dataset — every approved, listed opportunity — in one response, with no",
  "pagination and no filters. Sent as an attachment named `opportunities-<UTC date>.<ext>`.",
  "Released under CC0-1.0.",
  "\n\nThis is a LIVE download: it reflects the database at the moment of the request. The nightly",
  "snapshot published at `exports/` in the repository is the same bytes per record from the same",
  "serializer, but is at most 24 hours old and, unlike this response, is immutable, digest-named",
  "and named by a manifest — fetch that instead when you need an archive you can cite and verify.",
  "\n\nSent with an `ETag` that moves only when the dataset does: send `If-None-Match` and get a 304",
  "instead of the whole dataset again.",
].join(" ");

export const datasetExport = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/opportunities.json",
    {
      schema: {
        operationId: "downloadOpportunitiesJson",
        tags: ["export"],
        summary: "Download the whole dataset as JSON",
        description: `${SHARED_DESCRIPTION} The envelope is the one \`exports/latest.json\` carries, with \`generatedAt\` set to the time of this request. The \`ETag\` is WEAK, because that stamp makes two responses over identical data differ in their bytes.`,
        querystring: noQuerySchema,
        response: {
          200: { content: { "application/json": { schema: { $ref: "DatasetExport#" } } } },
          400: { $ref: "ErrorResponse#" },
        },
      },
    },
    exportController.json,
  );

  router.get(
    "/opportunities.csv",
    {
      schema: {
        operationId: "downloadOpportunitiesCsv",
        tags: ["export"],
        summary: "Download the whole dataset as CSV",
        description: `${SHARED_DESCRIPTION} The file is the one \`exports/latest.csv\` carries. The \`ETag\` is STRONG — a CSV holds no timestamp, so identical data really does serialize to identical bytes. CSV is a flat format, so \`deadlines[]\` is represented by the derived \`nextDeadlineAt\` and \`rollingDeadline\` columns; the full array is in the JSON download. No rights sidecar accompanies a download, so the CC0-1.0 grant is stated here.`,
        querystring: noQuerySchema,
        response: {
          200: {
            content: {
              "text/csv": {
                schema: {
                  type: "string",
                  description:
                    "An RFC 4180 CSV: a header row, then one row per opportunity — `id`, `fundingType`, `status`, `title`, `organization`, `organizationSlug`, `ecosystems`, `categories`, `currency`, `minAward`, `maxAward`, `budget`, `allocated`, `opensAt`, `nextDeadlineAt`, `rollingDeadline`, `applicationUrl`. Multi-valued columns are `|`-joined. An empty dataset is the header row alone.",
                },
              },
            },
          },
          400: { $ref: "ErrorResponse#" },
        },
      },
    },
    exportController.csv,
  );
};

import type { FastifyReply, FastifyRequest } from "fastify";
import { type ExportFormat, ExportService } from "../../services/export/export.service.js";
import { DOWNLOAD_CACHE_CONTROL, ifNoneMatchSatisfied } from "../../shared/http-cache.js";

/**
 * Serve one full-dataset download.
 *
 * The document is sent as a `Buffer`, which is what keeps it intact: a Buffer payload bypasses
 * Fastify's response serializer entirely, so the bytes on the wire are exactly the bytes the shared
 * format module produced — the whole point of these routes. Sending the JSON as an object instead
 * would hand it to fast-json-stringify, which would re-serialize it against the response schema and
 * quietly break the byte-for-byte equality with the published archive.
 *
 * `Content-Disposition: attachment` because this is a download, not a page: a browser that follows
 * the URL should save `opportunities-<date>.json` rather than render a megabyte of JSON, and every
 * HTTP client honours the filename it carries.
 *
 * The `ETag` is the same bargain the feeds strike, and it matters more here: this is the largest
 * response the API serves, and the dataset behind it moves only when an ingest runs, so a client on
 * a schedule should be paying for one 304 rather than for the whole dataset again. The validator
 * and the cache policy go out on the 304 as well as on the 200 (RFC 9110 §15.4.5), so a client that
 * revalidates repeatedly keeps a usable, refreshed cache entry instead of losing its tag on the
 * first hit. Whether that tag is strong or weak is a property of the FORMAT, decided in the service.
 */
async function serve(format: ExportFormat, req: FastifyRequest, res: FastifyReply) {
  const service = new ExportService();
  const download = await service.render(format);

  res
    .header("ETag", download.etag)
    .header("Cache-Control", DOWNLOAD_CACHE_CONTROL)
    .header("Content-Disposition", `attachment; filename="${download.filename}"`);

  if (ifNoneMatchSatisfied(req.headers["if-none-match"], download.etag)) {
    return res.code(304).send();
  }
  return res.type(download.contentType).send(download.body);
}

/** GET /v1/export/opportunities.json — the whole public dataset, in the published JSON envelope. */
const json = async (req: FastifyRequest, res: FastifyReply) => serve("json", req, res);

/** GET /v1/export/opportunities.csv — the same dataset, in the published flat CSV projection. */
const csv = async (req: FastifyRequest, res: FastifyReply) => serve("csv", req, res);

export const exportController = { json, csv };

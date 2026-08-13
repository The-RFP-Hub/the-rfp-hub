/**
 * Download assembly: read the whole public dataset, serialize it in the requested format, and
 * describe the response well enough that the controller only has to set headers.
 *
 * The read goes through `OpportunityService.listAll`, deliberately and without a second query path
 * — the same method the open-data export runs on, so a download cannot drift into serving a record
 * the export omits. The serialization goes through `modules/shared/export-format.ts`, the module
 * the export writer serializes with, so the bytes match per record as well as the record set does.
 *
 * What this deliberately does NOT inherit from the export is the publication machinery: no
 * `EXPORT_MIN_COUNT` floor, no digest-named archives, no manifest, no CC0 sidecar file. Those exist
 * to stop a short or half-written run from replacing a good published dataset, and a download
 * replaces nothing — a request against an empty database gets a valid empty envelope and a
 * header-only CSV, which is the truthful answer, where the writer would (rightly) refuse to write.
 * The CC0 grant is carried in the JSON envelope's `license` and stated in the OpenAPI description
 * for the CSV, which has no room for it.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import {
  datasetIdentity,
  orderForExport,
  toCsv,
  toExportJson,
} from "../../shared/export-format.js";
import { entityTag, weakTag } from "../../shared/http-cache.js";
import { OpportunityService } from "../opportunities/opportunity.service.js";

export type ExportFormat = "json" | "csv";

/** One serialized download: the exact bytes, and everything the response headers are built from. */
export interface RenderedExport {
  /** The document, as the exact bytes to send. */
  body: Buffer;
  /** Full `Content-Type`, charset included. */
  contentType: string;
  /** The name the download is offered under, in `Content-Disposition`. */
  filename: string;
  /** The entity-tag for these bytes — strong or weak per format; see `validator` below. */
  etag: string;
  /** Records in the document. Reported, never inferred from the bytes. */
  recordCount: number;
}

const FORMATS = {
  json: {
    path: "/v1/export/opportunities.json",
    contentType: "application/json; charset=utf-8",
    extension: "json",
    render: (ordered: Opportunity[], generatedAt: string) => toExportJson(ordered, generatedAt),
    /**
     * WEAK, and taken from the records rather than from the body. The envelope carries
     * `generatedAt`, so two responses over identical data are not byte-identical and a strong tag
     * would be a false claim; hashing the body would move the tag on every request and never
     * revalidate to a 304. The dataset's own identity is the thing that should move it, so that is
     * what is hashed.
     */
    validator: (ordered: Opportunity[]) => weakTag(entityTag(datasetIdentity(ordered))),
  },
  csv: {
    path: "/v1/export/opportunities.csv",
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
    render: (ordered: Opportunity[]) => toCsv(ordered),
    /**
     * STRONG, over the bytes themselves — the CSV has no timestamp in it, so the document really is
     * a pure function of the data and byte-equality is a promise this format can keep.
     */
    validator: (_ordered: Opportunity[], body: string) => entityTag(body),
  },
} as const satisfies Record<
  ExportFormat,
  {
    path: string;
    contentType: string;
    extension: string;
    render: (ordered: Opportunity[], generatedAt: string) => string;
    validator: (ordered: Opportunity[], body: string) => string;
  }
>;

/** The route path each format is served at — the routes and the docs read it from here. */
export const exportPath = (format: ExportFormat): string => FORMATS[format].path;

/**
 * The filename a download is offered under: `opportunities-<UTC date>.<ext>`.
 *
 * The same readable prefix the published archives use (`opportunities-<date>-<digest>.<ext>`),
 * minus the digest — a live download is not content-addressed and must not look as though it were,
 * because nothing republishes it and no manifest names it. The date is UTC, so the name does not
 * depend on where the client happens to be.
 */
export const downloadFilename = (format: ExportFormat, generatedAt: string): string =>
  `opportunities-${generatedAt.slice(0, 10)}.${FORMATS[format].extension}`;

export class ExportService {
  constructor(private readonly opportunities: OpportunityService = new OpportunityService()) {}

  /**
   * Render one download.
   *
   * `now` is injectable so a test can pin the one non-deterministic input; every other byte is a
   * function of the records alone.
   */
  async render(format: ExportFormat, now: Date = new Date()): Promise<RenderedExport> {
    const { contentType, render, validator } = FORMATS[format];
    const generatedAt = now.toISOString();
    const ordered = orderForExport(await this.opportunities.listAll());
    const document = render(ordered, generatedAt);

    return {
      body: Buffer.from(document, "utf8"),
      contentType,
      filename: downloadFilename(format, generatedAt),
      etag: validator(ordered, document),
      recordCount: ordered.length,
    };
  }
}

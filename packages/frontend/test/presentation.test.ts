import {
  PUBLISHER_STATUS_LABELS,
  accountRoleLabel,
  auditActionLabel,
  auditFieldLabel,
  auditFieldLabels,
  duplicateStatusLabel,
  fundingTypeLabel,
  ingestionMethodLabel,
  isOpenDuplicateStatus,
  opportunityStatusLabel,
  orgRoleLabel,
  publisherStatus,
  reviewStatusLabel,
} from "@/lib/presentation";
import { describe, expect, it } from "vitest";

describe("presentation vocabulary", () => {
  it("labels domain wire values without changing the values sent over the wire", () => {
    expect(fundingTypeLabel("vc_fund")).toBe("Venture fund");
    expect(fundingTypeLabel("rfp")).toBe("Request for proposals");
    expect(opportunityStatusLabel("open")).toBe("Open");
    expect(reviewStatusLabel("pending")).toBe("Waiting for review");
    expect(duplicateStatusLabel("suspected")).toBe("Needs review");
    expect(duplicateStatusLabel("dismissed")).toBe("Dismissed — different programmes");
    expect(ingestionMethodLabel("publisher_api")).toBe("Submitted with an API key");
  });

  it("disambiguates global and organization roles only in display copy", () => {
    expect(accountRoleLabel("submitter")).toBe("Submitter");
    expect(accountRoleLabel("reviewer")).toBe("Hub reviewer");
    expect(accountRoleLabel("admin")).toBe("Hub admin");
    expect(orgRoleLabel("owner")).toBe("Organization owner");
    expect(orgRoleLabel("admin")).toBe("Organization admin");
    expect(orgRoleLabel("publisher")).toBe("Organization publisher");
  });

  it("humanizes audit vocabulary with deterministic future-token fallbacks", () => {
    expect(auditActionLabel("verify_source")).toBe("Checked the source");
    expect(auditFieldLabel("operatingOrganizations/0/slug")).toBe("Running organizations");
    expect(auditFieldLabel("futureFieldName")).toBe("Future field name");
    expect(auditActionLabel("future_action")).toBe("Future action");
  });

  it("finishes database-shaped audit labels and sorts by the displayed words", () => {
    expect(
      auditFieldLabels([
        "typeData",
        "httpStatus",
        "publicId",
        "orgSlugs",
        "ingestedVia",
        "specVersion",
      ]),
    ).toEqual([
      "HTTP status",
      "Ingestion method",
      "Organization slugs",
      "Programme details",
      "Public ID",
      "Specification version",
    ]);
  });

  it("identifies duplicate states that still need attention", () => {
    expect(isOpenDuplicateStatus("suspected")).toBe(true);
    expect(isOpenDuplicateStatus("confirmed")).toBe(true);
    expect(isOpenDuplicateStatus("dismissed")).toBe(false);
    expect(isOpenDuplicateStatus("merged")).toBe(false);
  });
});

describe("publisherStatus", () => {
  it.each([
    [
      "merged",
      { mergedInto: { id: "acme:survivor" }, reviewStatus: "rejected", isListed: true },
      "Merged",
    ],
    ["rejected", { mergedInto: null, reviewStatus: "rejected", isListed: true }, "Rejected"],
    [
      "pending",
      { mergedInto: null, reviewStatus: "pending", isListed: true },
      "Waiting for review",
    ],
    [
      "hidden",
      { mergedInto: null, reviewStatus: "approved", isListed: false },
      "Hidden from directory",
    ],
    ["live", { mergedInto: null, reviewStatus: "approved", isListed: true }, "Live"],
  ] as const)("derives %s with the required precedence", (status, source, label) => {
    expect(publisherStatus(source)).toBe(status);
    expect(PUBLISHER_STATUS_LABELS[status]).toBe(label);
  });
});

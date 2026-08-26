import { legacyOrganizationDestination } from "@/app/organisations/[[...rest]]/page";
import { describe, expect, it } from "vitest";

describe("the legacy organizations route", () => {
  it("maps the list and nested paths to their US-English equivalents", () => {
    expect(legacyOrganizationDestination()).toBe("/organizations");
    expect(legacyOrganizationDestination(["acme foundation"])).toBe(
      "/organizations/acme%20foundation",
    );
  });
});

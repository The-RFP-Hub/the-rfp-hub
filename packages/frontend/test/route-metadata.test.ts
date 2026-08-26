import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { generateMetadata as listingMetadata } from "@/app/listings/[id]/layout";
import { generateMetadata as opportunityMetadata } from "@/app/opportunities/[id]/layout";
import { generateMetadata as organisationMetadata } from "@/app/organisations/[slug]/layout";
import { metadata as organisationsMetadata } from "@/app/organisations/layout";
import { describe, expect, it } from "vitest";

const appRoot = join(process.cwd(), "src", "app");

function pageRoutes(directory = appRoot): string[] {
  const routes: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "page.tsx")) {
    const route = relative(appRoot, directory).split(sep).filter(Boolean).join("/");
    routes.push(route === "" ? "/" : `/${route}`);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) routes.push(...pageRoutes(join(directory, entry.name)));
  }
  return routes.sort();
}

describe("route metadata", () => {
  it("uses the directory title as the root default and templates every child title", () => {
    const source = readFileSync(join(appRoot, "layout.tsx"), "utf8");
    expect(source).toContain('default: "Directory | RFP Hub"');
    expect(source).toContain('template: "%s | RFP Hub"');
  });

  it("gives every current page route its own server metadata boundary", () => {
    expect(pageRoutes()).toEqual([
      "/",
      "/account",
      "/admin",
      "/auth/complete",
      "/dashboard",
      "/duplicates",
      "/how-it-works",
      "/keys",
      "/listings",
      "/listings/[id]",
      "/listings/[id]/edit",
      "/listings/new",
      "/opportunities/[id]",
      "/organisations",
      "/organisations/[slug]",
      "/privacy",
      "/review",
      "/terms",
    ]);

    for (const route of pageRoutes().filter((item) => item !== "/")) {
      const source = readFileSync(join(appRoot, route.slice(1), "layout.tsx"), "utf8");
      expect(source, `${route} needs server-owned metadata`).toMatch(
        /export (?:const metadata|async function generateMetadata)/,
      );
      expect(source).not.toContain('title: "Directory | RFP Hub"');
    }
  });

  it("uses URL identifiers for dynamic titles without fetching private listing data", async () => {
    await expect(
      listingMetadata({ params: Promise.resolve({ id: "acme:round-4" }) }),
    ).resolves.toEqual({ title: "Listing acme:round-4" });
    await expect(
      opportunityMetadata({ params: Promise.resolve({ id: "acme:round-4" }) }),
    ).resolves.toEqual({ title: "Opportunity acme:round-4" });
    await expect(
      organisationMetadata({ params: Promise.resolve({ slug: "acme-foundation" }) }),
    ).resolves.toEqual({ title: "Organisation acme-foundation" });
    expect(organisationsMetadata).toEqual({
      title: { default: "Organisations", template: "%s | RFP Hub" },
    });
  });
});

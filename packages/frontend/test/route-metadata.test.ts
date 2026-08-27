import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { generateMetadata as listingMetadata } from "@/app/listings/[id]/layout";
import { metadata as listingsMetadata } from "@/app/listings/layout";
import { generateMetadata as opportunityMetadata } from "@/app/opportunities/[id]/layout";
import { generateMetadata as organizationMetadata } from "@/app/organizations/[slug]/layout";
import { metadata as organizationsMetadata } from "@/app/organizations/layout";
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
    // The literal moved out of layout.tsx and into lib/root-metadata.ts (see that file's own
    // comment): generateMetadata there needs no import from the font/provider tree that has no
    // transform under this package's test runner. Either file carrying the literal satisfies the
    // invariant this test exists to pin.
    const source =
      readFileSync(join(appRoot, "layout.tsx"), "utf8") +
      readFileSync(join(process.cwd(), "src", "lib", "root-metadata.ts"), "utf8");
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
      "/notifications",
      "/opportunities/[id]",
      "/organisations/[[...rest]]",
      "/organizations",
      "/organizations/[slug]",
      "/privacy",
      "/publishers",
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

  it("keeps nested route templates and uses URL identifiers until client data loads", async () => {
    await expect(
      listingMetadata({ params: Promise.resolve({ id: "acme:round-4" }) }),
    ).resolves.toEqual({
      title: { default: "acme:round-4", template: "%s | RFP Hub" },
    });
    await expect(
      opportunityMetadata({ params: Promise.resolve({ id: "acme:round-4" }) }),
    ).resolves.toEqual({ title: "acme:round-4" });
    await expect(
      organizationMetadata({ params: Promise.resolve({ slug: "acme-foundation" }) }),
    ).resolves.toEqual({ title: "Organization acme-foundation" });
    expect(organizationsMetadata).toEqual({
      title: { default: "Organizations", template: "%s | RFP Hub" },
    });
    expect(listingsMetadata).toEqual({
      title: { default: "Your listings", template: "%s | RFP Hub" },
    });
  });
});

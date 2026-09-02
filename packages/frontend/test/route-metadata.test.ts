import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { generateMetadata as listingMetadata } from "@/app/listings/[id]/layout";
import { metadata as listingsMetadata } from "@/app/listings/layout";
import { generateMetadata as opportunityMetadata } from "@/app/opportunities/[id]/layout";
import { generateMetadata as organizationMetadata } from "@/app/organizations/[slug]/layout";
import { metadata as organizationsMetadata } from "@/app/organizations/layout";
import { NOINDEX_ROBOTS, NOINDEX_ROUTE_PREFIXES } from "@/lib/noindex-routes";
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

/**
 * The routes this app WANTS a search engine to carry: the set `src/app/sitemap.ts` publishes, plus
 * `/opportunities/[id]`, which a crawler reaches by following a directory link.
 */
const PUBLIC_ROUTES = [
  "/",
  "/how-it-works",
  "/opportunities/[id]",
  "/privacy",
  "/publishers",
  "/terms",
];

/**
 * The other half, written out rather than computed as "everything else": the previous version of
 * this test compared a filter with the expression that produced it, so it could not fail.
 */
const NOINDEX_ROUTES = [
  "/account",
  "/admin",
  "/auth/complete",
  "/dashboard",
  "/duplicates",
  "/keys",
  "/listings",
  "/listings/[id]",
  "/listings/[id]/edit",
  "/listings/new",
  "/notifications",
  "/organisations/[[...rest]]",
  "/organizations",
  "/organizations/[slug]",
  "/review",
];

/** Next merges metadata down the tree, so a route inherits the nearest ancestor layout's robots. */
function noindexInSource(route: string): boolean {
  const segments = route === "/" ? [] : route.slice(1).split("/");
  for (let depth = segments.length; depth >= 0; depth--) {
    const layout = join(appRoot, ...segments.slice(0, depth), "layout.tsx");
    if (existsSync(layout) && readFileSync(layout, "utf8").includes("NOINDEX_ROBOTS")) return true;
  }
  return false;
}

describe("route metadata", () => {
  it("uses the directory title as the root default and templates every child title", () => {
    // Either file may carry the literal: it moved to lib/root-metadata.ts so a test can import it.
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
      robots: NOINDEX_ROBOTS,
    });
    expect(listingsMetadata).toEqual({
      title: { default: "Your listings", template: "%s | RFP Hub" },
      robots: NOINDEX_ROBOTS,
    });
  });

  // The root layout's `index: true` cascades to every route that does not override it.
  describe("every non-public route overrides indexing off", () => {
    const noindexRoutes = NOINDEX_ROUTES;

    it("is exactly what the layouts on disk mark noindex, and the two halves cover every route", () => {
      // A public route that gains NOINDEX_ROBOTS, or a workbench route that loses it, moves between
      // these two lists and fails here.
      expect(pageRoutes().filter(noindexInSource)).toEqual([...NOINDEX_ROUTES].sort());
      expect(pageRoutes().filter((route) => !noindexInSource(route))).toEqual(
        [...PUBLIC_ROUTES].sort(),
      );
      // And a route added to neither list fails too: the partition has to be exhaustive.
      expect([...PUBLIC_ROUTES, ...NOINDEX_ROUTES].sort()).toEqual(pageRoutes());
    });

    it("has NOINDEX_ROUTE_PREFIXES cover every noindex route and no public route", () => {
      const coveredByPrefix = (route: string) =>
        NOINDEX_ROUTE_PREFIXES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));

      for (const route of noindexRoutes) {
        expect(coveredByPrefix(route), `${route} should match a NOINDEX_ROUTE_PREFIXES entry`).toBe(
          true,
        );
      }
      for (const route of PUBLIC_ROUTES) {
        expect(
          coveredByPrefix(route),
          `${route} must stay public — no prefix should match it`,
        ).toBe(false);
      }
    });

    // The shallowest layout that owns each prefix — listed, because the folder is not always the
    // prefix's own name (there is no src/app/auth/layout.tsx, only .../auth/complete/).
    const OWNING_LAYOUT: Record<(typeof NOINDEX_ROUTE_PREFIXES)[number], string> = {
      "/account": "account/layout.tsx",
      "/admin": "admin/layout.tsx",
      "/auth": "auth/complete/layout.tsx",
      "/dashboard": "dashboard/layout.tsx",
      "/duplicates": "duplicates/layout.tsx",
      "/keys": "keys/layout.tsx",
      "/listings": "listings/layout.tsx",
      "/notifications": "notifications/layout.tsx",
      "/organisations": "organisations/[[...rest]]/layout.tsx",
      "/organizations": "organizations/layout.tsx",
      "/review": "review/layout.tsx",
    };

    it("has every prefix's owning layout actually reference NOINDEX_ROBOTS", () => {
      expect(Object.keys(OWNING_LAYOUT).sort()).toEqual([...NOINDEX_ROUTE_PREFIXES].sort());
      for (const [prefix, layoutPath] of Object.entries(OWNING_LAYOUT)) {
        const source = readFileSync(join(appRoot, layoutPath), "utf8");
        expect(source, `${prefix}'s layout (${layoutPath}) should set NOINDEX_ROBOTS`).toContain(
          "NOINDEX_ROBOTS",
        );
      }
    });

    it("never lets NOINDEX_ROUTE_PREFIXES drift from robots.ts's own Disallow list", () => {
      const robotsSource = readFileSync(join(appRoot, "robots.ts"), "utf8");
      expect(robotsSource).toContain("NOINDEX_ROUTE_PREFIXES");
    });
  });
});

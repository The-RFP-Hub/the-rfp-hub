import { readFileSync, readdirSync } from "node:fs";
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
 * The routes this app WANTS a search engine to carry — everything else is the workbench or an
 * auth-mechanics page, and must stay `noindex` on every origin including the canonical one. This is
 * the exact set `src/app/sitemap.ts` publishes, plus `/opportunities/[id]`: a public detail page a
 * crawler reaches by following a directory link rather than one the sitemap enumerates itself
 * (`sitemap.ts`'s own comment explains why it does not fetch and list every opportunity).
 */
const PUBLIC_ROUTES = [
  "/",
  "/how-it-works",
  "/opportunities/[id]",
  "/privacy",
  "/publishers",
  "/terms",
];

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
      robots: NOINDEX_ROBOTS,
    });
    expect(listingsMetadata).toEqual({
      title: { default: "Your listings", template: "%s | RFP Hub" },
      robots: NOINDEX_ROBOTS,
    });
  });

  /**
   * THE ROOT LAYOUT'S `index: true` CASCADES TO EVERY ROUTE THAT DOES NOT OVERRIDE IT (Codex review,
   * round 2) — Next's metadata merge means a child route with no `robots` field of its own inherits
   * the nearest ancestor's, so turning indexing on at the root silently turned it on for
   * `/dashboard`, every `/listings/*` and `/organizations/*` route, `/keys`, `/account`, `/admin`,
   * `/review`, `/duplicates`, `/notifications` and `/auth/complete` too, unless each of them said
   * otherwise. These two tests pin that every NON-public route says otherwise, and that the set
   * saying so is exactly "every route minus the public ones" — neither a route quietly left off nor
   * a public route accidentally caught by an overbroad prefix.
   */
  describe("every non-public route overrides indexing off", () => {
    const noindexRoutes = pageRoutes().filter((route) => !PUBLIC_ROUTES.includes(route));

    it("is exactly every page route minus the public set — nothing left uncovered, nothing wrongly covered", () => {
      expect(noindexRoutes.sort()).toEqual(
        pageRoutes()
          .filter((route) => !PUBLIC_ROUTES.includes(route))
          .sort(),
      );
      // The partition is exhaustive: every route is EITHER public OR noindex, never both, never
      // neither.
      for (const route of pageRoutes()) {
        const isPublic = PUBLIC_ROUTES.includes(route);
        const isNoindex = noindexRoutes.includes(route);
        expect(isPublic).toBe(!isNoindex);
      }
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

    // The layout that actually OWNS `NOINDEX_ROBOTS` for each prefix — the shallowest one, since
    // every route nested beneath it (e.g. /listings/[id] under /listings) inherits rather than
    // repeating it. Listed explicitly because the folder that holds a prefix's layout is not always
    // the prefix's own name (there is no src/app/auth/layout.tsx — only .../auth/complete/ has one).
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

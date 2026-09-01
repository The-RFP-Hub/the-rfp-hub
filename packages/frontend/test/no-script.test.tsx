/**
 * The one thing a scriptless reader gets: where the same data lives as JSON.
 *
 * `/` renders its list after hydration, so with scripting off there is nothing on the page — and
 * that is also what a crawler which does not execute JavaScript sees, on the origin the robots
 * rules now allow one to index.
 *
 * ASSERTED AGAINST THE SERVER-RENDERED MARKUP, not a client render: React DOM leaves a `<noscript>`
 * empty in the browser (nothing there will ever be displayed), so the HTML the framework actually
 * sends is the only place this notice exists.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NoScriptNotice } from "@/components/NoScriptNotice";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("the no-JavaScript notice", () => {
  it("names the public JSON endpoint of the configured API", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    const html = renderToStaticMarkup(<NoScriptNotice />);

    expect(html.startsWith("<noscript>")).toBe(true);
    expect(html).toContain("https://api.example.com/v1/opportunities");
  });

  it("is rendered by the public directory page, the surface with nothing else to show", () => {
    // Read from disk rather than rendered: the page pulls in the session provider and the whole
    // directory, and what has to be true here is one line of wiring.
    const source = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(source).toContain("<NoScriptNotice />");
  });

  it("names the variable rather than inventing an origin when the API is unconfigured", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const html = renderToStaticMarkup(<NoScriptNotice />);

    expect(html).toContain("NEXT_PUBLIC_API_URL");
    expect(html).not.toContain("undefined");
  });
});

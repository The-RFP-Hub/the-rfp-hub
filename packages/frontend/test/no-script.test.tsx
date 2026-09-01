/**
 * ASSERTED AGAINST THE SERVER-RENDERED MARKUP, not a client render: React DOM leaves a `<noscript>`
 * empty in the browser, so the HTML the framework sends is the only place this notice exists.
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
    // Read from disk: rendering the page pulls in the session provider and the whole directory.
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

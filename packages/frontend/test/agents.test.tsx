import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "@/app/llms.txt/route";
import { AgentsGuide } from "@/components/AgentsGuide";
import { MCP_VERSION, agentPrompt, llmsTxt } from "@/lib/agents";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({
    get: (key: string) => (key === "host" ? "rfphub.example" : null),
  }),
}));

const origins = { siteOrigin: "https://rfphub.example", apiBaseUrl: "https://api.rfphub.example" };

function links(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] as string);
}

describe("the MCP version agents are told to install", () => {
  it("is the version packages/mcp releases", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "..", "mcp", "package.json"), "utf8"),
    ) as { version: string };
    expect(MCP_VERSION).toBe(manifest.version);
  });
});

describe("llms.txt", () => {
  it("follows the llms.txt shape: a title, a summary quote, then sections of links", () => {
    const text = llmsTxt(origins);
    const lines = text.split("\n");
    expect(lines[0]).toBe("# RFP Hub");
    expect(lines[2]?.startsWith("> ")).toBe(true);
    expect(text).toMatch(/^## Search the index$/m);
    expect(text).not.toContain("undefined");
  });

  it("points every in-house link at this deployment's site and API", () => {
    const own = links(llmsTxt(origins)).filter((url) => !url.startsWith("https://github.com/"));
    expect(own.length).toBeGreaterThan(8);
    for (const url of own) {
      expect(url.startsWith(origins.siteOrigin) || url.startsWith(origins.apiBaseUrl)).toBe(true);
    }
    expect(own).toContain(`${origins.apiBaseUrl}/v1/docs/json`);
    expect(own).toContain(`${origins.siteOrigin}/agents`);
  });

  it("is served as plain text from the request's own origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.rfphub.example/");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(llmsTxt(origins));
  });

  it("says so when the API is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const response = await GET();
    expect(response.status).toBe(500);
  });
});

describe("the agents page", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("shows the whole prompt and copies exactly what it shows", async () => {
    const { container } = render(<AgentsGuide {...origins} />);
    const prompt = agentPrompt(origins);
    expect(container.querySelector("pre")?.textContent).toBe(prompt);
    expect(prompt).toContain(`${origins.siteOrigin}/llms.txt`);
    expect(prompt).toContain(`@the-rfp-hub/mcp@${MCP_VERSION}`);

    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("says when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<AgentsGuide {...origins} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(await screen.findByText(/Could not copy/)).toBeTruthy();
  });

  it("links to llms.txt and to this deployment's API documentation", () => {
    render(<AgentsGuide {...origins} />);
    expect(screen.getAllByRole("link", { name: "llms.txt" })[0]?.getAttribute("href")).toBe(
      "/llms.txt",
    );
    expect(screen.getByRole("link", { name: "API reference" }).getAttribute("href")).toBe(
      `${origins.apiBaseUrl}/v1/docs`,
    );
  });
});

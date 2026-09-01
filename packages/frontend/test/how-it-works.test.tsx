/**
 * THE REFERENCE PAGE'S SHAPE IS A CONTRACT.
 *
 * Access errors send readers straight to `#roles`, the publishing pathway is useful only when its
 * links remain honest, and the permission matrix is intentionally the only table. These assertions
 * pin that public structure while leaving the explanatory copy free to improve.
 */
import HowItWorksPage from "@/app/how-it-works/page";
import { GOVERNANCE, PUBLISHERS_DOC, REVIEW_CRITERIA, RFC_PROCESS } from "@/lib/links";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("the how-it-works reference page", () => {
  it("keeps the role summary open and directly addressable", () => {
    const { container } = render(<HowItWorksPage />);
    const roles = container.ownerDocument.getElementById("roles");

    expect(roles).toBeTruthy();
    expect(roles?.tagName).toBe("H2");
    expect(roles?.closest("details")).toBeNull();
    expect(roles?.nextElementSibling?.tagName).toBe("DL");
  });

  it("keeps one permission matrix with the five exact role headers", () => {
    const { container } = render(<HowItWorksPage />);
    const table = within(container).getByRole("table");

    expect(screen.getByRole("heading", { name: "Who can do what" })).toBeTruthy();
    expect(within(container).getAllByRole("table")).toHaveLength(1);
    expect(table.querySelectorAll("tbody")).toHaveLength(3);
    expect(table.querySelectorAll(".matrix-band")).toHaveLength(3);
    expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(17);
    for (const name of [
      "Visitor",
      "Submitter",
      "Verified org member",
      "Hub reviewer",
      "Hub admin",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
  });

  it("links every publishing step to its real destination", () => {
    const { container } = render(<HowItWorksPage />);
    const pathway = container.querySelector("#publish");

    expect(pathway).toBeTruthy();
    expect(
      within(pathway as HTMLElement)
        .getByRole("link", { name: "Sign in." })
        .getAttribute("href"),
    ).toBe("/dashboard");
    expect(
      within(pathway as HTMLElement)
        .getByRole("link", { name: "Submit the opportunity." })
        .getAttribute("href"),
    ).toBe("/listings/new");
    expect(
      within(pathway as HTMLElement)
        .getByRole("link", {
          name: "Get your organization verified — optional, and it is what removes the wait.",
        })
        .getAttribute("href"),
    ).toBe("/organizations");
    expect(
      within(pathway as HTMLElement)
        .getByRole("link", { name: "Open it in the directory" })
        .getAttribute("href"),
    ).toBe("/");
  });

  it("starts every explanation closed and offers no primary button", () => {
    const { container } = render(<HowItWorksPage />);
    const details = [...container.querySelectorAll("details")];

    expect(details).toHaveLength(3);
    for (const detail of details) {
      expect(detail.open).toBe(false);
    }
    expect(container.querySelector(".button-primary")).toBeNull();
  });

  it("links how decisions are made to the four governance documents, inside that section", () => {
    const { container } = render(<HowItWorksPage />);

    // The region, not the page: scoping to the nearest `<section>` used to resolve to the page's
    // single root element, so the four links could have sat anywhere and the test still passed.
    const decisions = screen.getByRole("region", { name: "How decisions are made" });
    expect(container.querySelector("#decisions")).toBe(decisions.querySelector("h2#decisions"));

    for (const [name, href] of [
      ["Governance", GOVERNANCE],
      ["Publishers", PUBLISHERS_DOC],
      ["Review criteria", REVIEW_CRITERIA],
      ["RFC process", RFC_PROCESS],
    ] as const) {
      expect(within(decisions).getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
  });
});

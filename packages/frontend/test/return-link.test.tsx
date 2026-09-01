/**
 * THE CONSUMER SIDE: a detail page renders the way back only when the way back is real.
 *
 * `return-to.test.ts` pins the rules; this pins that the component obeys them, because the failure
 * mode is a rendered link rather than a wrong boolean — a "← Back to your listings" control that
 * navigates to somebody else's site is the specific thing being prevented.
 */
import { ReturnLink } from "@/components/ReturnLink";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: { current: "" } }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query.current),
}));

const mount = (search: string) => {
  query.current = search;
  return render(<ReturnLink />);
};

beforeEach(() => {
  query.current = "";
});

describe("the labelled way back", () => {
  it("names a review queue it was sent from", () => {
    mount("back=%2Freview%3Ftab%3Dclaims");

    const link = screen.getByRole("link", { name: /Back to the claims queue/ });
    // The origin's own query state survives, so the reader returns to the tab they left.
    expect(link.getAttribute("href")).toBe("/review?tab=claims");
    expect(link.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it("names an organization by the name the origin supplied, not by its slug", () => {
    mount("back=%2Forganizations%2Ffilecoin&backLabel=Filecoin+Foundation");

    expect(screen.getByRole("link", { name: /Back to Filecoin Foundation/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Filecoin Foundation/ }).getAttribute("href")).toBe(
      "/organizations/filecoin",
    );
  });

  it("renders nothing at all when there is no origin", () => {
    const { container } = mount("");
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders nothing for an origin that leaves this site", () => {
    for (const hostile of [
      "back=%2F%2Fevil.example",
      "back=https%3A%2F%2Fevil.example",
      "back=javascript%3Aalert(1)",
      "back=%2Flistingsevil",
    ]) {
      const { container, unmount } = mount(hostile);
      expect(container.querySelector("a")).toBeNull();
      unmount();
    }
  });

  it("ignores a label attached to a path that names itself", () => {
    // A crafted link cannot relabel the review queue as something else.
    mount("back=%2Freview&backLabel=Your+Bank+Login");

    expect(screen.getByRole("link", { name: /Back to the review queue/ })).toBeTruthy();
    expect(screen.queryByText(/Bank/)).toBeNull();
  });
});

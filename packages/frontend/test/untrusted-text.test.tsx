import { UntrustedLink, UntrustedText } from "@/components/UntrustedText";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("untrusted text overflow hooks", () => {
  it("marks an uninterrupted title and its fallback for defensive wrapping", () => {
    const title = "PublisherSuppliedTitle".repeat(16);
    const { rerender } = render(<UntrustedText value={title} className="row-title" />);

    expect(screen.getByText(title).className).toContain("row-title");
    expect(screen.getByText(title).className).toContain("untrusted-text");

    rerender(<UntrustedText value="" />);
    expect(screen.getByText("—").className).toContain("untrusted-text");
  });

  it("marks safe and unsafe uninterrupted URLs without changing their safety behavior", () => {
    const safe = `https://example.com/${"segment".repeat(30)}`;
    const { rerender } = render(<UntrustedLink href={safe} />);

    const link = screen.getByRole("link", { name: safe });
    expect(link.className).toContain("untrusted-link");
    expect(link.getAttribute("href")).toBe(safe);

    const unsafe = `javascript:${"payload".repeat(30)}`;
    rerender(<UntrustedLink href={unsafe} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(unsafe).className).toContain("untrusted-link");
  });
});

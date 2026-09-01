import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * THE SHARED FURNITURE, PROVEN RATHER THAN EYEBALLED: the read state machine, the failure states
 * every page renders through it, and the badges that carry editorial state.
 *
 * None of this is a feature anybody asked for by name, and all of it is what a reader actually
 * experiences. A refetch that blanks the screen, a 401 that offers no way back in, an empty list
 * with no next step and a badge whose meaning lives only in a colour are four different pages'
 * worth of complaints with one root each — so they are checked here, once, instead of being
 * re-asserted at every call site.
 */
import { isCurrent } from "@/components/Chrome";
import {
  ListedBadge,
  MatchBadge,
  ReviewStatusBadge,
  StatusBadge,
  VerifiedBadge,
} from "@/components/badges";
import { EmptyState, ErrorState, Loading, ResourceView } from "@/components/states";
import { ApiError } from "@/lib/api";
import { RESOURCE_TIMEOUT_MS, useResource } from "@/lib/resource";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ useResource --- */

/** A read that never settles, so the hook's own timeout is the only thing that can end it. */
function NeverSettles({ timeoutMs }: { timeoutMs: number }) {
  const load = useCallback(() => new Promise<string>(() => {}), []);
  const { state, reload } = useResource(load, { timeoutMs });
  return (
    <ResourceView resource={state} what="the list" onRetry={reload}>
      {(data) => <p>{data}</p>}
    </ResourceView>
  );
}

/**
 * A harness whose loader can be resolved by hand, so the IN-FLIGHT moment — the one this change is
 * about — can be inspected rather than raced against.
 */
function Harness({ load }: { load: (attempt: number) => Promise<string> }) {
  const [attempt, setAttempt] = useState(0);
  const loader = useCallback(() => load(attempt), [load, attempt]);
  const { state, reload } = useResource(loader);

  return (
    <div>
      <button type="button" onClick={() => setAttempt((n) => n + 1)}>
        change the query
      </button>
      <button type="button" onClick={reload}>
        reload
      </button>
      <ResourceView resource={state} what="the list">
        {(data) => <p>{data}</p>}
      </ResourceView>
      {state.status === "ready" && state.stale ? <span>refreshing</span> : null}
    </div>
  );
}

describe("useResource", () => {
  it("gives up on a read that never answers, instead of spinning forever", async () => {
    render(<NeverSettles timeoutMs={20} />);
    expect(screen.getByText(/Loading the list/)).toBeTruthy();

    expect(await screen.findByText(/We couldn’t load the list/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(within(details).getByText("timeout")).toBeTruthy();
  });

  it("defaults to a bound a reader would actually wait out", () => {
    expect(RESOURCE_TIMEOUT_MS).toBe(30_000);
  });

  /** A promise with its resolver pulled out, so a test can decide when a read finishes. */
  function deferred<T>() {
    let settle!: (value: T) => void;
    let fail!: (reason: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return { promise, settle, fail };
  }

  it("says it is loading for the FIRST read, when there is nothing else it could honestly show", async () => {
    const first = deferred<string>();
    render(<Harness load={() => first.promise} />);

    const loading = screen.getByText(/Loading the list/).closest("output");
    expect(loading).toBeTruthy();
    expect(loading?.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    await act(async () => first.settle("first answer"));
    expect(screen.getByText("first answer")).toBeTruthy();
  });

  it("KEEPS THE PREVIOUS ANSWER ON SCREEN while a refetch is in flight", async () => {
    const reads = [deferred<string>(), deferred<string>()];
    let call = 0;
    render(<Harness load={() => reads[call++]?.promise ?? Promise.resolve("extra")} />);

    await act(async () => reads[0]?.settle("first answer"));
    expect(screen.getByText("first answer")).toBeTruthy();

    // The regression this exists for: every mutation in the workbench and every filter change in
    // the directory ends in a re-run, and each one used to blank the surface to a single line and
    // rebuild it a moment later. A reviewer working a queue lost the list they had just acted on;
    // a reader paging the directory lost their place on every click.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(screen.getByText("first answer")).toBeTruthy();
    expect(screen.queryByText(/Loading the list/)).toBeNull();
    // And it is LABELLED stale rather than passed off as current.
    expect(screen.getByText("refreshing")).toBeTruthy();

    await act(async () => reads[1]?.settle("second answer"));
    expect(screen.getByText("second answer")).toBeTruthy();
    expect(screen.queryByText("refreshing")).toBeNull();
  });

  it("keeps it across a CHANGED loader too — a new filter is a refetch, not a new page", async () => {
    const reads = [deferred<string>(), deferred<string>()];
    render(<Harness load={(attempt) => reads[attempt]?.promise ?? Promise.resolve("extra")} />);

    await act(async () => reads[0]?.settle("page 1"));
    fireEvent.click(screen.getByRole("button", { name: "change the query" }));

    expect(screen.getByText("page 1")).toBeTruthy();
    expect(screen.getByText("refreshing")).toBeTruthy();
    await act(async () => reads[1]?.settle("page 2"));
    expect(screen.getByText("page 2")).toBeTruthy();
  });

  it("does NOT keep it across a failure — stale numbers under a failed refresh are a lie", async () => {
    const reads = [deferred<string>(), deferred<string>()];
    let call = 0;
    render(<Harness load={() => reads[call++]?.promise ?? Promise.resolve("extra")} />);

    await act(async () => reads[0]?.settle("first answer"));
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await act(async () => {
      reads[1]?.fail(new ApiError(500, "internal_error", "The API fell over."));
      await Promise.resolve();
    });

    // The read failed. A dashboard that went on showing the last good numbers under a broken
    // refresh is a dashboard reporting figures that are quietly hours old.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText("first answer")).toBeNull();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("The API fell over.")).toBeTruthy();
  });
});

/* --------------------------------------------------------------------- states --- */

describe("ErrorState", () => {
  it("tells a 401 apart from every other failure, and offers the one thing that helps", () => {
    const login = vi.fn();
    render(
      <ErrorState
        error={new ApiError(401, "unauthenticated", "No session was presented.")}
        what="your listings"
        onRetry={() => {}}
        onLogin={login}
      />,
    );

    expect(screen.getByText("Your sign-in has ended.")).toBeTruthy();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("No session was presented.")).toBeTruthy();
    expect(within(details).getByText("unauthenticated")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Log in again" }));
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("NEVER offers a login for a 403, because signing in again cannot help", () => {
    render(
      <ErrorState
        error={new ApiError(403, "forbidden", "This account may not run the review queues.")}
        what="the review queue"
        onRetry={() => {}}
        onLogin={() => {}}
      />,
    );

    // Authenticated and refused are not the same state. Sending somebody round a login loop that
    // ends exactly where it started is the worst thing this component could do.
    expect(screen.queryByRole("button", { name: "Log in again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText(/You don’t have access to the review queue/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Check your account" }).getAttribute("href")).toBe(
      "/account",
    );
    expect(screen.getByRole("link", { name: "See who can do what" }).getAttribute("href")).toBe(
      "/how-it-works#roles",
    );
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("forbidden")).toBeTruthy();
  });

  it("does not invite an immediate retry after a 429, and says how long to wait", () => {
    render(
      <ErrorState
        error={new ApiError(429, "rate_limited", "Too many requests.", undefined, 30)}
        what="the directory"
        onRetry={() => {}}
      />,
    );

    // A retry button here fires the request that was just refused, and gets refused again.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText(/Wait about 30 seconds/)).toBeTruthy();
  });

  it("falls back to a vaguer wait when no Retry-After was readable", () => {
    render(
      <ErrorState
        error={new ApiError(429, "rate_limited", "Too many requests.")}
        what="the directory"
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText(/Wait a moment/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps generic diagnostics in a closed disclosure", () => {
    render(
      <ErrorState
        error={new ApiError(0, "network_error", "Could not reach the API.")}
        what="the directory"
      />,
    );

    expect(screen.getByText(/We couldn’t load the directory/)).toBeTruthy();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("0 (no response)")).toBeTruthy();
    expect(within(details).getByText("network_error")).toBeTruthy();
  });

  it("gives a 404 a directory action and no retry", () => {
    render(
      <ErrorState
        error={new ApiError(404, "not_found", "No opportunity matched this id.")}
        what="this listing"
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText(/We couldn’t find this listing/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Search the directory" }).getAttribute("href")).toBe(
      "/",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("No opportunity matched this id.")).toBeTruthy();
  });
});

describe("the empty and loading states", () => {
  it("gives an empty state its next step rather than a bordered dead end", () => {
    render(
      <EmptyState
        title="You have not submitted anything yet."
        detail="Everything you submit shows up here."
        action={<a href="/listings/new">Submit an opportunity</a>}
      />,
    );

    expect(screen.getByRole("link", { name: "Submit an opportunity" })).toBeTruthy();
  });

  it("reserves the loading state's height, so the page does not jump under a reaching hand", () => {
    const { container } = render(<Loading what="the directory" />);
    // The height is a stylesheet rule keyed off this class; what is checkable here is that the
    // class is actually applied, which is the half that regresses.
    expect(container.querySelector(".state.loading")).toBeTruthy();
  });
});

/* --------------------------------------------------------------------- badges --- */

describe("badges carry meaning without colour", () => {
  it("gives every state a word and a shape, and never an inline colour", () => {
    const { container } = render(
      <>
        <StatusBadge status="open" />
        <StatusBadge status="closed" />
        <ReviewStatusBadge status="pending" />
        <ReviewStatusBadge status="rejected" />
        <ListedBadge isListed={false} reviewStatus="approved" />
        <MatchBadge matched={null} />
      </>,
    );

    // The WORD is the primary carrier. A screenshot in greyscale, a printout and a colourblind
    // reader all get the same information as the screen.
    for (const word of [
      "Open",
      "Closed",
      "Waiting for review",
      "Rejected",
      "Hidden from the public directory",
      "not checked",
    ]) {
      expect(screen.getByText(word)).toBeTruthy();
    }
    // The SHAPE is a class the stylesheet turns into an outline, a fill, a dash or a strike.
    for (const badge of container.querySelectorAll(".badge")) {
      expect(badge.className).toMatch(/badge-/);
      expect(badge.getAttribute("style")).toBeNull();
    }
  });

  it("distinguishes a public listing from a pending public preference", () => {
    const { rerender } = render(<ListedBadge isListed reviewStatus="pending" />);

    expect(screen.getByText("Will appear once approved")).toBeTruthy();
    expect(screen.queryByText("Visible in the public directory")).toBeNull();
    expect(screen.getByText("Will appear once approved").className).toContain("badge-pending");

    rerender(<ListedBadge isListed reviewStatus="approved" />);
    expect(screen.getByText("Visible in the public directory").className).toContain("badge-listed");
  });

  it("says what a verification verdict is NOT, in the badge's own title", () => {
    render(<MatchBadge matched={true} />);
    expect(screen.getByText("link looks right").getAttribute("title")).toMatch(/not a fact-check/);
  });

  it("names failed link checks by reachability without striking them through", () => {
    const { rerender } = render(<MatchBadge matched={false} existsAtSource={false} />);
    expect(screen.getByText("link not reachable").getAttribute("title")).toMatch(
      /could not be reached/,
    );

    rerender(<MatchBadge matched={false} existsAtSource />);
    expect(screen.getByText("content did not match").getAttribute("title")).toMatch(/was reached/);

    rerender(<MatchBadge matched={false} />);
    expect(screen.getByText("link check failed")).toBeTruthy();

    const unmatchedRule = readFileSync(
      join(process.cwd(), "src", "app", "globals.css"),
      "utf8",
    ).match(/\.badge-unmatched\s*\{([^}]*)\}/)?.[1];
    expect(unmatchedRule).not.toContain("line-through");
  });

  it("puts the consequence of verification ON SCREEN where a member has to act on it", () => {
    // A tooltip does not exist on a touch device and is not reliably announced. The account page
    // is where somebody works out what their membership actually gets them, so the sentence is
    // beside the badge rather than only behind a hover.
    const { rerender } = render(<VerifiedBadge verified gloss />);
    expect(screen.getByText(/publish immediately/)).toBeTruthy();

    rerender(<VerifiedBadge verified={false} gloss />);
    expect(screen.getByText(/wait for a reviewer/)).toBeTruthy();

    // Without the flag it is the bare badge, for the dense tables that have no room for a sentence.
    rerender(<VerifiedBadge verified />);
    expect(screen.queryByText(/publish immediately/)).toBeNull();
    expect(screen.getByText("Verified").getAttribute("title")).toMatch(/without review/);
  });
});

/* ---------------------------------------------------------- the accent discipline --- */

/**
 * THE ACCENT IS RATIONED, AND THIS IS THE RATION, ENFORCED.
 *
 * One olive accent exists on this site and it means exactly one thing: HERE IS WHERE YOU CAN ACT.
 * The primary button, native selected controls, the focus ring, the current-section underline, the
 * link colour, and the tint under a hovered control or row. That is the whole list.
 *
 * It is barred from every state, verdict and category — status, review status, listing,
 * verification, success, error, warning, chart bars — because those are read by people who cannot
 * see it, printed in black and white, and pasted into bug reports as greyscale screenshots. The
 * moment a colour is the thing that distinguishes "approved" from "rejected", the design has
 * quietly stopped working for a fair number of its readers.
 *
 * The scan reads the STYLESHEET rather than a rendered page: jsdom does not apply an external
 * stylesheet, and the rule being protected is a rule about the source. A rendered-DOM assertion
 * would pass forever while the CSS said something else entirely.
 */
describe("the accent never carries state", () => {
  const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

  /** Every `selector { … }` rule in the sheet, comments stripped so prose cannot trip the scan. */
  const rules: { selector: string; body: string }[] = [
    ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map((match) => ({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" }));

  it("finds a stylesheet with rules in it at all", () => {
    // Without this, a rename or a failed read would make every assertion below vacuously pass.
    expect(rules.length).toBeGreaterThan(50);
    expect(rules.some((rule) => rule.body.includes("--accent"))).toBe(true);
  });

  it("names NO accent token on a badge, a state, a note or a chart", () => {
    // Each of these carries meaning. Meaning is typographic here: weight, case, border style, fill.
    const forbidden = /\.badge|\.note\b|\.state\b|\.bar\b|\.tile-value|\.empty-title/;
    const offenders = rules
      .filter((rule) => forbidden.test(rule.selector) && rule.body.includes("--accent"))
      .map((rule) => rule.selector);
    expect(offenders).toEqual([]);
  });

  it("spends the accent ONLY on action, focus, current-section, links and hover", () => {
    // The complete allowlist, written out. A new accent usage fails this test until somebody adds
    // it here on purpose — which is the review this discipline is asking for.
    const allowed = [
      "a", // textual links on paper
      "button:hover",
      ".button:hover",
      'button[aria-pressed="true"],\nbutton[aria-selected="true"]',
      ".button-primary",
      ".button-primary:hover",
      'input[type="range"],\ninput[type="radio"],\ninput[type="checkbox"]',
      '.shell-nav a[aria-current="page"]',
      ".section-nav a:hover",
      '.section-nav a[aria-current="page"]',
      ".shell-footer a",
      "tbody tr:hover",
    ];
    const normalise = (selector: string) => selector.replace(/\s+/g, " ").trim();
    const allowlist = new Set(allowed.map(normalise));
    const used = rules
      .filter((rule) => rule.body.includes("var(--accent"))
      .map((rule) => normalise(rule.selector))
      // The focus ring is one rule listing every focusable element; match it by shape.
      .filter((selector) => !selector.includes("focus-visible"));

    for (const selector of used) expect([...allowlist]).toContain(selector);
  });

  it("uses the action accent for native range, radio and checkbox controls", () => {
    const native = rules.find(
      (rule) => rule.selector.includes('input[type="range"]') && rule.selector.includes("radio"),
    );
    expect(native?.selector).toContain('input[type="checkbox"]');
    expect(native?.body).toContain("accent-color: var(--accent)");
  });

  it("emphasises live listings while terminal badges remain quiet outlines", () => {
    const live = rules.find((rule) => rule.selector === ".badge-live");
    const terminal = rules.find((rule) => rule.selector.includes(".badge-merged"));
    expect(live?.body).toContain("background: var(--ink)");
    expect(terminal?.body).toContain("border-color: var(--line)");
    expect(terminal?.body).not.toContain("background:");
  });

  it("keeps links inside error summaries in the error hue", () => {
    const errorLink = rules.find((rule) => rule.selector === ".state.error a");
    expect(errorLink?.body).toContain("color: var(--bad)");
    expect(errorLink?.body).toContain("text-decoration-thickness: 2px");
  });

  it("keeps the focus ring on the accent, at 2px, for everything focusable", () => {
    const focus = rules.find((rule) => rule.selector.includes("focus-visible"));
    expect(focus?.body).toContain("outline: 2px solid var(--accent)");
    // One rule, not one per control — a focus ring that some controls miss is worse than none,
    // because the reader learns to trust it.
    for (const element of ["input", "select", "textarea", "button", "a"]) {
      expect(focus?.selector).toContain(`${element}:focus-visible`);
    }
  });

  it("declares an sRGB fallback before every oklch accent", () => {
    // oklch is the source of truth; the hex before it is the same colour for anything that cannot
    // parse the second declaration. A token with only the oklch form would resolve to nothing.
    for (const token of ["--accent", "--accent-ink", "--accent-soft"]) {
      const hex = new RegExp(`${token}:\\s*#[0-9a-f]{6};`);
      const oklch = new RegExp(`${token}:\\s*oklch\\(`);
      expect(css).toMatch(hex);
      expect(css).toMatch(oklch);
      expect(css.indexOf(`${token}: #`)).toBeLessThan(css.indexOf(`${token}: oklch`));
    }
  });

  it("gives form errors and warnings fallback-backed hues while badges stay hueless", () => {
    expect(css).toMatch(/--ok:\s*var\(--ink/);
    for (const token of ["--warn", "--warn-soft", "--bad", "--bad-soft"]) {
      const hex = new RegExp(`${token}:\\s*#[0-9a-f]{6};`);
      const oklch = new RegExp(`${token}:\\s*oklch\\(`);
      expect(css).toMatch(hex);
      expect(css).toMatch(oklch);
      expect(css.indexOf(`${token}: #`)).toBeLessThan(css.indexOf(`${token}: oklch`));
    }
    const form = readFileSync(
      join(process.cwd(), "src", "components", "OpportunityForm.module.css"),
      "utf8",
    );
    expect(form).not.toContain("--accent");
  });
});

/* ------------------------------------------------------------------ navigation --- */

describe("the navigation's current-section mark", () => {
  it("marks the SECTION, not only its index page", () => {
    // The one moment a reader most needs to know where they are is three levels into a form, and
    // an exact-match comparison left the whole navigation unmarked on every page except a
    // section's own index.
    expect(isCurrent("/listings", "/listings")).toBe(true);
    expect(isCurrent("/listings/acme:round-4", "/listings")).toBe(true);
    expect(isCurrent("/listings/acme:round-4/edit", "/listings")).toBe(true);
  });

  it("does not mark a section whose name merely starts the same way", () => {
    expect(isCurrent("/listings-archive", "/listings")).toBe(false);
    expect(isCurrent("/keys", "/listings")).toBe(false);
  });

  it("keeps the directory exact, because '/' prefixes everything", () => {
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/listings", "/")).toBe(false);
  });
});

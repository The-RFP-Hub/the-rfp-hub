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
import { useResource } from "@/lib/resource";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ useResource --- */

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

    expect(screen.getByText(/Loading the list/)).toBeTruthy();
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
    expect(screen.getByText("The API fell over.")).toBeTruthy();
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

    expect(screen.getByText("The API did not accept this session.")).toBeTruthy();
    // The API's own sentence survives the framing — this branch is reached both by a session that
    // aged out mid-task and by a one-shot credential that had already been spent, and only the
    // API knows which.
    expect(screen.getByText("No session was presented.")).toBeTruthy();

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
    expect(screen.getByText(/may not read the review queue/)).toBeTruthy();
    expect(screen.getByText(/403 · forbidden/)).toBeTruthy();
  });

  it("still quotes the code for everything else, so a bug report can carry it", () => {
    render(
      <ErrorState
        error={new ApiError(0, "network_error", "Could not reach the API.")}
        what="the directory"
      />,
    );

    expect(screen.getByText(/no response · network_error/)).toBeTruthy();
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
        <ListedBadge isListed={false} />
        <MatchBadge matched={null} />
      </>,
    );

    // The WORD is the primary carrier. A screenshot in greyscale, a printout and a colourblind
    // reader all get the same information as the screen.
    for (const word of ["open", "closed", "pending", "rejected", "unlisted", "not checked"]) {
      expect(screen.getByText(word)).toBeTruthy();
    }
    // The SHAPE is a class the stylesheet turns into an outline, a fill, a dash or a strike.
    for (const badge of container.querySelectorAll(".badge")) {
      expect(badge.className).toMatch(/badge-/);
      expect(badge.getAttribute("style")).toBeNull();
    }
  });

  it("says what a verification verdict is NOT, in the badge's own title", () => {
    render(<MatchBadge matched={true} />);
    expect(screen.getByText("link looks right").getAttribute("title")).toMatch(/not a fact-check/);
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
    expect(screen.getByText("verified").getAttribute("title")).toMatch(/without review/);
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

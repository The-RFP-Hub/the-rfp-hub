"use client";

/**
 * One asynchronous read, as a state a page must render every branch of.
 *
 * The point of modelling it as a union rather than three loose booleans is that TypeScript then
 * refuses to compile a page that renders `data` without having handled `loading` and `error`. Every
 * screen in this frontend therefore has an honest empty, loading and failure state — not because a
 * reviewer remembered to ask for one, but because the type would not typecheck otherwise.
 *
 * A REFETCH KEEPS THE PREVIOUS ANSWER ON SCREEN, and this is the one behaviour in this module that
 * a user can feel. Every mutation in the workbench ends in `reload()`, and every page-change and
 * filter-change in the directory re-runs the loader — and each of those used to blank the surface
 * to "Loading…" and rebuild it a moment later. For a reviewer working a queue that meant the list
 * they had just acted on vanished, the page collapsed to one line, and everything below jumped;
 * for a reader paging the directory it meant losing their place on every click. So a re-run of an
 * already-loaded resource stays `ready`, holding the OLD data, with `stale: true` — the data is
 * honestly labelled as the previous answer rather than pretended to be the current one, and a
 * caller that cares (a "refreshing…" hint, a dimmed table) can say so.
 *
 * WHAT IS DELIBERATELY NOT KEPT: a FAILURE replaces the data. Showing the last good answer under a
 * failed refresh is how a dashboard reports numbers that are quietly minutes or hours old; the read
 * failed, and the page says so.
 *
 * There is still no cache shared between components and no background revalidation. See
 * `lib/api.ts` for why.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export type Resource<T> =
  | { status: "idle" }
  | { status: "loading" }
  /** `stale` means: this is the PREVIOUS answer and a newer read is in flight. */
  | { status: "ready"; data: T; stale: boolean }
  | { status: "error"; error: ApiError };

/**
 * A loading state has no end of its own: an API that accepts the connection and never answers
 * leaves the page spinning until the reader closes the tab.
 */
export const RESOURCE_TIMEOUT_MS = 30_000;

export interface ResourceHandle<T> {
  state: Resource<T>;
  /** Re-run the loader — after a mutation, or from a "try again" button on the error state. */
  reload: () => void;
}

/**
 * `load` must be stable (wrap it in `useCallback`): it is the dependency that decides when a read
 * re-runs, so an inline arrow would re-fetch on every render.
 *
 * `enabled: false` holds the resource at `idle`, which is what a page uses while it is still
 * waiting to know whether anybody is logged in. `idle` is not `loading`: showing a spinner for a
 * request that was never made is a lie about what the page is doing.
 */
export function useResource<T>(
  load: () => Promise<T>,
  options?: { enabled?: boolean; timeoutMs?: number },
): ResourceHandle<T> {
  const enabled = options?.enabled ?? true;
  const timeoutMs = options?.timeoutMs ?? RESOURCE_TIMEOUT_MS;
  const [state, setState] = useState<Resource<T>>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  // Guards against a resolved response from a superseded read overwriting a newer one, and against
  // setting state on an unmounted tree.
  const generation = useRef(0);

  // `nonce` is not READ by the effect below — it is the re-run trigger. `reload()` increments it,
  // and listing it as a dependency is what turns that increment into another execution of exactly
  // this effect. Removing it, as the rule suggests, would leave the "try again" button and every
  // post-mutation refresh doing nothing at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the reload trigger, by design
  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    generation.current += 1;
    const mine = generation.current;
    // THE FIRST read announces itself as loading; a RE-read keeps whatever is on screen and marks
    // it stale. The updater form is what makes that decision from the live state rather than from
    // a `state` captured in this effect's closure, which would have to be a dependency and would
    // then re-run the fetch every time the fetch finished.
    setState((current) =>
      current.status === "ready" ? { ...current, stale: true } : { status: "loading" },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ApiError(
              0,
              "timeout",
              `The API did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
            ),
          ),
        timeoutMs,
      );
    });

    Promise.race([load(), expired])
      .then((data) => {
        if (generation.current === mine) setState({ status: "ready", data, stale: false });
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        setState({
          status: "error",
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, "unexpected_error", (error as Error)?.message ?? "Unknown error"),
        });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      // Nothing to abort — `fetch` is left to finish — but the result is now stale by definition.
      generation.current += 1;
    };
  }, [load, enabled, nonce, timeoutMs]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { state, reload };
}

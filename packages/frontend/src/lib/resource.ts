"use client";

/**
 * One asynchronous read, as a state a page must render every branch of.
 *
 * The point of modelling it as a union rather than three loose booleans is that TypeScript then
 * refuses to compile a page that renders `data` without having handled `loading` and `error`. Every
 * screen in this frontend therefore has an honest empty, loading and failure state — not because a
 * reviewer remembered to ask for one, but because the type would not typecheck otherwise.
 *
 * There is no cache and no background revalidation. See `lib/api.ts` for why.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export type Resource<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError };

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
  options?: { enabled?: boolean },
): ResourceHandle<T> {
  const enabled = options?.enabled ?? true;
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
    setState({ status: "loading" });
    load()
      .then((data) => {
        if (generation.current === mine) setState({ status: "ready", data });
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
      });
    return () => {
      // Nothing to abort — `fetch` is left to finish — but the result is now stale by definition.
      generation.current += 1;
    };
  }, [load, enabled, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { state, reload };
}

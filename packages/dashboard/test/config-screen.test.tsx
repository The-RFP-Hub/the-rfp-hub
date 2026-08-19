/**
 * THE MISCONFIGURATION SCREEN HAS TO WIN, and for one build it could not.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time, so getting it wrong is the single most common way
 * to break a deployment here — which is why this package renders a named, legible diagnostic instead
 * of failing. That diagnostic is useless if something crashes before React reaches it.
 *
 * `createAuthClient` validates its `baseURL` EAGERLY and throws `BetterAuthError` on anything
 * malformed (verified: `"not a url"` and `"ftp://x"` throw, `""` does not). The auth client is
 * constructed at module scope, and its module is on the root layout's import chain, so a malformed
 * value threw during module evaluation — before `AppProviders` ran, before React rendered anything.
 * Every route answered 500 with a stack trace, for the one error this screen exists to explain.
 *
 * These tests import the module graph FRESH under each environment, which is the only way to
 * exercise module-scope behaviour: `vi.resetModules()` plus a dynamic import.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn() }),
}));

/** Load `lib/session` afresh with one value of the variable. Throws if module evaluation throws. */
async function loadWith(apiUrl: string | undefined) {
  vi.resetModules();
  if (apiUrl === undefined) vi.stubEnv("NEXT_PUBLIC_API_URL", "");
  else vi.stubEnv("NEXT_PUBLIC_API_URL", apiUrl);
  return import("@/lib/session");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("a malformed API origin", () => {
  // The two shapes `createAuthClient` rejects outright, plus the empty one it happens to tolerate.
  for (const bad of ["not a url", "ftp://api.example.com", "://nope", ""]) {
    it(`renders the diagnostic rather than crashing, for ${JSON.stringify(bad)}`, async () => {
      // THE REGRESSION IS HERE: this import used to throw for the malformed values.
      const { AppProviders } = await loadWith(bad);

      render(
        <AppProviders>
          <p>the app</p>
        </AppProviders>,
      );

      expect(screen.getByText("This dashboard is not configured")).toBeTruthy();
      expect(screen.getByText("NEXT_PUBLIC_API_URL")).toBeTruthy();
      // The app itself must NOT be mounted behind the diagnostic — that is what keeps the auth
      // client from ever being called with a base URL nothing validated.
      expect(screen.queryByText("the app")).toBeNull();
    });
  }

  it("says the value is read at BUILD time, which is the part people lose an afternoon to", async () => {
    const { AppProviders } = await loadWith("not a url");

    render(
      <AppProviders>
        <p>the app</p>
      </AppProviders>,
    );

    expect(screen.getByText(/rebuild with it present/)).toBeTruthy();
  });
});

describe("a valid API origin", () => {
  it("mounts the application instead of the diagnostic", async () => {
    const { AppProviders } = await loadWith("https://api.example.com");

    render(
      <AppProviders>
        <p>the app</p>
      </AppProviders>,
    );

    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.queryByText("This dashboard is not configured")).toBeNull();
  });
});

/**
 * WHERE THE SESSION TOKEN LIVES, AND WHAT HAPPENS WHEN IT CANNOT LIVE THERE.
 *
 * `localStorage` is not a place that either works or is absent — it is a place that THROWS. Safari
 * in private mode, a browser with site data blocked, and some enterprise policies raise a
 * `SecurityError`, sometimes on the very first property access rather than on write. An earlier
 * version of this module caught that and dropped the token on the floor, which produced the worst
 * possible shape of bug: sign-in appeared to succeed, the next session read found nothing, and the
 * user was bounced back to the sign-in panel with no error anywhere to explain it.
 *
 * These tests pin the fix — an in-memory copy that lasts as long as the page — and they are written
 * against the two distinct failure shapes, because a stub that only breaks `setItem` would not have
 * caught the accessor that throws on read.
 */
import { clearSessionToken, readSessionToken, storeSessionToken } from "@/lib/auth-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** Replace the whole accessor, so even READING `globalThis.localStorage` throws. */
function blockStorageEntirely() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError: access to storage is denied for this document");
    },
  });
}

function restoreStorage() {
  if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
}

beforeEach(() => {
  restoreStorage();
  globalThis.localStorage.clear();
  clearSessionToken();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreStorage();
  clearSessionToken();
});

describe("the session token, when storage works", () => {
  it("round-trips through localStorage under a namespaced key", () => {
    storeSessionToken("token-abc");

    expect(readSessionToken()).toBe("token-abc");
    // Namespaced so a preview host serving several apps from one origin cannot collide.
    expect(globalThis.localStorage.getItem("rfphub.session-token")).toBe("token-abc");
  });

  it("is gone after a sign-out, from storage and from memory alike", () => {
    storeSessionToken("token-abc");
    clearSessionToken();

    expect(readSessionToken()).toBeNull();
    expect(globalThis.localStorage.getItem("rfphub.session-token")).toBeNull();
  });

  it("reads null when nothing was ever stored", () => {
    expect(readSessionToken()).toBeNull();
  });
});

describe("the session token, when storage is unavailable", () => {
  it("survives a throwing setItem for the life of the page", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    storeSessionToken("token-abc");

    // THE REGRESSION: this used to be null, so the session read that follows a sign-in reported
    // "signed out" a moment after the sign-in succeeded.
    expect(readSessionToken()).toBe("token-abc");
  });

  it("survives an accessor that throws on read as well as on write", () => {
    blockStorageEntirely();

    storeSessionToken("token-xyz");

    expect(readSessionToken()).toBe("token-xyz");
  });

  it("still forgets the token on sign-out when storage is blocked", () => {
    blockStorageEntirely();
    storeSessionToken("token-xyz");

    clearSessionToken();

    // A sign-out that leaves a usable token in memory is not a sign-out.
    expect(readSessionToken()).toBeNull();
  });

  it("never lets a storage failure escape to the caller", () => {
    blockStorageEntirely();

    // The public directory renders for readers who will never sign in; a throw from any of these
    // would take that page down over a feature it does not use.
    expect(() => storeSessionToken("t")).not.toThrow();
    expect(() => readSessionToken()).not.toThrow();
    expect(() => clearSessionToken()).not.toThrow();
  });
});

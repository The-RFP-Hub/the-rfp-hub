import { describe, expect, it } from "vitest";
import { DeadlineExceeded, withDeadline } from "../../src/modules/shared/deadline.js";

describe("withDeadline", () => {
  it("passes a prompt result through", async () => {
    await expect(withDeadline(Promise.resolve(42), 1_000, "x")).resolves.toBe(42);
  });

  it("passes a prompt rejection through unchanged", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 1_000, "x")).rejects.toThrow(
      "boom",
    );
  });

  it("rejects with DeadlineExceeded when the work is late, and drops the late outcome", async () => {
    let settle: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      settle = resolve;
    });
    await expect(withDeadline(late, 10, "duplicate check")).rejects.toBeInstanceOf(
      DeadlineExceeded,
    );
    settle("too late");
    await expect(late).resolves.toBe("too late");
  });

  it("does not turn a late rejection into an unhandled one", async () => {
    let fail: (error: Error) => void = () => undefined;
    const late = new Promise<never>((_, reject) => {
      fail = reject;
    });
    await expect(withDeadline(late, 10, "x")).rejects.toBeInstanceOf(DeadlineExceeded);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    fail(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

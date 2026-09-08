/** Thrown by `withDeadline` when the work did not settle in time. The work itself keeps running. */
export class DeadlineExceeded extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms} ms`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * Resolve to `work`'s result, or reject with `DeadlineExceeded` after `ms`.
 *
 * The work is not cancelled — a promise cannot be — so its late outcome is observed and dropped
 * rather than left to surface as an unhandled rejection. The timer is cleared as soon as the
 * work settles, so a fast path holds no timer open.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(label, ms)), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

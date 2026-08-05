/**
 * The advisory tier.
 *
 * Schema errors and advisory warnings are deliberately different things. The schema stays
 * permissive — free-text deadline labels, an open programModel list — because a closed enum
 * built from one publisher's vocabulary would force every other publisher into it. That
 * permissiveness is what makes the registries load-bearing: nothing would ever notice drift
 * if the only signal were pass/fail.
 *
 * So: a document that raises warnings is still CONFORMANT. Warnings are quality signal,
 * reported separately, and only `--strict` turns them into a failing exit code.
 */
export interface Warning {
  /** Stable machine-readable identifier for the check that fired. */
  code: string;
  /** JSON-Pointer-ish path to the offending value, in the same shape ajv uses. */
  instancePath: string;
  /** One-line human-readable explanation, naming the offending value. */
  message: string;
}

export interface Check {
  code: string;
  /**
   * Verb phrase completing "N of M entries …", for count-phrased text output.
   * e.g. "use an unregistered deadline label".
   */
  entryPhrase: string;
  run(entry: Record<string, unknown>): Warning[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

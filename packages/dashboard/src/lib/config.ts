/**
 * The two variables this dashboard cannot run without, read in one place and validated honestly.
 *
 * Both are `NEXT_PUBLIC_`, which means they are INLINED AT BUILD TIME. Setting them on a running
 * host changes nothing until the next build, and that trips people up often enough that the error
 * text says so rather than reporting a generic "not configured".
 *
 * A missing value is reported, never defaulted. A dashboard that quietly falls back to somebody
 * else's API sends a user's bearer token there, and a dashboard that falls back to a shared auth
 * application puts two environments' users in one identity pool.
 */
export interface ClientConfig {
  apiBaseUrl: string;
  privyAppId: string;
}

export type ConfigResult =
  | { ok: true; config: ClientConfig }
  | { ok: false; problems: { variable: string; problem: string }[] };

/**
 * Validate the build-time environment.
 *
 * Takes the values rather than reading `process.env` itself so the rules are testable. The caller
 * passes the inlined literals — they have to be written out as `process.env.NEXT_PUBLIC_…` at the
 * call site for the bundler to replace them, which is why this is not a loop over names.
 */
export function readConfig(env: {
  apiUrl: string | undefined;
  privyAppId: string | undefined;
}): ConfigResult {
  const problems: { variable: string; problem: string }[] = [];

  const apiUrl = env.apiUrl?.trim();
  if (!apiUrl) {
    problems.push({
      variable: "NEXT_PUBLIC_API_URL",
      problem: "not set — the dashboard has no API to talk to.",
    });
  } else {
    try {
      const parsed = new URL(apiUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        problems.push({
          variable: "NEXT_PUBLIC_API_URL",
          problem: `${apiUrl} is not an http(s) URL.`,
        });
      }
    } catch {
      problems.push({ variable: "NEXT_PUBLIC_API_URL", problem: `${apiUrl} is not a URL.` });
    }
  }

  const privyAppId = env.privyAppId?.trim();
  if (!privyAppId) {
    problems.push({
      variable: "NEXT_PUBLIC_PRIVY_APP_ID",
      problem:
        "not set — there is no auth application to log in against. Use a SEPARATE application per environment.",
    });
  }

  if (problems.length > 0 || !apiUrl || !privyAppId) return { ok: false, problems };
  return { ok: true, config: { apiBaseUrl: apiUrl.replace(/\/+$/, ""), privyAppId } };
}

/**
 * The one variable this frontend cannot run without, read in one place and validated honestly.
 *
 * It is `NEXT_PUBLIC_`, which means it is INLINED AT BUILD TIME. Setting it on a running host
 * changes nothing until the next build, and that trips people up often enough that the error text
 * says so rather than reporting a generic "not configured".
 *
 * ONE, not two. Authentication used to need its own application id here, naming a third-party
 * identity pool that had to be kept distinct per environment or two environments' users ended up in
 * one directory. Sessions are now issued by the API itself, so the API's origin is the only thing
 * this client needs to be told — and there is no longer a second identifier that can be right,
 * wrong, or right for the wrong environment.
 *
 * A missing value is reported, never defaulted. A dashboard that quietly falls back to somebody
 * else's API sends a user's session token there.
 */
export interface ClientConfig {
  apiBaseUrl: string;
}

export type ConfigResult =
  | { ok: true; config: ClientConfig }
  | { ok: false; problems: { variable: string; problem: string }[] };

/**
 * Validate the build-time environment.
 *
 * Takes the value rather than reading `process.env` itself so the rules are testable. The caller
 * passes the inlined literal — it has to be written out as `process.env.NEXT_PUBLIC_…` at the call
 * site for the bundler to replace it, which is why this is not a loop over names.
 */
export function readConfig(env: { apiUrl: string | undefined }): ConfigResult {
  const problems: { variable: string; problem: string }[] = [];

  const apiUrl = env.apiUrl?.trim();
  if (!apiUrl) {
    problems.push({
      variable: "NEXT_PUBLIC_API_URL",
      problem: "not set — the frontend has no API to talk to, and no way to sign anybody in.",
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

  if (problems.length > 0 || !apiUrl) return { ok: false, problems };
  return { ok: true, config: { apiBaseUrl: apiUrl.replace(/\/+$/, "") } };
}

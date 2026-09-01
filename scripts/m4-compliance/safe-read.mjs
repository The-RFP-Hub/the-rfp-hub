/**
 * Parse and run a `safe-read` block from the handoff docs.
 *
 * THE PROBLEM THIS REPLACES. The previous implementation handed the block's text to
 * `bash -c` with the caller's full `process.env`. A checker that advertises itself as
 * "100% read-only, safe to point at production" was therefore executing arbitrary shell, chosen
 * by whatever a markdown file happened to say, with whatever npm/cloud credentials the operator's
 * shell had exported. A typo or a docs change could POST, delete, or read `~/.npmrc`.
 *
 * There is no shell here at all. Each line is parsed into a pipeline of argv arrays, validated
 * against a narrow grammar, and spawned directly:
 *
 *   - stage 0 is `curl` with GET/HEAD semantics only — no `-d/-F/-T`, no `Authorization`/`Cookie`
 *     header, no `-u`, no `-X POST`;
 *   - later stages may only be `jq`, `head`, `sed -n` or `python3 -m json.tool`;
 *   - command substitution exists in exactly one form, `NAME=$(<pipeline>)`, whose inside must
 *     itself satisfy this grammar — that is what `docs/api-integration.md`'s real blocks use to
 *     pick a sample id, and it is not a general escape hatch;
 *   - backticks, redirection, `;`, `&`, `&&` and any other `||` are rejected outright;
 *   - every URL must expand to the `--api`/`--site` origin under test, and a `/v1/r/` link-out
 *     must carry `DNT: 1` or the block is refused before it can record a click;
 *   - the child environment is an allowlist, never `process.env`.
 *
 * Running the stages ourselves also closes the `pipefail` gap honestly. `curl -f … | jq` under
 * bash reports only `jq`'s status, so a 404 "succeeded"; adding `pipefail` broke `curl … | head`,
 * because head closing the pipe makes curl's own write fail. Buffering between stages removes
 * that conflict: head reads all of a completed capture, and curl's exit code is examined directly.
 */
import { spawn } from "node:child_process";

const PIPE_COMMANDS = new Set(["jq", "head", "sed", "python3"]);

const CURL_BOOL_SHORT = new Set(["s", "S", "i", "I", "f", "L", "g"]);
const CURL_VALUE_SHORT = new Set(["o", "H", "m", "A", "X"]);
const CURL_FORBIDDEN_SHORT = new Map([
  ["d", "a request body (-d)"],
  ["F", "a multipart form (-F)"],
  ["T", "an upload (-T)"],
  ["u", "credentials (-u)"],
  ["b", "a cookie jar (-b)"],
  ["c", "a cookie jar (-c)"],
  ["e", "a referer (-e)"],
  ["E", "a client certificate (-E)"],
  ["K", "a config file (-K)"],
]);
const CURL_BOOL_LONG = new Set([
  "--silent",
  "--show-error",
  "--include",
  "--head",
  "--fail",
  "--fail-with-body",
  "--location",
  "--compressed",
  "--globoff",
  "--no-progress-meter",
]);
const CURL_VALUE_LONG = new Set([
  "--header",
  "--output",
  "--max-time",
  "--connect-timeout",
  "--user-agent",
  "--request",
  "--url",
  "--retry",
]);

const FORBIDDEN_HEADERS = ["authorization", "cookie", "proxy-authorization"];

class ParseError extends Error {}

const fail = (reason) => {
  throw new ParseError(reason);
};

/**
 * Split one line into tokens and `|` separators, honoring quotes, and refusing every shell
 * construct this grammar does not have. Returns `{ tokens, allowFailure }` where a token is
 * `{ parts: [{ text, quoted }] }` — `quoted` marks a single-quoted run, where `$` is literal.
 */
export function tokenize(line) {
  const tokens = [];
  let current = null;
  const push = (text, quoted) => {
    if (current === null) current = { parts: [] };
    if (text) current.parts.push({ text, quoted });
  };
  const end = () => {
    if (current !== null) tokens.push(current);
    current = null;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1);
      if (close === -1) fail(`unterminated ${ch} quote`);
      const inner = line.slice(i + 1, close);
      if (ch === '"' && (inner.includes("$(") || inner.includes("`"))) {
        fail("command substitution inside a quoted argument");
      }
      push(inner, ch === "'");
      i = close;
      continue;
    }
    if (ch === "`") fail("backtick command substitution");
    if (ch === "\\") fail("backslash escaping");
    if (ch === ">" || ch === "<") fail(`redirection (${ch})`);
    if (ch === "&") fail("& (background or &&)");
    if (ch === ";") fail("; (command sequencing)");
    if (ch === "$" && line[i + 1] === "(") fail("command substitution outside NAME=$( … )");
    if (ch === "#" && current === null) {
      end();
      break; // a comment token starts here; the rest of the line is prose
    }
    if (/\s/.test(ch)) {
      end();
      continue;
    }
    if (ch === "|") {
      end();
      if (line[i + 1] === "|") {
        tokens.push({ operator: "||" });
        i++;
      } else {
        tokens.push({ operator: "|" });
      }
      continue;
    }
    push(ch, false);
  }
  end();

  let allowFailure = false;
  const last = tokens.length >= 2 ? tokens[tokens.length - 2] : undefined;
  if (last?.operator === "||") {
    if (raw(tokens[tokens.length - 1]) !== "true") {
      fail("|| is only allowed as a trailing `|| true`");
    }
    tokens.splice(tokens.length - 2, 2);
    allowFailure = true;
  }
  if (tokens.some((t) => t.operator === "||")) {
    fail("|| is only allowed as a trailing `|| true`");
  }
  return { tokens, allowFailure };
}

const raw = (token) => (token.parts ?? []).map((p) => p.text).join("");

/** Substitute `$NAME`/`${NAME}` from `vars`, leaving single-quoted runs alone. */
function expand(token, vars) {
  return (token.parts ?? [])
    .map(({ text, quoted }) => {
      if (quoted) return text;
      return text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name) => {
        if (!(name in vars)) fail(`undefined variable $${name}`);
        return vars[name];
      });
    })
    .join("");
}

function splitStages(tokens) {
  const stages = [[]];
  for (const token of tokens) {
    if (token.operator === "|") {
      stages.push([]);
      continue;
    }
    stages[stages.length - 1].push(token);
  }
  if (stages.some((stage) => stage.length === 0)) fail("an empty pipeline stage");
  return stages;
}

function checkCurl(tokens, { vars, allowedOrigins }) {
  const urls = [];
  const headers = [];
  let method = "GET";
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const text = raw(token);
    const value = () => {
      const next = tokens[++i];
      if (!next) fail(`${text} needs a value`);
      return expand(next, vars);
    };
    if (text.startsWith("--")) {
      const [name, inline] = text.includes("=") ? text.split(/=(.*)/s) : [text, undefined];
      if (CURL_BOOL_LONG.has(name)) continue;
      if (!CURL_VALUE_LONG.has(name)) fail(`curl option ${name} is not in the safe-read grammar`);
      const v = inline !== undefined ? inline : value();
      if (name === "--request") method = v.toUpperCase();
      if (name === "--header") headers.push(v);
      if (name === "--output") checkOutput(v);
      if (name === "--url") urls.push(v);
      continue;
    }
    if (text.startsWith("-") && text.length > 1) {
      const flags = text.slice(1);
      for (let f = 0; f < flags.length; f++) {
        const flag = flags[f];
        const forbidden = CURL_FORBIDDEN_SHORT.get(flag);
        if (forbidden) fail(`curl is asked for ${forbidden}, which is not a read`);
        if (CURL_BOOL_SHORT.has(flag)) continue;
        if (!CURL_VALUE_SHORT.has(flag))
          fail(`curl option -${flag} is not in the safe-read grammar`);
        const rest = flags.slice(f + 1);
        const v = rest || value();
        if (flag === "X") method = v.toUpperCase();
        if (flag === "H") headers.push(v);
        if (flag === "o") checkOutput(v);
        f = flags.length;
      }
      continue;
    }
    urls.push(expand(token, vars));
  }

  if (method !== "GET" && method !== "HEAD") fail(`curl -X ${method} is not a read`);
  for (const header of headers) {
    const name = header.split(":")[0].trim().toLowerCase();
    if (FORBIDDEN_HEADERS.includes(name)) fail(`curl sends an ${name} header`);
  }
  if (urls.length !== 1) fail(`curl needs exactly one URL, found ${urls.length}`);
  checkUrl(urls[0], { allowedOrigins, headers });
}

function checkOutput(target) {
  if (target === "/dev/null") return;
  if (!/^[A-Za-z0-9._-]+$/.test(target) || target.startsWith(".")) {
    fail(
      `curl writes to "${target}" — only /dev/null or a plain filename in the scratch directory`,
    );
  }
}

function checkUrl(value, { allowedOrigins, headers }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`"${value}" is not an absolute URL`);
  }
  if (!allowedOrigins.includes(url.origin)) {
    fail(`${url.origin} is not the deployment under test (${allowedOrigins.join(", ")})`);
  }
  if (url.pathname.startsWith("/v1/r/")) {
    const dnt = headers.some((h) => /^\s*dnt\s*:\s*1\s*$/i.test(h));
    if (!dnt) fail("a /v1/r/ link-out without `DNT: 1` would record a click");
  }
}

function checkPipeStage(tokens) {
  const command = raw(tokens[0]);
  if (!PIPE_COMMANDS.has(command)) {
    fail(
      `${command} may not appear in a safe-read pipeline (only ${[...PIPE_COMMANDS].join(", ")})`,
    );
  }
  const args = tokens.slice(1).map(raw);
  if (command === "python3") {
    if (args.join(" ") !== "-m json.tool")
      fail("python3 is allowed only as `python3 -m json.tool`");
  }
  if (command === "sed") {
    if (!args.includes("-n")) fail("sed is allowed only with -n");
    if (args.some((a) => !a.startsWith("-") && /[ew]/.test(a))) {
      fail("a sed script with an e/w command can execute or write");
    }
  }
  if (command === "jq") {
    for (const arg of args) {
      if (arg.startsWith("-") && !/^-{1,2}[recsSa-]+$/.test(arg)) {
        fail(`jq option ${arg} is not in the safe-read grammar`);
      }
    }
  }
}

/**
 * Parse a whole block. Returns `{ ok: true, lines }` or `{ ok: false, reason }` — never throws,
 * because a malformed block is a criterion FAILURE with a reason, not a crash.
 */
export function parseSafeReadBlock(source, { api, site }) {
  const allowedOrigins = [...new Set([api, site].filter(Boolean).map((b) => new URL(b).origin))];
  const parseVars = { API: api, ...(site ? { SITE: site } : {}) };
  const lines = [];
  try {
    for (const rawLine of String(source).split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=\$\((.*)\)\s*$/.exec(line);
      const body = assignment ? assignment[2] : line;
      const assignTo = assignment?.[1];
      const { tokens, allowFailure } = tokenize(body);
      if (tokens.length === 0) continue;
      const stages = splitStages(tokens);
      if (raw(stages[0][0]) !== "curl") {
        fail(`a safe-read line must start with curl, found "${raw(stages[0][0])}"`);
      }
      checkCurl(stages[0], { vars: parseVars, allowedOrigins });
      for (const stage of stages.slice(1)) checkPipeStage(stage);
      lines.push({ source: line, assignTo, stages, allowFailure });
      // A value produced by an earlier line may appear in a later URL's PATH. It can never
      // introduce a host: the origin is checked again, against the real value, before spawning.
      if (assignTo) parseVars[assignTo] = "captured";
    }
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, reason: err.message };
    throw err;
  }
  return { ok: true, lines, allowedOrigins };
}

/** The only environment a safe-read child ever sees. */
export function safeReadEnv(base = process.env) {
  const env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  return env;
}

function runOne(command, args, input, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${command} could not be started: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
    // `head` exits as soon as it has its lines; writing the rest then raises EPIPE, which is the
    // normal end of that conversation and not an error.
    child.stdin.on("error", () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run a parsed block. Returns `{ ok }` or `{ ok: false, reason }`. Never throws on child failure. */
export async function runSafeReadBlock(parsed, { cwd, timeoutMs = 15000, api, site, env } = {}) {
  const vars = { API: api, ...(site ? { SITE: site } : {}) };
  for (const line of parsed.lines) {
    let input = null;
    let failedStage = null;
    for (const [index, stage] of line.stages.entries()) {
      const command = raw(stage[0]);
      let args;
      try {
        args = stage.slice(1).map((token) => expand(token, vars));
        if (index === 0) args = withFailFlag(args, { allowedOrigins: parsed.allowedOrigins });
      } catch (err) {
        return { ok: false, reason: `${line.source}: ${err.message}` };
      }
      let result;
      try {
        result = await runOne(command, args, input, { cwd, env: env ?? safeReadEnv(), timeoutMs });
      } catch (err) {
        return { ok: false, reason: `${line.source}: ${err.message}` };
      }
      if (result.code !== 0) {
        failedStage = `${command} exited ${result.code}${result.stderr ? ` — ${result.stderr.trim().slice(0, 200)}` : ""}`;
        break;
      }
      input = result.stdout;
    }
    if (failedStage && !line.allowFailure) {
      return { ok: false, reason: `${line.source}: ${failedStage}` };
    }
    if (line.assignTo) vars[line.assignTo] = (input ?? Buffer.alloc(0)).toString("utf8").trim();
  }
  return { ok: true };
}

/**
 * `--fail` is added when the block did not ask for it: without it curl answers 0 for a 404 and
 * the pipeline "succeeds" on an error body. Re-validating the expanded URL here is the second
 * half of the runtime check — a value captured from an earlier line lands in a path, and this is
 * where that is proved rather than assumed.
 */
function withFailFlag(args, { allowedOrigins }) {
  const url = args.find((a) => /^https?:\/\//i.test(a));
  if (url) checkUrl(url, { allowedOrigins, headers: headerValues(args) });
  const hasFail = args.some((a) => a === "--fail" || (/^-[A-Za-z]+$/.test(a) && a.includes("f")));
  return hasFail ? args : ["--fail", ...args];
}

function headerValues(args) {
  const headers = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-H" || args[i] === "--header") headers.push(args[i + 1] ?? "");
    else if (args[i].startsWith("--header=")) headers.push(args[i].slice("--header=".length));
  }
  return headers;
}

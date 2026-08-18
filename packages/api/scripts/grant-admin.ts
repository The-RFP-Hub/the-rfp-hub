/**
 * THE ADMIN CEREMONY: make one account an administrator, using the database credential.
 *
 * This is the grant the product cannot make, because making it needs an administrator. It is
 * deliberately held HERE rather than in the service's environment: a list of privileged identities
 * in a task definition grants a role on every login, to whoever holds the deployment configuration,
 * and nothing in the product can revoke it. Run once at install with the same credential that runs
 * the migrations, this grant is an EVENT — audited once, revocable afterwards by any admin — and
 * every later administrator is made by an administrator over `POST /v1/admin/accounts/:id/role`.
 *
 * It is also the lockout recovery: the route refuses to demote the last remaining admin, and if a
 * deployment reaches that state anyway, this is what undoes it.
 *
 *   pnpm --filter @the-rfp-hub/api grant-admin -- --did <privy-did> [--create] --yes
 *
 * `DATABASE_URL` comes from the environment and should be the ADMIN/migration URL. The script
 * echoes the host, port and database it resolved — never the URL itself, which carries a password —
 * refuses a target that is not loopback without `--allow-remote`, and refuses to write anything at
 * all without `--yes`. Every refusal exits non-zero.
 */
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { pool } from "../src/db/client.js";
import { AccountService } from "../src/modules/services/auth/account.service.js";
import { isHttpError } from "../src/modules/shared/http-error.js";
import { isLoopbackHost } from "../src/shared/loopback.js";

export interface GrantAdminOptions {
  did?: string;
  create: boolean;
  yes: boolean;
  allowRemote: boolean;
  help: boolean;
}

const USAGE = [
  "Usage: pnpm --filter @the-rfp-hub/api grant-admin -- --did <privy-did> [--create] --yes",
  "",
  "  --did <subject>   the identity provider's subject for the account to promote (required)",
  "  --create          provision the account if that subject has never logged in",
  "  --yes             actually write; without it the script only reports and exits non-zero",
  "  --allow-remote    permit a DATABASE_URL that is not loopback",
  "",
  "DATABASE_URL is read from the environment and should be the migration credential.",
].join("\n");

export function parseArgs(argv: string[]): GrantAdminOptions {
  const options: GrantAdminOptions = {
    create: false,
    yes: false,
    allowRemote: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      // The package manager's own separator, which it forwards rather than swallows. The documented
      // invocation carries it, so it is an argument this parser has to expect.
      case "--":
        break;
      case "--did":
        options.did = argv[++i];
        break;
      case "--create":
        options.create = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--allow-remote":
        options.allowRemote = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

/** `host:port/database` — everything an operator needs to recognise the target, and no credential. */
export function describeTarget(databaseUrl: string): { label: string; host: string } {
  const url = new URL(databaseUrl);
  const host = url.hostname;
  const port = url.port === "" ? "5432" : url.port;
  const database = url.pathname.replace(/^\//, "") || "(default)";
  return { label: `${host}:${port}/${database}`, host };
}

/**
 * The whole script, as a function, so a test can drive it without a subprocess and read what it
 * printed. Returns the process exit code: 0 for a grant or a no-op, non-zero for every refusal.
 */
export async function main(
  argv: string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  let options: GrantAdminOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    out(USAGE);
    return 2;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }

  const did = options.did?.trim();
  if (did === undefined || did === "") {
    out("--did is required.");
    out(USAGE);
    return 2;
  }

  const target = describeTarget(config.databaseUrl);
  out(`database: ${target.label}`);
  if (!isLoopbackHost(target.host) && !options.allowRemote) {
    out(
      `refusing: ${target.host} is not loopback. Re-run with --allow-remote if that is the database you mean.`,
    );
    return 1;
  }

  const accounts = new AccountService();
  const existing = await accounts.findByPrivyDid(did);
  if (existing) {
    out(
      `account: id=${existing.id} handle=${existing.handle ?? "(none)"} role=${existing.globalRole} created_at=${existing.createdAt.toISOString()}`,
    );
  } else if (options.create) {
    out("account: none for that subject yet — --create will provision it");
  } else {
    out("refusing: no account for that subject. Re-run with --create to provision one.");
    return 1;
  }

  if (!options.yes) {
    out("refusing: --yes was not given, so nothing was written.");
    return 1;
  }

  try {
    const grant = await accounts.grantAdmin(did, { create: options.create });
    if (grant.created) out(`created account id=${grant.account.id}`);
    if (grant.promoted) {
      out(`granted: account id=${grant.account.id} is now an admin.`);
    } else {
      out(`unchanged: account id=${grant.account.id} was already an admin.`);
    }
    return 0;
  } catch (error) {
    // A refusal the service made — an absent account without `--create` is the one that matters —
    // reads as itself; anything else is a real failure and keeps its own message.
    out(`refusing: ${isHttpError(error) ? error.message : String(error)}`);
    return 1;
  }
}

// Run only when this file IS the entry point, so a test can import `main` without the module
// promoting anybody on import.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
  await pool.end();
}

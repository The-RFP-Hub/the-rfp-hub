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
 *   pnpm --filter @the-rfp-hub/api grant-admin -- --email <address> [--create] --yes
 *
 * `DATABASE_URL` comes from the environment and should be the ADMIN/migration URL. The script
 * echoes the host, port and database it resolved — never the URL itself, which carries a password —
 * refuses a target that is not loopback without `--allow-remote`, and refuses to write anything at
 * all without `--yes`. Every refusal exits non-zero.
 */
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { db, pool } from "../src/db/client.js";
import { repositories } from "../src/modules/repositories/index.js";
import { AccountService } from "../src/modules/services/auth/account.service.js";
import { isHttpError } from "../src/modules/shared/http-error.js";
import { isLoopbackHost } from "../src/shared/loopback.js";

export interface GrantAdminOptions {
  /** The address the person signs in with. A LOOKUP key — never what gets stored. */
  email?: string;
  /** The identity's opaque user id, for when an operator already has it. */
  subject?: string;
  create: boolean;
  yes: boolean;
  allowRemote: boolean;
  help: boolean;
}

const USAGE = [
  "Usage: pnpm --filter @the-rfp-hub/api grant-admin -- --email <address> [--create] --yes",
  "",
  "  --email <address>  the address the person signs in with. They must have signed in at least",
  "                     once, so that an identity exists to promote",
  "  --subject <id>     the identity's user id, if you already have it. Alternative to --email",
  "  --create           provision the accounts row when the identity has signed in but has never",
  "                     made an API request",
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
      case "--email":
        options.email = argv[++i];
        break;
      case "--subject":
        options.subject = argv[++i];
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

  const email = options.email?.trim();
  const subject = options.subject?.trim();
  if ((email === undefined || email === "") && (subject === undefined || subject === "")) {
    out("one of --email or --subject is required.");
    out(USAGE);
    return 2;
  }
  if (email && subject) {
    out("--email and --subject name the same thing two ways; give one.");
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

  // THE ADDRESS IS A LOOKUP, NEVER THE STORED VALUE. An address is transferable and can be
  // changed; the subject is the one identifier that is stable for the life of the identity, and it
  // is what `accounts.auth_user_id` holds. Resolving here means an operator can use the thing they
  // actually know.
  //
  // BOTH SELECTORS ARE RESOLVED AGAINST THE IDENTITY TABLE, and `--subject` is not exempt. There is
  // deliberately no foreign key from `accounts.auth_user_id` (an accounts row must outlive the
  // identity it belonged to, because audit history points at it), so nothing in the database would
  // catch a mistyped subject: `--subject --create` would mint an admin nobody can ever sign in as,
  // and that ghost would then count toward the last-admin guard — the exact hazard the migration's
  // orphan policy exists to clear.
  const repos = repositories(db);
  const identity = subject
    ? await repos.accounts.identityBySubject(subject)
    : await repos.accounts.identityByEmail(email as string);
  if (!identity) {
    out(
      subject
        ? `refusing: no identity has the subject ${JSON.stringify(subject)}. Check it against \`auth_user.id\`, or use --email, which looks the subject up for you. Granting a subject that names nobody would create an admin who must sign in once and never can.`
        : `refusing: nobody has signed in as ${JSON.stringify(email)}. That person must sign in once — the identity is created by signing in, not by this script — and then this command will find them.`,
    );
    return 1;
  }
  out(`identity: subject=${identity.id} email_verified=${identity.emailVerified}`);
  const resolved = identity.id;

  const accounts = new AccountService();
  const existing = await accounts.findBySubject(resolved);
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
    const grant = await accounts.grantAdmin(resolved, { create: options.create });
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

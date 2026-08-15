/**
 * Account enrichment: fill in the wallet and email the identity provider holds, off the auth path.
 *
 * WHY THIS IS A JOB AT ALL. The provider's user endpoint needs a SECOND credential (the app
 * secret), is heavily rate-limited, and is a network hop. Doing it during login would make every
 * sign-in wait on a third party and would turn a provider outage into a lockout. So a login
 * completes with the DID alone and leaves `accounts.enriched_at` NULL — which IS the queue. There
 * is no queue table, no retry column and nothing to drain: the cursor is the absence of a value.
 *
 * WHAT IT IS FOR. `accounts.primary_wallet` is usable as an authorization input
 * (`BOOTSTRAP_ADMIN_WALLETS`) only because it came from the provider's own record rather than from
 * a request body — a wallet address that arrives in a request is self-asserted. This job is the
 * only writer of that column, which is what makes that sentence true.
 *
 * AND IT APPLIES THAT INPUT, HERE, RATHER THAN LEAVING IT FOR SOMEBODY ELSE. Enrichment stamps
 * `enriched_at`, which takes the account out of this job's cursor permanently, so a promotion
 * deferred to "the next enrichment run" would never happen. The moment the verified wallet lands
 * it is checked against the configured list, and a match is promoted through the SAME audited,
 * idempotent path the DID bootstrap uses. `AccountService.applyBootstrapAdmin` re-checks on every
 * login too, so adding a wallet to the list later still takes effect without touching the database.
 *
 * WITHOUT `PRIVY_APP_SECRET` THE JOB IS INERT and says so: `{skipped}`, exit 0, no rows touched.
 * That is a configuration statement, not a failure, and it is deliberately distinguishable from
 * the runner's `{skipped: "locked"}`.
 *
 * A per-account failure — a 404 for a deleted user, a 429, a timeout — does not end the batch and
 * does not write `enriched_at`, so the account stays in the cursor and the next run tries again.
 * The one exception is a 404: the provider does not know this subject, and retrying nightly forever
 * would be a slow, permanent, self-inflicted rate-limit. Those are stamped as enriched with nothing
 * filled in, and the trail says why.
 */
import { and, asc, isNull, sql } from "drizzle-orm";
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type AccountRow, accounts } from "../../../db/schema.js";
import { AccountService } from "../auth/account.service.js";
import type { JobResult } from "./types.js";

/** The provider's user record, reduced to the two members this job reads. */
export interface ProviderUser {
  primaryWallet: string | null;
  email: string | null;
}

/**
 * The outbound call, injectable so the tests never touch the network.
 *
 * Returns `null` when the provider does not know the subject — a distinct outcome from throwing,
 * which means "ask again later".
 */
export type ProviderUserFetcher = (did: string) => Promise<ProviderUser | null>;

const DEFAULT_LIMIT = 50;
const DEFAULT_ENDPOINT = "https://api.privy.io/v1/users";
const TIMEOUT_MS = 10_000;

export interface AccountEnrichmentOptions {
  limit?: number;
  now?: Date;
}

export class AccountEnrichmentService {
  private readonly config: AppConfig;
  private readonly fetchUser: ProviderUserFetcher | undefined;
  private readonly accountsService: AccountService;

  constructor(
    private readonly db: DB = defaultDb,
    options: {
      config?: AppConfig;
      fetchUser?: ProviderUserFetcher;
      accounts?: AccountService;
    } = {},
  ) {
    this.config = options.config ?? defaultConfig;
    this.fetchUser = options.fetchUser ?? privyUserFetcher(this.config);
    this.accountsService =
      options.accounts ??
      new AccountService(
        db,
        this.config.bootstrapAdminPrivyDids,
        this.config.bootstrapAdminWallets,
      );
  }

  async runBatch(options: AccountEnrichmentOptions = {}): Promise<JobResult> {
    const fetchUser = this.fetchUser;
    if (!fetchUser) {
      return { processed: 0, remaining: 0, skipped: "no identity-provider app secret" };
    }
    const limit = options.limit ?? DEFAULT_LIMIT;
    const now = options.now ?? new Date();

    const pending = await this.pending(limit);
    let processed = 0;
    let unknown = 0;
    let failed = 0;
    let promoted = 0;

    for (const row of pending) {
      const did = row.privyDid;
      if (did === null) continue;
      try {
        const user = await fetchUser(did);
        const updated = await this.db
          .update(accounts)
          .set({
            // A record the provider does not have leaves both columns as they were: absent is not
            // the same as "provider says none", and overwriting a known wallet with null on a
            // transient 404 would remove an authorization input.
            ...(user ? { primaryWallet: user.primaryWallet, email: user.email } : {}),
            enrichedAt: now,
          })
          .where(sql`${accounts.id} = ${row.id}`)
          .returning();
        const stored = updated[0];
        // The bootstrap check runs against the row AS STORED, so it sees the wallet this pass just
        // wrote. A no-op for every account that matches nothing, which is nearly all of them.
        if (stored) {
          const after = await this.accountsService.applyBootstrapAdmin(stored);
          if (after.globalRole !== stored.globalRole) promoted++;
        }
        if (user === null) unknown++;
        processed++;
      } catch {
        // Left in the cursor on purpose — `enriched_at` stays NULL, so the next run retries.
        failed++;
      }
    }

    return {
      processed,
      remaining: await this.pendingCount(),
      details: {
        attempted: pending.length,
        unknownToProvider: unknown,
        failed,
        bootstrapAdminsPromoted: promoted,
      },
    };
  }

  /** The cursor: accounts with a subject and no enrichment stamp, oldest first. */
  private async pending(limit: number): Promise<AccountRow[]> {
    return this.db
      .select()
      .from(accounts)
      .where(and(isNull(accounts.enrichedAt), sql`${accounts.privyDid} IS NOT NULL`))
      .orderBy(asc(accounts.id))
      .limit(limit);
  }

  private async pendingCount(): Promise<number> {
    const rows = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(accounts)
      .where(and(isNull(accounts.enrichedAt), sql`${accounts.privyDid} IS NOT NULL`));
    return rows[0]?.value ?? 0;
  }
}

/**
 * The real call: Basic auth over `<appId>:<appSecret>`, plus the app id as its own header — the
 * provider requires both, and omitting the header authenticates as no application at all.
 *
 * Returns `undefined` (rather than a fetcher that always fails) when the credentials are absent, so
 * the job can report `skipped` instead of failing a scheduled task for a feature nobody enabled.
 */
export function privyUserFetcher(config: AppConfig): ProviderUserFetcher | undefined {
  const { appId, appSecret } = config.privy;
  if (!appId || !appSecret) return undefined;
  const authorization = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;

  return async (did: string): Promise<ProviderUser | null> => {
    const response = await fetch(`${DEFAULT_ENDPOINT}/${encodeURIComponent(did)}`, {
      headers: { authorization, "privy-app-id": appId, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`identity-provider user lookup failed: ${response.status}`);
    return readUser(await response.json());
  };
}

/**
 * The two fields, pulled out of the provider's linked-account list.
 *
 * PURE and exported so it is unit-testable without a network: the shape is a third party's, it
 * changes without notice, and reading it defensively is the difference between a job that skips
 * one account and a job that throws on all of them.
 */
export function readUser(payload: unknown): ProviderUser {
  const linked = (payload as { linked_accounts?: unknown })?.linked_accounts;
  const entries = Array.isArray(linked) ? (linked as Record<string, unknown>[]) : [];
  const first = (type: string): string | null => {
    for (const entry of entries) {
      if (entry?.type !== type) continue;
      const value = entry.address;
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return null;
  };
  return { primaryWallet: first("wallet")?.toLowerCase() ?? null, email: first("email") };
}

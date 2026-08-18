/**
 * Account enrichment: fill in the wallet and email the identity provider holds, off the auth path.
 *
 * WHY THIS IS A JOB AT ALL. The provider's user endpoint needs a SECOND credential (the app
 * secret), is heavily rate-limited, and is a network hop. Doing it during login would make every
 * sign-in wait on a third party and would turn a provider outage into a lockout. So a login
 * completes with the DID alone and leaves `accounts.enriched_at` NULL — which IS the queue. There
 * is no queue table, no retry column and nothing to drain: the cursor is the absence of a value.
 *
 * WHAT IT IS FOR. `accounts.primary_wallet` and `accounts.email` are the provider's own record of
 * this subject, and this job is the ONLY writer of either — a wallet address that arrives in a
 * request is self-asserted, and the difference is the whole reason the column is trustworthy. It
 * grants nothing by itself: roles are granted by an admin over the audited route, or by an operator
 * running the admin ceremony (`scripts/grant-admin.ts`), never by a value landing in a column.
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

  constructor(
    private readonly db: DB = defaultDb,
    options: {
      config?: AppConfig;
      fetchUser?: ProviderUserFetcher;
    } = {},
  ) {
    this.config = options.config ?? defaultConfig;
    this.fetchUser = options.fetchUser ?? privyUserFetcher(this.config);
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

    for (const row of pending) {
      const did = row.privyDid;
      if (did === null) continue;
      try {
        // The network call stays OUTSIDE the transaction: a provider round trip must never be what
        // holds one open.
        const user = await fetchUser(did);

        // The stamp is what takes this account out of the cursor, so it is written only once the
        // provider has answered: a failure anywhere in here rolls the whole thing back and the next
        // run selects the account again.
        await this.db.transaction(async (tx) => {
          const updated = await tx
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
          if (!updated[0]) throw new Error(`account ${row.id} vanished during enrichment`);
        });

        if (user === null) unknown++;
        processed++;
      } catch {
        // Left in the cursor on purpose — the whole transaction rolled back, so `enriched_at` is
        // still NULL and the next run tries this account again.
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

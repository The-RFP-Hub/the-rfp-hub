import { config } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type Repositories, repositories } from "../../repositories/index.js";
import { verifyUnsubscribeToken } from "./unsubscribe-token.js";

export class EmailPreferenceService {
  private readonly repos: Repositories;

  constructor(
    db: DB = defaultDb,
    private readonly secret: string = config.betterAuth.secret,
  ) {
    this.repos = repositories(db);
  }

  isValidStaleReminderToken(token: string): boolean {
    return verifyUnsubscribeToken(this.secret, token, "stale_listing_reminder") !== undefined;
  }

  /** False only for a token this deployment did not sign. Repeating a valid one is a no-op. */
  async optOutOfStaleReminders(token: string, now = new Date()): Promise<boolean> {
    const accountId = verifyUnsubscribeToken(this.secret, token, "stale_listing_reminder");
    if (accountId === undefined) return false;
    await this.repos.accounts.optOutOfStaleReminders(accountId, now);
    return true;
  }
}

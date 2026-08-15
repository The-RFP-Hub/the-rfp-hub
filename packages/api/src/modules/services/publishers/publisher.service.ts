/**
 * `GET /v1/publishers` — the public list of verified organisations.
 *
 * This is the one place the verified flag is a PUBLIC fact rather than an authorization input, and
 * it is worth being explicit about what it does and does not say: a row here means writes from this
 * namespace are published without review, so a consumer can weigh an entry's provenance. It does not
 * endorse the programmes themselves.
 *
 * Only the directory fields are served. Contacts are not: the directory carries publisher contact
 * details for editorial use, and an unauthenticated endpoint is not where they belong.
 */
import { count, eq } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { organizations } from "../../../db/schema.js";
import type { PublisherListView } from "../../shared/api-views.js";

export class PublisherService {
  constructor(private readonly db: DB = defaultDb) {}

  async list(): Promise<PublisherListView> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.verified, true))
      .orderBy(organizations.slug);

    const counted = await this.db
      .select({ value: count() })
      .from(organizations)
      .where(eq(organizations.verified, true));

    return {
      items: rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        description: row.description,
        website: row.website,
        logoUrl: row.logoUrl,
        ecosystems: row.ecosystems,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
      })),
      total: counted[0]?.value ?? 0,
    };
  }
}

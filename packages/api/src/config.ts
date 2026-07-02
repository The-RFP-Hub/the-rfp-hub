/** Runtime configuration, read from the environment with local-friendly defaults. */
export interface AppConfig {
  databaseUrl: string;
  port: number;
  host: string;
  /**
   * Base URL of the upstream funding-map registry API the seed loader ingests from.
   * Deployment-specific — set via SOURCE_API_URL (see .env-example). Empty unless configured.
   */
  sourceApiUrl: string;
  /** Provenance namespace recorded on seeded entries (source_system column + public id prefix). */
  sourceSystem: string;
  /**
   * Base URL for a program's page on the upstream source, used as a provenance fallback when a
   * program has no application/website URL. Deployment-specific — set via SOURCE_PROGRAM_URL_BASE.
   */
  sourceProgramUrlBase: string;
}

export const config: AppConfig = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://rfphub:rfphub@localhost:5432/rfphub",
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "0.0.0.0",
  sourceApiUrl: process.env.SOURCE_API_URL ?? "",
  sourceSystem: process.env.SOURCE_SYSTEM ?? "fundingmap",
  sourceProgramUrlBase: process.env.SOURCE_PROGRAM_URL_BASE ?? "",
};

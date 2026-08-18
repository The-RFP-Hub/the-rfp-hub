/**
 * Identity fixtures for the M3 integration suites.
 *
 * The API verifies session tokens LOCALLY with a PEM public key, which is exactly what makes this
 * possible: the tests generate their own ES256 key pair, hand the public half to `buildApp` and mint
 * their own tokens with the private half. No live identity provider, no network, no vendor SDK —
 * and the code path under test is the real one, not a stub, because the verifier cannot tell where
 * a correctly-signed token came from.
 */
import { eq } from "drizzle-orm";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import type { PrivyConfig } from "../../src/config.js";
import { db } from "../../src/db/client.js";
import {
  type AccountRow,
  type OrganizationRow,
  accounts,
  apiKeys,
  orgMemberships,
  organizations,
} from "../../src/db/schema.js";
import { mintApiKey as mintToken } from "../../src/modules/shared/api-key-token.js";
import type { ApiKeyScope } from "../../src/modules/shared/capabilities.js";

/** The app id every minted token carries as its audience, and the app is configured with. */
export const TEST_APP_ID = "m3auth-test-app";

/** `generateKeyPair` returns whatever `jose` returns; naming its half here keeps that unstated. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

interface KeyMaterial {
  privateKey: PrivateKey;
  publicPem: string;
}

let material: Promise<KeyMaterial> | undefined;

async function keys(): Promise<KeyMaterial> {
  material ??= (async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    return { privateKey: pair.privateKey, publicPem: await exportSPKI(pair.publicKey) };
  })();
  return material;
}

/** The identity configuration to hand `buildApp({ auth: { privy: await testPrivyConfig() } })`. */
export async function testPrivyConfig(): Promise<PrivyConfig> {
  const { publicPem } = await keys();
  return {
    appId: TEST_APP_ID,
    verificationKey: publicPem,
    jwksUrl: undefined,
    appSecret: undefined,
  };
}

export interface TokenOptions {
  /** Seconds from now. Negative mints an already-expired token, which is the point of one test. */
  expiresIn?: number;
  issuer?: string;
  audience?: string;
  /** Omits `exp` entirely — the shape a non-expiring forgery would have. */
  omitExpiry?: boolean;
}

/** A signed access token for a DID. */
export async function mintPrivyToken(did: string, options: TokenOptions = {}): Promise<string> {
  const { privateKey } = await keys();
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(did)
    .setIssuer(options.issuer ?? "privy.io")
    .setAudience(options.audience ?? TEST_APP_ID)
    .setIssuedAt(now);
  if (!options.omitExpiry) {
    builder.setExpirationTime(now + (options.expiresIn ?? 600));
  }
  return builder.sign(privateKey);
}

/** A token signed by a DIFFERENT key — the forgery case. */
export async function mintForeignToken(did: string): Promise<string> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(did)
    .setIssuer("privy.io")
    .setAudience(TEST_APP_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(pair.privateKey);
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ── database fixtures ────────────────────────────────────────────────────────────
export interface SeedAccountInput {
  did: string;
  handle?: string;
  role?: "submitter" | "reviewer" | "admin";
  directCreate?: boolean;
}

export async function seedAccount(input: SeedAccountInput): Promise<AccountRow> {
  const rows = await db
    .insert(accounts)
    .values({
      privyDid: input.did,
      handle: input.handle,
      globalRole: input.role ?? "submitter",
      directCreate: input.directCreate ?? false,
    })
    .onConflictDoNothing()
    .returning();
  const created = rows[0];
  if (created) return created;
  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.privyDid, input.did))
    .limit(1);
  const found = existing[0];
  if (!found) throw new Error(`could not seed account ${input.did}`);
  return found;
}

export async function seedOrganization(input: {
  slug: string;
  name?: string;
  verified?: boolean;
}): Promise<OrganizationRow> {
  await db
    .insert(organizations)
    .values({
      slug: input.slug,
      name: input.name ?? input.slug,
      verified: input.verified ?? false,
      verifiedAt: input.verified ? new Date() : null,
    })
    .onConflictDoNothing({ target: organizations.slug });
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, input.slug))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`could not seed organisation ${input.slug}`);
  // A repeated seed must be able to flip the flag: the fixtures reuse slugs across cases.
  if (input.verified !== undefined && row.verified !== input.verified) {
    const updated = await db
      .update(organizations)
      .set({ verified: input.verified, verifiedAt: input.verified ? new Date() : null })
      .where(eq(organizations.id, row.id))
      .returning();
    return updated[0] ?? row;
  }
  return row;
}

export async function grantMembership(
  accountId: number,
  organizationId: number,
  role: "owner" | "admin" | "publisher" = "publisher",
): Promise<void> {
  await db
    .insert(orgMemberships)
    .values({ accountId, organizationId, role })
    .onConflictDoNothing({ target: [orgMemberships.accountId, orgMemberships.organizationId] });
}

/** Insert a key directly, returning the token — the fixture equivalent of `POST /v1/keys`. */
export async function mintApiKeyFor(
  accountId: number,
  scopes: ApiKeyScope[] = ["read", "write"],
): Promise<string> {
  const minted = mintToken();
  await db.insert(apiKeys).values({
    accountId,
    name: "fixture",
    keyPrefix: minted.prefix,
    keyHash: minted.keyHash,
    scopes,
  });
  return minted.token;
}

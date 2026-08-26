/**
 * Identity fixtures for the integration suites — real sessions, no network, no third party.
 *
 * The suites drive a SECOND, TEST-ONLY auth instance over the same test database as the app. It is
 * the real library with the real plugins; what differs is where its one-time codes go (an in-memory
 * transport this file can read) and that it carries the library's own test helpers. A test-only
 * instance never ships, which is what makes that acceptable — the alternative, teaching the
 * production instance to reveal codes, would be a hole with a flag on it.
 *
 * WHY THE CODE COMES FROM THE TRANSPORT AND NOT FROM `testUtils.getOTP`. `getOTP` captures what is
 * WRITTEN TO THE DATABASE, and this deployment stores OTPs hashed (`storeOTP: "hashed"`), so it
 * would hand back a digest. Reading the transport instead gets the code as a person would receive
 * it, and exercises the send seam on the way past. `testUtils` is still installed for `test.login`,
 * which mints a session without the round trip when a suite does not care about the dance.
 *
 * THE CONTRACT EVERY LATER PHASE DEPENDS ON: an identity is `{ email, userId, token }` — all three,
 * always. `email` is what a person types, `token` is what an HTTP call carries, and `userId` is the
 * opaque subject that `accounts.auth_user_id` stores and that seeds and cleanup key on. An address
 * is never a join key.
 */
import { eq } from "drizzle-orm";
import { type Auth, createAuth } from "../../src/auth/better-auth.js";
import type { AuthConfig } from "../../src/auth/better-auth.js";
import { db } from "../../src/db/client.js";
import {
  type AccountRow,
  type OrganizationRow,
  accounts,
  apiKeys,
  authUser,
  orgMemberships,
  organizations,
} from "../../src/db/schema.js";
import {
  type EmailTransport,
  createEmailTransport,
} from "../../src/modules/services/email/email-transport.js";
import { EmailService } from "../../src/modules/services/email/email.service.js";
import { mintApiKey as mintToken } from "../../src/modules/shared/api-key-token.js";
import type { ApiKeyScope } from "../../src/modules/shared/capabilities.js";

/** Long enough to be a secret, fixed so every suite in a run verifies the same sessions. */
const TEST_SECRET = "rfphub-integration-secret-0123456789abcdef";
/** A different one, for the "signed by another deployment" case. Never used to build the app. */
const FOREIGN_SECRET = "rfphub-foreign-secret-fedcba9876543210xyz";

function testConfig(secret: string): AuthConfig {
  const email = {
    transport: "memory" as const,
    from: "no-reply@rfphub.invalid",
    outboxDir: undefined,
    sesRegion: undefined,
    resendApiKey: undefined,
    mailgunApiKey: undefined,
    mailgunDomain: undefined,
    mailgunApiBase: "https://api.mailgun.net",
  };
  return {
    betterAuth: {
      secret,
      secretConfigured: true,
      url: "http://127.0.0.1:3099",
      // Exactly one, so the CORS accept/reject cases have something concrete to be about.
      trustedOrigins: ["http://127.0.0.1:3005"],
      previewOriginPattern: undefined,
    },
    google: { clientId: undefined, clientSecret: undefined },
    email,
  };
}

interface TestInstance {
  auth: Auth;
  transport: EmailTransport;
  config: AuthConfig;
}

/**
 * ONE instance per worker process. Building it constructs the adapter and reads the schema, and
 * every suite's `beforeAll` asks for it — a per-call instance would pay that cost per file for no
 * isolation, since they all share the one database anyway.
 */
let shared: TestInstance | undefined;

function instance(): TestInstance {
  if (!shared) {
    const config = testConfig(TEST_SECRET);
    const transport = createEmailTransport(config.email);
    shared = {
      auth: createAuth({
        db,
        config,
        email: new EmailService({ config: config.email, transport }),
      }),
      transport,
      config,
    };
  }
  return shared;
}

/** The instance to hand `buildApp({ auth: { auth: await testAuth() } })`. */
export async function testAuth(): Promise<Auth> {
  return instance().auth;
}

/** The same instance's configuration, for the suites that exercise the mount's own policies. */
export function testAuthConfig(): AuthConfig {
  return instance().config;
}

export interface Identity {
  email: string;
  /** The opaque subject. THE join key — `accounts.auth_user_id`, seeds, cleanup. */
  userId: string;
  /** The signed session token, exactly as a browser would send it back. */
  token: string;
}

/** Cached per address: signing in twice for one fixture is two round trips for one identity. */
const identities = new Map<string, Identity>();

/**
 * A real sign-in: request a code, read it out of the transport, submit it.
 *
 * The token returned is the SIGNED one from `set-auth-token` — the value a browser stores and sends
 * back. The unsigned token in the response body is deliberately not used: `requireSignature: true`
 * means it would be refused, which is a case `auth.test.ts` asserts rather than works around.
 */
export async function signIn(email: string): Promise<Identity> {
  const cached = identities.get(email);
  if (cached) return cached;

  const { auth, transport } = instance();
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });

  const messages = transport.drain?.(email) ?? [];
  const last = messages[messages.length - 1];
  const otp = last === undefined ? undefined : /\b(\d{6})\b/.exec(last.text)?.[1];
  if (otp === undefined) {
    throw new Error(`no sign-in code was delivered for ${email} (${messages.length} messages)`);
  }

  const result = await auth.api.signInEmailOTP({ body: { email, otp }, returnHeaders: true });
  const token = result.headers.get("set-auth-token");
  const userId = (result.response as { user?: { id?: string } }).user?.id;
  if (!token || !userId) throw new Error(`sign-in for ${email} returned no session`);

  const identity: Identity = { email, userId, token };
  identities.set(email, identity);
  return identity;
}

/** The raw, UNSIGNED session token for an identity — refused by the bearer path, and asserted so. */
export async function unsignedToken(email: string): Promise<string> {
  const { auth, transport } = instance();
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const messages = transport.drain?.(email) ?? [];
  const otp = /\b(\d{6})\b/.exec(messages[messages.length - 1]?.text ?? "")?.[1];
  if (otp === undefined) throw new Error(`no sign-in code was delivered for ${email}`);
  const result = await auth.api.signInEmailOTP({ body: { email, otp } });
  return (result as { token?: string }).token ?? "";
}

/**
 * A session minted by a DIFFERENT deployment — same database, same schema, different secret.
 *
 * This is the strongest negative the suite has: the row exists and the token is genuine, so nothing
 * but the signature check can refuse it. It replaces the old "signed by a foreign key" case and is
 * stronger, because the old one could not produce a session that was real anywhere.
 */
export async function foreignToken(email: string): Promise<string> {
  const config = testConfig(FOREIGN_SECRET);
  const transport = createEmailTransport(config.email);
  const foreign = createAuth({
    db,
    config,
    email: new EmailService({ config: config.email, transport }),
  });
  await foreign.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const messages = transport.drain?.(email) ?? [];
  const otp = /\b(\d{6})\b/.exec(messages[messages.length - 1]?.text ?? "")?.[1];
  if (otp === undefined) throw new Error(`no sign-in code was delivered for ${email}`);
  const result = await foreign.api.signInEmailOTP({ body: { email, otp }, returnHeaders: true });
  return result.headers.get("set-auth-token") ?? "";
}

/** Sign a session out through the real route, so the row is gone. Used by the revocation case. */
export async function signOut(token: string): Promise<void> {
  const { auth } = instance();
  const name = (await auth.$context).authCookies.sessionToken.name;
  await auth.api.signOut({
    headers: new Headers({ cookie: `${name}=${encodeURIComponent(token)}` }),
  });
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ── database fixtures ────────────────────────────────────────────────────────────
export interface SeedAccountInput {
  /** The identity's subject — from `signIn()`, never an address. */
  userId: string;
  handle?: string;
  role?: "submitter" | "reviewer" | "admin";
  directCreate?: boolean;
}

export async function seedAccount(input: SeedAccountInput): Promise<AccountRow> {
  const rows = await db
    .insert(accounts)
    .values({
      authUserId: input.userId,
      handle: input.handle,
      globalRole: input.role ?? "submitter",
      directCreate: input.directCreate ?? false,
    })
    // Targeted at the JOIN KEY, so a collision on anything else — a handle another suite or an
    // older run left behind — raises with the constraint's own name instead of vanishing into a
    // "could not seed" that says nothing about why.
    .onConflictDoNothing({ target: accounts.authUserId })
    .returning();
  const created = rows[0];
  if (created) return created;
  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.authUserId, input.userId))
    .limit(1);
  const found = existing[0];
  if (!found) throw new Error(`could not seed account ${input.userId}`);
  // A repeated seed must be able to set the role: suites reuse identities across cases.
  if (input.role !== undefined && found.globalRole !== input.role) {
    const updated = await db
      .update(accounts)
      .set({ globalRole: input.role })
      .where(eq(accounts.id, found.id))
      .returning();
    return updated[0] ?? found;
  }
  return found;
}

/** Sign in and provision the `accounts` row in one step — the shape most suites want. */
export async function seedIdentity(
  email: string,
  input: Omit<SeedAccountInput, "userId"> = {},
): Promise<Identity & { account: AccountRow }> {
  const identity = await signIn(email);
  const account = await seedAccount({ ...input, userId: identity.userId });
  return { ...identity, account };
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

/** The identity row behind an address, for the suites that assert on it directly. */
export async function identityRow(email: string) {
  const rows = await db.select().from(authUser).where(eq(authUser.email, email)).limit(1);
  return rows[0];
}

/** Forget the in-process cache — for a suite that deletes its identities and signs in again. */
export function forgetIdentities(): void {
  identities.clear();
}

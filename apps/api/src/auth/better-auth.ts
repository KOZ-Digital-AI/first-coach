// Better Auth server instance on the app's own bun:sqlite database.
//
// - `createAuth(config)` is a factory (tests build one per temp DB); `getAuth(deps)`
//   memoises one instance per Database handle, so the route module and later
//   middleware share it.
// - Better Auth owns the tables `user`, `session`, `account` and `verification`. They
//   are created at boot by `ensureAuthSchema` (`runMigrations`, additive and idempotent),
//   NOT by apps/api/src/db/migrations. Later numbered migrations must not reuse those
//   names; they may reference them, e.g. `REFERENCES "user"(id)`.
// - Anonymous plugin = players; email + password = contributors (no verification, no
//   mail transport); admin plugin with roles `contributor` and `admin`.
// - Known caveat: Kysely shares the app's single synchronous bun:sqlite connection, so
//   keep app writes out of async transaction gaps. Anonymous-user cleanup and the
//   onLinkAccount recovery flow are later work.
import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { adminAc, defaultAc } from "better-auth/plugins/admin/access";
import { anonymous } from "better-auth/plugins/anonymous";

export const ROLE_CONTRIBUTOR = "contributor";
export const ROLE_ADMIN = "admin";

const MIN_SECRET_LENGTH = 32;
// Non-secret dev/test defaults. Never reachable in production (see resolveAuthConfig).
const DEV_SECRET = "dev-only-better-auth-secret-0123456789abcdef";
const DEV_BASE_URL = "http://localhost:4111";
const DEV_TRUSTED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]; // Vite dev server
// Players have no sign-up, so a short session would silently drop their progress.
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 90;

export type AuthConfig = {
  db: Database;
  secret: string;
  baseURL: string;
  /** Secure (`__Secure-`) cookies and rate limiting on; true for anything but dev/test. */
  production: boolean;
  trustedOrigins?: string[];
};

const roles = {
  admin: adminAc,
  // No permissions at all: a contributor can never call an admin endpoint.
  contributor: defaultAc.newRole({ user: [], session: [] }),
};

/**
 * Reads BETTER_AUTH_SECRET, BETTER_AUTH_URL, BETTER_AUTH_TRUSTED_ORIGINS and NODE_ENV.
 *
 * FAILS CLOSED: the dev fallbacks (public secret, http://localhost:4111, non-Secure
 * cookies, no rate limiter) apply ONLY when NODE_ENV is exactly "development" or "test"
 * (Bun sets "test" under `bun test`). Any other value, including undefined, "Production"
 * or "staging", is production: the secret (at least 32 characters) and BETTER_AUTH_URL
 * are required, and wildcards in BETTER_AUTH_TRUSTED_ORIGINS are refused. Consequence:
 * running the api locally needs NODE_ENV=development (the `dev` script in
 * apps/api/package.json does not set it yet; a follow-up bead adds it).
 * Error messages name the variable, never the secret's value.
 */
export function resolveAuthConfig(db: Database, env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const url = env.BETTER_AUTH_URL?.trim() ?? "";
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  const production = env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
  const extraOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (production) {
    if (secret === "") throw new Error("BETTER_AUTH_SECRET is required in production");
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production`);
    }
    if (url === "") throw new Error("BETTER_AUTH_URL is required in production");
    if (extraOrigins.some((origin) => origin.includes("*"))) {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must not contain wildcards in production");
    }
  }
  return {
    db,
    secret: secret || DEV_SECRET,
    baseURL: url || DEV_BASE_URL,
    production,
    trustedOrigins: [...(production ? [] : DEV_TRUSTED_ORIGINS), ...extraOrigins],
  };
}

export function createAuth(config: AuthConfig) {
  return betterAuth({
    database: config.db, // a bun:sqlite Database is accepted directly
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: "/api/auth",
    trustedOrigins: config.trustedOrigins ?? [],
    // No sendVerificationEmail / sendResetPassword: nothing can send mail.
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    session: { expiresIn: SESSION_EXPIRES_IN_SECONDS },
    advanced: {
      useSecureCookies: config.production,
      // Better Auth skips the origin check under NODE_ENV=test unless told otherwise.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // ensureAuthSchema runs right after construction; the built-in eager check would
      // log a false "schema mismatch" error on every first boot (tables do not exist yet).
      database: { validateSchema: false },
    },
    // In-memory limiter keyed by client IP. Anonymous sign-in gets a roomier rule so a
    // classroom behind one NAT can start together; it is still capped per minute.
    // Advisory: the limiter trusts X-Forwarded-For from the platform proxy, so a caller
    // that rotates that header evades it and a header-less caller shares one bucket.
    // Verify Railway's forwarding behaviour at deploy time.
    rateLimit: {
      enabled: config.production,
      storage: "memory",
      customRules: { "/sign-in/anonymous": { window: 60, max: 30 } },
    },
    plugins: [
      anonymous(),
      admin({ roles, defaultRole: ROLE_CONTRIBUTOR, adminRoles: [ROLE_ADMIN] }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const instances = new WeakMap<Database, Auth>();
const migrations = new WeakMap<Database, Promise<void>>();

/** One Auth per Database handle, configured from env on first use. */
export function getAuth(deps: { db: Database }, env: NodeJS.ProcessEnv = process.env): Auth {
  let auth = instances.get(deps.db);
  if (!auth) {
    auth = createAuth(resolveAuthConfig(deps.db, env));
    instances.set(deps.db, auth);
  }
  return auth;
}

/** Creates or extends Better Auth's tables. Idempotent; concurrent callers share one run. */
export function ensureAuthSchema(auth: Auth, db: Database): Promise<void> {
  let run = migrations.get(db);
  if (!run) {
    run = auth.$context.then((ctx) => ctx.runMigrations());
    migrations.set(db, run);
    run.catch(() => migrations.delete(db)); // a failed run may be retried
  }
  return run;
}

/** Session for a request's headers (cookie), or null. Later middleware wraps this. */
export async function getSession(auth: Auth, headers: Headers) {
  return auth.api.getSession({ headers });
}

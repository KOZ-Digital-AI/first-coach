// Session middleware and role guards for route modules.
//
//   import { requireAdmin, type AuthVariables } from "../../auth/middleware";
//   const admin = new Hono<{ Variables: AuthVariables }>();
//   admin.use("*", requireAdmin(deps));
//   admin.get("/x", (c) => c.json({ me: c.var.playerId }));
//
// - requirePlayer      any signed-in user, anonymous players included.
// - requireContributor a signed-in, non-anonymous user (email + password account).
// - requireAdmin       a non-anonymous user whose role includes "admin".
//
// Anonymous players also carry the role "contributor" (the admin plugin's defaultRole
// applies to everyone), so the role alone cannot tell a player from a contributor: the
// `isAnonymous` flag decides that.
//
// Trust boundary: identity and roles come ONLY from the server session, which Better Auth
// resolves from the signed session cookie and the database row. Nothing in the request
// (other headers, query, body) is ever read here, so it cannot grant a role.
//
// Every guard fails closed: no session is a 401, a banned or insufficient user is a 403,
// and an exception while resolving the session propagates to the app's error handler (a
// 500) without ever calling next().
//
// Style: a factory per guard, `requireX(deps, options?)`. `deps` supplies the database that
// the shared Better Auth instance (getAuth) is keyed on; the auth instance is resolved
// lazily on the first request. `options.resolveSession` replaces the real lookup in tests.
import type { Database } from "bun:sqlite";
import type { MiddlewareHandler } from "hono";
import { problem } from "../http/problem";
import { getAuth, getSession, ROLE_ADMIN, ROLE_CONTRIBUTOR } from "./better-auth";

export type AuthUser = {
  id: string;
  /** Raw role string as stored (possibly comma-separated); defaults to contributor. */
  role: string;
  isAnonymous: boolean;
  name?: string;
};

/** Hono `Variables` set by every guard; use as `new Hono<{ Variables: AuthVariables }>()`. */
export type AuthVariables = {
  /** The session user's id. */
  playerId: string;
  user: AuthUser;
};

/** The part of a Better Auth session the guards read (the real session is assignable). */
export type SessionLike = {
  user: {
    id: string;
    name?: string | null;
    role?: string | null;
    isAnonymous?: boolean | null;
    banned?: boolean | null;
    banExpires?: Date | string | number | null;
  };
};

export type SessionResolver = (headers: Headers) => Promise<SessionLike | null>;

export type GuardOptions = {
  /** Test seam; defaults to Better Auth's `getSession` on the shared auth instance. */
  resolveSession?: SessionResolver;
};

export type Guard = (
  deps: { db: Database },
  options?: GuardOptions,
) => MiddlewareHandler<{ Variables: AuthVariables }>;

type Level = "player" | "contributor" | "admin";

const unauthorized = () => problem(401, "Unauthorized", "Authentication is required.");
const forbidden = (detail: string) => problem(403, "Forbidden", detail);

/** A ban applies until its expiry; no expiry, or an unreadable one, means it still applies. */
function isBanned(user: SessionLike["user"]): boolean {
  if (!user.banned) return false;
  if (user.banExpires === null || user.banExpires === undefined) return true;
  const until = new Date(user.banExpires).getTime();
  return Number.isNaN(until) || until > Date.now();
}

const hasRole = (role: string, wanted: string): boolean =>
  role.split(",").some((part) => part.trim() === wanted);

function guard(level: Level): Guard {
  return (deps, options = {}) => {
    const resolve: SessionResolver =
      options.resolveSession ?? ((headers) => getSession(getAuth(deps), headers));

    return async (c, next) => {
      let session: SessionLike | null;
      try {
        session = await resolve(c.req.raw.headers);
      } catch (cause) {
        // Never fall through to next(). Hono only routes `Error` instances to onError.
        throw cause instanceof Error ? cause : new Error("session lookup failed", { cause });
      }
      if (!session?.user) return unauthorized();

      const { user } = session;
      if (isBanned(user)) return forbidden("This account may not perform this action.");

      // Only an explicit `false` is a non-anonymous account.
      const isAnonymous = user.isAnonymous !== false;
      const role = user.role ?? ROLE_CONTRIBUTOR;

      if (level !== "player" && isAnonymous) {
        return forbidden("A contributor account is required.");
      }
      if (level === "admin" && !hasRole(role, ROLE_ADMIN)) {
        return forbidden("An administrator account is required.");
      }

      c.set("playerId", user.id);
      c.set("user", {
        id: user.id,
        role,
        isAnonymous,
        ...(typeof user.name === "string" && { name: user.name }),
      });
      await next();
    };
  };
}

export const requirePlayer: Guard = guard("player");
export const requireContributor: Guard = guard("contributor");
export const requireAdmin: Guard = guard("admin");

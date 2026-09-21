// Rate limits for the auth endpoints and the write routes.
//
// - `RATE_LIMITS` is the ONE place the numbers live. better-auth.ts derives Better Auth's
//   own rules (sign-in, sign-up, anonymous sign-in) from it; the Hono limiter below reads
//   the write-route rules from it.
// - `rateLimit(rule)` is a Hono middleware for write routes. Mount it AFTER a session guard:
//
//     app.post("/contributions", requireContributor(deps), rateLimit("contribution"), handler);
//
//   It keys on the session user id (`c.var.playerId`, set by the guards) plus the client IP,
//   counts every request that reaches it (a request that later fails validation still uses
//   budget, so probing costs the caller), and answers 429 problem+json with a Retry-After
//   header (whole seconds) when the budget is spent. It uses fixed windows that start at a
//   key's first request.
// - Brute-force protection for passwords is exactly these limits: there is no email, so
//   there is no reset flow; a lost password is reset by the admin CLI (cc.cli).
//
// FAILS CLOSED: mounted without a guard (no user id on the context) it answers 401 and never
// calls next(); an unusable client IP falls into a shared "unknown" bucket instead of skipping
// the limit.
//
// TRUSTED-PROXY ASSUMPTION (client IP): the client address comes from X-Forwarded-For, which a
// caller can forge. It is trusted only when it holds EXACTLY ONE valid IP address, the shape
// the platform edge proxy produces when it sets or appends the header for a client that sent
// none. A multi-value chain (a caller-prepended claim plus the proxy's entry), an unparseable
// value or no header is treated as "unknown" (one shared bucket), never as the leftmost
// value, so rotating fake addresses cannot buy fresh budgets. This is only sound while the
// app is reachable solely through that one proxy (Railway's edge) and the proxy overwrites a
// spoofed header; if the origin is ever exposed directly, or a second proxy hop is added,
// revisit this function. Better Auth's own limiter (better-auth.ts) applies the same rule to
// the same header. Known gaps: counters live in this process's memory and reset on restart
// (single instance; Better Auth's counters are in SQLite), and IPv6 addresses are not
// collapsed to a /64, so one host with a whole /64 could use several buckets per user.
import { isIP } from "node:net";
import type { MiddlewareHandler } from "hono";
import { problem } from "../http/problem";
import type { AuthVariables } from "./middleware";

/** `window` is in seconds (Better Auth's rule shape). */
export type RateRule = { max: number; window: number };

const MINUTES_15 = 15 * 60;
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const RATE_LIMITS = {
  // Better Auth built-ins, per IP (see better-auth.ts).
  signIn: { max: 10, window: MINUTES_15 },
  signUp: { max: 10, window: MINUTES_15 },
  anonymousSignIn: { max: 30, window: HOUR },
  // Write routes, per user id + IP (the Hono limiter below).
  contribution: { max: 10, window: DAY },
  videoAnalysis: { max: 10, window: DAY },
  aiPlan: { max: 20, window: DAY },
  recover: { max: 5, window: MINUTES_15 },
} as const satisfies Record<string, RateRule>;

/** Rules the Hono limiter can enforce. */
export type WriteRuleName = "contribution" | "videoAnalysis" | "aiPlan" | "recover";

type Entry = { count: number; resetAt: number };
export type RateLimitStore = Map<string, Entry>;

export const createRateLimitStore = (): RateLimitStore => new Map();

export type RateLimitOptions = {
  /** Clock in epoch milliseconds; a test seam. */
  now?: () => number;
  /** Counters. Defaults to one store per rule, shared by every route using that rule. */
  store?: RateLimitStore;
  /** Most keys a store holds before expired ones are swept and then the oldest evicted. */
  maxKeys?: number;
};

const DEFAULT_MAX_KEYS = 50_000;
const UNKNOWN_IP = "unknown";
const defaultStores = new Map<WriteRuleName, RateLimitStore>();

const storeFor = (name: WriteRuleName): RateLimitStore => {
  let store = defaultStores.get(name);
  if (!store) {
    store = createRateLimitStore();
    defaultStores.set(name, store);
  }
  return store;
};

/** See the TRUSTED-PROXY ASSUMPTION above. Returns a canonical address or "unknown". */
function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return UNKNOWN_IP;
  const chain = forwarded.split(",");
  if (chain.length !== 1) return UNKNOWN_IP;
  const ip = chain[0]!.trim();
  const family = isIP(ip);
  if (family === 4) return ip;
  // The URL parser canonicalises IPv6 text (case, "::" compression), so one address is one key.
  if (family === 6) return new URL(`http://[${ip}]/`).hostname;
  return UNKNOWN_IP;
}

/** Makes room for one more key: drop expired counters, then the oldest ones. */
function makeRoom(store: RateLimitStore, now: number, maxKeys: number): void {
  if (store.size < maxKeys) return;
  for (const [key, entry] of store) if (now >= entry.resetAt) store.delete(key);
  for (const key of store.keys()) {
    if (store.size < maxKeys) break;
    store.delete(key); // Map iterates in insertion order: oldest first
  }
}

export function rateLimit(
  name: WriteRuleName,
  options: RateLimitOptions = {},
): MiddlewareHandler<{ Variables: AuthVariables }> {
  const rule: RateRule = RATE_LIMITS[name];
  const now = options.now ?? Date.now;
  const store = options.store ?? storeFor(name);
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

  return async (c, next) => {
    const userId = c.get("playerId");
    if (typeof userId !== "string" || userId === "") {
      return problem(401, "Unauthorized", "Authentication is required.");
    }

    const key = `${userId}|${clientIp(c.req.raw.headers)}`;
    const at = now();
    const entry = store.get(key);

    if (entry && at < entry.resetAt) {
      if (entry.count >= rule.max) {
        const res = problem(429, "Too Many Requests", "Rate limit exceeded. Try again later.");
        res.headers.set("Retry-After", String(Math.ceil((entry.resetAt - at) / 1000)));
        return res;
      }
      entry.count += 1;
    } else {
      store.delete(key); // a lapsed window is replaced, and becomes the newest key
      makeRoom(store, at, maxKeys);
      store.set(key, { count: 1, resetAt: at + rule.window * 1000 });
    }
    await next();
  };
}

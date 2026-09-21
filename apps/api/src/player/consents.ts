// The player's consents (fc-mol-bjm.2): what they agreed to, as a history in `consents` (007_privacy.sql), and the
// gate that keeps a feature behind a consent.
//
//   getConsents(db, playerId)             the current Consents (shared/privacy.ts); everything off for a player who never chose
//   setConsents(db, playerId, update)     appends history rows, applies the under-13 rule, returns the updated Consents
//   requireConsent(deps, kind)            Hono middleware: 403 problem 'consent required' unless `kind` is granted
//
// Consumers: the privacy settings screen (GET/PUT /api/player/consents, http/routes/player-consents.routes.ts) and the
// video coach endpoint (requireConsent(deps, "videoAnalysis") after requirePlayer).
//
// Every function takes the bun:sqlite Database (no module singleton); SQL uses bound parameters only. Every statement
// is keyed by the `playerId` the caller took from the session, never from a request body.
//
// Readings the criteria leave open (each pinned by consents.test.ts)
//   * requireConsent takes the deps first, like the guards (`requirePlayer(deps)`): the middleware needs the database,
//     and it needs the player, which a session guard mounted BEFORE it puts on the context (`c.var.playerId`). Without a
//     player on the context it fails closed with a 401 and never calls next().
//   * CURRENT = the highest id of a (player, kind), as 007_privacy.sql prescribes (never the timestamp, a host clock may
//     step back). No row means the constant DEFAULT_CONSENTS entry (granted false, no `at`).
//   * A request writes ONE row per key that is PRESENT (true grants, false revokes); an omitted key writes nothing, and so
//     does `guardianConfirmed` on its own. Repeating the current value still appends a row (it is a recorded decision).
//   * guardian_confirmed is stored 1 only for a videoAnalysis GRANT whose request says guardianConfirmed: true (at any
//     age); a revoke and every modelImprovement row store 0 (the table refuses a modelImprovement row with 1).
//   * THE UNDER-13 RULE is isConsentUpdateAllowed(age, update) from the contract, with the player's CURRENT age read from
//     player_profiles inside the same transaction. A refusal is GuardianConfirmationRequiredError and NOTHING of the
//     request is written (all or nothing). A player with no profile has no age and no row to reference:
//     PlayerNotOnboardedError. Reading needs no profile.
//   * changed_at is the server's time (Date#toISOString, canonical UTC); `now` is an option for tests.
import type { Database } from "bun:sqlite";
import type { MiddlewareHandler } from "hono";
import { problem } from "../http/problem";
import type { AuthVariables } from "../auth/middleware";
import { DEFAULT_CONSENTS, isConsentUpdateAllowed } from "../shared/privacy";
import type { Consents, UpdateConsentsRequest } from "../shared/privacy";
import { CONSENT_REQUIRED_TITLE } from "../shared/video";

/** A consent that can be gated: a key of the contract's Consents. */
export type ConsentKind = keyof Consents;

/** The consent kinds in the order they are written and read. */
const KINDS = ["videoAnalysis", "modelImprovement"] as const satisfies readonly ConsentKind[];

/** The request would grant videoAnalysis to a player under 13 without `guardianConfirmed: true`. */
export class GuardianConfirmationRequiredError extends Error {
  constructor() {
    super("A guardian must confirm before a player under 13 can grant video analysis.");
    this.name = "GuardianConfirmationRequiredError";
  }
}

/** The player has no profile (no age to apply the rules to, no row to attach consents to). */
export class PlayerNotOnboardedError extends Error {
  constructor() {
    super("The player is not onboarded.");
    this.name = "PlayerNotOnboardedError";
  }
}

/** Injectable clock. */
export interface ConsentOptions {
  now?: () => Date;
}

interface ConsentRow {
  granted: number;
  guardian_confirmed: number;
  changed_at: string;
}

/** The latest row of a (player, kind): the highest id, a backwards seek of consents_by_player_kind. */
function currentRow(db: Database, playerId: string, kind: ConsentKind): ConsentRow | null {
  return db
    .query<ConsentRow, [string, string]>(
      "SELECT granted, guardian_confirmed, changed_at FROM consents WHERE player_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
    )
    .get(playerId, kind);
}

/** The player's current consents; everything off (DEFAULT_CONSENTS) for whatever they never chose. */
export function getConsents(db: Database, playerId: string): Consents {
  const video = currentRow(db, playerId, "videoAnalysis");
  const model = currentRow(db, playerId, "modelImprovement");
  return {
    videoAnalysis:
      video === null
        ? DEFAULT_CONSENTS.videoAnalysis
        : { granted: video.granted === 1, at: video.changed_at, guardianConfirmed: video.guardian_confirmed === 1 },
    modelImprovement:
      model === null ? DEFAULT_CONSENTS.modelImprovement : { granted: model.granted === 1, at: model.changed_at },
  };
}

/**
 * Records the change in `update` as new history rows and returns the player's Consents as they are afterwards.
 * Throws PlayerNotOnboardedError or GuardianConfirmationRequiredError, writing nothing.
 */
export function setConsents(db: Database, playerId: string, update: UpdateConsentsRequest, options: ConsentOptions = {}): Consents {
  const at = (options.now?.() ?? new Date()).toISOString();
  return db
    .transaction((): Consents => {
      const profile = db.query<{ age: number }, [string]>("SELECT age FROM player_profiles WHERE player_id = ?").get(playerId);
      if (profile === null) throw new PlayerNotOnboardedError();
      if (!isConsentUpdateAllowed(profile.age, update)) throw new GuardianConfirmationRequiredError();

      const insert = db.query("INSERT INTO consents (player_id, kind, granted, guardian_confirmed, changed_at) VALUES (?, ?, ?, ?, ?)");
      for (const kind of KINDS) {
        const granted = update[kind];
        if (granted === undefined) continue;
        const guardian = kind === "videoAnalysis" && granted && update.guardianConfirmed === true;
        insert.run(playerId, kind, granted ? 1 : 0, guardian ? 1 : 0, at);
      }
      return getConsents(db, playerId);
    })
    .immediate();
}

/**
 * Middleware: lets the request through only while the session's player has `kind` granted, else a 403 problem
 * titled 'consent required'. Mount it AFTER a session guard (requirePlayer), which sets `c.var.playerId`; without
 * one it answers 401 and never calls next().
 */
export function requireConsent(deps: { db: Database }, kind: ConsentKind): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const playerId = c.get("playerId") as string | undefined;
    if (typeof playerId !== "string" || playerId === "") return problem(401, "Unauthorized", "Authentication is required.");
    if (!getConsents(deps.db, playerId)[kind].granted) {
      return problem(403, CONSENT_REQUIRED_TITLE, `The player has not granted the ${kind} consent.`);
    }
    await next();
  };
}

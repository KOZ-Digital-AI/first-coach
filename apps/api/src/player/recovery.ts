// Recovery codes (fc-mol-bjm.3): how a player who has no account takes their progress to a new session.
//
// The player is shown a code once (POST /api/player/recovery-code). Later, on another device or after the
// cookie was lost, the client signs in anonymously and posts the code (POST /api/player/recover): every row of
// the old player moves to that new session. Tables: recovery_codes (007_privacy.sql).
//
// THE CODE
//   * 16 characters from a 31-character alphabet with nothing that looks like something else (no 0, 1, O, I, L),
//     shown as 4 groups of 4 joined by hyphens, the contract's canonical form (RECOVERY_CODE_PATTERN). Drawn
//     from crypto.getRandomValues with rejection sampling (no modulo bias): 31^16 is about 2^79.
//   * ONLY its hash is stored: sha-256 of the CANONICAL code (normalizeRecoveryCode first, so what was typed with
//     spaces or in lower case hashes like what was shown), 64 lower-case hex characters (the CHECK of
//     recovery_codes.code_hash). 79 bits of entropy make a salt or a work factor pointless: there is nothing to
//     brute-force offline, and the attempt limit of the route (5 per 15 minutes per IP) covers the online guess.
//   * The lookup is WHERE code_hash = ? (an index seek on a digest the caller cannot steer, so its timing says
//     nothing about the code), and the digest is then compared with crypto.timingSafeEqual. An unknown code is
//     compared against an all-zero digest, so a known and an unknown code cost the same comparison.
//
// RESTORE (recoverPlayer), ONE `db.transaction(...).immediate()`
//   1. verify the code (unknown = "invalid", the route's generic 422);
//   2. when the code is the current player's own, nothing moves (success, idempotent);
//   3. when the current player already has data (a row in ANY table with a player_id) it is refused ("conflict",
//      409) unless `replace` is set, which deletes that data first;
//   4. every table with a player_id column, DISCOVERED BY INTROSPECTION (sqlite_master + pragma_table_info, so a
//      table a later migration adds is moved without touching this file), is re-pointed from the old player to
//      the current one. player_profiles goes first: its ON UPDATE CASCADE re-keys the children that reference
//      it (a child moved before its parent would violate its foreign key), and a plain UPDATE on the others
//      then picks up whatever has no foreign key. NEVER `UPDATE OR REPLACE` / `INSERT OR REPLACE` here (see
//      007_privacy.sql: a replace would delete another player's profile, and the cascade takes their data);
//      the target is checked empty (step 3) before the re-key, so the primary key never collides;
//   5. last_used_at of the code is set; the code stays valid for the new session (the row moved with the
//      profile).
// Any failure rolls the whole transaction back: the player keeps every row under the old id.
import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import type { PlayerProfileView, Roadmap } from "../shared/domain";
import { normalizeRecoveryCode } from "../shared/privacy";
import type { RecoveryCodeResponse } from "../shared/privacy";
import { getProfile, getRoadmap } from "./profile-repo";

// --- the code ------------------------------------------------------------------------------------

/** 31 characters: the digits and capitals without 0, 1, O, I and L. */
export const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const GROUPS = 4;
const GROUP_SIZE = 4;
const CODE_LENGTH = GROUPS * GROUP_SIZE;
/** Bytes below this are spread evenly over the alphabet (248 = 8 * 31); the rest are redrawn. */
const UNBIASED_LIMIT = 248;

/** A new random code in the canonical form, e.g. "K7QM-2XHD-9WTB-PNC4". */
export function generateRecoveryCode(): string {
  const chars: string[] = [];
  while (chars.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
      if (byte >= UNBIASED_LIMIT || chars.length === CODE_LENGTH) continue;
      chars.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]!);
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i += GROUP_SIZE) groups.push(chars.slice(i, i + GROUP_SIZE).join(""));
  return groups.join("-");
}

/** The stored form of a code: lower-case hex sha-256 of its canonical spelling. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

/** What an unknown code is compared with, so that it costs the same comparison as a known one. */
const NO_HASH = "0".repeat(64);

/** The constant-time comparator; a parameter only so that a test can see it being used. */
export type DigestCompare = (a: Uint8Array, b: Uint8Array) => boolean;

/** The player id the code belongs to, or null. The digests are compared with `compare` (constant time). */
export function verifyRecoveryCode(db: Database, code: string, compare: DigestCompare = timingSafeEqual): string | null {
  const wanted = hashRecoveryCode(code);
  const row = db
    .query<{ player_id: string; code_hash: string }, [string]>("SELECT player_id, code_hash FROM recovery_codes WHERE code_hash = ?")
    .get(wanted);
  const same = compare(Buffer.from(wanted, "hex"), Buffer.from(row?.code_hash ?? NO_HASH, "hex"));
  return row !== null && same ? row.player_id : null;
}

// --- creating a code -----------------------------------------------------------------------------

export interface CreateOptions {
  now?: () => Date;
  /** A test seam: where codes come from. */
  generate?: () => string;
}

const MAX_DRAWS = 5;

const isHashCollision = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("UNIQUE constraint failed: recovery_codes.code_hash");

/**
 * Generates a code for the player, stores its hash (replacing an earlier code: one row per player, last_used_at
 * starts over) and returns it with the creation time. Null when the player has no profile. A code whose hash
 * another player holds is drawn again (007_privacy.sql: "a writer that hits it generates another code").
 */
export function createRecoveryCode(db: Database, playerId: string, options: CreateOptions = {}): RecoveryCodeResponse | null {
  const generate = options.generate ?? generateRecoveryCode;
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  return db
    .transaction((): RecoveryCodeResponse | null => {
      if (db.query("SELECT 1 FROM player_profiles WHERE player_id = ?").get(playerId) === null) return null;
      for (let draw = 0; draw < MAX_DRAWS; draw++) {
        const code = generate();
        try {
          db.query(
            `INSERT INTO recovery_codes (player_id, code_hash, created_at) VALUES (?, ?, ?)
             ON CONFLICT (player_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, last_used_at = NULL`,
          ).run(playerId, hashRecoveryCode(code), createdAt);
          return { code, createdAt };
        } catch (error) {
          if (!isHashCollision(error)) throw error;
        }
      }
      throw new Error("Could not draw a recovery code that is not already taken");
    })
    .immediate();
}

// --- restoring -----------------------------------------------------------------------------------

export type RecoverOutcome =
  | { status: "recovered"; profile: PlayerProfileView; roadmap: Roadmap | null }
  | { status: "invalid" }
  | { status: "conflict" };

export interface RecoverOptions {
  /** Drop the current player's own data instead of refusing. */
  replace?: boolean;
  now?: () => Date;
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Every table that has a player_id column, player_profiles first (its cascade re-keys the children). */
function playerIdTables(db: Database): string[] {
  const names = db
    .query<{ name: string }, []>(
      "SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = 'player_id' ORDER BY m.name",
    )
    .all()
    .map((row) => row.name);
  return [...names.filter((name) => name === "player_profiles"), ...names.filter((name) => name !== "player_profiles")];
}

const hasRows = (db: Database, tables: string[], playerId: string): boolean =>
  tables.some((table) => db.query(`SELECT 1 FROM ${quote(table)} WHERE player_id = ? LIMIT 1`).get(playerId) !== null);

/** Deletes the parent's rows first: the profile's cascade removes what references it. */
function deleteRows(db: Database, tables: string[], playerId: string): void {
  for (const table of tables) db.query(`DELETE FROM ${quote(table)} WHERE player_id = ?`).run(playerId);
}

function moveRows(db: Database, tables: string[], from: string, to: string): void {
  for (const table of tables) db.query(`UPDATE ${quote(table)} SET player_id = ?1 WHERE player_id = ?2`).run(to, from);
}

/** Moves the player behind `code` to `targetPlayerId` (the current session), see the header. */
export function recoverPlayer(db: Database, code: string, targetPlayerId: string, options: RecoverOptions = {}): RecoverOutcome {
  const usedAt = (options.now?.() ?? new Date()).toISOString();
  return db
    .transaction((): RecoverOutcome => {
      const fromPlayerId = verifyRecoveryCode(db, code);
      if (fromPlayerId === null) return { status: "invalid" };

      if (fromPlayerId !== targetPlayerId) {
        const tables = playerIdTables(db);
        if (hasRows(db, tables, targetPlayerId)) {
          if (options.replace !== true) return { status: "conflict" };
          deleteRows(db, tables, targetPlayerId);
        }
        moveRows(db, tables, fromPlayerId, targetPlayerId);
      }
      db.query("UPDATE recovery_codes SET last_used_at = ? WHERE player_id = ?").run(usedAt, targetPlayerId);

      const profile = getProfile(db, targetPlayerId);
      if (profile === null) throw new Error("A recovered player has no profile"); // rolls back: never a half restore
      return { status: "recovered", profile, roadmap: getRoadmap(db, targetPlayerId) };
    })
    .immediate();
}

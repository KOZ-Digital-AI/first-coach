// Player data erasure (fc-mol-bjm.5): what DELETE /api/player (http/routes/player-delete.routes.ts) runs.
//
// deletePlayerData(db, playerId)
//   Deletes the player's player_profiles row. Every other player-owned table references player_profiles
//   ON DELETE CASCADE (002, 005 and 007), so the database removes the rest (results, roadmaps, sessions, session
//   events, consents, the recovery code hash): this module deletes no child row itself. It then VERIFIES: every
//   table with a column named player_id, found in the schema at run time, must hold no row of the player, and if
//   one still does (a later migration's table that forgot the cascade, or a connection with foreign keys OFF)
//   it throws ErasureIncompleteError naming the tables. The whole thing is ONE `db.transaction(...).immediate()`
//   (a savepoint when the caller already has a transaction), so a failed verification rolls the deletion back and
//   nothing changes: a half-erased player is never left behind, and a failure is loud, never a silent leftover.
//
// deletePlayerAccount(db, playerId)
//   deletePlayerData plus the caller's Better Auth user, its sessions and its accounts, in the same transaction:
//   the erasure of the data and the end of the identity stand or fall together. Better Auth's tables are created at
//   route-register time (auth/better-auth.ts), so each is only touched when it exists.
//
// Readings the criteria leave open
//   * "No table still holds the player id" = no table with a player_id column (main and TEMP schemas) holds a row
//     with that value. Columns with other names are not player data: contributions.submitter_user_id and
//     drill_versions.author_user_id (no foreign key to "user", 001 and 006) are NOT touched, so "contributions made
//     under a coach account ... stay attributed" (and their uploaded files, which belong to the contribution).
//   * The auth user is deleted whatever its kind. A guest linked to an email account (fc-mol-70i.12) has its rows
//     re-keyed to the account, so the account's DELETE erases them; a coach account is deleted as a whole.
//   * A player without a profile owns no rows (every table references player_profiles): only the identity ends.
//     deletePlayerData answers { deleted: false } and throws nothing.
//   * The same synchronous transaction as auth/link-account.ts: Better Auth's Kysely shares the app's single
//     bun:sqlite connection, so there is no `await` between BEGIN and COMMIT. The auth rows are deleted with SQL
//     (session and account also cascade from "user"; the explicit deletes make the order plain).
import type { Database } from "bun:sqlite";

/** Thrown, after rolling back, when a table with a player_id column still holds the player's rows. */
export class ErasureIncompleteError extends Error {
  /** The tables that still held a row of the player (schema names, never the player id). */
  readonly tables: readonly string[];

  constructor(tables: readonly string[]) {
    super(`Player erasure is incomplete: table(s) still holding the player id: ${tables.join(", ")}`);
    this.name = "ErasureIncompleteError";
    this.tables = tables;
  }
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Every table (main and TEMP schema) with a column named player_id, from the schema itself. */
export function playerIdTables(db: Database): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT m.name AS name
         FROM (SELECT name, type FROM sqlite_master UNION ALL SELECT name, type FROM sqlite_temp_master) m,
              pragma_table_info(m.name) c
        WHERE m.type = 'table' AND lower(c.name) = 'player_id'
        ORDER BY m.name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

const tableExists = (db: Database, name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;

function eraseWithinTransaction(db: Database, playerId: string): { deleted: boolean } {
  const { changes } = db.query("DELETE FROM player_profiles WHERE player_id = ?").run(playerId);
  const leftovers = playerIdTables(db).filter(
    (table) => db.query(`SELECT 1 FROM ${quote(table)} WHERE player_id = ? LIMIT 1`).get(playerId) !== null,
  );
  if (leftovers.length > 0) throw new ErasureIncompleteError(leftovers);
  return { deleted: changes > 0 };
}

/** Deletes the player's profile (the foreign keys cascade the rest) and verifies nothing is left; see the header. */
export function deletePlayerData(db: Database, playerId: string): { deleted: boolean } {
  return db.transaction(() => eraseWithinTransaction(db, playerId)).immediate();
}

/** deletePlayerData plus the Better Auth user, its sessions and accounts, atomically; see the header. */
export function deletePlayerAccount(db: Database, playerId: string): { deleted: boolean } {
  return db
    .transaction(() => {
      const result = eraseWithinTransaction(db, playerId);
      if (tableExists(db, "session")) db.query('DELETE FROM "session" WHERE "userId" = ?').run(playerId);
      if (tableExists(db, "account")) db.query('DELETE FROM "account" WHERE "userId" = ?').run(playerId);
      if (tableExists(db, "user")) db.query('DELETE FROM "user" WHERE id = ?').run(playerId);
      return result;
    })
    .immediate();
}

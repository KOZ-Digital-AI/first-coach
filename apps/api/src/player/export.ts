// The player's data export (fc-mol-bjm.4): everything stored about one player, as one JSON document. Served by
// GET /api/player/export (http/routes/player-export.routes.ts); the contract is shared/privacy.ts (PlayerExport,
// "a JSON download of everything stored about the player; its content is not fixed").
//
// DISCOVERY BY SCHEMA. The tables are not listed here: every table of the database with a column named player_id
// is exported (the rows WHERE player_id = <the player>), found through sqlite_master and pragma_table_info at call
// time, exactly as auth/link-account.ts finds the tables it must move. A table that a later slice adds is
// therefore exported with no change to this file (it gets a generic README line until someone writes it a
// specific one below). Two tables hold the player's data under another key and are added explicitly, when they exist:
// contributions (submitter_user_id, no player_id: contributions are made by signed-in accounts) and its attachments.
//
// OWNER ISOLATION. `playerId` comes from the session, never from the request; every statement is bound to it, so
// another player's row cannot reach the document.
//
// SECRETS NEVER LEAVE. Columns are chosen from the schema and a column whose name says hash, token, secret,
// password or salt is not selected at all (SECRET_COLUMN): the recovery code hash (recovery_codes.code_hash) is
// one, and a secret column added by a later slice is dropped the same way (fail closed: an innocent column that
// matches the pattern is left out, which is the safe error). Better Auth's own tables (user, session, account,
// verification) have no player_id column and are not exported, so session tokens and password hashes are not in
// reach. contribution_attachments.stored_path (a server-side file path) is withheld by name.
//
// Readings the criteria leave open
//   * SHAPE: { exportedAt, playerId, readme: { about, sections }, tables }; `tables[name]` is the array of the
//     player's rows (column name -> stored value, in the order the table stores them: rowid, or the primary key
//     of a WITHOUT ROWID table); `readme.sections[name]` explains that table. A table with no rows of the player
//     is still present, as [], so the reader sees it exists.
//   * VALUES are what SQLite stores: integers stay numbers (booleans are 0/1), JSON columns stay the JSON text
//     they are stored as (roadmaps.json, sessions.items), a BLOB is base64 text so the document is plain JSON.
//   * A PLAYER WITHOUT DATA (never onboarded) still gets a valid document with every section empty; it is not a 404.
import type { Database } from "bun:sqlite";

export type PlayerExportDocument = {
  exportedAt: string;
  playerId: string;
  readme: { about: string; sections: Record<string, string> };
  tables: Record<string, Record<string, unknown>[]>;
};

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Columns whose name says they hold a secret; never selected. */
const SECRET_COLUMN = /hash|token|secret|password|salt/i;

/** Columns withheld by name, per table, on top of SECRET_COLUMN. */
const WITHHELD_COLUMNS: Record<string, readonly string[]> = {
  contribution_attachments: ["stored_path"],
};

/** Tables that hold the player's data under a key other than player_id: table, and the WHERE that selects the player's rows. */
const EXTRA_SOURCES: readonly { table: string; where: string }[] = [
  { table: "contributions", where: "submitter_user_id = ?" },
  { table: "contribution_attachments", where: "contribution_id IN (SELECT id FROM contributions WHERE submitter_user_id = ?)" },
];

const ABOUT =
  "Everything First Coach stores about you, one section per table under `tables`. Each section holds only your own " +
  "rows; no other player's data is included. Secrets are left out: the hash of your recovery code, session tokens and " +
  "passwords. Times are UTC (ISO 8601). Columns that hold JSON are kept as the text they are stored as, yes/no values " +
  "are 1/0, and binary data is base64. `readme.sections` explains each section.";

/** What each known table is, in the player's terms. A table without an entry gets GENERIC. */
const SECTIONS: Record<string, string> = {
  player_profiles: "Your profile: age, level, goal, equipment, space, partner, days per week, minutes per session and language.",
  test_results: "Your skill test results, baseline and retests, one row per measurement (or skipped test), oldest first.",
  roadmaps: "Your training plans (roadmaps). The newest row is the current plan, older rows are the history; the plan itself is JSON text.",
  sessions: "Your daily training sessions: the date, who planned it and the list of drills (JSON text); finished_at is empty until you finished it.",
  session_events: "What you did in your sessions: drills done or undone, results and session finished, with the time the app recorded it and the time the server received it.",
  consents: "Your privacy choices as a history: each row is one grant or revoke of a consent (kind, granted 1/0, guardian_confirmed 1/0, changed_at); the newest row of a kind is the current choice.",
  recovery_codes: "Your recovery code record: when the current code was created and when it was last used. The hash of the code is left out and the code itself is never stored.",
  contributions: "The drills and improvements you submitted (payload is JSON text), with their review state. The internal content hash is left out.",
  contribution_attachments: "The files attached to your contributions: kind, type, size and original file name. The server's storage path is left out.",
};

const generic = (table: string): string => `Rows of the table ${table} that belong to you.`;

const tableExists = (db: Database, table: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;

/** Every table of the database with a column named player_id, from the schema itself. */
function tablesWithPlayerId(db: Database): string[] {
  return (
    db
      .query(
        `SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) c
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND c.name = 'player_id' ORDER BY m.name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/** The columns to export (in stored order) and the ORDER BY clause of a table. */
function layout(db: Database, table: string): { columns: string[]; orderBy: string } {
  const info = db.query("SELECT name, pk FROM pragma_table_info(?) ORDER BY cid").all(table) as { name: string; pk: number }[];
  const withheld = WITHHELD_COLUMNS[table] ?? [];
  const columns = info.map((c) => c.name).filter((name) => !SECRET_COLUMN.test(name) && !withheld.includes(name));
  const withoutRowid = (db.query("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(table) as { wr: number } | null)?.wr === 1;
  const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => quote(c.name));
  return { columns, orderBy: withoutRowid && pk.length > 0 ? `ORDER BY ${pk.join(", ")}` : "ORDER BY rowid" };
}

const plain = (value: unknown): unknown => (value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value);

function rowsOf(db: Database, table: string, where: string, playerId: string): Record<string, unknown>[] {
  const { columns, orderBy } = layout(db, table);
  if (columns.length === 0) return [];
  const sql = `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)} WHERE ${where} ${orderBy}`;
  return (db.query(sql).all(playerId) as Record<string, unknown>[]).map((row) =>
    Object.fromEntries(Object.entries(row).map(([name, value]) => [name, plain(value)])),
  );
}

/** Builds the export document of `playerId`. Synchronous and read-only. */
export function buildPlayerExport(db: Database, playerId: string, now: Date = new Date()): PlayerExportDocument {
  const sources = [
    ...tablesWithPlayerId(db).map((table) => ({ table, where: "player_id = ?" })),
    ...EXTRA_SOURCES.filter((source) => tableExists(db, source.table)),
  ];
  const tables: PlayerExportDocument["tables"] = {};
  const sections: Record<string, string> = {};
  // One read transaction: every section comes from the same snapshot.
  db.transaction(() => {
    for (const { table, where } of sources) {
      tables[table] = rowsOf(db, table, where, playerId);
      sections[table] = SECTIONS[table] ?? generic(table);
    }
  })();
  return { exportedAt: now.toISOString(), playerId, readme: { about: ABOUT, sections }, tables };
}

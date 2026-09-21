// onLinkAccount for Better Auth's anonymous() plugin (fc-mol-70i.12): a guest who signs up or signs in to a
// real (email) account keeps their progress.
//
// Why it is needed: every player-owned row is keyed by the auth user id, with NO foreign key to "user"
// (002_player.sql header). Better Auth deletes the anonymous user after a link, so without this hook the guest's
// profile, results, roadmaps, sessions and events would be orphaned under an id nobody can sign in to again.
//
// Where it runs (better-auth 1.7.5, plugins/anonymous): in the plugin's `after` hook of /sign-in*, /sign-up* and
// the other sign-in style paths, once the request has produced a NEW session and the request carried a session of
// an anonymous user. `onLinkAccount` is awaited BEFORE `deleteUser(anonymousUser)`, and a throw skips that delete
// (disableDeleteAnonymousUser is left at its default so the plugin keeps cleaning the anonymous user up after a
// successful link). The identity of both users comes from signed session cookies, never from the request body.
//
// The re-key (ON UPDATE CASCADE, as 002 and 005 document)
//   UPDATE player_profiles SET player_id = <account> WHERE player_id = <guest>
// and the database's ON UPDATE CASCADE carries test_results, roadmaps, sessions and session_events along (the
// append-only trigger of session_events allows exactly this: an update that changes player_id and nothing else).
// It is plain UPDATE, never UPDATE OR REPLACE (005 header: that would delete the profile that owns the target id).
//
// Everything runs in ONE synchronous `db.transaction(...).immediate()` on the app's single bun:sqlite connection,
// with no `await` between its BEGIN and COMMIT: Better Auth's Kysely shares that connection, so an async gap inside
// a transaction would let another request's statements run inside it (better-auth.ts header).
//
// FAIL CLOSED. Inside that transaction, after the update, every table that has a player_id column (discovered from
// the schema at run time, so a table added by a later migration is included) must hold exactly the rows the
// account and the guest held together before (rows are only moved, so the guest then holds none). Anything else (a table with no cascading key,
// foreign keys switched off) throws, the transaction rolls back and the hook throws: Better Auth then answers 500
// without a session cookie and does not delete the anonymous user, so the guest's data stays reachable and the
// person can sign in again with the same guest cookie (the account itself already exists by then). Neither user's
// data is ever lost. link-account.test.ts scans the migrated schema and fails when a table would not be carried.
//
// Readings the criteria leave open
//   * The real account ALREADY has a player_profiles row: nothing is merged and nothing is overwritten (the
//     account's data wins) and the guest's rows are left exactly where they are, reported as "account-kept". The
//     plugin still deletes the anonymous user, so those rows stay as orphans under an id nobody can use (a CONTRACT
//     GAP: reclaiming them is a later cleanup). They hold no personal data (002: no name, email or birth date).
//   * The guest has no profile: there is nothing to move ("nothing-to-link"). Every player-owned table references
//     player_profiles, so a guest without a profile owns no rows.
//   * The new user is itself anonymous (the plugin does not delete the anonymous user then) or is the same user:
//     "not-applicable", nothing touched.
//   * Outcome reporting: `linkPlayerData` RETURNS the outcome (the plugin ignores what onLinkAccount returns) and
//     the handler LOGS it through Better Auth's logger: status and row counts per table, never an id, email or name.
import type { Database } from "bun:sqlite";
import type { AnonymousOptions } from "better-auth/plugins/anonymous";

export type LinkOutcome =
  | { status: "linked"; rows: Record<string, number> }
  | { status: "nothing-to-link" }
  | { status: "account-kept" }
  | { status: "not-applicable" };

/** Where the handler reports an outcome. Defaults to Better Auth's logger (info, warn for account-kept). */
export type LinkLog = (outcome: LinkOutcome) => void;

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Every table of the database with a column named player_id, from the schema itself. */
function tablesWithPlayerId(db: Database): string[] {
  return (
    db
      .query(
        `SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) c
          WHERE m.type = 'table' AND c.name = 'player_id' ORDER BY m.name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const countRows = (db: Database, table: string, playerId: string): number =>
  (db.query(`SELECT count(*) AS n FROM ${quote(table)} WHERE player_id = ?`).get(playerId) as { n: number }).n;

const hasProfile = (db: Database, playerId: string): boolean =>
  db.query("SELECT 1 FROM player_profiles WHERE player_id = ?").get(playerId) !== null;

/**
 * Moves every player-owned row of `anonymousId` to `accountId`, atomically and synchronously. Throws (and changes
 * nothing) when the move cannot be proven complete. See the header for the outcomes.
 */
export function linkPlayerData(db: Database, anonymousId: string, accountId: string): LinkOutcome {
  if (anonymousId === accountId) return { status: "not-applicable" };
  return db
    .transaction((): LinkOutcome => {
      if (!hasProfile(db, anonymousId)) return { status: "nothing-to-link" };
      if (hasProfile(db, accountId)) return { status: "account-kept" };

      const tables = tablesWithPlayerId(db);
      const guestBefore = tables.map((table) => countRows(db, table, anonymousId));
      const accountBefore = tables.map((table) => countRows(db, table, accountId));

      db.query("UPDATE player_profiles SET player_id = ? WHERE player_id = ?").run(accountId, anonymousId);

      const rows: Record<string, number> = {};
      tables.forEach((table, i) => {
        // Rows are only moved, never created or deleted: the account holds all of them (so the guest holds none)
        // exactly when its count is what the two held together before.
        if (countRows(db, table, accountId) !== (accountBefore[i] ?? 0) + (guestBefore[i] ?? 0)) {
          // Table names come from the schema: safe to name, and they say which table the re-key forgot.
          throw new Error(`Guest to account re-key is incomplete for table ${table}`);
        }
        rows[table] = guestBefore[i] ?? 0;
      });
      return { status: "linked", rows };
    })
    .immediate();
}

type LinkAccountHandler = NonNullable<AnonymousOptions["onLinkAccount"]>;

/** The hook context the default logger needs; the real GenericEndpointContext satisfies it. */
type LoggerContext = {
  context: { logger: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void } };
};

/**
 * The anonymous() plugin's onLinkAccount. `log` replaces the default sink (tests). A failure of the re-key
 * propagates, which is what stops Better Auth from deleting the anonymous user.
 */
export function createLinkAccountHandler(db: Database, log?: LinkLog): LinkAccountHandler {
  return async ({ anonymousUser, newUser, ctx }) => {
    // The plugin does not delete the anonymous user when the new one is anonymous too: nothing to move.
    const outcome: LinkOutcome = newUser.user.isAnonymous
      ? { status: "not-applicable" }
      : linkPlayerData(db, anonymousUser.user.id, newUser.user.id);
    if (log) return log(outcome);
    const logger = (ctx as unknown as LoggerContext).context.logger;
    if (outcome.status === "account-kept") logger.warn("anonymous player data not moved: the account already has a profile", outcome);
    else if (outcome.status !== "not-applicable") logger.info("anonymous player data link", outcome);
  };
}

-- 007_privacy: what the player has consented to (as a history) and the hash of their recovery code.
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 008 and later. It touches nothing from 001, 003, 004, 005 or 006 and only REFERENCES
-- player_profiles from 002. The contract is shared/privacy.ts (Consents, UpdateConsentsRequest,
-- isConsentUpdateAllowed, RecoveryCodeResponse, RecoverRequest, RECOVERY_CODE_PATTERN).
--
-- Tables: consents (one row per consent CHANGE: the history, the highest id wins) and recovery_codes (at most
-- one row per player: the hash of the code the player was shown, never the code).
--
-- Names and Better Auth
--   * Our tables are consents and recovery_codes. Better Auth's own tables ("user", "session", "account"
--     and "verification") are created later by its migrator, at route-register time; none of the names
--     collide with ours (005 owns sessions and session_events, 006 contributions and
--     contribution_attachments), and 007_privacy.test.ts creates the Better Auth tables next to ours to
--     prove it. Our migrations must never create user, session, account or verification.
--   * player_id is the auth user id and has NO foreign key to "user" (see 002): on a migrate-only database
--     "user" does not exist. Both tables reference player_profiles instead (player_profiles.player_id).
--
-- Conventions (as 001-006)
--   * STRICT tables. Timestamps are TEXT, canonical ISO 8601 UTC with milliseconds
--     ("2026-01-01T00:00:00.000Z"): a CHECK refuses any other spelling (offsets, no milliseconds, invalid
--     dates, and hour 24: strftime would round-trip "T24:00:00.000Z", which Zod refuses and which spells the
--     next day's midnight twice), so text order IS time order. Writers must normalise to UTC
--     (new Date(at).toISOString()); Consents.at and RecoveryCodeResponse.createdAt are read back from here.
--   * CHECKs use IS, never = or <>, on anything that could be NULL: a NULL CHECK result ACCEPTS the row.
--     Every column but recovery_codes.last_used_at is NOT NULL.
--   * Booleans are INTEGER 0 / 1 (STRICT has no boolean type), CHECKed IN (0, 1).
--   * Enum CHECKs exist ONLY where the contract fixes the list: consents.kind. Its list MIRRORS the keys of
--     Consents in shared/privacy.ts (videoAnalysis, modelImprovement), spelt exactly as the contract spells
--     them; 007_privacy.test.ts parses it back out of sqlite_master and compares it with the contract.
--   * Text that must not be blank is refused when it is nothing but whitespace, whitespace being space, tab,
--     newline and carriage return; here that is subsumed by the fixed shapes (an enum, 64 hex characters).
--
-- consents
--   * A consent is never edited: each change (grant or revoke) is a NEW row, so the table is the player's
--     consent history (the contract says "history kept as rows"). The current consent of a player for a kind
--     is the LATEST row for that (player_id, kind), and latest means the HIGHEST id: id (AUTOINCREMENT) only
--     ever grows, so the later insert wins and the choice is immune to the host clock:
--       SELECT granted, guardian_confirmed, changed_at FROM consents
--        WHERE player_id = ? AND kind = ? ORDER BY id DESC LIMIT 1;
--     Ordering by changed_at would not be safe: if the host clock steps back (NTP, a restore, a VM resume) a
--     revoke stamped earlier than the grant before it would sort first, and the player's revoke would read as
--     still granted. changed_at is therefore for display and audit only (Consents.at is the current row's
--     changed_at) and is never used to decide which row is current; it may be older than an earlier row's.
--     No row means "never chose" = everything off (DEFAULT_CONSENTS, a server constant, not a table default).
--     PUT /api/player/consents inserts one row for each key that is present in the request; an omitted key is
--     left as it is (no row), so an omitted key writes nothing.
--   * (player_id, kind, id) is indexed (consents_by_player_kind): one backwards seek finds the current row,
--     with no sort, and the leading player_id also serves the erasure cascade and "all of a player's rows".
--     It is deliberately NOT unique: repeating a (player_id, kind) is the whole point of a history.
--   * granted is 1 for a grant and 0 for a revoke. guardian_confirmed is the contract's guardianConfirmed and
--     guardian confirmation applies only to videoAnalysis (modelImprovement has none): a CHECK refuses a
--     modelImprovement row with guardian_confirmed = 1, so a writer stores 0 for that kind whatever the
--     request said. It defaults to 0 = not confirmed. The under-13 rule needs the player's
--     age, which lives in player_profiles and changes, so it is NOT a CHECK: the writer applies
--     isConsentUpdateAllowed(age, update) before inserting, and this table keeps only what was recorded.
--   * changed_at is the server's time of the change (defaults to now, canonical UTC), never a client value;
--     it is for display and audit, see the first point.
--   * APPEND-ONLY is a BEFORE UPDATE trigger, consents_append_only, that ABORTs every UPDATE of a stored row,
--     even one that sets a column to its own value: a row is immutable once written. The ONE exception is an
--     UPDATE that changes player_id and nothing else, for a player_id that no longer has a profile: that is
--     what ON UPDATE CASCADE does when a profile is re-keyed (POST /api/player/recover moves a player's data
--     to the new session's player_id, see 002), and it fires triggers, so a blanket guard would make recovery
--     fail. In a cascade the profile has already moved to its new key when the child row is updated, so the
--     old player_id has no profile; a DIRECT UPDATE consents SET player_id = ... names an old id that still
--     has its profile and is refused, so history cannot be moved to another player by hand (unlike 005, this
--     table has no composite foreign key to stop that).
--     The trigger READS player_profiles (the NOT EXISTS above), and SQLite re-parses every trigger when a
--     table is renamed: a drop-and-rename REBUILD of player_profiles (see 002) fails with the error
--     no such table: main.player_profiles
--     while the trigger exists. Such a rebuild must DROP TRIGGER consents_append_only first and recreate
--     consents_append_only from its saved sql (sqlite_master) once the table is back.
--   * There is deliberately NO BEFORE DELETE trigger: it would also fire for the ON DELETE CASCADE from
--     player_profiles and break erasure. Deleting the profile (DELETE /api/player, shared/privacy.ts) cascades
--     to the player's consents; a direct DELETE by application code is not blocked, so append-only is a rule
--     for writers, enforced against UPDATE only.
--
-- recovery_codes
--   * Only a HASH of the recovery code is stored: the code itself (four groups of four characters, shown to
--     the player once) is never stored, logged or returned again. code_hash is the sha-256 of the CANONICAL
--     code (normalizeRecoveryCode from shared/privacy.ts applied first, so what the player typed with spaces
--     or in lower case and what was generated hash alike) as 64 lower-case hex characters. The contract does
--     not name the hash function; sha-256 is the house choice (as contributions.content_hash in 006). A keyed
--     hash (HMAC-SHA-256 with a server secret) has the same shape and needs no schema change; the CHECK pins
--     the SHAPE (a plaintext code such as ABCD-EFGH-IJKL-MNOP is refused), not the scheme. The CHECK reads
--     the text length AND the byte length: SQLite's length() and GLOB stop at the first NUL character, so a
--     string of 64 hex digits followed by a NUL and anything else would pass a length() = 64 / GLOB check.
--   * UNIQUE (player_id): one code per player. UNIQUE (code_hash): the recovery lookup key. POST
--     /api/player/recover finds the player by WHERE code_hash = ? (an index seek), and two players sharing a
--     hash would make that ambiguous, so a collision fails loudly instead. A writer that hits it generates
--     another code.
--   * REGENERATING a code (POST /api/player/recovery-code: "shown once, and it replaces any earlier code")
--     changes the ONE row of the player, in one statement:
--       INSERT INTO recovery_codes (player_id, code_hash, created_at) VALUES (?, ?, ?)
--       ON CONFLICT (player_id) DO UPDATE SET code_hash = excluded.code_hash,
--         created_at = excluded.created_at, last_used_at = NULL;
--     (or UPDATE code_hash, created_at and last_used_at of the existing row, or a DELETE + INSERT inside one
--     transaction). The new code clears last_used_at: a fresh code has not been used. After a
--     recover, last_used_at is set to that time; the row is re-keyed to the new player_id by the profile's
--     ON UPDATE CASCADE, so the code keeps working for the player's new session.
--   * created_at is when the CURRENT code was generated (RecoveryCodeResponse.createdAt); last_used_at is NULL
--     until a recover succeeds with it.
--
-- Foreign keys and erasure
--   * consents.player_id and recovery_codes.player_id reference player_profiles (player_id) ON DELETE CASCADE
--     ON UPDATE CASCADE: erasing the profile erases the consents and the recovery code hash with it, and the
--     re-key of a profile moves them (see the trigger rule above). The cascade is the DATABASE's, but it runs
--     only on a connection with PRAGMA foreign_keys = ON (openDatabase sets it). Nothing else in this file
--     depends on that pragma; a connection with it OFF migrates to the same schema and simply does not
--     cascade or check references.
--
-- Rules for later migration authors and writers
--   * INSERT OR REPLACE (and REPLACE INTO) resolves a conflict on EITHER unique key by deleting the
--     conflicting row(s) first. On recovery_codes it silently swaps a player's code (regeneration then has no
--     ON CONFLICT clause to fail on, and is not an UPDATE), and when the new code_hash collides with another
--     player's it silently DELETES that other player's code as well. On player_profiles the DELETE cascades:
--     replacing a profile wipes its consents and recovery code. On consents it slips past the append-only
--     trigger (a replace of an id is a delete + insert, not an UPDATE). Never use it on these tables:
--     regenerate with ON CONFLICT (player_id) DO UPDATE as above, and append consents with a plain INSERT.
--   * UPDATE OR REPLACE player_profiles SET player_id = <an id that already has a profile> is the same hazard
--     through the recovery re-key: the profile that owns that id is deleted first, and its consents and code
--     go with it by cascade (the recovering player's own rows are then re-keyed onto the id). POST
--     /api/player/recover must check that the target id has no profile before re-keying.
--     UPDATE OR REPLACE recovery_codes SET player_id = <a player who already has a code> deletes that
--     player's code row, silently; without OR REPLACE the UNIQUE (player_id) fails loudly. Never use OR REPLACE.
--   * ALTER TABLE ... ADD COLUMN is fine for a new nullable column, but the trigger lists the columns it
--     protects: drop and recreate consents_append_only with the new column in its WHEN list, otherwise the
--     column is not frozen (007_privacy.test.ts pins the guard with positive assertions, so it keeps passing
--     either way; check the trigger yourself).
--   * SQLite cannot ALTER a CHECK: a new consent kind or another hash length needs a table rebuild (the
--     rebuild recipe: create the new table, copy the rows (keeping id), DROP TABLE the old one, rename).
--     Nothing references consents or recovery_codes, so their own DROP TABLE cascades nowhere, but it
--     destroys the rows unless they were copied first; a rebuild of consents must recreate the trigger and
--     its index (the trigger is dropped with the table). The runner cannot switch foreign keys off inside
--     its transaction. A rebuild of player_profiles (see 002) must never DROP the parent while these
--     children hold rows: with foreign keys on, that DROP TABLE cascades to them and wipes every player's
--     consents and recovery code, and with the trigger present it fails anyway (see the trigger rule).

CREATE TABLE consents (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,                        -- the tie-break of the history order
  player_id          TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('videoAnalysis', 'modelImprovement')),   -- the keys of Consents (shared/privacy.ts)
  granted            INTEGER NOT NULL CHECK (granted IN (0, 1)),               -- 1 grants, 0 revokes
  guardian_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (guardian_confirmed IN (0, 1)),   -- 1 only with videoAnalysis, see below
  changed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))      -- the server's time
                     CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', changed_at) IS changed_at AND substr(changed_at, 12, 2) < '24'),
  CHECK (guardian_confirmed IS 0 OR kind IS 'videoAnalysis')                 -- guardian confirmation applies only to videoAnalysis
) STRICT;
-- The current consent of a (player, kind) is the highest id: a backwards seek; also the child index of the foreign key (erasure).
CREATE INDEX consents_by_player_kind ON consents (player_id, kind, id);

-- Append-only: every UPDATE is refused except one that changes player_id and nothing else, from a player_id
-- that no longer has a profile (the ON UPDATE CASCADE of a profile re-key). No DELETE trigger, see the header.
CREATE TRIGGER consents_append_only
BEFORE UPDATE ON consents
WHEN NOT (NEW.player_id IS NOT OLD.player_id
          AND NEW.id IS OLD.id
          AND NEW.kind IS OLD.kind
          AND NEW.granted IS OLD.granted
          AND NEW.guardian_confirmed IS OLD.guardian_confirmed
          AND NEW.changed_at IS OLD.changed_at
          AND NOT EXISTS (SELECT 1 FROM player_profiles WHERE player_id = OLD.player_id))
BEGIN
  SELECT RAISE(ABORT, 'consents is append-only: a stored consent cannot be updated');
END;

CREATE TABLE recovery_codes (
  player_id    TEXT NOT NULL UNIQUE                                            -- one code per player
               REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,
  code_hash    TEXT NOT NULL UNIQUE                                            -- sha-256 of the canonical code, lower-case hex; the lookup key
               CHECK (length(code_hash) = 64 AND length(CAST(code_hash AS BLOB)) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- when the current code was generated
               CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) < '24'),
  last_used_at TEXT                                                            -- NULL until a recover succeeds with the code
               CHECK (last_used_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS last_used_at AND substr(last_used_at, 12, 2) < '24'))
) STRICT;

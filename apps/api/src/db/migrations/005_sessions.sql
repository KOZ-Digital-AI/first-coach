-- 005_sessions: the player's daily training sessions and the append-only log of what happened in them.
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 006 and later. It touches nothing from 001, 003 or 004 and only REFERENCES
-- player_profiles from 002. The contract is shared/session.ts (TodaySession, SessionEvent).
--
-- Tables: sessions (one row per player per calendar day) and session_events (what the player did,
-- as the offline outbox reports it: drill done / undone, a skill-test result, session finished).
--
-- Names and Better Auth
--   * The plural "sessions" is ours; Better Auth's own table is the singular "session" (with "user",
--     "account" and "verification"), which its migrator creates later, at route-register time.
--     SQLite table names are case-insensitive but "sessions" and "session" are different names, so
--     the two cannot collide, and 005_sessions.test.ts creates all four Better Auth tables next to
--     ours to prove it. Our migrations must never create user, session, account or verification,
--     and must not rename these two to a Better Auth name.
--   * player_id is the auth user id and has NO foreign key to "user" (see 002): on a migrate-only
--     database "user" does not exist. Both tables reference player_profiles instead.
--
-- Conventions (as 001-004)
--   * STRICT tables. Timestamps are TEXT, canonical ISO 8601 UTC with milliseconds
--     ("2026-01-01T00:00:00.000Z"): a CHECK refuses any other spelling (offsets, no
--     milliseconds, invalid dates, and hour 24: strftime would round-trip "T24:00:00.000Z", which
--     Zod refuses and which spells the next day's midnight twice), so text order IS time order.
--     Writers must normalise a client `at` with an offset to UTC (new Date(at).toISOString()).
--   * `date` is the session's calendar day, TEXT YYYY-MM-DD, CHECKed by round trip through SQLite's
--     date(): date('2026-02-30') is '2026-03-02', which is not what was stored, so impossible days
--     are refused. The round trip runs only behind a GLOB for the ten-character shape, inside a CASE
--     (which guarantees the order): date() also reads 'now' and modifiers, and SQLite raises "non-
--     deterministic use of date() in a CHECK constraint" for them, an error that would hide which
--     rule was broken. The player's own calendar day (their time zone) is the caller's decision;
--     this file only knows that it is a real day.
--   * CHECKs use IS, never = or <>, on anything that could be NULL: a NULL CHECK result ACCEPTS the
--     row. Every column but finished_at, item_id and value is also NOT NULL.
--   * Enum CHECKs exist ONLY where the contract fixes the list: sessions.planner (TodaySession) and
--     session_events.type (SessionEvent). Their lists MIRROR the z.enum options in shared/session.ts;
--     005_sessions.test.ts parses them back out of sqlite_master and compares them with the contract.
--   * Ids the contract calls EntityId (sessions.id, session_events.item_id) are CHECKed 1-128 characters
--     of [A-Za-z0-9._-]. graph_version is never blank: nothing but whitespace is refused, whitespace
--     being space, tab, newline and carriage return.
--   * client_uuid mirrors z.uuid() as ClientUuid uses it (zod 4.6.5), on lower-case input: version
--     nibble 1-8, variant nibble 8/9/a/b, or the nil / max UUID; upper case is refused because
--     ClientUuid lower-cases first and replay identity is a plain string compare. It is the same CHECK
--     as test_results.client_uuid in 002. If zod's rule changes this CHECK is only defence in depth;
--     005_sessions.test.ts compares both on every version and variant nibble.
--   * JSON is CHECKed json_valid plus its top-level type; the wire contract is validated by Zod at the
--     write boundary, not here.
--
-- sessions
--   * items is the JSON array of the session's drills (TodayItem: itemId, drillVersionId, minutes, done,
--     ...). Each item's drillVersionId is a drill_versions.id (001): a drill VERSION, which is immutable
--     and never deleted, so the id keeps resolving and the session keeps its exact content. It is JSON,
--     so there is NO SQL foreign key; the writer validates the ids against drill_versions.
--   * UNIQUE (player_id, date): one session per player per day; a second one the same day is rejected.
--     UNIQUE (id, player_id) exists only so that session_events can reference the pair (composite FK).
--   * finished_at is NULL until the session is finished.
--   * sessions is mutable (a swap rewrites items, finishing sets finished_at); session_events is not.
--
-- session_events
--   * An append-only log. client_uuid is the offline outbox's idempotency key and is UNIQUE across ALL
--     players and sessions: replaying an event is a rejected duplicate, so write with
--     INSERT ... ON CONFLICT (client_uuid) DO NOTHING (and compare player_id / session_id when it matters).
--     ON CONFLICT DO UPDATE is an UPDATE and is refused by the trigger below.
--   * (session_id, player_id) is a composite foreign key to sessions (id, player_id): an event can only
--     reference a session that belongs to the same player, whoever is asking. player_id also references
--     player_profiles directly, so that a player's whole log can be read (session_events_by_player) and
--     erased without going through sessions. The key is ON UPDATE CASCADE, so changing a session's id
--     would rewrite the session_id of its events, which the append-only trigger refuses: a session id is
--     effectively immutable once the session has an event (before that it can be changed). A writer must
--     therefore never upsert a session with ON CONFLICT (player_id, date) DO UPDATE SET id = ...; keep
--     the stored id and update only items / finished_at.
--   * The idempotent insert ON CONFLICT (client_uuid) DO NOTHING skips only a duplicate client_uuid: it
--     does not swallow a foreign key error, so an event for a session that does not exist (or belongs
--     to another player) still raises. The writer checks the session first.
--   * `at` is the client's timestamp (may be days older than received_at when replayed offline);
--     received_at is the server's, defaulting to now. value is REAL and nullable (the contract's
--     z.number().optional()); item_id is nullable (a `result` for the session's skill test has no item).
--     Infinity is refused; NaN cannot be stored by SQLite (it becomes NULL).
--   * APPEND-ONLY is a BEFORE UPDATE trigger, session_events_append_only, that ABORTs every UPDATE of a
--     stored event, even one that sets a column to its own value. The ONE exception is an UPDATE that
--     changes player_id and nothing else: that is what ON UPDATE CASCADE does when a profile is re-keyed
--     (POST /api/player/recover moves a player's data to the new session's player_id, see 002), and it
--     does fire triggers, so a blanket guard would make recovery fail. A direct re-key of a single
--     event is still stopped by the composite foreign key.
--   * There is deliberately NO BEFORE DELETE trigger: it would also fire for the ON DELETE CASCADE
--     from sessions and player_profiles and break erasure. Deleting the profile (DELETE /api/player,
--     shared/privacy.ts) cascades to its sessions and their events; a direct DELETE by application
--     code is not blocked, so append-only is a rule for writers, enforced against UPDATE only.
--
-- Foreign keys and erasure
--   * sessions.player_id and session_events.player_id reference player_profiles ON DELETE CASCADE
--     ON UPDATE CASCADE, and the composite key cascades from sessions in the same way. The cascade is
--     the DATABASE's, but it runs only on a connection with PRAGMA foreign_keys = ON (openDatabase
--     sets it). Nothing else in this file depends on that pragma; a connection with it OFF migrates to
--     the same schema and simply does not cascade or check references.
--
-- Rules for later migration authors and writers
--   * INSERT OR REPLACE (and REPLACE INTO) deletes the conflicting row first, and that DELETE cascades:
--     replacing a sessions row wipes its events, replacing a player_profiles row wipes everything of the
--     player. It is also not an UPDATE, so on session_events it slips past the append-only trigger.
--     Never use it on these tables: upsert a session with INSERT ... ON CONFLICT (player_id, date) DO
--     UPDATE, and insert events with ON CONFLICT (client_uuid) DO NOTHING.
--   * UPDATE OR REPLACE player_profiles SET player_id = <an id that already has a profile> is the same
--     hazard through the recovery re-key: the profile that owns that id is deleted first, and its
--     sessions and events go with it by cascade (the recovering player's own rows are then re-keyed onto
--     the id). POST /api/player/recover must check that the target id has no profile before re-keying.
--   * ALTER TABLE session_events ADD COLUMN is fine for a new nullable column, but the trigger lists the
--     columns it protects: drop and recreate session_events_append_only with the new column in its
--     WHEN list, otherwise the column is not frozen (005_sessions.test.ts pins the guard with positive
--     assertions, so it keeps passing either way; check the trigger yourself).
--   * SQLite cannot ALTER a CHECK: growing planner or the event types needs a table rebuild. A DROP TABLE
--     on sessions performs an implicit DELETE FROM, and with foreign keys on that cascades to
--     session_events, wiping every player's log; the runner cannot switch foreign keys off inside its
--     transaction, so a rebuild of sessions must copy the events out first (or rebuild both tables) and
--     must never DROP the parent while children hold rows. A rebuild of session_events must recreate the
--     trigger and its indexes.

CREATE TABLE sessions (
  id            TEXT NOT NULL PRIMARY KEY                                -- TodaySession.id (EntityId)
                CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._-]*'),
  player_id     TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,
  date          TEXT NOT NULL                                            -- CalendarDate, a real day (see header)
                CHECK (CASE WHEN date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN date(date) IS date ELSE 0 END),
  planner       TEXT NOT NULL CHECK (planner IN ('rules', 'ai')),        -- TodaySession.planner
  graph_version TEXT NOT NULL CHECK (trim(graph_version, ' ' || char(9) || char(10) || char(13)) <> ''),   -- as sports.graph_version
  items         TEXT NOT NULL CHECK (json_valid(items) AND json_type(items) IS 'array'),   -- TodayItem[], drillVersionId = drill_versions.id
  finished_at   TEXT CHECK (finished_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) IS finished_at AND substr(finished_at, 12, 2) < '24')),
  UNIQUE (player_id, date),
  UNIQUE (id, player_id)
) STRICT;

CREATE TABLE session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,
  session_id  TEXT NOT NULL,
  client_uuid TEXT NOT NULL UNIQUE                                       -- lower-case, mirrors z.uuid() (see header)
              CHECK (client_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
                     OR client_uuid IN ('00000000-0000-0000-0000-000000000000',
                                        'ffffffff-ffff-ffff-ffff-ffffffffffff')),
  type        TEXT NOT NULL CHECK (type IN ('drill_done', 'drill_undone', 'result', 'session_finished')),   -- SessionEvent.type
  item_id     TEXT CHECK (item_id IS NULL OR (length(item_id) BETWEEN 1 AND 128 AND item_id NOT GLOB '*[^A-Za-z0-9._-]*')),   -- a TodayItem.itemId of the session (in JSON, no FK)
  value       REAL CHECK (value IS NULL OR value BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),   -- refuses +/- infinity
  at          TEXT NOT NULL                                              -- the client's time
              CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at AND substr(at, 12, 2) < '24'),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))   -- the server's time
              CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at AND substr(received_at, 12, 2) < '24'),
  FOREIGN KEY (session_id, player_id) REFERENCES sessions (id, player_id) ON DELETE CASCADE ON UPDATE CASCADE
) STRICT;
-- A session's events in time order (also the child index of the composite foreign key).
CREATE INDEX session_events_by_session ON session_events (session_id, at, id);
-- A player's events in time order (history, export). Also serves the erasure cascade.
CREATE INDEX session_events_by_player ON session_events (player_id, at, id);

-- Append-only: every UPDATE is refused except one that changes player_id and nothing else (the
-- ON UPDATE CASCADE of a profile re-key). No DELETE trigger, see the header.
CREATE TRIGGER session_events_append_only
BEFORE UPDATE ON session_events
WHEN NOT (NEW.player_id IS NOT OLD.player_id
          AND NEW.id IS OLD.id
          AND NEW.session_id IS OLD.session_id
          AND NEW.client_uuid IS OLD.client_uuid
          AND NEW.type IS OLD.type
          AND NEW.item_id IS OLD.item_id
          AND NEW.value IS OLD.value
          AND NEW.at IS OLD.at
          AND NEW.received_at IS OLD.received_at)
BEGIN
  SELECT RAISE(ABORT, 'session_events is append-only: a stored event cannot be updated');
END;

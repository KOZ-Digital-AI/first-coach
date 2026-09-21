-- 002_player: the player's own data (profile, skill-test results, roadmaps).
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 003 and later. It touches nothing from 001.
--
-- Conventions (as 001)
--   * STRICT tables. Timestamps are TEXT, canonical ISO 8601 UTC with milliseconds
--     ("2026-01-01T00:00:00.000Z"): a CHECK refuses any other spelling (offsets, no
--     milliseconds, invalid dates, and hour 24: strftime would round-trip "T24:00:00.000Z", which
--     Zod refuses and which spells the next day's midnight twice), so text order IS time order
--     and ORDER BY created_at is safe. Writers must normalise a client `at` with an offset to UTC
--     (new Date(at).toISOString()).
--   * JSON is CHECKed json_valid plus its top-level type; the wire contract (shared/domain.ts) is
--     validated by Zod at the write boundary, not here.
--   * CHECK lists and bounds exist ONLY where the contract fixes them and a stored value can
--     never be "new": locale (LOCALES), minutes_per_session (MINUTES_PER_SESSION), days_per_week
--     (DAYS_PER_WEEK), age (AGE_MIN..AGE_MAX). 002_player.test.ts parses each back out of
--     sqlite_master and compares it with the contract. level, goal, equipment and space are
--     free TEXT (never blank: nothing but whitespace is refused, whitespace being space, tab,
--     newline and carriage return) on purpose, like their twins in 001: the vocabulary is per sport and
--     grows with the commons, and Zod is its write boundary. See "Rebuilding player_profiles"
--     below for why a CHECK on the parent table is expensive to grow.
--
--   * client_uuid mirrors z.uuid() as ClientUuid uses it (zod 4.6.5), on lower-case input:
--     version nibble 1-8, variant nibble 8/9/a/b, or the nil / max UUID. Upper case is refused
--     here because ClientUuid lower-cases first and replay identity is a plain string compare.
--     If zod's rule changes, this CHECK is only defence in depth; 002_player.test.ts compares
--     both on a fixed candidate list and fails when they drift.
--
-- Personal data
--   * NO name, email or birth date, and no other identifier of a person, in any column. The
--     profile is age + preferences only (PlayerProfileShape); player_id is an opaque auth id.
--
-- player_id, Better Auth and erasure
--   * player_profiles.player_id is the auth user id and has NO foreign key to "user": Better
--     Auth creates its own tables later, at route-register time, so on a migrate-only database
--     "user" does not exist. Erasure (DELETE /api/player, shared/privacy.ts) therefore deletes
--     the player's rows explicitly by player_id; deleting the profile cascades to the results
--     and roadmaps. Whatever ends a session or removes the auth user must call that erasure.
--   * test_results.player_id and roadmaps.player_id reference player_profiles ON DELETE CASCADE.
--     A player always has a profile first: POST /api/player/start creates the profile with its
--     baseline results in one request, and every later endpoint needs an existing profile.
--     ON UPDATE CASCADE lets recovery re-key a profile (POST /api/player/recover moves the data
--     to the new session's player_id) without orphaning its history.
--   * test_results.test_slug has NO foreign key to skill_tests: an offline result replayed after
--     the seed changed (or before it loaded) must still be stored, and history must outlive the
--     test definition. Writers validate the slug against the seeded tests.
--
-- Rules for later migration authors and writers
--   * INSERT OR REPLACE (and REPLACE INTO) on player_profiles deletes the old row first, and
--     that DELETE cascades: every result and roadmap of the player is wiped. Upsert with
--     INSERT ... ON CONFLICT (player_id) DO UPDATE instead.
--   * Idempotent replay: INSERT INTO test_results ... ON CONFLICT (client_uuid) DO NOTHING.
--     client_uuid is unique across ALL players, so a replay under another player is dropped
--     too; compare player_id when that matters.
--   * The current roadmap of a player is the latest by (created_at, id); older rows are history.
--     A plan reset deletes the player's roadmaps rows (the profile and results stay).
--   * Rebuilding player_profiles (the SQLite table-rebuild recipe, e.g. to grow a CHECK): a
--     DROP TABLE performs an implicit DELETE FROM, and with foreign keys on that cascades to
--     test_results and roadmaps, wiping every player's history. The runner cannot switch foreign
--     keys off inside its transaction, so a rebuild must copy the children out first (or
--     rename-and-recreate them too) and must never DROP the parent while children hold rows.
--   * SQLite cannot ALTER a CHECK: growing locale, minutes_per_session or the bounds needs that
--     table rebuild. ALTER TABLE ... ADD COLUMN is fine for new nullable columns.

CREATE TABLE player_profiles (
  player_id           TEXT NOT NULL PRIMARY KEY CHECK (trim(player_id, ' ' || char(9) || char(10) || char(13)) <> ''),   -- the auth user id, no FK (see header)
  age                 INTEGER NOT NULL CHECK (age BETWEEN 5 AND 99),       -- AGE_MIN..AGE_MAX
  level               TEXT NOT NULL CHECK (trim(level, ' ' || char(9) || char(10) || char(13)) <> ''),                   -- ExperienceLevel
  goal                TEXT NOT NULL CHECK (trim(goal, ' ' || char(9) || char(10) || char(13)) <> ''),                    -- Goal
  equipment           TEXT NOT NULL CHECK (trim(equipment, ' ' || char(9) || char(10) || char(13)) <> ''),               -- Equipment
  space               TEXT NOT NULL CHECK (trim(space, ' ' || char(9) || char(10) || char(13)) <> ''),                   -- Space
  partner             INTEGER NOT NULL CHECK (partner IN (0, 1)),          -- boolean
  days_per_week       INTEGER NOT NULL CHECK (days_per_week BETWEEN 2 AND 6),   -- DAYS_PER_WEEK
  minutes_per_session INTEGER NOT NULL CHECK (minutes_per_session IN (10, 15, 20, 30, 45)),  -- MINUTES_PER_SESSION
  locale              TEXT NOT NULL CHECK (locale IN ('kk', 'ru', 'en')),  -- LOCALES
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                      CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) < '24'),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                      CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND substr(updated_at, 12, 2) < '24')
) STRICT;

-- One row per measured (or skipped) baseline / retest result. client_uuid is the offline
-- outbox's idempotency key (ClientUuid: a lower-case UUID), unique across all players.
CREATE TABLE test_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,
  test_slug   TEXT NOT NULL                                              -- SkillTest.slug, no FK (see header)
              CHECK (length(test_slug) BETWEEN 1 AND 128 AND test_slug NOT GLOB '*[^A-Za-z0-9._-]*'),
  value       REAL NOT NULL                                              -- z.number(): fractions and 0 (skipped) are fine
              CHECK (value BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),   -- refuses +/- infinity
  attempts    INTEGER CHECK (attempts IS NULL OR attempts >= 0),        -- Count.optional(): NULL = not recorded
  errors      INTEGER CHECK (errors IS NULL OR errors >= 0),            -- Count.optional(): NULL = not recorded
  skipped     INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),     -- 1: nothing measured, value is 0
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at AND substr(recorded_at, 12, 2) < '24'),
  client_uuid TEXT NOT NULL UNIQUE                                       -- lower-case, mirrors z.uuid() (see header)
              CHECK (client_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
                     OR client_uuid IN ('00000000-0000-0000-0000-000000000000',
                                        'ffffffff-ffff-ffff-ffff-ffffffffffff'))
) STRICT;
-- Latest / previous / personal best of one test for one player.
CREATE INDEX test_results_by_player_test ON test_results (player_id, test_slug, recorded_at, id);
-- A player's results in time order (history, export). Also serves the erasure cascade.
CREATE INDEX test_results_by_player_time ON test_results (player_id, recorded_at, id);

-- Roadmap history: never UNIQUE per player. The current one is the latest by (created_at, id).
CREATE TABLE roadmaps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,
  json          TEXT NOT NULL CHECK (json_valid(json) AND json_type(json) = 'object'),   -- Roadmap
  graph_version TEXT NOT NULL CHECK (graph_version <> ''),                                -- as sports.graph_version
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) < '24')
) STRICT;
CREATE INDEX roadmaps_by_player ON roadmaps (player_id, created_at, id);

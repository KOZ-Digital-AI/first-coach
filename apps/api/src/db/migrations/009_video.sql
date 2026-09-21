-- 009_video: the player's analyses of a short clip by the Beta AI Video Coach (what the coach said, never the clip).
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 010 and later. It only REFERENCES player_profiles from 002 and touches nothing else:
-- it needs no table from 003-008 (009_video.test.ts applies it on 001-007 plus an empty stand-in 008
-- to prove it), so it applies after 007 as well as after 008. The contract is shared/video.ts
-- (VideoAnalysis, PoseFeatures, CONFIDENCE_LEVELS, CreateVideoAnalysisRequest); the tests build the
-- checks below from it.
--
-- Table: video_analyses (one row per FINISHED analysis, the history behind GET /api/player/video-analyses).
-- A rerecord verdict ({ rerecord: true, reason }) is not a history entry and is never stored (shared/video.ts),
-- which is why scores below is never empty. The row is what the coach SAID: a rubric version, a confidence,
-- per-criterion scores with notes, one focus, some drills and a summary of the pose features. It is NOT the clip.
--
-- Names and Better Auth
--   * Our table is video_analyses. Better Auth's own tables ("user", "session", "account", "verification") are
--     created later by its migrator, at route-register time; the name does not collide, and 009_video.test.ts
--     creates them next to ours to prove it. Our migrations must never create them.
--   * player_id is the auth user id and has NO foreign key to "user" (see 002): on a migrate-only database
--     "user" does not exist. It references player_profiles (player_id) instead.
--
-- Conventions (as 001-008)
--   * STRICT tables. created_at is TEXT, canonical ISO 8601 UTC with milliseconds
--     ("2026-01-01T00:00:00.000Z"): a CHECK refuses any other spelling (offsets, no milliseconds, invalid
--     dates, and hour 24), so text order IS time order. It defaults to the server's now (VideoAnalysis.createdAt
--     is read back from here; the writer sends nothing).
--   * CHECKs use IS, never = or <>, on anything that could be NULL: a NULL CHECK result ACCEPTS the row.
--     Every column is NOT NULL.
--   * Enum CHECKs exist ONLY where the contract fixes the list: confidence MIRRORS CONFIDENCE_LEVELS
--     (shared/video.ts; the test parses it back out of sqlite_master and compares).
--   * Ids the contract calls EntityId (id, skill_slug) are CHECKed 1-128 characters of [A-Za-z0-9._-]
--     (as sessions.id in 005). skill_slug has no foreign key: it names a rubric skill, which is not a table.
--   * length() and GLOB stop at the first NUL character, so a value such as 'ok' || char(0) || <500 more
--     characters> would pass a length() cap or a character-set GLOB. Every capped or shaped text column
--     therefore also refuses any NUL, by searching its BLOB form (instr(CAST(x AS BLOB), x'00') = 0),
--     which sees the whole value.
--   * Text that must not be blank (focus_next) is refused when it is nothing but whitespace, whitespace
--     being space, tab, newline and carriage return.
--
-- What is NOT stored (privacy, the reason the table looks like this)
--   * NO video, NO keyframe, NO image, and NO BLOB column: none of those has a column. The client keeps the
--     raw video on the device and sends only pose features and 3-6 small JPEG keyframes to be analysed
--     (shared/video.ts); the keyframes are used for the one analysis call and are NOT written here (this
--     table has no column, and no path, url or reference, for an image). What is kept is the analysis
--     and a SUMMARY of the pose features: numbers such as cadence, left/right balance, joint-angle
--     statistics, mean visibility and the frame count.
--   * There is NO overall number ("you play at 63/100"): the only scores are the per-criterion ones inside
--     the scores JSON (each 1-10 with a note), and there is no total, grade or rating column.
--   * The JSON and text columns cannot smuggle an image in either. Each is capped in size
--     (scores and recommended 16384 characters, features_summary 2048, focus_next 2000), and none may
--     hold a run of 256 or more characters from the base64 alphabet plus backslash (A-Za-z0-9 + / = \): a JPEG
--     frame is such a run (its base64 begins /9j/), and ordinary words, sentences and Kazakh / Russian text
--     are not (they contain spaces, or are not ASCII, and JSON punctuation ends a run). features_summary is
--     stricter: it may contain ONLY the characters of a JSON object of numbers (A-Za-z0-9 . , : { } " [ ] + -):
--     no space, no slash, no backslash and nothing outside ASCII, and no run of more than 64 key or number
--     characters. Writers must therefore serialise it COMPACTLY (JSON.stringify: no spaces).
--     What this does NOT stop: an image cut into pieces of fewer than 256 characters, each in its own JSON
--     string, inside the size caps. A CHECK cannot look inside a JSON array (no subqueries), so the shape of
--     each element (Zod: CriterionScore, RecommendedDrill, PoseFeatures) is the write boundary's job: the
--     writer stores what it parsed with those schemas, never the request's keyframes.
--
-- Columns
--   * id is the analysis id (VideoAnalysis.id, an EntityId), TEXT and chosen by the WRITER (a random id
--     such as a uuid, or anything of the EntityId shape) as sessions.id in 005; the contract types it as an
--     EntityId and the client only ever gets it back, so there is no auto-increment. It is the primary key.
--   * player_id: see Foreign keys and erasure. NOT NULL: an analysis always belongs to a player.
--   * skill_slug is the skill whose rubric was used (VideoAnalysis.skillSlug, an EntityId).
--   * rubric_version is the version of that rubric the client filmed for and the server judged against
--     (Rubric.version, CreateVideoAnalysisRequest.rubricVersion): a positive integer. Together with
--     skill_slug it says which criteria the scores belong to.
--   * confidence is the coach's confidence in its own reading (low, medium, high; Confidence).
--   * scores is the JSON array of CriterionScore ({ key, label, score 1-10, note }), at least one element,
--     in the language of the request. Its elements are validated by Zod at the write boundary, not here.
--   * focus_next is the one thing to work on next (VideoAnalysis.focusNext), 1-2000 characters. The
--     contract fixes no maximum: 2000 is this file's own generous bound for a coach's sentence or two;
--     the writer must keep what it stores within it.
--   * recommended is the JSON array of RecommendedDrill ({ drillVersionId, slug, title, reason }), empty when
--     nothing was recommended. Each drillVersionId is a drill_versions.id (001), a drill VERSION, which is
--     immutable and never deleted; it is JSON, so there is NO SQL foreign key, and the writer validates
--     the ids against drill_versions (as sessions.items in 005).
--   * features_summary is the JSON object summarising the pose features the client extracted (PoseFeatures:
--     cadencePerMin, leftRightBalance, kneeAngleStats, trunkLeanStats, meanVisibility, framesAnalysed),
--     as far as the writer keeps them. Numbers only, see above; the object may be empty.
--   * client_uuid is the offline outbox's idempotency key (CreateVideoAnalysisRequest.clientUuid). It mirrors
--     z.uuid() as ClientUuid uses it (zod 4.6.5), on lower-case input: version nibble 1-8, variant nibble
--     8/9/a/b, or the nil / max UUID; upper case is refused because ClientUuid lower-cases first and replay
--     identity is a plain string compare. It is the same CHECK as session_events.client_uuid in 005 (with a
--     byte-length check so a NUL cannot hide a tail from GLOB). It is UNIQUE across ALL players: replaying a
--     request is a rejected duplicate, so write with INSERT ... ON CONFLICT (client_uuid) DO NOTHING and,
--     when it did nothing, read the row back and compare player_id (a uuid that already belongs to another
--     player must not return that player's analysis).
--   * Analyses are immutable by convention: writers only INSERT. Nothing in this file blocks an UPDATE or a
--     DELETE, and no trigger reads player_profiles, so a rebuild of player_profiles (see 002) is not made
--     harder by it.
--
-- Foreign keys and erasure
--   * player_id references player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE: erasing the
--     profile (DELETE /api/player) erases the player's analyses with it, and the re-key of a profile
--     (POST /api/player/recover moves a player's data to the new session's player_id, see 002) moves them.
--     The cascade is the DATABASE's, but it runs only on a connection with PRAGMA foreign_keys = ON
--     (openDatabase sets it). The erasure and the export find this table by its player_id column.
--   * Erasure needs nothing more: no file, no path and no other table holds the player's video data.
--
-- Rules for later migration authors and writers
--   * INSERT OR REPLACE (and REPLACE INTO) resolves a conflict on EITHER unique key (id, client_uuid) by
--     deleting the conflicting row(s) first: it silently swaps someone's analysis. On player_profiles the
--     DELETE cascades: replacing a profile wipes its analyses. Never use it on these tables: insert with a
--     plain INSERT, or ON CONFLICT (client_uuid) DO NOTHING as above, and upsert profiles with
--     ON CONFLICT (player_id) DO UPDATE (see 002).
--   * UPDATE OR REPLACE player_profiles SET player_id = <an id that already has a profile> is the same
--     hazard through the recovery re-key: the profile that owns that id is deleted first and its analyses go
--     with it by cascade. POST /api/player/recover must check that the target id has no profile.
--   * SQLite cannot ALTER a CHECK: a new confidence level or another cap needs a table rebuild (create the
--     new table, copy the rows, DROP TABLE the old one, rename, recreate the index). Nothing references
--     video_analyses, so its own DROP TABLE cascades nowhere. ALTER TABLE ... ADD COLUMN is fine for a new
--     nullable column, but never add one that holds a video, an image or a frame: see the section above.

CREATE TABLE video_analyses (
  id               TEXT NOT NULL PRIMARY KEY                                  -- VideoAnalysis.id (EntityId), chosen by the writer
                   CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._-]*' AND instr(CAST(id AS BLOB), x'00') = 0),
  player_id        TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,
  skill_slug       TEXT NOT NULL                                              -- VideoAnalysis.skillSlug (EntityId), no FK
                   CHECK (length(skill_slug) BETWEEN 1 AND 128 AND skill_slug NOT GLOB '*[^A-Za-z0-9._-]*' AND instr(CAST(skill_slug AS BLOB), x'00') = 0),
  rubric_version   INTEGER NOT NULL CHECK (rubric_version >= 1),              -- Rubric.version: a positive integer
  confidence       TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),   -- CONFIDENCE_LEVELS
  scores           TEXT NOT NULL                                              -- JSON array of CriterionScore, at least one
                   CHECK (json_valid(scores) AND json_type(scores) IS 'array' AND json_array_length(scores) >= 1
                          AND length(scores) <= 16384 AND instr(CAST(scores AS BLOB), x'00') = 0
                          AND scores NOT GLOB ('*' || replace(printf('%0256d', 0), '0', '[A-Za-z0-9+/=\]') || '*')),   -- no run of 256 base64 characters
  focus_next       TEXT NOT NULL                                              -- VideoAnalysis.focusNext
                   CHECK (length(focus_next) BETWEEN 1 AND 2000 AND instr(CAST(focus_next AS BLOB), x'00') = 0
                          AND trim(focus_next, ' ' || char(9) || char(10) || char(13)) <> ''
                          AND focus_next NOT GLOB ('*' || replace(printf('%0256d', 0), '0', '[A-Za-z0-9+/=\]') || '*')),
  recommended      TEXT NOT NULL                                              -- JSON array of RecommendedDrill, may be empty
                   CHECK (json_valid(recommended) AND json_type(recommended) IS 'array'
                          AND length(recommended) <= 16384 AND instr(CAST(recommended AS BLOB), x'00') = 0
                          AND recommended NOT GLOB ('*' || replace(printf('%0256d', 0), '0', '[A-Za-z0-9+/=\]') || '*')),
  features_summary TEXT NOT NULL                                              -- JSON object of numbers (PoseFeatures summary), compact
                   CHECK (json_valid(features_summary) AND json_type(features_summary) IS 'object'
                          AND length(features_summary) <= 2048 AND instr(CAST(features_summary AS BLOB), x'00') = 0
                          AND features_summary NOT GLOB '*[^]A-Za-z0-9.,:{}"[+-]*'
                          AND features_summary NOT GLOB ('*' || replace(printf('%065d', 0), '0', '[A-Za-z0-9+.-]') || '*')),   -- no run of 65 key or number characters
  client_uuid      TEXT NOT NULL UNIQUE                                       -- lower-case, mirrors z.uuid() (see header); the outbox idempotency key
                   CHECK (length(CAST(client_uuid AS BLOB)) = 36
                          AND (client_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
                               OR client_uuid IN ('00000000-0000-0000-0000-000000000000',
                                                  'ffffffff-ffff-ffff-ffff-ffffffffffff'))),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                   CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) < '24')
) STRICT;
-- A player's analyses in time order; also the child index of the foreign key (the erasure cascade and the re-key).
CREATE INDEX video_analyses_by_player ON video_analyses (player_id, created_at, id);

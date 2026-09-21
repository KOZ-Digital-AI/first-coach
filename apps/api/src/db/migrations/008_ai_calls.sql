-- 008_ai_calls: the log of every call the server makes to an AI provider (plan, explain, video).
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 009 and later. It only REFERENCES player_profiles from 002 and touches nothing else:
-- it needs no table from 003-007 (008_ai_calls.test.ts applies it on 001-006 plus an empty stand-in 007
-- to prove it), so it applies after 006 as well as after 007. The contract is shared/ai.ts (AiPlan,
-- AiFallbackCode / AI_FALLBACK_CODES, aiPlanUnknownIds); the tests build the checks below from it.
--
-- Table: ai_calls (one row per provider call, or per attempt that fell back before any call was made).
-- It is an operational log for cost, latency and quality questions ("which model, how long, how many
-- tokens, did the validator accept it, why did it fall back"), NOT a transcript.
--
-- Names and Better Auth
--   * Our table is ai_calls. Better Auth's own tables ("user", "session", "account", "verification") are
--     created later by its migrator, at route-register time; the name does not collide, and
--     008_ai_calls.test.ts creates them next to ours to prove it. Our migrations must never create them.
--   * player_id is the auth user id and has NO foreign key to "user" (see 002): on a migrate-only database
--     "user" does not exist. It references player_profiles (player_id) instead.
--
-- Conventions (as 001-007)
--   * STRICT tables. created_at is TEXT, canonical ISO 8601 UTC with milliseconds
--     ("2026-01-01T00:00:00.000Z"): a CHECK refuses any other spelling (offsets, no milliseconds, invalid
--     dates, and hour 24), so text order IS time order. It defaults to the server's now.
--   * CHECKs use IS, never = or <>, on anything that could be NULL: a NULL CHECK result ACCEPTS the row.
--   * Enum CHECKs exist ONLY where a list is fixed: fallback_code MIRRORS AI_FALLBACK_CODES (shared/ai.ts;
--     the test parses it back out of sqlite_master and compares) and kind is the bead's own list
--     (plan, explain, video: no shared constant exists yet, the test pins the three literals).
--   * Text that must not be blank is refused when it is nothing but whitespace, whitespace being space, tab,
--     newline and carriage return.
--   * length() and GLOB stop at the first NUL character, so a value such as 'ok' || char(0) || <500 more
--     characters> would pass a length() cap. Every capped text column therefore also refuses any NUL, by
--     searching its BLOB form (instr(CAST(x AS BLOB), x'00') = 0), which sees the whole value.
--
-- What is NOT stored (privacy, the reason the table looks like this)
--   * NO prompt, NO model output, NO player free-text (the optional "note" of POST /api/player/today/ai-plan,
--     max 200 characters), NO image or video frame, and NO BLOB column: none of those has a column. What
--     the table keeps is metadata and ids: which drills were offered, which were chosen, and hashes and
--     codes about the call. No column can hold a run of more than 200 characters of text:
--       * model and validator_result are capped at 1-200 characters (a model id and a short validator code);
--       * candidate_ids and chosen_ids are JSON arrays whose text may contain ONLY the characters of an
--         EntityId (A-Za-z0-9 . _ -) plus the JSON punctuation of an array of strings or numbers ( [ ] , " ):
--         no space, no colon, no brace, no backslash and nothing outside ASCII, so a sentence, an object
--         or an escaped character cannot be smuggled in. Writers must therefore serialise COMPACTLY
--         (JSON.stringify: no spaces). EACH ELEMENT is capped too: a run of more than 128 id characters (an
--         EntityId is at most 128) is refused, so one id cannot carry a long unspaced string such as
--         'my-ankle-hurts-my-ankle-hurts-...'. The whole array is capped at 8192 characters;
--       * profile_hash is a sha-256 hex digest, never the profile itself.
--     What the two id columns do NOT stop: a person's words spelt as SEVERAL short id-shaped elements
--     (each at most 128 characters, no spaces). That they are real ids is the write boundary's job: the
--     writer takes both lists from the server's own candidate set (Zod / aiPlanUnknownIds, chosen is a
--     subset of candidate), never from the note or the model text; a CHECK cannot look inside a JSON
--     array (no subqueries), and element types (strings, numbers, nested arrays) are not distinguished
--     here either.
-- Columns
--   * player_id is NULLABLE: a call that belongs to no player (no profile) is still logged. A row WITH a
--     player_id is erased with the profile (ON DELETE CASCADE), and re-keyed with it (ON UPDATE CASCADE,
--     POST /api/player/recover moves a player's data to the new session's player_id, see 002). A row with a
--     NULL player_id belongs to nobody and is never erased by a cascade, so a writer must put nothing
--     personal in it. The cascade is the DATABASE's, but it runs only on a connection with
--     PRAGMA foreign_keys = ON (openDatabase sets it).
--   * kind is which feature made the call. model is the provider's model id as configured.
--   * profile_hash is the sha-256 of the canonical player profile that was sent (64 lower-case hex, the same
--     shape as recovery_codes.code_hash in 007), or NULL when no profile was involved. It groups calls by
--     profile shape; it identifies nobody beyond the player_id in the same row.
--   * candidate_ids are the ids the SERVER offered (the approved drill versions); chosen_ids are the ids the
--     AI picked and that survived validation. A fallback row has chosen_ids = '[]'.
--   * validator_result is the short outcome of the server-side validation of the answer (for a plan,
--     the aiPlanUnknownIds check and the schema parse), NULL when no validator ran (the call never
--     happened: no_key, disabled; or it failed first: timeout, provider_error). The contract does not fix
--     its vocabulary, so there is no enum CHECK.
--   * fallback_code is NULL when the AI answer was served, otherwise why the deterministic session was
--     served instead (AI_FALLBACK_CODES). Which combinations of columns make sense is the writer's business.
--   * latency_ms is the wall time of the call in whole milliseconds, 0 or more (NOT NULL: measured by the
--     server, also for a call that timed out). tokens_in / tokens_out are the provider's usage counts,
--     NULL when the provider never reported them (a timeout, a provider error, a call never made).
--
-- Rules for later migration authors and writers
--   * The table is a log: writers only INSERT. Nothing in this file blocks an UPDATE or a DELETE, and no
--     trigger reads player_profiles, so a rebuild of player_profiles (see 002) is not made harder by it.
--   * INSERT OR REPLACE on player_profiles deletes the old row first, and that DELETE cascades to this table;
--     upsert profiles with ON CONFLICT (player_id) DO UPDATE (see 002).
--   * SQLite cannot ALTER a CHECK: a new kind or fallback code needs a table rebuild (create the new table,
--     copy the rows keeping id, DROP TABLE the old one, rename, recreate the index). Nothing references
--     ai_calls, so its own DROP TABLE cascades nowhere. ALTER TABLE ... ADD COLUMN is fine for a new
--     nullable column, but never add one that holds prompt or model text: see the section above.

CREATE TABLE ai_calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id        TEXT REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE,   -- NULL: no player
  kind             TEXT NOT NULL CHECK (kind IN ('plan', 'explain', 'video')),
  model            TEXT NOT NULL                                              -- the provider's model id
                   CHECK (length(model) BETWEEN 1 AND 200 AND instr(CAST(model AS BLOB), x'00') = 0
                          AND trim(model, ' ' || char(9) || char(10) || char(13)) <> ''),
  profile_hash     TEXT                                                       -- sha-256 hex of the canonical profile, NULL: none
                   CHECK (profile_hash IS NULL
                          OR (length(profile_hash) = 64 AND length(CAST(profile_hash AS BLOB)) = 64
                              AND profile_hash NOT GLOB '*[^0-9a-f]*')),
  candidate_ids    TEXT NOT NULL                                              -- JSON array of the ids the server offered
                   CHECK (json_valid(candidate_ids) AND json_type(candidate_ids) IS 'array'
                          AND length(candidate_ids) <= 8192 AND instr(CAST(candidate_ids AS BLOB), x'00') = 0
                          AND candidate_ids NOT GLOB '*[^]A-Za-z0-9._,"[-]*'
                          AND candidate_ids NOT GLOB ('*' || replace(printf('%0129d', 0), '0', '[A-Za-z0-9._-]') || '*')),   -- no run of 129 id characters
  chosen_ids       TEXT NOT NULL                                              -- JSON array of the ids the AI chose and validation kept
                   CHECK (json_valid(chosen_ids) AND json_type(chosen_ids) IS 'array'
                          AND length(chosen_ids) <= 8192 AND instr(CAST(chosen_ids AS BLOB), x'00') = 0
                          AND chosen_ids NOT GLOB '*[^]A-Za-z0-9._,"[-]*'
                          AND chosen_ids NOT GLOB ('*' || replace(printf('%0129d', 0), '0', '[A-Za-z0-9._-]') || '*')),   -- no run of 129 id characters
  validator_result TEXT                                                       -- short outcome of the server-side validation, NULL: none ran
                   CHECK (validator_result IS NULL
                          OR (length(validator_result) BETWEEN 1 AND 200 AND instr(CAST(validator_result AS BLOB), x'00') = 0
                              AND trim(validator_result, ' ' || char(9) || char(10) || char(13)) <> '')),
  fallback_code    TEXT CHECK (fallback_code IS NULL OR fallback_code IN ('no_key', 'disabled', 'timeout', 'invalid_output', 'provider_error')),   -- AI_FALLBACK_CODES
  latency_ms       INTEGER NOT NULL CHECK (latency_ms >= 0),
  tokens_in        INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out       INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                   CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) < '24')
) STRICT;
-- A player's calls in time order; also the child index of the foreign key (the erasure cascade and the re-key).
CREATE INDEX ai_calls_by_player ON ai_calls (player_id, created_at, id);

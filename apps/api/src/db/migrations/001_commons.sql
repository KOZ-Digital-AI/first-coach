-- 001_commons: the Open Sport Commons tables (sports, skill graph, drills and their versions,
-- review audit rows).
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 002 and later.
--
-- Conventions
--   * STRICT tables; ids are TEXT (the seeder picks stable ids; drill_versions.id is the
--     `versionId` clients cache offline). Timestamps are TEXT, ISO 8601 UTC ("...Z").
--   * JSON columns are CHECKed json_valid plus the expected top-level type; the wire contract
--     (apps/api/src/shared) is validated by Zod at the write boundary, not here.
--   * Enum CHECKs exist ONLY for drill_versions.status, reviews.from_status/to_status, license
--     and skill_tests.direction. Their lists MIRROR TRUST_STATUSES, LICENSE_IDS and
--     TEST_DIRECTIONS (shared/primitives.ts, shared/domain.ts); 001_commons.test.ts parses
--     them back out of sqlite_master and compares them with the contract. Equipment, space and
--     level are free TEXT on purpose: Zod is their write boundary.
--   * No ON DELETE actions: the commons is append-only, nothing here cascades.
--   * author_user_id and reviewer_user_id are plain TEXT with no FK on purpose: Better Auth
--     creates its own user table later, and our migrations must not create user, session,
--     account or verification tables.
--
-- Rules for later migration authors
--   * SQLite cannot ALTER a CHECK: growing an enum (a new status, license or direction)
--     needs a table-rebuild migration that recreates the table, its indexes and its trigger.
--   * ALTER TABLE drill_versions ADD COLUMN needs the drill_versions_immutable trigger to be
--     dropped and recreated with the new column in its list, otherwise the column is not
--     frozen (001_commons.test.ts fails until it is).
--   * INSERT OR REPLACE (and REPLACE INTO) deletes and re-inserts, so it bypasses the
--     immutability trigger. Writers must never use it on drill_versions.

CREATE TABLE sports (
  id            TEXT NOT NULL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE
                CHECK (length(slug) BETWEEN 1 AND 128 AND slug NOT GLOB '*[^A-Za-z0-9._-]*'),
  name          TEXT NOT NULL CHECK (json_valid(name) AND json_type(name) = 'object'),      -- LocalizedText
  graph_version TEXT NOT NULL CHECK (graph_version <> ''),                                  -- SkillGraph.version
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE skills (
  id         TEXT NOT NULL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE
             CHECK (length(slug) BETWEEN 1 AND 128 AND slug NOT GLOB '*[^A-Za-z0-9._-]*'),
  sport_id   TEXT NOT NULL REFERENCES sports (id),
  parent_id  TEXT,                                            -- NULL = root skill
  sort_order INTEGER NOT NULL DEFAULT 0,
  names      TEXT NOT NULL CHECK (json_valid(names) AND json_type(names) = 'object'),       -- LocalizedText
  levels     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(levels) AND json_type(levels) = 'array'),
  age_min    INTEGER NOT NULL CHECK (age_min >= 0),
  age_max    INTEGER NOT NULL,
  equipment  TEXT NOT NULL,
  safety     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(safety) AND json_type(safety) = 'array'),
  outcomes   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(outcomes) AND json_type(outcomes) = 'array'),
  mistakes   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mistakes) AND json_type(mistakes) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (sport_id, id),
  FOREIGN KEY (sport_id, parent_id) REFERENCES skills (sport_id, id),  -- a parent lives in the same sport
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (age_max >= age_min)
) STRICT;
CREATE INDEX skills_by_parent ON skills (parent_id, sort_order);

CREATE TABLE skill_prerequisites (
  skill_id        TEXT NOT NULL REFERENCES skills (id),
  prerequisite_id TEXT NOT NULL REFERENCES skills (id),
  min_level       INTEGER NOT NULL CHECK (min_level BETWEEN 1 AND 5),   -- SKILL_LEVEL_MIN..MAX
  PRIMARY KEY (skill_id, prerequisite_id),
  CHECK (skill_id <> prerequisite_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX skill_prerequisites_by_prerequisite ON skill_prerequisites (prerequisite_id, skill_id);

CREATE TABLE skill_tests (
  id         TEXT NOT NULL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE
             CHECK (length(slug) BETWEEN 1 AND 128 AND slug NOT GLOB '*[^A-Za-z0-9._-]*'),
  skill_id   TEXT NOT NULL REFERENCES skills (id),
  metric     TEXT NOT NULL CHECK (metric <> ''),
  unit       TEXT NOT NULL CHECK (unit <> ''),
  direction  TEXT NOT NULL CHECK (direction IN ('higher', 'lower')),
  protocol   TEXT NOT NULL CHECK (json_valid(protocol) AND json_type(protocol) = 'object'),  -- LocalizedText
  equipment  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX skill_tests_by_skill ON skill_tests (skill_id);

-- A drill is a stable identity (slug) that points at its current version. Publishing state
-- and the current pointer are mutable; content lives in drill_versions and never changes.
CREATE TABLE drills (
  id                 TEXT NOT NULL PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE
                     CHECK (length(slug) BETWEEN 1 AND 128 AND slug NOT GLOB '*[^A-Za-z0-9._-]*'),
  sport_id           TEXT NOT NULL REFERENCES sports (id),
  current_version_id TEXT,                                    -- NULL only until the first version is linked
  unpublished_at     TEXT,                                    -- NULL = published
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (id, current_version_id) REFERENCES drill_versions (drill_id, id)  -- current is one of its own
) STRICT;
CREATE INDEX drills_by_sport ON drills (sport_id);

CREATE TABLE drill_versions (
  id                TEXT NOT NULL PRIMARY KEY,
  drill_id          TEXT NOT NULL REFERENCES drills (id),
  semver            TEXT NOT NULL                           -- Semver: three digit-only segments, optional -prerelease
                    CHECK (semver NOT GLOB '*[^0-9A-Za-z.-]*'
                           AND instr(semver, '-') <> length(semver)                      -- a '-' needs a non-empty suffix
                           AND substr(semver, 1, instr(semver || '-', '-') - 1) GLOB '[0-9]*.[0-9]*.[0-9]*'
                           AND substr(semver, 1, instr(semver || '-', '-') - 1) NOT GLOB '*[^0-9.]*'
                           AND substr(semver, 1, instr(semver || '-', '-') - 1) NOT GLOB '*..*'
                           AND length(substr(semver, 1, instr(semver || '-', '-') - 1)) - length(replace(substr(semver, 1, instr(semver || '-', '-') - 1), '.', '')) = 2),
  parent_version_id TEXT,                                     -- NULL for the first version
  status            TEXT NOT NULL
                    CHECK (status IN ('COMMUNITY', 'REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED')),
  content           TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'object'), -- DrillContent
  -- Filter columns: copies of content.conditions kept for indexing. The CHECKs below make them
  -- impossible to disagree with `content`. They use IS, never =: a NULL CHECK result ACCEPTS the
  -- row, so `=` against an absent JSON key would let any column value through. The json_type
  -- tests reject a mistyped value that column affinity would otherwise coerce (5 vs '5').
  equipment         TEXT NOT NULL,
  space             TEXT NOT NULL,                            -- primary space = conditions.spaces[0]
  partner           INTEGER NOT NULL DEFAULT 0 CHECK (partner IN (0, 1)),
  age_min           INTEGER CHECK (age_min >= 0),
  age_max           INTEGER CHECK (age_max >= 0),
  level             TEXT NOT NULL,                            -- ExperienceLevel
  minutes           INTEGER NOT NULL CHECK (minutes > 0),
  -- Attribution.
  license           TEXT NOT NULL CHECK (license IN ('CC-BY-SA-4.0', 'CC-BY-4.0', 'CC0-1.0')),
  author_name       TEXT NOT NULL CHECK (author_name <> ''),
  author_user_id    TEXT,                                     -- no FK: Better Auth's user table comes later
  source            TEXT NOT NULL CHECK (source <> ''),
  source_url        TEXT CHECK (source_url IS NULL OR source_url LIKE 'http://%' OR source_url LIKE 'https://%'),
  origin            TEXT NOT NULL CHECK (origin <> ''),       -- provenance, e.g. 'seed' or 'contribution'
  change_summary    TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (drill_id, semver),
  UNIQUE (drill_id, id),
  FOREIGN KEY (drill_id, parent_version_id) REFERENCES drill_versions (drill_id, id),  -- same lineage
  CHECK (parent_version_id IS NULL OR parent_version_id <> id),
  CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max),
  CHECK (equipment IS json_extract(content, '$.conditions.equipment')
         AND json_type(content, '$.conditions.equipment') IS 'text'),
  CHECK (space IS json_extract(content, '$.conditions.spaces[0]')
         AND json_type(content, '$.conditions.spaces[0]') IS 'text'),
  CHECK (partner IS coalesce(json_extract(content, '$.conditions.partner'), 0)
         AND coalesce(json_type(content, '$.conditions.partner'), 'false') IN ('true', 'false')),
  CHECK (age_min IS json_extract(content, '$.conditions.ageMin')
         AND coalesce(json_type(content, '$.conditions.ageMin'), 'integer') = 'integer'),
  CHECK (age_max IS json_extract(content, '$.conditions.ageMax')
         AND coalesce(json_type(content, '$.conditions.ageMax'), 'integer') = 'integer')
) STRICT;
CREATE INDEX drill_versions_by_drill ON drill_versions (drill_id, created_at);

-- Only `status` may change on a version (a trust decision, always paired with a reviews row by
-- the server). Every other column is content or provenance and is frozen after INSERT. This
-- fires whenever such a column is named in an UPDATE's SET list, even with an unchanged value.
-- A column added to drill_versions later must be added to this list (drop and recreate).
CREATE TRIGGER drill_versions_immutable
BEFORE UPDATE OF id, drill_id, semver, parent_version_id, content, equipment, space, partner,
  age_min, age_max, level, minutes, license, author_name, author_user_id, source, source_url,
  origin, change_summary, created_at ON drill_versions
BEGIN
  SELECT RAISE(ABORT, 'drill_versions content is immutable: only status may change, insert a new version instead');
END;

CREATE TABLE drill_skills (
  drill_id   TEXT NOT NULL REFERENCES drills (id),
  skill_id   TEXT NOT NULL REFERENCES skills (id),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),   -- the drill's track (DrillSummary.track)
  PRIMARY KEY (drill_id, skill_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX drill_skills_by_skill ON drill_skills (skill_id, drill_id);
CREATE UNIQUE INDEX drill_skills_one_primary ON drill_skills (drill_id) WHERE is_primary = 1;

-- Audit rows for trust-status transitions. `reviewer` is the display name shown on the drill;
-- reviewer_user_id is the account, when there is one.
CREATE TABLE reviews (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  drill_version_id TEXT NOT NULL REFERENCES drill_versions (id),
  reviewer         TEXT NOT NULL CHECK (reviewer <> ''),
  reviewer_user_id TEXT,
  org_label        TEXT NOT NULL DEFAULT '',
  from_status      TEXT NOT NULL
                   CHECK (from_status IN ('COMMUNITY', 'REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED')),
  to_status        TEXT NOT NULL
                   CHECK (to_status IN ('COMMUNITY', 'REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED')),
  note             TEXT NOT NULL DEFAULT '',
  reviewed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX reviews_by_version ON reviews (drill_version_id, reviewed_at, id);

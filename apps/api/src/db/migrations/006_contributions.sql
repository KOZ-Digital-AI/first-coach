-- 006_contributions: coach-contributed drills (new methods and improvements of existing ones), their
-- moderation state, and the files attached to them.
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 007 and later. It REFERENCES drills from 001 and touches nothing else. The contract is
-- shared/contributions.ts (Contribution, ContributionPayloadRequest, ContributionAttachment) and the
-- state machine is contributions/transitions.ts (CONTRIBUTION_MACHINE).
--
-- Tables: contributions (one row per submission; MUTABLE: the state moves, the owner edits while
-- pending or changes_requested) and contribution_attachments (the uploaded video / images / documents,
-- one row per stored file).
--
-- Names and Better Auth
--   * Our tables are contributions and contribution_attachments. Better Auth's own tables (user, session,
--     account, verification) are created later by its migrator, at route-register time, and 005 owns
--     sessions and session_events. None of these names collide with ours, and 006_contributions.test.ts
--     creates the Better Auth tables next to ours to prove it. Our migrations must never create user,
--     session, account or verification.
--   * submitter_user_id is the auth user id and has NO foreign key to "user" (as player_profiles.player_id
--     in 002 and drill_versions.author_user_id in 001): on a migrate-only database "user" does not exist.
--     It is CHECKed non-blank and is immutable (see contributions_immutable). Erasure of an account
--     (shared/privacy.ts) therefore deletes the person's contributions explicitly by submitter_user_id;
--     the attachment rows go by cascade, but the FILES at stored_path do not: the erasure must also
--     remove them (or the orphan sweep will).
--
-- Conventions (as 001-005)
--   * STRICT tables. Timestamps are TEXT, canonical ISO 8601 UTC with milliseconds
--     ("2026-01-01T00:00:00.000Z"): a CHECK refuses any other spelling (offsets, no milliseconds,
--     invalid dates, and hour 24: strftime would round-trip "T24:00:00.000Z", which Zod refuses and which
--     spells the next day's midnight twice), so text order IS time order and updated_at >= created_at can
--     be CHECKed as a string comparison. Writers must normalise to UTC (new Date(at).toISOString()).
--   * CHECKs use IS, never = or <>, on anything that could be NULL: a NULL CHECK result ACCEPTS the row.
--   * Text that must not be blank (origin, submitter_user_id, reviewer_note when present, and in the
--     attachments stored_path, mime and original_name) is refused when it is nothing but whitespace,
--     whitespace being space, tab, newline and carriage return.
--   * Enum CHECKs exist ONLY where the contract fixes the list: contributions.kind (CONTRIBUTION_KINDS),
--     contributions.improvement_kind (IMPROVEMENT_KINDS), contributions.state (CONTRIBUTION_STATES) and
--     contribution_attachments.kind (MEDIA_KINDS, shared/primitives.ts). Their lists MIRROR those constants;
--     006_contributions.test.ts parses them back out of sqlite_master and compares them with the contract.
--     origin is deliberately NOT an enum: see below.
--   * Ids the contract calls EntityId (contributions.id, contribution_attachments.id) are CHECKed 1-128
--     characters of [A-Za-z0-9._-].
--   * payload is CHECKed json_valid plus json_type = 'object': the WHOLE ContributionPayload as submitted
--     (kind, targetDrillSlug, improvementKind, name, instructions, ...). The wire contract is validated by
--     Zod at the write boundary, not here. The payload keeps the slugs as submitted; the columns below are
--     the resolved, indexable copies.
--
-- contributions
--   * kind / target_drill_id: an improvement names the drill it improves and a new drill names none.
--     ContributionPayloadRequest refines the same rule for targetDrillSlug; the writer resolves the slug to
--     drills.id. The CHECK compares the two truth values with IS, so no NULL can slip through.
--   * improvement_kind is allowed ONLY for an improvement and is optional there (the payload's
--     improvementKind is optional too). A new drill has none.
--   * state defaults to 'pending'. Which move is legal is CONTRIBUTION_MACHINE's business (a pure module),
--     not the database's: a state CHECK plus updated_at is all this file adds.
--   * resulting_drill_id is the drill an approval produced (or, for an improvement, the drill it improved).
--     It may be set only when state is 'approved'; approved does not force it (the contract's
--     resultingDrillSlug is optional).
--   * origin is where the submission came from, default 'form' (the coach's contribute form). It is the
--     seam for later ingestion sources (an AI import, say), so it is free non-blank TEXT, not an enum: a
--     new source must not need a table rebuild.
--   * content_hash is the sha256 of the canonical payload as 64 lower-case hex characters, for duplicate
--     detection. It is indexed but NOT unique: a duplicate is flagged to the admin, not blocked. It changes
--     when the owner edits the payload (PUT), so it is not frozen.
--   * target_drill_id and resulting_drill_id are foreign keys to drills(id) with the default NO ACTION.
--     001 states that the commons is append-only and nothing there cascades: a drill is unpublished
--     (drills.unpublished_at), never hard-deleted, so a contribution can always keep pointing at its drill.
--     A hard DELETE of a drill that a contribution references is refused by the foreign key (with
--     foreign_keys ON) instead of silently orphaning or erasing a coach's submission; CASCADE would delete
--     the submission and SET NULL would break the kind / target rule.
--   * contributions_immutable (BEFORE UPDATE) refuses a change of id, submitter_user_id or created_at:
--     who submitted what, and when, never changes. It compares with IS NOT, so an UPDATE that sets a column
--     to its own value (an idempotent upsert) passes. Nothing else is frozen: state, payload and
--     content_hash change on edits and moderation. There is deliberately NO BEFORE DELETE trigger: it would
--     also fire for the cascades and break erasure and withdrawal.
--   * Indexes: (submitter_user_id, created_at, id) for "my contributions", (state, created_at, id) for the
--     moderation queue, (content_hash) for duplicate lookup; the trailing id makes the order total.
--
-- contribution_attachments
--   * One row per stored file. stored_path is the file's path in the upload store, UNIQUE, because the
--     orphan sweep matches files on disk to rows by path; original_name is the client's file name (shown
--     as ContributionAttachment.filename), mime and bytes the checked type and size. kind is a MediaKind.
--   * contribution_id references contributions(id) ON DELETE CASCADE: deleting a contribution deletes its
--     attachment ROWS (not the files). The key is not ON UPDATE CASCADE: the id is immutable.
--
-- Foreign keys and cascades
--   * The cascade is the DATABASE's, but it runs only on a connection with PRAGMA foreign_keys = ON
--     (openDatabase sets it). Nothing else in this file depends on that pragma; a connection with it OFF
--     migrates to the same schema and simply does not cascade or check references.
--
-- Rules for later migration authors and writers (contributions is MUTABLE, so it is not append-only)
--   * INSERT OR REPLACE (and REPLACE INTO) on contributions deletes the conflicting row first, and that
--     DELETE cascades: every attachment row of the submission is wiped. It is also not an UPDATE, so it
--     bypasses the contributions_immutable trigger and can rewrite submitter_user_id and created_at. Never
--     use it: upsert with INSERT ... ON CONFLICT (id) DO UPDATE SET ... and leave the immutable columns
--     out of the SET list (or set them to their stored value).
--   * UPDATE OR REPLACE contributions SET id = <an existing id> is refused by the trigger before any row
--     is replaced. UPDATE OR REPLACE contribution_attachments SET stored_path = <another attachment's
--     path> is not: the other attachment row is deleted first and its file is left orphaned. Never use
--     OR REPLACE on these tables; insert attachments with a plain INSERT and let the UNIQUE fail loudly.
--   * ALTER TABLE contributions ADD COLUMN is fine for a new nullable column, but contributions_immutable
--     lists the columns it protects: a column that must be frozen needs the trigger dropped and recreated.
--   * SQLite cannot ALTER a CHECK: growing kind, improvement_kind, state or the media kinds needs a table
--     rebuild. A DROP TABLE on contributions performs an implicit DELETE FROM, and with foreign keys on
--     that cascades to contribution_attachments, wiping every attachment row; the runner cannot switch
--     foreign keys off inside its transaction, so a rebuild of contributions must copy the attachments
--     out first (or rebuild both tables) and must never DROP the parent while children hold rows. A
--     rebuild must recreate the trigger and the indexes.

CREATE TABLE contributions (
  id                 TEXT NOT NULL PRIMARY KEY                                 -- Contribution.id (EntityId)
                     CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._-]*'),
  kind               TEXT NOT NULL CHECK (kind IN ('new', 'improvement')),     -- CONTRIBUTION_KINDS
  target_drill_id    TEXT REFERENCES drills (id),                              -- the drill an improvement improves; NULL for a new one
  improvement_kind   TEXT                                                      -- IMPROVEMENT_KINDS; only for an improvement, optional there
                     CHECK (improvement_kind IS NULL
                            OR (kind IS 'improvement'
                                AND improvement_kind IN ('explanation', 'progression', 'simpler_variant', 'age_adaptation',
                                                         'translation', 'video', 'accessibility', 'safety'))),
  payload            TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) IS 'object'),   -- ContributionPayload as submitted
  state              TEXT NOT NULL DEFAULT 'pending'                           -- CONTRIBUTION_STATES
                     CHECK (state IN ('pending', 'changes_requested', 'approved', 'rejected', 'withdrawn')),
  origin             TEXT NOT NULL DEFAULT 'form'                              -- free text, the seam for later sources (see header)
                     CHECK (trim(origin, ' ' || char(9) || char(10) || char(13)) <> ''),
  submitter_user_id  TEXT NOT NULL                                             -- the auth user id, no FK (see header)
                     CHECK (trim(submitter_user_id, ' ' || char(9) || char(10) || char(13)) <> ''),
  reviewer_note      TEXT CHECK (reviewer_note IS NULL OR trim(reviewer_note, ' ' || char(9) || char(10) || char(13)) <> ''),
  content_hash       TEXT NOT NULL                                             -- sha256 of the canonical payload, lower-case hex
                     CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  resulting_drill_id TEXT REFERENCES drills (id),                              -- only once approved
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                     CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) < '24'),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                     CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND substr(updated_at, 12, 2) < '24'),
  CHECK ((kind IS 'improvement') = (target_drill_id IS NOT NULL)),             -- an improvement names its drill, a new one none
  CHECK (resulting_drill_id IS NULL OR state IS 'approved'),
  CHECK (updated_at >= created_at)
) STRICT;
-- "My contributions" (newest first is a backwards scan).
CREATE INDEX contributions_by_submitter ON contributions (submitter_user_id, created_at, id);
-- The moderation queue: oldest pending first.
CREATE INDEX contributions_by_state ON contributions (state, created_at, id);
-- Duplicate detection (not unique: duplicates are flagged for the admin, not blocked).
CREATE INDEX contributions_by_content_hash ON contributions (content_hash);

-- Who submitted a contribution, and when, never changes. Fires only when one of these columns is named
-- in an UPDATE's SET list AND the value really differs (IS NOT is NULL-safe). A column added later that
-- must be frozen needs this trigger dropped and recreated. INSERT OR REPLACE bypasses it (see header).
CREATE TRIGGER contributions_immutable
BEFORE UPDATE OF id, submitter_user_id, created_at ON contributions
WHEN NEW.id IS NOT OLD.id
  OR NEW.submitter_user_id IS NOT OLD.submitter_user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'contributions.id, submitter_user_id and created_at are immutable');
END;

CREATE TABLE contribution_attachments (
  id              TEXT NOT NULL PRIMARY KEY                                    -- ContributionAttachment.id (EntityId)
                  CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._-]*'),
  contribution_id TEXT NOT NULL REFERENCES contributions (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('video', 'image', 'document')),   -- MEDIA_KINDS
  stored_path     TEXT NOT NULL UNIQUE                                         -- the file's path in the upload store; the sweep matches by it
                  CHECK (trim(stored_path, ' ' || char(9) || char(10) || char(13)) <> ''),
  mime            TEXT NOT NULL CHECK (trim(mime, ' ' || char(9) || char(10) || char(13)) <> ''),
  bytes           INTEGER NOT NULL CHECK (bytes >= 0),
  original_name   TEXT NOT NULL CHECK (trim(original_name, ' ' || char(9) || char(10) || char(13)) <> ''),   -- ContributionAttachment.filename
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) < '24')
) STRICT;
-- A contribution's files in upload order (also the child index of the foreign key, which serves the cascade).
CREATE INDEX contribution_attachments_by_contribution ON contribution_attachments (contribution_id, created_at, id);

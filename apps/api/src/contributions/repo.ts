// Contribution repository (fc-mol-70i.3): every read and write of the contributions and
// contribution_attachments tables (006_contributions.sql) goes through here.
//
// Consumers: the contribution routes (POST, PUT, DELETE, GET mine) and, later, moderation. Every
// function takes the bun:sqlite Database as its first parameter (no module singleton) and is
// synchronous, like bun:sqlite. SQL uses bound parameters only.
//
// Rules that hold for EVERY function
//   - OWNER ISOLATION: a contribution is reachable only by its submitter. getForOwner answers null and
//     the two writes throw ContributionNotFoundError for someone else's contribution AND for an id that
//     does not exist: a stranger never learns that an id exists, nor its state (the owner check comes
//     before the state check).
//   - ONE TRANSACTION: each write runs its read (owner + state guard), its checks and all its writes in a
//     single BEGIN IMMEDIATE transaction (db.transaction(fn).immediate()). The write lock is taken up
//     front, so the state that was checked cannot change before it is written (no TOCTOU) and a failure
//     part-way rolls everything back (no contribution row without its attachments, no state change
//     without the attachment delete). The reads use a deferred transaction for one consistent snapshot.
//   - STATE GUARDS come from the machine (./transitions canTransition) and the contract's
//     EDITABLE_STATES; the machine is never re-encoded here.
//   - Timestamps are canonical ISO 8601 UTC with milliseconds (Date#toISOString), as the schema's CHECKs
//     require. `now` is a parameter for tests. updated_at is never earlier than created_at.
//
// CHOICES the contract leaves open (each pinned by a test)
//   - The public functions return the full Contribution view. withdraw deletes the attachment ROWS only;
//     the FILES are the uploads module's job. The caller reads attachmentPathsOf(db, id) BEFORE calling
//     withdraw (or a resubmit that replaces the attachments) and purges those files afterwards.
//   - updateForResubmit: attachments omitted keeps the stored ones; an array REPLACES them all (an empty
//     array clears them). The reviewer's note is kept until a moderator changes it.
//   - The payload column stores the payload as submitted minus the honeypot `website`. The kind, target and
//     improvement kind COLUMNS are re-derived from the payload on every write: a new contribution has no
//     target (even if its payload names a slug); an improvement's slug must be an existing drills.slug.
//   - content_hash is the sha256 (lower-case hex) of the canonical JSON of the normalised payload: see
//     contentHash. Duplicates are found with findDuplicates and flagged for moderation, never blocked.
//   - An attachment's view url is `/uploads/<stored_path>`: stored_path is the path in the upload store and
//     the uploads module serves the store under /uploads (the prefix the DrillContent media urls use).
//   - A stored_path already used by another attachment fails on the schema's UNIQUE constraint (the
//     driver's error, the transaction rolled back): the uploads module hands out unique paths.
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { ContributionPayloadView, EDITABLE_STATES } from '../shared/contributions';
import type {
  Contribution,
  ContributionAttachment,
  ContributionPayloadRequest,
  ContributionState,
} from '../shared/contributions';
import type { MediaKind } from '../shared/primitives';
import { canTransition } from './transitions';

// --- errors ----------------------------------------------------------------------------------

/** No such contribution FOR THIS USER: it does not exist, or it belongs to someone else (routes answer 404). */
export class ContributionNotFoundError extends Error {
  constructor() {
    super('Contribution not found');
    this.name = 'ContributionNotFoundError';
  }
}

/** The operation is not allowed in the contribution's current state (routes answer 409). */
export class InvalidStateError extends Error {
  readonly state: ContributionState;
  readonly operation: 'resubmit' | 'withdraw';

  constructor(state: ContributionState, operation: 'resubmit' | 'withdraw') {
    super(`Cannot ${operation} a contribution that is ${state}`);
    this.name = 'InvalidStateError';
    this.state = state;
    this.operation = operation;
  }
}

/** An improvement names no drill, or a drill slug that does not exist (routes answer 422 on "/targetDrillSlug"). */
export class TargetDrillNotFoundError extends Error {
  readonly slug: string | undefined;

  constructor(slug: string | undefined) {
    super(slug === undefined ? 'An improvement must name the drill it improves' : `No drill with slug "${slug}"`);
    this.name = 'TargetDrillNotFoundError';
    this.slug = slug;
  }
}

// --- content hash ----------------------------------------------------------------------------

/** Fields that are not content: the honeypot and the attestations are dropped from the hash. */
const NOT_HASHED = ['website', 'rightsAttested', 'noCommercialContent'];

/** Strings: NFC, trimmed. Objects: undefined values dropped. Recursive, so arrays and nested values are covered. */
function normalise(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC').trim();
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return Object.fromEntries(entries.map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}

const byCodeUnit = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON.stringify replacer: every plain object is emitted with its keys sorted. */
const sortKeys = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(byCodeUnit))
    : value;

/**
 * sha256, 64 lower-case hex characters, of the CANONICAL JSON of the normalised payload: strings
 * trimmed and NFC normalised, the name's internal whitespace collapsed to single spaces, the honeypot
 * and the attestation booleans dropped, keys sorted. Two payloads that differ only in key order,
 * surrounding whitespace, Unicode composition or the name's spacing hash the same.
 */
export function contentHash(payload: ContributionPayloadRequest): string {
  const normalised = normalise(payload) as Record<string, unknown>;
  for (const key of NOT_HASHED) delete normalised[key];
  if (typeof normalised.name === 'string') normalised.name = normalised.name.replace(/\s+/g, ' ');
  return createHash('sha256').update(JSON.stringify(normalised, sortKeys)).digest('hex');
}

// --- helpers ---------------------------------------------------------------------------------

/** A file that was stored by the uploads module and now belongs to a contribution. */
export interface NewAttachment {
  kind: MediaKind;
  /** The file's path in the upload store (UNIQUE across all attachments). */
  storedPath: string;
  mime: string;
  bytes: number;
  /** The client's file name, shown as ContributionAttachment.filename. */
  originalName: string;
}

/** The uploads module serves the upload store under this prefix. */
export const UPLOADS_URL_PREFIX = '/uploads/';

interface ContributionRow {
  id: string;
  state: ContributionState;
  payload: string;
  reviewer_note: string | null;
  created_at: string;
  updated_at: string;
  resulting_slug: string | null;
}

interface AttachmentRow {
  id: string;
  contribution_id: string;
  kind: MediaKind;
  stored_path: string;
  mime: string;
  bytes: number;
  original_name: string;
}

const SELECT_CONTRIBUTION = `
  SELECT c.id, c.state, c.payload, c.reviewer_note, c.created_at, c.updated_at, r.slug AS resulting_slug
    FROM contributions c
    LEFT JOIN drills r ON r.id = c.resulting_drill_id`;

// rowid keeps upload order: the attachments of one write share one created_at.
const ATTACHMENT_ORDER = 'ORDER BY a.created_at, a.rowid';

const attachmentView = (row: AttachmentRow): ContributionAttachment => ({
  id: row.id,
  kind: row.kind,
  url: `${UPLOADS_URL_PREFIX}${row.stored_path.replace(/^\/+/, '')}`,
  filename: row.original_name,
  mimeType: row.mime,
  size: row.bytes,
});

const contributionView = (row: ContributionRow, attachments: AttachmentRow[]): Contribution => ({
  id: row.id,
  state: row.state,
  payload: ContributionPayloadView.parse(JSON.parse(row.payload)),
  attachments: attachments.map(attachmentView),
  ...(row.reviewer_note === null ? {} : { reviewerNote: row.reviewer_note }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.resulting_slug === null ? {} : { resultingDrillSlug: row.resulting_slug }),
});

const iso = (at: Date): string => at.toISOString();

/** The columns derived from the payload: a new contribution has no target and no improvement kind. */
function derivedColumns(db: Database, payload: ContributionPayloadRequest): { targetDrillId: string | null; improvementKind: string | null } {
  if (payload.kind === 'new') return { targetDrillId: null, improvementKind: null };
  if (payload.targetDrillSlug === undefined) throw new TargetDrillNotFoundError(undefined);
  const drill = db.query('SELECT id FROM drills WHERE slug = ?').get(payload.targetDrillSlug) as { id: string } | null;
  if (drill === null) throw new TargetDrillNotFoundError(payload.targetDrillSlug);
  return { targetDrillId: drill.id, improvementKind: payload.improvementKind ?? null };
}

/** The payload as stored: as submitted, minus the honeypot. */
function storedPayload(payload: ContributionPayloadRequest): string {
  const { website: _honeypot, ...rest } = payload;
  return JSON.stringify(rest);
}

function insertAttachments(db: Database, contributionId: string, attachments: readonly NewAttachment[], at: string): void {
  const insert = db.query(
    `INSERT INTO contribution_attachments (id, contribution_id, kind, stored_path, mime, bytes, original_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of attachments) insert.run(randomUUID(), contributionId, a.kind, a.storedPath, a.mime, a.bytes, a.originalName, at);
}

const attachmentRows = (db: Database, contributionId: string): AttachmentRow[] =>
  db
    .query(`SELECT a.* FROM contribution_attachments a WHERE a.contribution_id = ? ${ATTACHMENT_ORDER}`)
    .all(contributionId) as AttachmentRow[];

/** One contribution of one owner as the view, or null (no such id, or someone else's). */
function loadOwned(db: Database, userId: string, id: string): Contribution | null {
  const row = db.query(`${SELECT_CONTRIBUTION} WHERE c.id = ? AND c.submitter_user_id = ?`).get(id, userId) as ContributionRow | null;
  return row === null ? null : contributionView(row, attachmentRows(db, id));
}

/** The owner check plus the state, read inside the caller's write transaction. */
function lockOwned(db: Database, userId: string, id: string): { state: ContributionState; createdAt: string } {
  const row = db.query('SELECT state, created_at FROM contributions WHERE id = ? AND submitter_user_id = ?').get(id, userId) as {
    state: ContributionState;
    created_at: string;
  } | null;
  if (row === null) throw new ContributionNotFoundError();
  return { state: row.state, createdAt: row.created_at };
}

/** An in-place edit of a pending contribution is not a move of the machine; a resubmit is changes_requested -> pending. */
const canResubmit = (state: ContributionState): boolean =>
  (EDITABLE_STATES as readonly ContributionState[]).includes(state) && (state === 'pending' || canTransition(state, 'pending'));

const canWithdraw = (state: ContributionState): boolean => canTransition(state, 'withdrawn');

/** updated_at may not precede created_at (a CHECK), whatever the clock says. */
const stamp = (now: Date, createdAt: string): string => (iso(now) < createdAt ? createdAt : iso(now));

// --- writes ----------------------------------------------------------------------------------

export interface CreateContributionInput {
  userId: string;
  payload: ContributionPayloadRequest;
  attachments?: readonly NewAttachment[];
  now?: Date;
}

/** Stores a new contribution (state 'pending', origin 'form') with its attachments, in one transaction. */
export function createContribution(db: Database, input: CreateContributionInput): Contribution {
  const { userId, payload, attachments = [], now = new Date() } = input;
  return db
    .transaction((): Contribution => {
      const { targetDrillId, improvementKind } = derivedColumns(db, payload);
      const id = randomUUID();
      const at = iso(now);
      db.query(
        `INSERT INTO contributions (id, kind, target_drill_id, improvement_kind, payload, state, origin, submitter_user_id, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 'form', ?, ?, ?, ?)`,
      ).run(id, payload.kind, targetDrillId, improvementKind, storedPayload(payload), userId, contentHash(payload), at, at);
      insertAttachments(db, id, attachments, at);
      return loadOwned(db, userId, id)!;
    })
    .immediate();
}

/**
 * The owner edits and resubmits: allowed only in pending or changes_requested (InvalidStateError
 * otherwise). The state becomes 'pending', content_hash is recomputed, updated_at is bumped; id,
 * submitter and created_at never change and the reviewer's note is kept. `attachments` omitted keeps
 * the stored ones, an array replaces them (read attachmentPathsOf first to purge the replaced files).
 */
export function updateForResubmit(
  db: Database,
  userId: string,
  id: string,
  payload: ContributionPayloadRequest,
  attachments?: readonly NewAttachment[],
  now: Date = new Date(),
): Contribution {
  return db
    .transaction((): Contribution => {
      const current = lockOwned(db, userId, id);
      if (!canResubmit(current.state)) throw new InvalidStateError(current.state, 'resubmit');
      const { targetDrillId, improvementKind } = derivedColumns(db, payload);
      const at = stamp(now, current.createdAt);
      db.query(
        `UPDATE contributions
            SET kind = ?, target_drill_id = ?, improvement_kind = ?, payload = ?, state = 'pending', content_hash = ?, updated_at = ?
          WHERE id = ?`,
      ).run(payload.kind, targetDrillId, improvementKind, storedPayload(payload), contentHash(payload), at, id);
      if (attachments !== undefined) {
        db.query('DELETE FROM contribution_attachments WHERE contribution_id = ?').run(id);
        insertAttachments(db, id, attachments, at);
      }
      return loadOwned(db, userId, id)!;
    })
    .immediate();
}

/**
 * The owner withdraws before a decision (pending or changes_requested; InvalidStateError otherwise).
 * The attachment ROWS are deleted; the files are not touched (see attachmentPathsOf).
 */
export function withdraw(db: Database, userId: string, id: string, now: Date = new Date()): Contribution {
  return db
    .transaction((): Contribution => {
      const current = lockOwned(db, userId, id);
      if (!canWithdraw(current.state)) throw new InvalidStateError(current.state, 'withdraw');
      db.query(`UPDATE contributions SET state = 'withdrawn', updated_at = ? WHERE id = ?`).run(stamp(now, current.createdAt), id);
      db.query('DELETE FROM contribution_attachments WHERE contribution_id = ?').run(id);
      return loadOwned(db, userId, id)!;
    })
    .immediate();
}

// --- reads -----------------------------------------------------------------------------------

/** The caller's own contributions in every state, newest first (created_at, then id, both descending). */
export function listMine(db: Database, userId: string): Contribution[] {
  return db.transaction((): Contribution[] => {
    const rows = db
      .query(`${SELECT_CONTRIBUTION} WHERE c.submitter_user_id = ? ORDER BY c.created_at DESC, c.id DESC`)
      .all(userId) as ContributionRow[];
    const attachments = db
      .query(
        `SELECT a.* FROM contribution_attachments a
           JOIN contributions c ON c.id = a.contribution_id
          WHERE c.submitter_user_id = ? ${ATTACHMENT_ORDER}`,
      )
      .all(userId) as AttachmentRow[];
    const byContribution = new Map<string, AttachmentRow[]>();
    for (const a of attachments) byContribution.set(a.contribution_id, [...(byContribution.get(a.contribution_id) ?? []), a]);
    return rows.map((row) => contributionView(row, byContribution.get(row.id) ?? []));
  })();
}

/** One of the caller's contributions; null for someone else's and for an id that does not exist. */
export function getForOwner(db: Database, userId: string, id: string): Contribution | null {
  return db.transaction((): Contribution | null => loadOwned(db, userId, id))();
}

/** The stored paths of a contribution's attachment files, in upload order: read BEFORE withdrawing, purge AFTER. */
export function attachmentPathsOf(db: Database, id: string): string[] {
  const rows = db
    .query(`SELECT a.stored_path FROM contribution_attachments a WHERE a.contribution_id = ? ${ATTACHMENT_ORDER}`)
    .all(id) as { stored_path: string }[];
  return rows.map((row) => row.stored_path);
}

/** Ids of the OTHER contributions (any submitter, any state) with this content hash, oldest first: a moderation flag. */
export function findDuplicates(db: Database, hash: string, excludeId?: string): string[] {
  const rows = db
    .query('SELECT id FROM contributions WHERE content_hash = ? AND id IS NOT ? ORDER BY created_at, id')
    .all(hash, excludeId ?? null) as { id: string }[];
  return rows.map((row) => row.id);
}

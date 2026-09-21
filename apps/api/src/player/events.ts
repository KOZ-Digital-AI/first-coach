// Idempotent ingestion of the player's session events (POST /api/player/session-events).
//
// Contract: ../shared/session.ts (SessionEvent, SessionProgress). Tables: 005_sessions.sql.
//
//   ingestEvents(db, playerId, events, opts)  writes one batch, all or nothing, and returns the progress summary.
//   progressSummary(db, playerId, opts)       the summary alone (the GET side reuses it).
//
// Rules this module fixes where the contract is silent:
//   * Ownership first. Every event's session is looked up by (id, player_id) BEFORE anything is written: an
//     unknown session and another player's session are the same SessionNotFoundError (routes answer 404), so
//     existence is not leaked. ON CONFLICT DO NOTHING would not swallow the missing-session FK error, and the
//     composite FK is only the backstop.
//   * Idempotency is `INSERT ... ON CONFLICT (client_uuid) DO NOTHING`, never OR IGNORE (which would also drop
//     a row that breaks a CHECK: an invalid event would vanish). Only a duplicate client_uuid is ignored, the
//     first write wins, whoever sends it; any other violation throws and rolls the whole batch back.
//   * The window: an event older than OFFLINE_EVENT_MAX_AGE_DAYS, or more than EVENT_MAX_FUTURE_MS ahead of
//     the injected clock, or with an `at` that is not an ISO 8601 timestamp with an offset, rejects the batch
//     (EventTimeError). Replays are held to it too.
//   * Done state IS stored: TodayItem.done lives in sessions.items (the contract has it), so it is rewritten.
//     Replaying the session's whole event log ordered by (at, id) derives each item's flag: drill_done sets,
//     drill_undone clears, the last one wins; an item with no drill event is not done. Events for an itemId
//     that is not in the session (a swapped-out drill), or with no itemId, stay in the log and change no flag,
//     so one stale outbox event cannot block a batch. `result` events are logged only.
//   * finished_at = the `at` of the EARLIEST session_finished event (the contract has no un-finish), else
//     NULL. The earliest, not the first to arrive, so the outcome does not depend on delivery order.
//   * Only sessions.items and sessions.finished_at are ever updated (never id: see 005's header). The events
//     table is only inserted into.
//   * The player's time zone is NOT in the data model (no column in 002, none in shared/): the caller passes
//     an IANA name as `opts.timeZone`; missing or invalid means UTC. The zone is applied to every finished_at
//     at read time, so a zone change re-dates the whole history.
//   * Streak = consecutive local calendar days on which the player finished a session (the local date of
//     finished_at). It is alive when the latest such day is today or yesterday (local); it then counts back
//     through consecutive days. A day after local today (clock skew) is ignored until it arrives.
import type { Database } from 'bun:sqlite';
import { OFFLINE_EVENT_MAX_AGE_DAYS } from '../shared/session';
import type { SessionEvent, SessionProgress } from '../shared/session';

/** An event may carry an `at` at most this far ahead of the server clock (device clock skew). */
export const EVENT_MAX_FUTURE_MS = 86_400_000;

const DAY_MS = 86_400_000;

/** Injectable clock and the player's IANA time zone (default UTC). */
export interface EventsOptions {
  now?: () => Date;
  timeZone?: string;
}

/** The batch names a session that is unknown or belongs to another player (one error: routes answer 404). */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export type EventTimeReason = 'invalid' | 'too_old' | 'in_future';

/** An event's `at` is not a timestamp, is older than the offline window, or is too far in the future. Nothing was written. */
export class EventTimeError extends Error {
  readonly reason: EventTimeReason;
  readonly clientUuid: string;

  constructor(reason: EventTimeReason, clientUuid: string) {
    const why = { invalid: 'is not an ISO 8601 timestamp with an offset', too_old: `is older than ${OFFLINE_EVENT_MAX_AGE_DAYS} days`, in_future: 'is too far in the future' }[reason];
    super(`Event ${clientUuid}: at ${why}`);
    this.name = 'EventTimeError';
    this.reason = reason;
    this.clientUuid = clientUuid;
  }
}

// --- time zone helpers -----------------------------------------------------------------------

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant an event's `at` names, as canonical ISO UTC; throws EventTimeError('invalid') otherwise. */
function normaliseAt(at: string, clientUuid: string): string {
  const ms = typeof at === 'string' && TIMESTAMP.test(at) ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(ms)) throw new EventTimeError('invalid', clientUuid);
  return new Date(ms).toISOString();
}

function resolveTimeZone(timeZone: string | undefined): string {
  if (timeZone === undefined) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** The calendar day (YYYY-MM-DD) an instant falls on in the zone. */
function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The previous calendar day, by date arithmetic (immune to DST: a day is a label here, not 24 hours). */
function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

// --- progress --------------------------------------------------------------------------------

/** The player's progress: finished sessions, minutes of the items done now, and the training streak. */
export function progressSummary(db: Database, playerId: string, opts: EventsOptions = {}): SessionProgress {
  const now = (opts.now ?? (() => new Date()))();
  const timeZone = resolveTimeZone(opts.timeZone);

  const completed = db.query('SELECT count(*) AS n FROM sessions WHERE player_id = ?1 AND finished_at IS NOT NULL').get(playerId) as { n: number };
  const minutes = db
    .query(
      `SELECT COALESCE(SUM(json_extract(j.value, '$.minutes')), 0) AS n
       FROM sessions s, json_each(s.items) j
       WHERE s.player_id = ?1
         AND json_extract(j.value, '$.done') = 1
         AND json_type(j.value, '$.minutes') IN ('integer', 'real')`,
    )
    .get(playerId) as { n: number };

  const finished = db.query('SELECT finished_at FROM sessions WHERE player_id = ?1 AND finished_at IS NOT NULL').all(playerId) as Array<{ finished_at: string }>;
  const days = new Set(finished.map((r) => localDate(new Date(r.finished_at), timeZone)));
  const today = localDate(now, timeZone);
  let day = days.has(today) ? today : previousDay(today);
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day = previousDay(day);
  }

  return { sessionsCompleted: completed.n, minutesTrained: minutes.n, streakDays: streak };
}

// --- ingestion -------------------------------------------------------------------------------

/**
 * Derives the session's done flags and finished_at from its event log and stores them. Events are read
 * ordered by (at, id): `at` is canonical ISO UTC text, so text order is time order.
 */
function recompute(db: Database, playerId: string, sessionId: string): void {
  const session = db.query('SELECT items, finished_at FROM sessions WHERE id = ?1 AND player_id = ?2').get(sessionId, playerId) as
    | { items: string; finished_at: string | null }
    | null;
  if (session === null) throw new SessionNotFoundError(sessionId);

  const log = db
    .query('SELECT type, item_id, at FROM session_events WHERE session_id = ?1 AND player_id = ?2 ORDER BY at, id')
    .all(sessionId, playerId) as Array<{ type: string; item_id: string | null; at: string }>;

  const done = new Map<string, boolean>();
  let finishedAt: string | null = null;
  for (const e of log) {
    if (e.item_id !== null && e.type === 'drill_done') done.set(e.item_id, true);
    else if (e.item_id !== null && e.type === 'drill_undone') done.set(e.item_id, false);
    else if (e.type === 'session_finished' && finishedAt === null) finishedAt = e.at;
  }

  const items: unknown = JSON.parse(session.items);
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === 'object' && item !== null && typeof (item as { itemId?: unknown }).itemId === 'string') {
        (item as { done: boolean }).done = done.get((item as { itemId: string }).itemId) === true;
      }
    }
  }
  const nextItems = JSON.stringify(items);
  if (nextItems !== session.items || finishedAt !== session.finished_at) {
    db.query('UPDATE sessions SET items = ?1, finished_at = ?2 WHERE id = ?3 AND player_id = ?4').run(nextItems, finishedAt, sessionId, playerId);
  }
}

/**
 * Writes a batch of events for `playerId` in one immediate transaction and returns the player's progress.
 *
 * Throws SessionNotFoundError (unknown or foreign session), EventTimeError (bad `at`) or the database's own
 * error (an event that breaks a CHECK); in every case nothing of the batch is written. Replaying a batch
 * (same client_uuids) changes nothing.
 */
export function ingestEvents(db: Database, playerId: string, events: readonly SessionEvent[], opts: EventsOptions = {}): SessionProgress {
  const now = (opts.now ?? (() => new Date()))();
  const receivedAt = now.toISOString();
  const oldest = now.getTime() - OFFLINE_EVENT_MAX_AGE_DAYS * DAY_MS;
  const newest = now.getTime() + EVENT_MAX_FUTURE_MS;

  const owns = db.query('SELECT 1 AS ok FROM sessions WHERE id = ?1 AND player_id = ?2');
  const insert = db.query(
    `INSERT INTO session_events (player_id, session_id, client_uuid, type, item_id, value, at, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (client_uuid) DO NOTHING`,
  );

  const apply = db.transaction((): SessionProgress => {
    for (const sessionId of new Set(events.map((e) => e.sessionId))) {
      if (owns.get(sessionId, playerId) === null) throw new SessionNotFoundError(sessionId);
    }
    const stamped = events.map((e) => {
      const at = normaliseAt(e.at, e.clientUuid);
      const ms = Date.parse(at);
      if (ms < oldest) throw new EventTimeError('too_old', e.clientUuid);
      if (ms > newest) throw new EventTimeError('in_future', e.clientUuid);
      return { event: e, at };
    });

    for (const { event: e, at } of stamped) {
      insert.run(playerId, e.sessionId, e.clientUuid, e.type, e.itemId ?? null, e.value ?? null, at, receivedAt);
    }
    for (const sessionId of new Set(events.map((e) => e.sessionId))) recompute(db, playerId, sessionId);
    return progressSummary(db, playerId, opts);
  });
  return db.inTransaction ? apply() : apply.immediate();
}

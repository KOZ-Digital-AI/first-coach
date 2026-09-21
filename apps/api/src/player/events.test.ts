import { beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { OFFLINE_EVENT_MAX_AGE_DAYS } from '../shared/session';
import type { SessionEvent } from '../shared/session';
import { openDatabase } from '../db/database';
import { migrate } from '../db/migrate';
import { EventTimeError, SessionNotFoundError, ingestEvents, progressSummary } from './events';

// Every test runs against a real, migrated :memory: database (001-005) with real profile and session rows.

const DAY = 86_400_000;
const NOW = new Date('2026-03-10T12:00:00.000Z');
const clock = { now: () => NOW };
const iso = (ms: number): string => new Date(ms).toISOString();

/** A lower-case RFC 4122 v4 UUID, distinct per n. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Session items per the contract's TodayItem (the fields ingestion reads, plus extras it must keep). */
const items = (done: readonly boolean[] = [false, false, false]): string =>
  JSON.stringify(
    done.map((d, i) => ({
      itemId: `i${i + 1}`,
      drillVersionId: `drill-${i + 1}@1.0.0`,
      minutes: 10 * (i + 1),
      reason: `why-${i + 1}`,
      done: d,
      content: { goal: { en: 'g' } },
    })),
  );

let db: Database;
let seq: number;

function addProfile(playerId: string): void {
  db.run(
    `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
     VALUES (?, 12, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, 'ru')`,
    [playerId],
  );
}

let dateCounter: number;
function addSession(id: string, playerId = 'p1', over: { date?: string; items?: string; finishedAt?: string | null } = {}): void {
  const date = over.date ?? iso(Date.UTC(2025, 0, 1) + DAY * ++dateCounter).slice(0, 10);
  db.run('INSERT INTO sessions (id, player_id, date, planner, graph_version, items, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    playerId,
    date,
    'rules',
    '1.0.0',
    over.items ?? items(),
    over.finishedAt ?? null,
  ]);
}

function ev(type: SessionEvent['type'], over: Partial<SessionEvent> = {}): SessionEvent {
  seq += 1;
  return { clientUuid: uuid(seq), sessionId: 's1', type, at: iso(NOW.getTime() - 3_600_000 + seq * 60_000), ...over };
}

function snapshot(): { sessions: unknown[]; events: unknown[] } {
  return {
    sessions: db.query('SELECT * FROM sessions ORDER BY id').all(),
    events: db.query('SELECT * FROM session_events ORDER BY id').all(),
  };
}

const eventCount = (): number => (db.query('SELECT count(*) AS n FROM session_events').get() as { n: number }).n;
const sessionRow = (id: string): { items: Array<Record<string, unknown>>; finished_at: string | null } => {
  const row = db.query('SELECT items, finished_at FROM sessions WHERE id = ?').get(id) as { items: string; finished_at: string | null };
  return { items: JSON.parse(row.items), finished_at: row.finished_at };
};
const doneFlags = (id: string): boolean[] => sessionRow(id).items.map((i) => i.done as boolean);

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  seq = 0;
  dateCounter = 0;
  addProfile('p1');
  addProfile('p2');
  addSession('s1');
});

describe('ingestEvents: writing the batch', () => {
  test('stores every event with the server clock as received_at and `at` normalised to UTC', () => {
    const batch = [
      ev('drill_done', { itemId: 'i1', at: '2026-03-10T15:00:00.000+05:00' }),
      ev('result', { value: 12.5, at: '2026-03-10T10:00:00.000Z' }),
    ];
    ingestEvents(db, 'p1', batch, clock);
    const rows = db.query('SELECT player_id, session_id, client_uuid, type, item_id, value, at, received_at FROM session_events ORDER BY id').all();
    expect(rows).toEqual([
      { player_id: 'p1', session_id: 's1', client_uuid: batch[0]!.clientUuid, type: 'drill_done', item_id: 'i1', value: null, at: '2026-03-10T10:00:00.000Z', received_at: NOW.toISOString() },
      { player_id: 'p1', session_id: 's1', client_uuid: batch[1]!.clientUuid, type: 'result', item_id: null, value: 12.5, at: '2026-03-10T10:00:00.000Z', received_at: NOW.toISOString() },
    ]);
  });

  test('replaying a batch changes nothing: same rows, same items, same finished_at, same summary', () => {
    const batch = [
      ev('drill_done', { itemId: 'i1' }),
      ev('drill_done', { itemId: 'i2' }),
      ev('drill_undone', { itemId: 'i2' }),
      ev('result', { value: 7 }),
      ev('session_finished'),
    ];
    const first = ingestEvents(db, 'p1', batch, clock);
    const before = snapshot();
    expect(eventCount()).toBe(5);

    const replay = ingestEvents(db, 'p1', batch, { now: () => new Date(NOW.getTime() + 60_000) });
    expect(snapshot()).toEqual(before);
    expect(replay).toEqual(first);
  });

  test('a client_uuid repeated inside one batch is stored once', () => {
    const e = ev('drill_done', { itemId: 'i1' });
    ingestEvents(db, 'p1', [e, e], clock);
    expect(eventCount()).toBe(1);
  });

  test('a known client_uuid with a different payload is ignored: the first write wins', () => {
    const first = ev('drill_done', { itemId: 'i1' });
    ingestEvents(db, 'p1', [first], clock);
    const before = snapshot();
    ingestEvents(db, 'p1', [{ ...first, type: 'drill_undone', itemId: 'i2', value: 99 }], clock);
    expect(snapshot()).toEqual(before);
    expect(doneFlags('s1')).toEqual([true, false, false]);
  });

  test('returns the summary and nothing else is required of the caller', () => {
    const progress = ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i2' }), ev('session_finished')], clock);
    expect(progress).toEqual({ sessionsCompleted: 1, minutesTrained: 20, streakDays: 1 });
  });
});

describe('ingestEvents: atomic and never lossy', () => {
  test('a batch with one invalid event fails as a whole: nothing is inserted, no session is touched', () => {
    const before = snapshot();
    const bad = { ...ev('drill_done', { itemId: 'i1' }), type: 'not_a_type' } as unknown as SessionEvent;
    expect(() => ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i2' }), bad], clock)).toThrow(/CHECK constraint failed/);
    expect(eventCount()).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  test('an invalid event is not swallowed as if it were a duplicate (not INSERT OR IGNORE)', () => {
    const bad = { ...ev('drill_done', { itemId: 'i1' }), clientUuid: 'not-a-uuid' } as SessionEvent;
    expect(() => ingestEvents(db, 'p1', [bad], clock)).toThrow(/CHECK constraint failed/);
    expect(eventCount()).toBe(0);
  });
});

describe('ingestEvents: ownership', () => {
  beforeEach(() => {
    addSession('s2', 'p2');
  });

  test("another player's session is rejected with SessionNotFoundError and nothing is written", () => {
    const before = snapshot();
    expect(() => ingestEvents(db, 'p1', [ev('drill_done', { sessionId: 's2', itemId: 'i1' })], clock)).toThrow(SessionNotFoundError);
    expect(snapshot()).toEqual(before);
  });

  test('a mixed batch (one own, one foreign event) inserts NOTHING, and the own session is untouched', () => {
    const before = snapshot();
    const batch = [ev('drill_done', { itemId: 'i1' }), ev('drill_done', { sessionId: 's2', itemId: 'i1' })];
    expect(() => ingestEvents(db, 'p1', batch, clock)).toThrow(SessionNotFoundError);
    expect(eventCount()).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  test('an unknown session and a foreign session are the same error: existence is not leaked', () => {
    const catchOf = (sessionId: string): SessionNotFoundError => {
      try {
        ingestEvents(db, 'p1', [ev('drill_done', { sessionId, itemId: 'i1' })], clock);
      } catch (e) {
        return e as SessionNotFoundError;
      }
      throw new Error('did not throw');
    };
    const foreign = catchOf('s2');
    const unknown = catchOf('nope');
    expect(foreign).toBeInstanceOf(SessionNotFoundError);
    expect(unknown).toBeInstanceOf(SessionNotFoundError);
    expect(foreign.name).toBe(unknown.name);
    expect(foreign.message.replace('s2', 'X')).toBe(unknown.message.replace('nope', 'X'));
  });

  test("a foreign player replaying player A's client_uuid against A's session is rejected and alters nothing", () => {
    const mine = ev('drill_done', { itemId: 'i1' });
    ingestEvents(db, 'p1', [mine], clock);
    const before = snapshot();
    expect(() => ingestEvents(db, 'p2', [mine], clock)).toThrow(SessionNotFoundError);
    expect(snapshot()).toEqual(before);
  });

  test("player B replaying player A's client_uuid against B's own session is dropped: A's row stays, B gets no row", () => {
    const mine = ev('drill_done', { itemId: 'i1' });
    ingestEvents(db, 'p1', [mine], clock);
    const before = snapshot();
    const progress = ingestEvents(db, 'p2', [{ ...mine, sessionId: 's2' }], clock);
    expect(snapshot()).toEqual(before);
    expect(doneFlags('s2')).toEqual([false, false, false]);
    expect(progress).toEqual({ sessionsCompleted: 0, minutesTrained: 0, streakDays: 0 });
  });

  test("a player's events never change another player's session", () => {
    ingestEvents(db, 'p2', [ev('drill_done', { sessionId: 's2', itemId: 'i1' })], clock);
    expect(doneFlags('s1')).toEqual([false, false, false]);
    expect(doneFlags('s2')).toEqual([true, false, false]);
  });
});

describe('ingestEvents: the offline window', () => {
  test('an event older than OFFLINE_EVENT_MAX_AGE_DAYS is rejected as a whole batch (EventTimeError too_old)', () => {
    expect(OFFLINE_EVENT_MAX_AGE_DAYS).toBe(30);
    const before = snapshot();
    const stale = ev('drill_done', { itemId: 'i1', at: iso(NOW.getTime() - 30 * DAY - 1) });
    let error: unknown;
    try {
      ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i2' }), stale], clock);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EventTimeError);
    expect((error as EventTimeError).reason).toBe('too_old');
    expect((error as EventTimeError).clientUuid).toBe(stale.clientUuid);
    expect(snapshot()).toEqual(before);
  });

  test('an event exactly 30 days old is still accepted', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1', at: iso(NOW.getTime() - 30 * DAY) })], clock);
    expect(eventCount()).toBe(1);
  });

  test('an event more than one day in the future is rejected (EventTimeError in_future); exactly one day is accepted', () => {
    const before = snapshot();
    const future = ev('drill_done', { itemId: 'i1', at: iso(NOW.getTime() + DAY + 1) });
    let error: unknown;
    try {
      ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i2' }), future], clock);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EventTimeError);
    expect((error as EventTimeError).reason).toBe('in_future');
    expect(snapshot()).toEqual(before);

    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1', at: iso(NOW.getTime() + DAY) })], clock);
    expect(eventCount()).toBe(1);
  });

  test('an `at` that is not a date is rejected (EventTimeError invalid) and nothing is written', () => {
    const before = snapshot();
    const junk = ev('drill_done', { itemId: 'i1', at: 'yesterday' });
    let error: unknown;
    try {
      ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i2' }), junk], clock);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EventTimeError);
    expect((error as EventTimeError).reason).toBe('invalid');
    expect(snapshot()).toEqual(before);
  });

  test('the window is measured against the injected clock', () => {
    const e = ev('drill_done', { itemId: 'i1', at: iso(NOW.getTime() - 5 * DAY) });
    expect(() => ingestEvents(db, 'p1', [e], { now: () => new Date(NOW.getTime() + 40 * DAY) })).toThrow(EventTimeError);
    expect(() => ingestEvents(db, 'p1', [e], clock)).not.toThrow();
  });
});

describe('ingestEvents: done flags are recomputed from the log', () => {
  test('drill_done sets the item done and keeps every other field of the items JSON', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i2' })], clock);
    const { items: stored } = sessionRow('s1');
    expect(stored.map((i) => i.done)).toEqual([false, true, false]);
    expect(stored[1]).toEqual({ itemId: 'i2', drillVersionId: 'drill-2@1.0.0', minutes: 20, reason: 'why-2', done: true, content: { goal: { en: 'g' } } });
  });

  test('undo after done: the item is not done any more (same batch)', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1' }), ev('drill_undone', { itemId: 'i1' })], clock);
    expect(doneFlags('s1')).toEqual([false, false, false]);
  });

  test('undo after done: the item is not done any more (undo in a later batch)', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1' })], clock);
    expect(doneFlags('s1')).toEqual([true, false, false]);
    ingestEvents(db, 'p1', [ev('drill_undone', { itemId: 'i1' })], clock);
    expect(doneFlags('s1')).toEqual([false, false, false]);
  });

  test('done, undone, done again: done', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1' }), ev('drill_undone', { itemId: 'i1' }), ev('drill_done', { itemId: 'i1' })], clock);
    expect(doneFlags('s1')).toEqual([true, false, false]);
  });

  test('the log is ordered by `at`, not by arrival: an undo that arrives first but happened later still wins', () => {
    const t = NOW.getTime();
    const done = ev('drill_done', { itemId: 'i1', at: iso(t - 3 * 60_000) });
    const undone = ev('drill_undone', { itemId: 'i1', at: iso(t - 60_000) });
    ingestEvents(db, 'p1', [undone], clock);
    ingestEvents(db, 'p1', [done], clock);
    expect(doneFlags('s1')).toEqual([false, false, false]);
  });

  test('events with the same `at` are ordered by insertion (the later row wins)', () => {
    const at = iso(NOW.getTime() - 60_000);
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1', at }), ev('drill_undone', { itemId: 'i1', at })], clock);
    expect(doneFlags('s1')).toEqual([false, false, false]);
  });

  test('a stale done flag with no event behind it is derived away: the log is the truth', () => {
    addSession('s3', 'p1', { items: items([true, true, true]) });
    ingestEvents(db, 'p1', [ev('drill_done', { sessionId: 's3', itemId: 'i2' })], clock);
    expect(doneFlags('s3')).toEqual([false, true, false]);
  });

  test('an event for an item that is not in the session is logged but changes no flag (no poison batch)', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'ghost' }), ev('drill_done', { itemId: 'i3' })], clock);
    expect(eventCount()).toBe(2);
    expect(doneFlags('s1')).toEqual([false, false, true]);
  });

  test('a drill event without an itemId is logged but changes no flag', () => {
    ingestEvents(db, 'p1', [ev('drill_done')], clock);
    expect(eventCount()).toBe(1);
    expect(doneFlags('s1')).toEqual([false, false, false]);
  });

  test('a result event is logged and changes neither the flags nor finished_at', () => {
    ingestEvents(db, 'p1', [ev('result', { value: 3 })], clock);
    expect(eventCount()).toBe(1);
    expect(doneFlags('s1')).toEqual([false, false, false]);
    expect(sessionRow('s1').finished_at).toBeNull();
  });

  test('only the sessions of the batch are recomputed', () => {
    addSession('s3', 'p1', { items: items([true, false, false]) });
    const before = db.query("SELECT * FROM sessions WHERE id = 's3'").get();
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1' })], clock);
    expect(db.query("SELECT * FROM sessions WHERE id = 's3'").get()).toEqual(before);
  });
});

describe('ingestEvents: finished_at is recomputed from the log', () => {
  test('session_finished sets finished_at to its `at` (UTC), and it counts as completed', () => {
    ingestEvents(db, 'p1', [ev('session_finished', { at: '2026-03-10T16:30:00.000+05:00' })], clock);
    expect(sessionRow('s1').finished_at).toBe('2026-03-10T11:30:00.000Z');
  });

  test('without a session_finished event finished_at stays NULL', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1' })], clock);
    expect(sessionRow('s1').finished_at).toBeNull();
  });

  test('the earliest session_finished wins, whatever the arrival order (there is no un-finish)', () => {
    const t = NOW.getTime();
    const late = ev('session_finished', { at: iso(t - 60_000) });
    const early = ev('session_finished', { at: iso(t - 3_600_000) });
    ingestEvents(db, 'p1', [late], clock);
    expect(sessionRow('s1').finished_at).toBe(late.at);
    ingestEvents(db, 'p1', [early], clock);
    expect(sessionRow('s1').finished_at).toBe(early.at);
    ingestEvents(db, 'p1', [ev('session_finished', { at: iso(t - 1_000) })], clock);
    expect(sessionRow('s1').finished_at).toBe(early.at);
  });

  test('finishing and un-doing drills are independent: an undone item does not un-finish the session', () => {
    ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1' }), ev('session_finished'), ev('drill_undone', { itemId: 'i1' })], clock);
    expect(sessionRow('s1').finished_at).not.toBeNull();
    expect(doneFlags('s1')).toEqual([false, false, false]);
  });
});

describe('progressSummary', () => {
  const at = (s: string): string => new Date(s).toISOString();
  let finishedCounter = 0;

  /** One finished session per timestamp (sessions.date is a unique filler; the streak reads finished_at). */
  function finishedAt(...stamps: string[]): void {
    for (const s of stamps) addSession(`fin${++finishedCounter}`, 'p1', { finishedAt: at(s) });
  }
  const summary = (opts: { now?: Date; timeZone?: string } = {}) =>
    progressSummary(db, 'p1', { now: () => opts.now ?? NOW, ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }) });

  test('a player with no sessions has nothing: 0 / 0 / 0', () => {
    expect(progressSummary(db, 'p2', clock)).toEqual({ sessionsCompleted: 0, minutesTrained: 0, streakDays: 0 });
  });

  test('a player without any row at all still gets zeros, not an error', () => {
    expect(progressSummary(db, 'nobody', clock)).toEqual({ sessionsCompleted: 0, minutesTrained: 0, streakDays: 0 });
  });

  test('sessionsCompleted counts the finished sessions of this player only', () => {
    finishedAt('2026-03-10T08:00:00Z', '2026-03-09T08:00:00Z');
    addSession('unfinished');
    addSession('s2-other', 'p2', { finishedAt: at('2026-03-10T08:00:00Z') });
    expect(summary().sessionsCompleted).toBe(2);
  });

  test('minutesTrained sums the minutes of the items currently done, across sessions, for this player only', () => {
    addSession('a', 'p1', { items: items([true, false, true]) }); // 10 + 30
    addSession('b', 'p1', { items: items([false, true, false]) }); // 20
    addSession('c', 'p2', { items: items([true, true, true]) });
    expect(summary().minutesTrained).toBe(60);
  });

  test('streak: consecutive local days ending today', () => {
    finishedAt('2026-03-10T08:00:00Z', '2026-03-09T08:00:00Z', '2026-03-08T08:00:00Z');
    expect(summary().streakDays).toBe(3);
  });

  test('streak stays alive when the last training day is yesterday (today not trained yet)', () => {
    finishedAt('2026-03-09T08:00:00Z', '2026-03-08T08:00:00Z');
    expect(summary().streakDays).toBe(2);
  });

  test('streak across a missed day resets: today and two days ago, yesterday missed, counts only today', () => {
    finishedAt('2026-03-10T08:00:00Z', '2026-03-08T08:00:00Z', '2026-03-07T08:00:00Z');
    expect(summary().streakDays).toBe(1);
  });

  test('a streak whose last day is two days ago is dead: 0', () => {
    finishedAt('2026-03-08T08:00:00Z', '2026-03-07T08:00:00Z');
    expect(summary().streakDays).toBe(0);
  });

  test('two sessions finished on the same local day count once', () => {
    finishedAt('2026-03-10T06:00:00Z', '2026-03-10T09:00:00Z', '2026-03-09T09:00:00Z');
    expect(summary().streakDays).toBe(2);
  });

  test('unfinished sessions never make a streak', () => {
    addSession('u1', 'p1', { items: items([true, true, true]) });
    expect(summary().streakDays).toBe(0);
  });

  test("another player's finished sessions do not make my streak", () => {
    addSession('theirs', 'p2', { finishedAt: at('2026-03-10T08:00:00Z') });
    expect(summary().streakDays).toBe(0);
  });

  test('days after the local today are ignored (client clock skew must not inflate a streak)', () => {
    finishedAt('2026-03-11T08:00:00Z', '2026-03-10T08:00:00Z');
    expect(summary().streakDays).toBe(1);
  });

  describe('the local calendar day is the one in the player time zone', () => {
    test('23:30 UTC is already the next day in Asia/Almaty (UTC+5), so it counts on the local day', () => {
      // 2026-03-08T23:30Z is 2026-03-09 04:30 in Almaty: yesterday, streak alive. In UTC it is two days ago: dead.
      finishedAt('2026-03-08T23:30:00Z');
      expect(summary({ timeZone: 'Asia/Almaty' }).streakDays).toBe(1);
      expect(summary({ timeZone: 'UTC' }).streakDays).toBe(0);
    });

    test('two finishes on one UTC day are two local days when the zone midnight falls between them', () => {
      // 18:30Z = 23:30 on 03-09 in Almaty, 19:30Z = 00:30 on 03-10 in Almaty.
      finishedAt('2026-03-09T18:30:00Z', '2026-03-09T19:30:00Z');
      expect(summary({ timeZone: 'Asia/Almaty' }).streakDays).toBe(2);
      expect(summary({ timeZone: 'UTC' }).streakDays).toBe(1);
    });

    test('"today" is the local today too: 20:00 UTC on the 10th is already the 11th in Almaty', () => {
      // Last finish 03-09 UTC noon (03-09 17:00 Almaty). Now 2026-03-10T20:00Z = 03-11 01:00 Almaty: last day is 2 days ago there.
      finishedAt('2026-03-09T12:00:00Z');
      const now = new Date('2026-03-10T20:00:00Z');
      expect(summary({ now, timeZone: 'UTC' }).streakDays).toBe(1);
      expect(summary({ now, timeZone: 'Asia/Almaty' }).streakDays).toBe(0);
    });

    test('a DST change (23-hour day in America/New_York, 2026-03-08) does not break the streak', () => {
      // 03-08T04:30Z = 03-07 23:30 EST; 03-09T03:30Z = 03-08 23:30 EDT. Consecutive local days, 23 hours apart.
      finishedAt('2026-03-08T04:30:00Z', '2026-03-09T03:30:00Z');
      expect(summary({ now: new Date('2026-03-09T12:00:00Z'), timeZone: 'America/New_York' }).streakDays).toBe(2);
    });

    test('an invalid IANA name falls back to UTC instead of throwing', () => {
      finishedAt('2026-03-09T08:00:00Z');
      expect(summary({ timeZone: 'Mars/Olympus' }).streakDays).toBe(1);
      expect(summary({ timeZone: 'Mars/Olympus' })).toEqual(summary({ timeZone: 'UTC' }));
    });

    test('with no zone given the day is the UTC day', () => {
      finishedAt('2026-03-08T23:30:00Z');
      expect(summary().streakDays).toBe(0);
    });
  });

  test('ingestEvents returns the same summary, in the zone it was given', () => {
    finishedAt('2026-03-08T23:30:00Z');
    const progress = ingestEvents(db, 'p1', [ev('drill_done', { itemId: 'i1' })], { ...clock, timeZone: 'Asia/Almaty' });
    expect(progress).toEqual({ sessionsCompleted: 1, minutesTrained: 10, streakDays: 1 });
    expect(progress).toEqual(summary({ timeZone: 'Asia/Almaty' }));
  });
});

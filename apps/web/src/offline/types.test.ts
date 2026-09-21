import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  getDefaultStore,
  type KeyValueStore,
  OFFLINE_KEY_PREFIX,
  OfflineSession,
  offlineKey,
  OUTBOX_KEY_NAME,
  OutboxEntry,
  playerKeys,
  readOfflineSession,
  readOutbox,
  readParsed,
  SESSION_KEY_NAME,
  writeJson,
  writeOfflineSession,
  writeOutbox,
} from './types';

// No DOM, no real localStorage, no timers: every storage test runs against an in-memory
// Map-backed fake, so this file behaves the same from the repo root (no happy-dom preload)
// and from apps/web (preload registered).

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// --- Local factories: realistic payloads, one field varied per negative case ---------------
// (shapes follow apps/api/src/shared/session.test.ts; that test file is not imported)

const makeContent = (): Record<string, unknown> => ({
  title: { ru: 'Слабая нога 50', en: 'Weak Foot 50' },
  goal: { ru: 'Улучшить контроль слабой ногой', en: 'Control with the weaker foot' },
  instructions: { ru: '50 касаний внутренней стороной.', en: '50 inside touches.' },
  dose: { reps: 50 },
  conditions: { equipment: 'ball', spaces: ['yard'] },
});

const makeAttribution = (): Record<string, unknown> => ({
  author: 'FIRST COACH Genesis',
  source: 'FIRST COACH Genesis',
  license: 'CC-BY-SA-4.0',
  createdAt: '2026-09-01T10:00:00Z',
  semver: '1.0.0',
});

const makeItem = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemId: 'item-1',
  drillVersionId: 'weak-foot-50-v1',
  minutes: 5,
  done: false,
  content: makeContent(),
  status: 'COMMUNITY',
  attribution: makeAttribution(),
  ...patch,
});

const makeTodaySession = (): Record<string, unknown> => ({
  id: 's-2026-09-21',
  date: '2026-09-21',
  planner: 'rules',
  totalMinutes: 20,
  graphVersion: '0.1.0',
  items: [makeItem(), makeItem({ itemId: 'item-2', drillVersionId: 'wall-passes-v2' })],
  roadmapSummary: {
    currentLevelLabel: 'Foundation',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'weakfoot', level: 1, targetLevel: 2, reason: 'Your stated goal.' },
      { skill: 'passing', level: 1, targetLevel: 2, reason: 'One of the weakest areas.' },
    ],
  },
});

const makeOfflineSession = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  playerId: 'player-a',
  session: makeTodaySession(),
  downloadedAt: '2026-09-21T06:00:00Z',
  locale: 'kk',
  ...patch,
});

const makeEvent = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientUuid: uuid(1),
  sessionId: 's-2026-09-21',
  type: 'drill_done',
  itemId: 'item-1',
  at: '2026-09-21T09:30:00+05:00',
  ...patch,
});

const makeEntry = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientUuid: uuid(1),
  playerId: 'player-a',
  event: makeEvent(),
  createdAt: '2026-09-21T09:30:01Z',
  attempts: 0,
  ...patch,
});

// A valid outbox entry n with its own clientUuid, so entries are distinguishable.
const entryN = (n: number, patch: Record<string, unknown> = {}): Record<string, unknown> =>
  makeEntry({ clientUuid: uuid(n), event: makeEvent({ clientUuid: uuid(n) }), ...patch });

// --- In-memory store fake that records what was written and removed --------------------------

function makeStore(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const removed: string[] = [];
  const written: string[] = [];
  const store: KeyValueStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      written.push(key);
      data.set(key, value);
    },
    removeItem: (key) => {
      removed.push(key);
      data.delete(key);
    },
  };
  return { store, data, removed, written };
}

// --- OfflineSession ------------------------------------------------------------------------

describe('OfflineSession', () => {
  test('parses a session downloaded for a player', () => {
    const parsed = OfflineSession.parse(makeOfflineSession());
    expect(parsed.playerId).toBe('player-a');
    expect(parsed.locale).toBe('kk');
    expect(parsed.downloadedAt).toBe('2026-09-21T06:00:00Z');
    expect(parsed.session.id).toBe('s-2026-09-21');
    expect(parsed.session.items).toHaveLength(2);
    expect(parsed.session.items[0]?.content.dose).toEqual({ reps: 50 });
  });

  test.each(['kk', 'ru', 'en'] as const)('accepts locale %p', (locale) => {
    expect(ok(OfflineSession, makeOfflineSession({ locale }))).toBe(true);
  });

  test('accepts a downloadedAt with a UTC offset', () => {
    expect(ok(OfflineSession, makeOfflineSession({ downloadedAt: '2026-09-21T11:00:00+05:00' }))).toBe(true);
  });

  test.each([
    ['playerId is missing', without(makeOfflineSession(), 'playerId')],
    ['playerId is empty', makeOfflineSession({ playerId: '' })],
    ['playerId is not a string', makeOfflineSession({ playerId: 7 })],
    ['downloadedAt is missing', without(makeOfflineSession(), 'downloadedAt')],
    ['downloadedAt is malformed', makeOfflineSession({ downloadedAt: 'yesterday morning' })],
    ['locale is missing', without(makeOfflineSession(), 'locale')],
    ['locale is not supported', makeOfflineSession({ locale: 'de' })],
    ['session is missing', without(makeOfflineSession(), 'session')],
    [
      'session lacks a required field',
      makeOfflineSession({ session: without(makeTodaySession(), 'items') }),
    ],
  ])('rejects when %s', (_name, value) => {
    expect(ok(OfflineSession, value)).toBe(false);
  });
});

// --- OutboxEntry ---------------------------------------------------------------------------

describe('OutboxEntry', () => {
  test('parses an unsent event with no lastError', () => {
    const parsed = OutboxEntry.parse(makeEntry());
    expect(parsed.clientUuid).toBe(uuid(1));
    expect(parsed.playerId).toBe('player-a');
    expect(parsed.event.type).toBe('drill_done');
    expect(parsed.event.itemId).toBe('item-1');
    expect(parsed.attempts).toBe(0);
    expect(parsed.lastError).toBeUndefined();
  });

  test('parses a retried entry and keeps lastError', () => {
    const parsed = OutboxEntry.parse(makeEntry({ attempts: 3, lastError: 'network down' }));
    expect(parsed.attempts).toBe(3);
    expect(parsed.lastError).toBe('network down');
  });

  test('parses an event without itemId (a skill-test result)', () => {
    expect(ok(OutboxEntry, makeEntry({ event: without(makeEvent({ type: 'result', value: 12 }), 'itemId') }))).toBe(
      true,
    );
  });

  test.each([
    ['clientUuid is not a uuid', makeEntry({ clientUuid: 'not-a-uuid' })],
    ['clientUuid is missing', without(makeEntry(), 'clientUuid')],
    ['playerId is missing', without(makeEntry(), 'playerId')],
    ['playerId is empty', makeEntry({ playerId: '' })],
    ['createdAt is malformed', makeEntry({ createdAt: '21/09/2026' })],
    ['createdAt is missing', without(makeEntry(), 'createdAt')],
    ['attempts is negative', makeEntry({ attempts: -1 })],
    ['attempts is not an integer', makeEntry({ attempts: 1.5 })],
    ['attempts is missing', without(makeEntry(), 'attempts')],
    ['event is missing', without(makeEntry(), 'event')],
    ['event type is unknown', makeEntry({ event: makeEvent({ type: 'drill_paused' }) })],
    ['event lacks its own clientUuid', makeEntry({ event: without(makeEvent(), 'clientUuid') })],
    ['lastError is not a string', makeEntry({ lastError: 42 })],
  ])('rejects when %s', (_name, value) => {
    expect(ok(OutboxEntry, value)).toBe(false);
  });
});

// --- Key namespacing -----------------------------------------------------------------------

describe('offlineKey', () => {
  test('namespaces a key as fc:<playerId>:<name>', () => {
    expect(offlineKey('player-a', 'session')).toBe('fc:player-a:session');
  });

  test('uses the exported prefix and key names', () => {
    expect(OFFLINE_KEY_PREFIX).toBe('fc');
    expect(SESSION_KEY_NAME).toBe('session');
    expect(OUTBOX_KEY_NAME).toBe('outbox');
  });

  test('the same name gives a different key per player', () => {
    expect(offlineKey('player-a', 'outbox')).not.toBe(offlineKey('player-b', 'outbox'));
  });

  test('different names give different keys for one player', () => {
    expect(offlineKey('player-a', 'session')).not.toBe(offlineKey('player-a', 'outbox'));
  });

  test('rejects an empty playerId with a TypeError', () => {
    expect(() => offlineKey('', 'session')).toThrow(TypeError);
  });

  test('rejects an empty name with a TypeError', () => {
    expect(() => offlineKey('player-a', '')).toThrow(TypeError);
  });

  test('rejects a colon in the playerId, which would let two players collide', () => {
    // player 'a:b' + name 'c' and player 'a' + name 'b:c' would both be 'fc:a:b:c'.
    expect(() => offlineKey('a:b', 'c')).toThrow(TypeError);
  });

  test('rejects a colon in the name, which would let two players collide', () => {
    expect(() => offlineKey('a', 'b:c')).toThrow(TypeError);
  });
});

describe('playerKeys', () => {
  test('gives the full session and outbox keys of a player', () => {
    expect(playerKeys('player-a')).toEqual({ session: 'fc:player-a:session', outbox: 'fc:player-a:outbox' });
  });

  test('gives different keys to different players', () => {
    const a = playerKeys('player-a');
    const b = playerKeys('player-b');
    expect(a.session).not.toBe(b.session);
    expect(a.outbox).not.toBe(b.outbox);
  });
});

// --- readParsed / writeJson ----------------------------------------------------------------

const Counter = z.object({ n: z.number() });

describe('readParsed', () => {
  test('returns undefined for a missing key and does not remove or write anything', () => {
    const { store, removed, written } = makeStore();
    expect(readParsed(store, 'fc:p:x', Counter)).toBeUndefined();
    expect(removed).toEqual([]);
    expect(written).toEqual([]);
  });

  test('returns the parsed value of a valid key and leaves it in place', () => {
    const { store, data, removed } = makeStore({ 'fc:p:x': '{"n":3}' });
    expect(readParsed(store, 'fc:p:x', Counter)).toEqual({ n: 3 });
    expect(removed).toEqual([]);
    expect(data.get('fc:p:x')).toBe('{"n":3}');
  });

  test('corrupted JSON resets the key: returns undefined and removes it, without throwing', () => {
    const { store, data, removed } = makeStore({ 'fc:p:x': '{"n": 3' });
    expect(readParsed(store, 'fc:p:x', Counter)).toBeUndefined();
    expect(removed).toEqual(['fc:p:x']);
    expect(data.has('fc:p:x')).toBe(false);
  });

  test('JSON that fails the schema resets the key: returns undefined and removes it', () => {
    const { store, data, removed } = makeStore({ 'fc:p:x': '{"n":"three"}' });
    expect(readParsed(store, 'fc:p:x', Counter)).toBeUndefined();
    expect(removed).toEqual(['fc:p:x']);
    expect(data.has('fc:p:x')).toBe(false);
  });

  test('a reset removes only the corrupted key', () => {
    const { store, data } = makeStore({ 'fc:p:x': 'not json', 'fc:p:y': '{"n":1}' });
    readParsed(store, 'fc:p:x', Counter);
    expect(data.get('fc:p:y')).toBe('{"n":1}');
  });

  test('a store whose getItem throws gives undefined instead of throwing', () => {
    const { store } = makeStore();
    const broken: KeyValueStore = {
      ...store,
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    expect(readParsed(broken, 'fc:p:x', Counter)).toBeUndefined();
  });

  test('a reset does not throw when removeItem throws too', () => {
    const { store } = makeStore({ 'fc:p:x': 'not json' });
    const broken: KeyValueStore = {
      ...store,
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    expect(readParsed(broken, 'fc:p:x', Counter)).toBeUndefined();
  });
});

describe('writeJson', () => {
  test('stores the JSON of the value and reports success', () => {
    const { store, data } = makeStore();
    expect(writeJson(store, 'fc:p:x', { n: 3 })).toBe(true);
    expect(data.get('fc:p:x')).toBe('{"n":3}');
  });

  test('round-trips through readParsed', () => {
    const { store } = makeStore();
    writeJson(store, 'fc:p:x', { n: 9 });
    expect(readParsed(store, 'fc:p:x', Counter)).toEqual({ n: 9 });
  });

  test('a setItem that throws (quota) returns false instead of throwing', () => {
    const { store } = makeStore();
    const full: KeyValueStore = {
      ...store,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(writeJson(full, 'fc:p:x', { n: 3 })).toBe(false);
  });

  test('a value JSON cannot serialise returns false instead of throwing', () => {
    const { store, data } = makeStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(writeJson(store, 'fc:p:x', circular)).toBe(false);
    expect(data.size).toBe(0);
  });
});

// --- Typed session and outbox reads/writes ---------------------------------------------------

describe('offline session storage', () => {
  test('an unset session reads as undefined', () => {
    const { store } = makeStore();
    expect(readOfflineSession(store, 'player-a')).toBeUndefined();
  });

  test('a written session reads back under the playerId-namespaced key', () => {
    const { store, data } = makeStore();
    const session = OfflineSession.parse(makeOfflineSession());
    expect(writeOfflineSession(store, 'player-a', session)).toBe(true);
    expect([...data.keys()]).toEqual(['fc:player-a:session']);
    expect(readOfflineSession(store, 'player-a')).toEqual(session);
  });

  test('a corrupted stored session is reset', () => {
    const { store, data, removed } = makeStore({ 'fc:player-a:session': '{"playerId":' });
    expect(readOfflineSession(store, 'player-a')).toBeUndefined();
    expect(removed).toEqual(['fc:player-a:session']);
    expect(data.size).toBe(0);
  });

  test('a stored session that fails the schema is reset', () => {
    const bad = JSON.stringify(makeOfflineSession({ locale: 'de' }));
    const { store, removed } = makeStore({ 'fc:player-a:session': bad });
    expect(readOfflineSession(store, 'player-a')).toBeUndefined();
    expect(removed).toEqual(['fc:player-a:session']);
  });

  test('a failing write reports false', () => {
    const full: KeyValueStore = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(writeOfflineSession(full, 'player-a', OfflineSession.parse(makeOfflineSession()))).toBe(false);
  });
});

describe('outbox storage', () => {
  const parsedEntries = (...ns: number[]) => ns.map((n) => OutboxEntry.parse(entryN(n)));

  test('an unset outbox reads as an empty list', () => {
    const { store } = makeStore();
    expect(readOutbox(store, 'player-a')).toEqual([]);
  });

  test('a written outbox reads back in order under the playerId-namespaced key', () => {
    const { store, data } = makeStore();
    const entries = parsedEntries(1, 2, 3);
    expect(writeOutbox(store, 'player-a', entries)).toBe(true);
    expect([...data.keys()]).toEqual(['fc:player-a:outbox']);
    expect(readOutbox(store, 'player-a')).toEqual(entries);
  });

  test('an all-valid outbox is not rewritten or removed on read', () => {
    const { store, removed, written } = makeStore();
    writeOutbox(store, 'player-a', parsedEntries(1, 2));
    written.length = 0;
    readOutbox(store, 'player-a');
    expect(written).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('one corrupted entry loses only itself: the valid entries survive and the key is rewritten', () => {
    const middleBad = entryN(2, { attempts: -1 });
    const raw = JSON.stringify([entryN(1), middleBad, entryN(3)]);
    const { store, data, removed } = makeStore({ 'fc:player-a:outbox': raw });

    const read = readOutbox(store, 'player-a');

    expect(read.map((e) => e.clientUuid)).toEqual([uuid(1), uuid(3)]);
    const stored = JSON.parse(data.get('fc:player-a:outbox') ?? 'null') as { clientUuid: string }[];
    expect(stored.map((e) => e.clientUuid)).toEqual([uuid(1), uuid(3)]);
    expect(removed).toEqual([]);
  });

  test('the rewritten outbox reads back without further changes', () => {
    const raw = JSON.stringify([entryN(1), entryN(2, { clientUuid: 'nope' }), entryN(3)]);
    const { store, written } = makeStore({ 'fc:player-a:outbox': raw });
    readOutbox(store, 'player-a');
    written.length = 0;
    expect(readOutbox(store, 'player-a')).toHaveLength(2);
    expect(written).toEqual([]);
  });

  test('an entry that is not even an object is dropped like any other bad entry', () => {
    const raw = JSON.stringify([entryN(1), 'garbage', entryN(3)]);
    const { store } = makeStore({ 'fc:player-a:outbox': raw });
    expect(readOutbox(store, 'player-a').map((e) => e.clientUuid)).toEqual([uuid(1), uuid(3)]);
  });

  test('an outbox with no valid entry is removed and reads as empty', () => {
    const raw = JSON.stringify([entryN(1, { attempts: -1 }), entryN(2, { playerId: '' })]);
    const { store, data } = makeStore({ 'fc:player-a:outbox': raw });
    expect(readOutbox(store, 'player-a')).toEqual([]);
    expect(data.has('fc:player-a:outbox')).toBe(false);
  });

  test('corrupted JSON resets the outbox key', () => {
    const { store, data, removed } = makeStore({ 'fc:player-a:outbox': '[{"clientUuid":' });
    expect(readOutbox(store, 'player-a')).toEqual([]);
    expect(removed).toEqual(['fc:player-a:outbox']);
    expect(data.size).toBe(0);
  });

  test('a stored outbox that is not an array resets the key', () => {
    const { store, removed } = makeStore({ 'fc:player-a:outbox': JSON.stringify(entryN(1)) });
    expect(readOutbox(store, 'player-a')).toEqual([]);
    expect(removed).toEqual(['fc:player-a:outbox']);
  });

  test('a failing write reports false', () => {
    const full: KeyValueStore = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(writeOutbox(full, 'player-a', parsedEntries(1))).toBe(false);
  });
});

// --- Two players on a shared device ---------------------------------------------------------

describe('two players on one device', () => {
  test('their sessions and outboxes coexist without overwriting each other', () => {
    const { store } = makeStore();
    const sessionA = OfflineSession.parse(makeOfflineSession({ playerId: 'player-a', locale: 'kk' }));
    const sessionB = OfflineSession.parse(makeOfflineSession({ playerId: 'player-b', locale: 'ru' }));
    const outboxA = [OutboxEntry.parse(entryN(1, { playerId: 'player-a' }))];
    const outboxB = [
      OutboxEntry.parse(entryN(2, { playerId: 'player-b' })),
      OutboxEntry.parse(entryN(3, { playerId: 'player-b' })),
    ];

    writeOfflineSession(store, 'player-a', sessionA);
    writeOfflineSession(store, 'player-b', sessionB);
    writeOutbox(store, 'player-a', outboxA);
    writeOutbox(store, 'player-b', outboxB);

    expect(readOfflineSession(store, 'player-a')).toEqual(sessionA);
    expect(readOfflineSession(store, 'player-b')).toEqual(sessionB);
    expect(readOutbox(store, 'player-a')).toEqual(outboxA);
    expect(readOutbox(store, 'player-b')).toEqual(outboxB);
  });

  test("overwriting one player's outbox leaves the other's untouched", () => {
    const { store } = makeStore();
    const outboxB = [OutboxEntry.parse(entryN(2, { playerId: 'player-b' }))];
    writeOutbox(store, 'player-b', outboxB);
    writeOutbox(store, 'player-a', [OutboxEntry.parse(entryN(1, { playerId: 'player-a' }))]);
    writeOutbox(store, 'player-a', []);
    expect(readOutbox(store, 'player-b')).toEqual(outboxB);
  });

  test("a corrupted key of player A does not touch player B's keys", () => {
    const { store, data, removed } = makeStore();
    const sessionB = OfflineSession.parse(makeOfflineSession({ playerId: 'player-b' }));
    const outboxB = [OutboxEntry.parse(entryN(2, { playerId: 'player-b' }))];
    writeOfflineSession(store, 'player-b', sessionB);
    writeOutbox(store, 'player-b', outboxB);
    data.set('fc:player-a:session', '{broken');
    data.set('fc:player-a:outbox', '[broken');

    expect(readOfflineSession(store, 'player-a')).toBeUndefined();
    expect(readOutbox(store, 'player-a')).toEqual([]);

    expect(removed.sort()).toEqual(['fc:player-a:outbox', 'fc:player-a:session']);
    expect(readOfflineSession(store, 'player-b')).toEqual(sessionB);
    expect(readOutbox(store, 'player-b')).toEqual(outboxB);
  });
});

// --- getDefaultStore -------------------------------------------------------------------------

describe('getDefaultStore', () => {
  // localStorage is present under the web preload (happy-dom) and absent from the repo root,
  // so each case pins its own situation and restores whatever was there.
  const withLocalStorage = (descriptor: PropertyDescriptor | undefined, run: () => void): void => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
      else Reflect.deleteProperty(globalThis, 'localStorage');
      run();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  };

  test('is undefined when localStorage is absent, and does not throw', () => {
    withLocalStorage(undefined, () => {
      expect(getDefaultStore()).toBeUndefined();
    });
  });

  test('is undefined when reading localStorage throws (blocked storage), and does not throw', () => {
    withLocalStorage(
      {
        get: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      },
      () => {
        expect(getDefaultStore()).toBeUndefined();
      },
    );
  });

  test('returns the global localStorage when one is available', () => {
    const { store } = makeStore();
    withLocalStorage({ get: () => store }, () => {
      expect(getDefaultStore()).toBe(store);
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { ENDPOINTS, SessionEvent, SessionEventsRequest, TodaySession } from '@api-types/session';
import type { Api } from '../../lib/api';
import { ApiProblem } from '../../lib/problem';
import { createEventsClient, submitEvents as defaultSubmitEvents } from './events-client';

// The fake `api` records what the client sends and answers like the real wrapper does: the response is PARSED with the
// schema the client passed, so a wrong schema (or none) shows up as a wrong result. The QueryClient is the real library's.

const SESSION_ID = 's-2026-09-21';
const TODAY = ['today'] as const;

const makeSessionJson = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SESSION_ID,
  date: '2026-09-21',
  planner: 'rules',
  totalMinutes: 20,
  graphVersion: '0.1.0',
  items: [
    {
      itemId: 'item-1',
      drillVersionId: 'weak-foot-50-v1',
      minutes: 5,
      done: true,
      content: {
        title: { ru: 'Слабая нога 50', en: 'Weak Foot 50' },
        goal: { ru: 'Улучшить контроль слабой ногой', en: 'Control with the weaker foot' },
        instructions: { ru: '50 касаний внутренней стороной.', en: '50 inside touches.' },
        dose: { reps: 50 },
        conditions: { equipment: 'ball', spaces: ['yard'] },
      },
      status: 'COMMUNITY',
      attribution: {
        author: 'FIRST COACH Genesis',
        source: 'FIRST COACH Genesis',
        license: 'CC-BY-SA-4.0',
        createdAt: '2026-09-01T10:00:00Z',
        semver: '1.0.0',
      },
    },
  ],
  roadmapSummary: {
    currentLevelLabel: 'Foundation',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [{ skill: 'weakfoot', level: 1, targetLevel: 2, reason: 'Your stated goal.' }],
  },
  ...patch,
});

const makeResponseJson = (sessionPatch: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: makeSessionJson(sessionPatch),
  progress: { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 },
  nextSessionDate: '2026-09-23',
});

interface Call {
  path: string;
  options: { body?: unknown; schema: { parse(input: unknown): unknown } };
}

/** `answer(callIndex)` returns the wire JSON for that call, or a promise of it, or throws/rejects with the failure. */
function fakeApi(answer: (index: number) => unknown): { api: Api; calls: Call[] } {
  const calls: Call[] = [];
  const post = async (path: string, options: Call['options']): Promise<unknown> => {
    const index = calls.length;
    calls.push({ path, options });
    return options.schema.parse(await answer(index));
  };
  const unused = () => {
    throw new Error('the events client may only POST');
  };
  return { api: { get: unused, put: unused, patch: unused, delete: unused, post } as unknown as Api, calls };
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const makeClient = (answer: (index: number) => unknown = () => makeResponseJson()) => {
  const { api, calls } = fakeApi(answer);
  const queryClient = new QueryClient();
  return { client: createEventsClient({ api, queryClient }), queryClient, calls };
};

const makeEvents = (count: number) => {
  const { client } = makeClient();
  return Array.from({ length: count }, (_, i) => client.makeEvent('drill_done', { sessionId: SESSION_ID, itemId: `item-${i + 1}` }));
};

describe('makeEvent', () => {
  test.each(['drill_done', 'drill_undone', 'result', 'session_finished'] as const)('a %p event is valid for the session-events contract', (type) => {
    const { client } = makeClient();
    const event = client.makeEvent(type, { sessionId: SESSION_ID, itemId: 'item-1', value: 12 });
    expect(SessionEvent.safeParse(event).success).toBe(true);
    expect(event.type).toBe(type);
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.itemId).toBe('item-1');
    expect(event.value).toBe(12);
  });

  test('itemId and value stay absent when the caller gave none', () => {
    const { client } = makeClient();
    const event = client.makeEvent('session_finished', { sessionId: SESSION_ID });
    expect(SessionEvent.safeParse(event).success).toBe(true);
    expect(event).not.toHaveProperty('itemId');
    expect(event).not.toHaveProperty('value');
  });

  test('1000 events get 1000 distinct clientUuids, all valid ClientUuids', () => {
    const { client } = makeClient();
    const events = Array.from({ length: 1000 }, () => client.makeEvent('drill_done', { sessionId: SESSION_ID, itemId: 'item-1' }));
    expect(new Set(events.map((event) => event.clientUuid)).size).toBe(1000);
    for (const event of events) expect(SessionEvent.safeParse(event).success).toBe(true);
  });

  test('ids stay distinct when the clock does not move (no id derived from time alone)', () => {
    const { api } = fakeApi(() => makeResponseJson());
    const client = createEventsClient({ api, queryClient: new QueryClient(), now: () => new Date('2026-09-21T10:00:00.000Z') });
    const ids = Array.from({ length: 1000 }, () => client.makeEvent('drill_done', { sessionId: SESSION_ID }).clientUuid);
    expect(new Set(ids).size).toBe(1000);
  });

  test('at is the current time as an ISO string with millisecond precision in UTC', () => {
    const { client } = makeClient();
    const before = Date.now();
    const event = client.makeEvent('drill_done', { sessionId: SESSION_ID });
    const after = Date.now();
    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const at = Date.parse(event.at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  test('at and clientUuid come from the injected clock and id source', () => {
    const { api } = fakeApi(() => makeResponseJson());
    let n = 0;
    const client = createEventsClient({
      api,
      queryClient: new QueryClient(),
      now: () => new Date('2026-09-20T09:30:00.123Z'),
      newId: () => uuid(++n),
    });
    const first = client.makeEvent('drill_done', { sessionId: SESSION_ID });
    const second = client.makeEvent('drill_undone', { sessionId: SESSION_ID });
    expect(first.at).toBe('2026-09-20T09:30:00.123Z');
    expect([first.clientUuid, second.clientUuid]).toEqual([uuid(1), uuid(2)]);
  });

  test('does not mutate the fields it is given', () => {
    const { client } = makeClient();
    const fields = Object.freeze({ sessionId: SESSION_ID, itemId: 'item-1', value: 3 });
    const event = client.makeEvent('result', fields);
    expect(fields).toEqual({ sessionId: SESSION_ID, itemId: 'item-1', value: 3 });
    expect(event).not.toBe(fields);
  });
});

describe('submitEvents', () => {
  test('sends the batch as ONE POST to the contract path, in order, with the contract request body and response schema', async () => {
    const { client, calls } = makeClient();
    const events = makeEvents(3);
    await client.submitEvents(events);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.path).toBe(ENDPOINTS.postSessionEvents.path);
    expect(call?.options.schema).toBe(ENDPOINTS.postSessionEvents.response);
    expect(call?.options.body).toEqual({ events });
    expect(SessionEventsRequest.safeParse(call?.options.body).success).toBe(true);
    expect((call?.options.body as { events: SessionEvent[] }).events.map((event) => event.itemId)).toEqual(['item-1', 'item-2', 'item-3']);
  });

  test('updates the [today] cache with the session the server returned, and resolves with the parsed response', async () => {
    const { client, queryClient } = makeClient();
    const returned = await client.submitEvents(makeEvents(1));

    const expected = TodaySession.parse(makeSessionJson());
    expect(queryClient.getQueryData(TODAY)).toEqual(expected);
    expect(returned.session).toEqual(expected);
    expect(returned.progress).toEqual({ sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 });
    expect(returned.nextSessionDate).toBe('2026-09-23');
  });

  test('replaces a stale cached session; it does not merge into it', async () => {
    const { client, queryClient } = makeClient(() => makeResponseJson({ totalMinutes: 25 }));
    queryClient.setQueryData(TODAY, { id: 'old-session', staleOnlyField: true, items: [{ itemId: 'gone' }] });
    await client.submitEvents(makeEvents(1));

    const cached = queryClient.getQueryData(TODAY);
    expect(cached).toStrictEqual(TodaySession.parse(makeSessionJson({ totalMinutes: 25 })));
    expect(cached).not.toHaveProperty('staleOnlyField');
  });

  test('an empty batch rejects locally with a clear error, sends nothing and leaves the cache alone', async () => {
    const { client, queryClient, calls } = makeClient();
    await expect(client.submitEvents([])).rejects.toThrow(/at least one event/i);
    expect(calls).toHaveLength(0);
    expect(queryClient.getQueryData(TODAY)).toBeUndefined();
  });

  test('a failed request rethrows the very same ApiProblem and leaves the cache at its previous value', async () => {
    const problem = new ApiProblem({ kind: 'server', status: 503 });
    const { client, queryClient } = makeClient(() => {
      throw problem;
    });
    const previous = TodaySession.parse(makeSessionJson({ totalMinutes: 15 }));
    queryClient.setQueryData(TODAY, previous);

    const outcome = await client.submitEvents(makeEvents(1)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBe(problem);
    expect(queryClient.getQueryData(TODAY)).toBe(previous);
  });

  test('a failed request with nothing cached yet leaves the cache empty', async () => {
    const { client, queryClient } = makeClient(() => {
      throw new ApiProblem({ kind: 'offline' });
    });
    await expect(client.submitEvents(makeEvents(1))).rejects.toBeInstanceOf(ApiProblem);
    expect(queryClient.getQueryData(TODAY)).toBeUndefined();
  });

  test('a response that fails the contract schema is a rejection, not a cache write', async () => {
    const { client, queryClient } = makeClient(() => ({ session: { id: 'x' } }));
    await expect(client.submitEvents(makeEvents(1))).rejects.toBeDefined();
    expect(queryClient.getQueryData(TODAY)).toBeUndefined();
  });

  test('resubmitting the same batch sends the same clientUuids and never mutates the events', async () => {
    const { client, calls } = makeClient();
    const events = makeEvents(2);
    const snapshot = structuredClone(events);
    Object.freeze(events);
    for (const event of events) Object.freeze(event);

    await client.submitEvents(events);
    await client.submitEvents(events);

    expect(events).toEqual(snapshot);
    expect(calls).toHaveLength(2);
    const sentIds = calls.map((call) => (call.options.body as { events: SessionEvent[] }).events.map((event) => event.clientUuid));
    expect(sentIds[0]).toEqual(snapshot.map((event) => event.clientUuid));
    expect(sentIds[1]).toEqual(sentIds[0]);
  });

  test('concurrent submissions: the response that arrives last is what the cache ends up holding', async () => {
    const releases: Array<() => void> = [];
    const { client, queryClient } = makeClient((index) => new Promise((resolve) => releases.push(() => resolve(makeResponseJson({ totalMinutes: 10 + index })))));

    const first = client.submitEvents(makeEvents(1));
    const second = client.submitEvents(makeEvents(1));
    releases[1]?.(); // second request answers first...
    await second;
    expect((queryClient.getQueryData(TODAY) as { totalMinutes: number }).totalMinutes).toBe(11);
    releases[0]?.(); // ...the first answers last and wins
    await first;
    expect((queryClient.getQueryData(TODAY) as { totalMinutes: number }).totalMinutes).toBe(10);
  });

  test('the QueryClient may be supplied lazily; it is read at submit time, and a missing one fails before any request', async () => {
    const { api, calls } = fakeApi(() => makeResponseJson());
    let queryClient: QueryClient | undefined;
    const client = createEventsClient({
      api,
      queryClient: () => {
        if (queryClient === undefined) throw new Error('no query client yet');
        return queryClient;
      },
    });
    const events = client.makeEvent('drill_done', { sessionId: SESSION_ID });

    await expect(client.submitEvents([events])).rejects.toThrow('no query client yet');
    expect(calls).toHaveLength(0);

    queryClient = new QueryClient();
    await client.submitEvents([events]);
    expect(queryClient.getQueryData(TODAY)).toBeDefined();
  });
});

describe('the default instance', () => {
  test('until configureEventsClient is called, submitting fails before any request is made', async () => {
    const events = makeEvents(1);
    await expect(defaultSubmitEvents(events)).rejects.toThrow(/configureEventsClient/);
  });
});

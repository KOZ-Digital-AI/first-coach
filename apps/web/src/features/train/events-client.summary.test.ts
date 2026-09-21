import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { Api } from '../../lib/api';
import { ApiProblem } from '../../lib/problem';
import { createEventsClient } from './events-client';

/*
 * fc-mol-urn.10 (additive change to the events client): after the existing ['today'] write, submitEvents also writes what the
 * summary screen needs to the in-memory key ['session-summary'] as { progress, nextSessionDate, sessionId } (sessionId is the
 * SERVER's session id, response.session.id). It is a cache write only: the key is not in the persisted allow-list.
 * The existing behaviour is pinned by events-client.test.ts and is not repeated here. The key is written as a literal on
 * purpose: it is the contract with the summary screen.
 */

const SUMMARY = ['session-summary'] as const;
const TODAY = ['today'] as const;
const SESSION_ID = 's-2026-09-21';

const responseJson = (patch: { id?: string; progress?: Record<string, number>; nextSessionDate?: string } = {}): Record<string, unknown> => ({
  session: {
    id: patch.id ?? SESSION_ID,
    date: '2026-09-21',
    planner: 'rules',
    totalMinutes: 20,
    graphVersion: '0.1.0',
    items: [],
    roadmapSummary: { currentLevelLabel: 'Foundation', sessionsPerWeek: 3, minutesPerSession: 20, focus: [
        { skill: 'weakfoot', level: 1, targetLevel: 2, reason: 'goal' },
        { skill: 'passing', level: 1, targetLevel: 2, reason: 'weakest' },
      ],
    },
  },
  progress: patch.progress ?? { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 },
  nextSessionDate: patch.nextSessionDate ?? '2026-09-23',
});

/** A fake `api` that answers like the real wrapper: the response is parsed with the schema the client passed. */
function make(answer: (index: number) => unknown = () => responseJson()) {
  let index = 0;
  const post = async (_path: string, options: { schema: { parse(input: unknown): unknown } }): Promise<unknown> => {
    const current = index++;
    return options.schema.parse(await answer(current));
  };
  const api = { post } as unknown as Api;
  const queryClient = new QueryClient();
  const client = createEventsClient({ api, queryClient });
  const finish = (sessionId = SESSION_ID) => [client.makeEvent('session_finished', { sessionId })];
  return { client, queryClient, finish };
}

describe("submitEvents writes ['session-summary']", () => {
  test('to exactly { progress, nextSessionDate, sessionId } from the validated response', async () => {
    const { client, queryClient, finish } = make();
    await client.submitEvents(finish());
    expect(queryClient.getQueryData(SUMMARY)).toStrictEqual({
      progress: { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 },
      nextSessionDate: '2026-09-23',
      sessionId: SESSION_ID,
    });
  });

  test("sessionId is the server's response.session.id, not the id the event named", async () => {
    const { client, queryClient, finish } = make(() => responseJson({ id: 'server-session' }));
    await client.submitEvents(finish('the-event-said-this'));
    expect((queryClient.getQueryData(SUMMARY) as { sessionId: string }).sessionId).toBe('server-session');
  });

  test("after the ['today'] write, so a reader of the summary always finds the matching session already cached", async () => {
    const { client, queryClient, finish } = make();
    const written: string[] = [];
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success') written.push(String(event.query.queryKey[0]));
    });
    await client.submitEvents(finish());
    expect(written).toEqual(['today', 'session-summary']);
    expect((queryClient.getQueryData(TODAY) as { id: string }).id).toBe(SESSION_ID);
  });

  test('a later response replaces the earlier summary; it is not merged', async () => {
    const { client, queryClient, finish } = make((index) =>
      index === 0
        ? responseJson({ progress: { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 }, nextSessionDate: '2026-09-23' })
        : responseJson({ id: 'next-session', progress: { sessionsCompleted: 5, minutesTrained: 100, streakDays: 3 }, nextSessionDate: '2026-09-25' }),
    );
    await client.submitEvents(finish());
    await client.submitEvents(finish('next-session'));
    expect(queryClient.getQueryData(SUMMARY)).toStrictEqual({
      progress: { sessionsCompleted: 5, minutesTrained: 100, streakDays: 3 },
      nextSessionDate: '2026-09-25',
      sessionId: 'next-session',
    });
  });

  test('the summary holds no session: the drills stay in [today] only', async () => {
    const { client, queryClient, finish } = make();
    await client.submitEvents(finish());
    expect(queryClient.getQueryData(SUMMARY)).not.toHaveProperty('session');
  });
});

describe("submitEvents leaves ['session-summary'] alone when nothing was accepted", () => {
  test('a failed request keeps the previous summary and rethrows the same problem', async () => {
    const problem = new ApiProblem({ kind: 'server', status: 503 });
    const { client, queryClient, finish } = make(() => {
      throw problem;
    });
    const previous = { progress: { sessionsCompleted: 1, minutesTrained: 20, streakDays: 1 }, nextSessionDate: '2026-09-22', sessionId: 'old' };
    queryClient.setQueryData(SUMMARY, previous);
    const outcome = await client.submitEvents(finish()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBe(problem);
    expect(queryClient.getQueryData(SUMMARY)).toBe(previous);
  });

  test('a failed request with nothing cached leaves the key empty', async () => {
    const { client, queryClient, finish } = make(() => {
      throw new ApiProblem({ kind: 'offline' });
    });
    await expect(client.submitEvents(finish())).rejects.toBeInstanceOf(ApiProblem);
    expect(queryClient.getQueryData(SUMMARY)).toBeUndefined();
  });

  test('a response that fails the contract schema is a rejection and writes nothing', async () => {
    const { client, queryClient, finish } = make(() => ({ ...responseJson(), progress: { sessionsCompleted: 'many' } }));
    await expect(client.submitEvents(finish())).rejects.toBeDefined();
    expect(queryClient.getQueryData(SUMMARY)).toBeUndefined();
  });

  test('an empty batch rejects locally and writes nothing', async () => {
    const { client, queryClient } = make();
    await expect(client.submitEvents([])).rejects.toThrow(/at least one event/i);
    expect(queryClient.getQueryData(SUMMARY)).toBeUndefined();
  });
});

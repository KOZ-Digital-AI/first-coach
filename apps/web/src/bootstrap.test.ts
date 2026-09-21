import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { configureEventsClient, makeEvent, submitEvents } from './features/train/events-client';

// fc-bi2: the app's one QueryClient must be handed to the session events client at start-up, otherwise every train
// screen's submitEvents rejects with "call configureEventsClient(...)". main.tsx cannot be imported in a test (it mounts
// into #root and needs the generated route tree), so the wiring lives in the tiny `bootstrap.ts` seam
// (`createAppQueryClient`): the behaviour is tested on the seam, and main.tsx is checked to go through it (the same
// source-scan style entry.test.ts uses for main.tsx).
//
// Reading of the bead: "wire it (or export the QueryClient) + a test that main wiring calls it" -> we wire it (main.tsx
// asks the seam for its QueryClient, the seam creates the client and calls configureEventsClient({ queryClient })).

const mainSource = readFileSync(join(import.meta.dir, 'main.tsx'), 'utf8');

const SESSION_ID = 's-2026-09-21';

const responseJson = {
  session: {
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
      focus: [
        { skill: 'weakfoot', level: 1, targetLevel: 2, reason: 'Your stated goal.' },
        { skill: 'passing', level: 1, targetLevel: 2, reason: 'One of the weakest areas.' },
      ],
    },
  },
  progress: { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 },
  nextSessionDate: '2026-09-23',
};

const realFetch = globalThis.fetch;
let requests: { url: string; method: string | undefined }[] = [];

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify(responseJson), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // ISOLATION: bun runs every test file in one process and events-client.ts keeps its configured QueryClient in a
  // module-level variable, so a client configured here would leak into events-client.test.ts ("until
  // configureEventsClient is called, submitting fails ..."). events-client exports no reset, but its guard is
  // `configuredQueryClient === undefined`, so configuring with `undefined` restores exactly the unconfigured state.
  configureEventsClient({ queryClient: undefined as unknown as QueryClient });
});

describe('createAppQueryClient (start-up wiring seam)', () => {
  test('returns a QueryClient', async () => {
    const { createAppQueryClient } = await import('./bootstrap');
    expect(createAppQueryClient()).toBeInstanceOf(QueryClient);
  });

  test('the session events client submits without a further configure call: it POSTs and does not reject', async () => {
    const { createAppQueryClient } = await import('./bootstrap');
    createAppQueryClient();
    const event = makeEvent('drill_done', { sessionId: SESSION_ID, itemId: 'item-1' });
    await expect(submitEvents([event])).resolves.toBeDefined();
    expect(requests).toEqual([{ url: '/api/player/session-events', method: 'POST' }]);
  });

  test("submitEvents writes the returned session into the returned client's ['today'] cache", async () => {
    const { createAppQueryClient } = await import('./bootstrap');
    const appClient = createAppQueryClient();
    expect(appClient.getQueryData(['today'])).toBeUndefined();

    await submitEvents([makeEvent('drill_done', { sessionId: SESSION_ID, itemId: 'item-1' })]);

    const cached = appClient.getQueryData(['today']) as { id: string } | undefined;
    expect(cached?.id).toBe(SESSION_ID);
  });

  test('a QueryClient the app did not get from the seam is not written to', async () => {
    const { createAppQueryClient } = await import('./bootstrap');
    const stranger = new QueryClient();
    const appClient = createAppQueryClient();

    await submitEvents([makeEvent('drill_done', { sessionId: SESSION_ID, itemId: 'item-1' })]);

    expect(stranger.getQueryData(['today'])).toBeUndefined();
    expect(appClient.getQueryData(['today'])).toBeDefined();
  });

  test('every call makes its own QueryClient and the events client follows the latest one', async () => {
    const { createAppQueryClient } = await import('./bootstrap');
    const first = createAppQueryClient();
    const second = createAppQueryClient();
    expect(second).not.toBe(first);

    await submitEvents([makeEvent('drill_done', { sessionId: SESSION_ID, itemId: 'item-1' })]);

    expect(second.getQueryData(['today'])).toBeDefined();
    expect(first.getQueryData(['today'])).toBeUndefined();
  });
});

describe('isolation', () => {
  test('after the seam tests the default events client is unconfigured again (no leak into other test files)', async () => {
    const { createAppQueryClient } = await import('./bootstrap');
    createAppQueryClient(); // configure it, then let afterEach restore it ...
  });

  test('... so the next submit fails before any request, as events-client.test.ts expects', async () => {
    await expect(submitEvents([makeEvent('drill_done', { sessionId: SESSION_ID, itemId: 'item-1' })])).rejects.toThrow(/configureEventsClient/);
    expect(requests).toEqual([]);
  });
});

describe('main.tsx goes through the seam', () => {
  test("imports createAppQueryClient from './bootstrap'", () => {
    expect(mainSource).toMatch(/import\s*\{\s*createAppQueryClient\s*\}\s*from\s*['"]\.\/bootstrap['"]/);
  });

  test('gets the app QueryClient from createAppQueryClient() and does not construct its own', () => {
    expect(mainSource).toMatch(/const\s+queryClient\s*=\s*createAppQueryClient\(\)/);
    expect(mainSource).not.toMatch(/new\s+QueryClient\s*\(/);
  });

  test('the client that reaches <QueryClientProvider> is that same queryClient', () => {
    expect(mainSource).toMatch(/<QueryClientProvider\s+client=\{queryClient\}/);
  });

  test('the client is created (and so the events client configured) before the first render', () => {
    const created = mainSource.search(/createAppQueryClient\(\)/);
    const rendered = mainSource.search(/\.render\(/);
    expect(created).toBeGreaterThan(-1);
    expect(rendered).toBeGreaterThan(-1);
    expect(created).toBeLessThan(rendered);
  });
});

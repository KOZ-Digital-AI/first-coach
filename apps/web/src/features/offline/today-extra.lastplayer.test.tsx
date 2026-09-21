import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { LAST_PLAYER_KEY } from '../../bootstrap';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { type OfflineSession, writeOfflineSession } from '../../offline/types';
import downloadMessages from './download.messages';

// Same happy-dom guard as download.test.tsx: the bead verifies from apps/web (the preload registers the DOM there), but a run
// from the repo root has none, so register it BEFORE Testing Library is imported.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor } = await import('@testing-library/react');

/*
 * fc-mol-eay.14, written from the bead's acceptance criteria (not from the implementation): offline, with no session answer,
 * the `today` slot component (the DEFAULT export of today-extra.tsx, which reads the player from `authClient.useSession()`)
 * falls back to the last player of this device (`readLastPlayerId()`, bootstrap.ts, fc-mol-eay.12) so the "Available offline"
 * badge shows for that player's downloaded session. A live session id wins; with neither, nothing changes ("unknown").
 *
 * What is real: the slot component, the device store (over the real happy-dom localStorage: the default store), the last-player
 * key (`fc:last-player`, read through the real bootstrap.readLastPlayerId), the outbox count and the i18n bundle. What is
 * replaced: `authClient.useSession` (lib/auth's app-wide Better Auth client): the test decides what the session hook answers.
 */

const TODAY_DATE = '2026-09-21';
const DOWNLOADED_AT = '2026-09-21T12:00:00.000Z';
const LAST = 'last-player-1';
const LIVE = 'live-player-2';

const item = (itemId: string) => ({
  itemId,
  drillVersionId: `${itemId}-v1`,
  minutes: 5,
  done: false,
  content: {
    title: { kk: 'Доп соққысы', ru: 'Касания мяча', en: 'Ball taps' },
    goal: { kk: 'Мақсат', ru: 'Цель', en: 'Goal' },
    instructions: { kk: 'Орында.', ru: 'Выполни.', en: 'Do it.' },
    dose: { reps: 20 },
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
});

const todaySession = (id = 'session-1') => ({
  id,
  date: TODAY_DATE,
  planner: 'rules',
  totalMinutes: 10,
  graphVersion: '0.1.0',
  items: [item('item-1'), item('item-2')],
  roadmapSummary: {
    currentLevelLabel: 'Basic',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'dribbling', level: 2, targetLevel: 3, reason: 'goal' },
      { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
    ],
  },
});

// --- the session hook the slot component reads ----------------------------------------------------------------------------

interface SessionAnswer {
  data: { user: { id: string } } | null;
  isPending: boolean;
}
let answer: SessionAnswer = { data: null, isPending: false };

const realAuth = await import('../../lib/auth');
let TodayExtra: ComponentType;

beforeAll(async () => {
  mock.module('../../lib/auth', () => ({ ...realAuth, authClient: { useSession: () => answer } }));
  ({ default: TodayExtra } = await import('./today-extra'));
});

// bun's module mocks outlive this file: put the real module back for the files that run after it.
afterAll(() => {
  mock.module('../../lib/auth', () => ({ ...realAuth }));
});

// --- rig ------------------------------------------------------------------------------------------------------------------

let onLine = true;

beforeEach(() => {
  onLine = true;
  answer = { data: null, isPending: false };
  localStorage.clear();
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (navigator as { onLine?: boolean }).onLine;
});

const rememberLastPlayer = (id: string) => localStorage.setItem(LAST_PLAYER_KEY, id);
const downloadedFor = (playerId: string, downloadedAt = DOWNLOADED_AT) =>
  writeOfflineSession(localStorage, playerId, { playerId, session: todaySession(), downloadedAt, locale: 'en' } as OfflineSession);

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['today'], todaySession());
  const i18n = createI18n({
    modules: { './download.messages.ts': { default: downloadMessages }, '../../lib/problem.messages.ts': { default: problemMessages } },
    languages: ['en'],
    storage: { getItem: () => null, setItem: () => {} },
    root: { lang: '' },
    dev: false,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <TodayExtra />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const AVAILABLE = 'Available offline';
const UNKNOWN = /Connect to the internet once/;
const DOWNLOAD = "Download today's session";
const badge = () => screen.queryByText(AVAILABLE);

// --- tests ----------------------------------------------------------------------------------------------------------------

describe('offline, no session answer: the last player of this device is the player', () => {
  test('shows the "Available offline" badge and the last-synced time for the last player\'s downloaded session', async () => {
    onLine = false;
    rememberLastPlayer(LAST);
    downloadedFor(LAST);
    mount();
    await waitFor(() => expect(badge()).not.toBeNull());
    expect(screen.getByText(/Last synced/)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });

  test('the remembered player is identified: with nothing downloaded for them it says how to prepare, not "unknown", and offers no live download', async () => {
    onLine = false;
    rememberLastPlayer(LAST);
    mount();
    await waitFor(() => expect(screen.getByText(/You are offline. Next time, open FIRST COACH with internet/)).toBeTruthy());
    expect(badge()).toBeNull();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
    expect((screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a session downloaded for ANOTHER player is not shown as the last player\'s', async () => {
    onLine = false;
    rememberLastPlayer(LAST);
    downloadedFor('someone-else');
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: DOWNLOAD })).toBeTruthy());
    expect(badge()).toBeNull();
  });

  test('a session read that is still pending falls back too (the answer may never come offline)', async () => {
    onLine = false;
    answer = { data: null, isPending: true };
    rememberLastPlayer(LAST);
    downloadedFor(LAST);
    mount();
    await waitFor(() => expect(badge()).not.toBeNull());
    expect(screen.queryByText(/Checking this device/)).toBeNull();
  });
});

describe('a live session id wins over the remembered one', () => {
  test('the badge is the LIVE player\'s: shown when only the live player has a download, even though another id is remembered', async () => {
    rememberLastPlayer(LAST);
    downloadedFor(LIVE, '2026-09-21T15:30:00.000Z');
    answer = { data: { user: { id: LIVE } }, isPending: false };
    mount();
    await waitFor(() => expect(badge()).not.toBeNull());
  });

  test('the remembered player\'s download is NOT shown for the live player', async () => {
    rememberLastPlayer(LAST);
    downloadedFor(LAST);
    answer = { data: { user: { id: LIVE } }, isPending: false };
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: DOWNLOAD })).toBeTruthy());
    expect(badge()).toBeNull();
    expect((screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a live session with the same id as the remembered one shows that player\'s badge', async () => {
    rememberLastPlayer(LIVE);
    downloadedFor(LIVE);
    answer = { data: { user: { id: LIVE } }, isPending: false };
    mount();
    await waitFor(() => expect(badge()).not.toBeNull());
  });
});

describe('no session id and no remembered id: the behaviour is unchanged', () => {
  test('nothing remembered, session settled without a user: "unknown", no badge, no download button, even with a session on the device', async () => {
    onLine = false;
    downloadedFor(LAST);
    mount();
    await waitFor(() => expect(screen.getByText(UNKNOWN)).toBeTruthy());
    expect(badge()).toBeNull();
    expect(screen.queryByRole('button', { name: DOWNLOAD })).toBeNull();
  });

  test('nothing remembered, session still loading: "Checking this device…"', async () => {
    answer = { data: null, isPending: true };
    mount();
    await waitFor(() => expect(screen.getByText(/Checking this device/)).toBeTruthy());
    expect(screen.queryByText(UNKNOWN)).toBeNull();
    expect(badge()).toBeNull();
  });

  test('an unusable remembered value (it could not name a storage namespace) is no id', async () => {
    onLine = false;
    localStorage.setItem(LAST_PLAYER_KEY, 'a:b');
    mount();
    await waitFor(() => expect(screen.getByText(UNKNOWN)).toBeTruthy());
    expect(badge()).toBeNull();
  });
});

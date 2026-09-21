import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Locale } from '@api-types/primitives';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { createI18n } from '../../lib/i18n';
import { collectSlot } from '../../lib/slots';
import problemMessages from '../../lib/problem.messages';
import { createSessionStore } from '../../offline/session-store';
import { type KeyValueStore, type OfflineSession, writeOfflineSession } from '../../offline/types';
import downloadMessages from './download.messages';
import * as todayExtraModule from './today-extra';
import TodayExtra, { OfflineDownload } from './today-extra';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the repo
// root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as
// features/offline/banner.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Written from the bead's acceptance criteria (fc-mol-eay.6), not from the implementation:
 *  - the `today` slot component shows "Download today's session" with progress, then an "Available offline" badge with the
 *    last-synced time, and a pending-sync count ("Saved on this device — will sync") when the outbox is not empty;
 *  - a failure shows a retry; offline with nothing downloaded it explains how to prepare next time;
 *  - loading, empty, error, disabled and success states; the mutation button is disabled while a request is in flight;
 *  - strings in kk, ru and en; state is never colour alone; polite status region.
 * The REAL session store runs (over a Map-backed device storage and the real typed client with a fake `fetch`), so the
 * download, the read-back and the schema parsing are the real thing. Only the network, the storage and the outbox count
 * are faked. Fixtures are test data only.
 */

const PLAYER = 'player-1';
const TODAY_DATE = '2026-09-21';
const DOWNLOADED_AT = '2026-09-21T12:00:00.000Z';

// --- fixtures ----------------------------------------------------------------------------------------------------------

const attribution = {
  author: 'FIRST COACH Genesis',
  source: 'FIRST COACH Genesis',
  license: 'CC-BY-SA-4.0',
  createdAt: '2026-09-01T10:00:00Z',
  semver: '1.0.0',
};

const item = (itemId: string, done = false) => ({
  itemId,
  drillVersionId: `${itemId}-v1`,
  minutes: 5,
  done,
  content: {
    title: { kk: 'Доп соққысы', ru: 'Касания мяча', en: 'Ball taps' },
    goal: { kk: 'Мақсат', ru: 'Цель', en: 'Goal' },
    instructions: { kk: 'Орында.', ru: 'Выполни.', en: 'Do it.' },
    dose: { reps: 20 },
    conditions: { equipment: 'ball', spaces: ['yard'] },
  },
  status: 'COMMUNITY',
  attribution,
});

const todaySession = (patch: Record<string, unknown> = {}) => ({
  id: 'session-1',
  date: TODAY_DATE,
  planner: 'rules',
  totalMinutes: 15,
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
  ...patch,
});

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const serverError = () => json({ type: 'about:blank', title: 'Problem', status: 500, errors: [] }, 500, 'application/problem+json');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// --- rig -----------------------------------------------------------------------------------------------------------------

let onLine = true;

beforeEach(() => {
  onLine = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
});

afterEach(() => {
  cleanup();
  delete (navigator as { onLine?: boolean }).onLine;
});

const goOffline = () =>
  act(() => {
    onLine = false;
    window.dispatchEvent(new Event('offline'));
  });
const goOnline = () =>
  act(() => {
    onLine = true;
    window.dispatchEvent(new Event('online'));
  });

function memoryDevice() {
  const data = new Map<string, string>();
  const device: KeyValueStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
  return device;
}

const noStorage = { getItem: () => null, setItem: () => {} };
const MODULES = {
  './download.messages.ts': { default: downloadMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

type Setup = {
  locale?: Locale;
  /** The ['today'] cache. `null` = nothing cached. Default: today's session. */
  cached?: unknown;
  /** A session already downloaded to the device before the screen mounts. */
  stored?: unknown;
  /** How the fake server answers GET /api/player/today. */
  today?: () => Response | Promise<Response>;
  playerId?: string | undefined;
  playerPending?: boolean;
  pendingCount?: (playerId: string) => Promise<number>;
  /** Makes the store's download reject with this instead of calling the server. */
  failWith?: Error;
};

function mount(setup: Setup = {}) {
  const locale = setup.locale ?? 'en';
  const device = memoryDevice();
  const calls: string[] = [];
  if (setup.stored !== undefined) {
    writeOfflineSession(device, PLAYER, { playerId: PLAYER, session: setup.stored, downloadedAt: DOWNLOADED_AT, locale } as OfflineSession);
  }
  const api = createApi({
    fetch: async (input: string) => {
      calls.push(input);
      return (setup.today ?? (() => json(todaySession())))();
    },
    language: () => locale,
    online: () => true,
  });
  const real = createSessionStore({ store: device, api, now: () => new Date(DOWNLOADED_AT) });
  const failWith = setup.failWith;
  const store = failWith === undefined ? real : { ...real, downloadToday: () => Promise.reject(failWith) };
  const pendingCount = mock(setup.pendingCount ?? (async () => 0));

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (setup.cached !== null) queryClient.setQueryData(['today'], setup.cached ?? todaySession());
  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });

  const props: ComponentProps<typeof OfflineDownload> = {
    playerId: 'playerId' in setup ? setup.playerId : PLAYER,
    playerPending: setup.playerPending ?? false,
    store,
    pendingCount,
    refreshMs: 0,
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <OfflineDownload {...props} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), view, device, store, calls, pendingCount, queryClient };
}

const DOWNLOAD = "Download today's session";
const downloadButton = () => screen.queryByRole('button', { name: DOWNLOAD });

// --- tests ---------------------------------------------------------------------------------------------------------------

describe('idle: nothing downloaded yet', () => {
  test('offers the download button, enabled, and claims nothing is available offline', () => {
    mount();
    const button = screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByText('Available offline')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Train without internet' })).toBeTruthy();
  });

  test('renders nothing when there is no session in the [today] cache', () => {
    mount({ cached: null });
    expect(downloadButton()).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  test('does not send any request just by being shown', async () => {
    const { calls, pendingCount } = mount();
    await waitFor(() => expect(pendingCount).toHaveBeenCalled());
    expect(calls).toEqual([]);
  });
});

describe('downloading', () => {
  test('tapping downloads through the store with the UI locale: one GET /api/player/today', async () => {
    const { user, calls } = mount({ locale: 'ru' });
    await user.click(screen.getByRole('button', { name: /.+/ }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toBe('/api/player/today?locale=ru');
  });

  test('while in flight the button is disabled and busy, progress is announced in words, and a second tap sends nothing', async () => {
    const pending = deferred<Response>();
    const { user, calls } = mount({ today: () => pending.promise });
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));

    const button = screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(within(screen.getByRole('status')).getByText("Downloading today's session…")).toBeTruthy();
    expect(screen.queryByText('Available offline')).toBeNull();

    await user.click(button);
    expect(calls.length).toBe(1);

    await act(async () => pending.resolve(json(todaySession())));
  });

  test('idle -> downloading -> available: the badge appears, the button goes, the session is on the device', async () => {
    const pending = deferred<Response>();
    const { user, store } = mount({ today: () => pending.promise });
    expect(store.getOffline(PLAYER, TODAY_DATE)).toBeUndefined();
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));
    await act(async () => pending.resolve(json(todaySession())));

    expect(await screen.findByText('Available offline')).toBeTruthy();
    expect(downloadButton()).toBeNull();
    expect(screen.queryByText("Downloading today's session…")).toBeNull();
    expect(store.getOffline(PLAYER, TODAY_DATE)?.session.id).toBe('session-1');
  });

  test('the available state is announced through the polite status region and carries an icon beside the words', async () => {
    const { user } = mount();
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));
    const badge = await screen.findByText('Available offline');
    const status = screen.getByRole('status');
    expect(status.contains(badge)).toBe(true);
    expect(status.getAttribute('aria-live')).toBe('polite');
    // Never colour alone: an aria-hidden icon sits next to the written state.
    const holder = badge.closest('[data-state="available"]') ?? badge.parentElement;
    expect(holder?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  test('a session that was downloaded before is shown as available at once, with no request', () => {
    const { calls } = mount({ stored: todaySession() });
    expect(screen.getByText('Available offline')).toBeTruthy();
    expect(downloadButton()).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a download stored for another day does not count as available for today', () => {
    mount({ stored: todaySession({ id: 'session-old', date: '2026-09-20' }) });
    expect(screen.queryByText('Available offline')).toBeNull();
    expect(screen.getByRole('button', { name: DOWNLOAD })).toBeTruthy();
  });
});

describe('last synced', () => {
  test('shows when the session was downloaded, in the UI locale format', () => {
    mount({ stored: todaySession() });
    const expected = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(DOWNLOADED_AT));
    const text = (screen.getByRole('status').textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain(`Last synced: ${expected.replace(/\s+/g, ' ')}`);
  });

  test('is the store timestamp, not the clock at render time', async () => {
    const { user } = mount();
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));
    await screen.findByText('Available offline');
    expect(screen.getByRole('status').textContent).toContain('2026');
  });
});

describe('error and retry', () => {
  test('a failed download shows an alert with a retry, and no available badge', async () => {
    const { user } = mount({ today: () => serverError() });
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Could not download today's session")).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Available offline')).toBeNull();
  });

  test('retry downloads again; the retry button is disabled while the retry is in flight; success clears the error', async () => {
    let attempt = 0;
    const second = deferred<Response>();
    const { user, calls } = mount({ today: () => (++attempt === 1 ? serverError() : second.promise) });
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));
    const retry = await within(await screen.findByRole('alert')).findByRole('button', { name: 'Try again' });

    await user.click(retry);
    await waitFor(() => expect(calls.length).toBe(2));
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(calls.length).toBe(2);

    await act(async () => second.resolve(json(todaySession())));
    expect(await screen.findByText('Available offline')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a download that throws (for instance a device with no storage) fails visibly instead of pretending to work', async () => {
    const { user } = mount({ failWith: new Error('session-store: this device has no storage for offline sessions') });
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Available offline')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('offline', () => {
  test('offline with nothing downloaded: explains how to prepare next time and disables the download', async () => {
    onLine = false;
    const { user, calls } = mount();
    const hint = await screen.findByText(/next time/i);
    expect(hint.textContent).toContain(DOWNLOAD);
    const button = screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The disabled button is explained, not just dimmed.
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    await user.click(button);
    expect(calls).toEqual([]);
  });

  test('going offline after mount shows the same explanation; coming back online re-enables the download', async () => {
    mount();
    expect((screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement).disabled).toBe(false);
    await goOffline();
    expect(screen.getByText(/next time/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement).disabled).toBe(true);
    await goOnline();
    expect(screen.queryByText(/next time/i)).toBeNull();
    expect((screen.getByRole('button', { name: DOWNLOAD }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('offline with a session already downloaded: available, and no "prepare next time" explanation', async () => {
    onLine = false;
    mount({ stored: todaySession() });
    expect(await screen.findByText('Available offline')).toBeTruthy();
    expect(screen.queryByText(/next time/i)).toBeNull();
  });
});

describe('pending sync count', () => {
  test('shows "Saved on this device — will sync" with the count when the outbox is not empty', async () => {
    mount({ stored: todaySession(), pendingCount: async () => 3 });
    const line = await screen.findByText(/Saved on this device — will sync/);
    expect(line.textContent).toContain('3');
    expect(within(screen.getByRole('status')).getByText(/Saved on this device — will sync/)).toBeTruthy();
    expect(line.parentElement?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  test('shows nothing about syncing when the outbox is empty', async () => {
    const { pendingCount } = mount({ stored: todaySession(), pendingCount: async () => 0 });
    await waitFor(() => expect(pendingCount).toHaveBeenCalled());
    expect(screen.queryByText(/will sync/)).toBeNull();
  });

  test('asks about the player whose device it is', async () => {
    const { pendingCount } = mount({ pendingCount: async () => 1 });
    await waitFor(() => expect(pendingCount).toHaveBeenCalledWith(PLAYER));
  });

  test('is shown even when today has not been downloaded (results can wait from an earlier session)', async () => {
    mount({ pendingCount: async () => 2 });
    expect(await screen.findByText(/Saved on this device — will sync/)).toBeTruthy();
    expect(screen.getByRole('button', { name: DOWNLOAD })).toBeTruthy();
  });

  test('is read again when the connection changes, so the count follows the outbox', async () => {
    let waiting = 2;
    mount({ stored: todaySession(), pendingCount: async () => waiting });
    expect((await screen.findByText(/will sync/)).textContent).toContain('2');
    waiting = 0;
    await goOnline();
    await waitFor(() => expect(screen.queryByText(/will sync/)).toBeNull());
  });

  test('a count that cannot be read is not shown, and nothing crashes', async () => {
    const { pendingCount } = mount({ stored: todaySession(), pendingCount: async () => Promise.reject(new Error('outbox: call configureOutbox({ playerId }) before using the outbox')) });
    await waitFor(() => expect(pendingCount).toHaveBeenCalled());
    expect(screen.queryByText(/will sync/)).toBeNull();
    expect(screen.getByText('Available offline')).toBeTruthy();
  });
});

describe('who is training', () => {
  test('while the player is still being identified: a status line, no download button', () => {
    mount({ playerId: undefined, playerPending: true });
    expect(within(screen.getByRole('status')).getByText('Checking this device…')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('with no player and no way to identify one: says so, offers no download that cannot be stored', () => {
    mount({ playerId: undefined, playerPending: false });
    expect(screen.queryByRole('button')).toBeNull();
    expect(within(screen.getByRole('status')).getByText(/check what is saved on this device/i)).toBeTruthy();
  });
});

describe('languages', () => {
  const flatten = (tree: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : flatten(value as Record<string, unknown>, `${prefix}${key}.`),
    );

  test('kk, ru and en define the same keys, and no value is empty', () => {
    const en = flatten(downloadMessages.en).sort();
    expect(en.length).toBeGreaterThan(8);
    expect(flatten(downloadMessages.ru).sort()).toEqual(en);
    expect(flatten(downloadMessages.kk).sort()).toEqual(en);
    const values = (tree: Record<string, unknown>): string[] =>
      Object.values(tree).flatMap((v) => (typeof v === 'string' ? [v] : values(v as Record<string, unknown>)));
    for (const locale of ['kk', 'ru', 'en'] as const) for (const value of values(downloadMessages[locale])) expect(value.trim()).not.toBe('');
  });

  test.each(['kk', 'ru'] as const)('%s renders the screen in that language (Cyrillic, not English, no raw keys)', async (locale) => {
    const { user } = mount({ locale, pendingCount: async () => 2 });
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.textContent).toMatch(/[Ѐ-ӿ]/);
    expect(button.textContent).not.toBe(DOWNLOAD);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/[Ѐ-ӿ]/);
    await user.click(button);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/[Ѐ-ӿ]/));
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toMatch(/Available offline|Last synced/));
    expect(document.body.textContent).not.toMatch(/\b(?:title|lead|download|available|pending)\.[a-z]+/i);
  });

  test('the Kazakh and Russian pending line carries the count', async () => {
    for (const locale of ['kk', 'ru'] as const) {
      cleanup();
      mount({ locale, stored: todaySession(), pendingCount: async () => 4 });
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('4'));
    }
  });
});

describe('the slot module', () => {
  test('default-exports a component that the today slot collects; it is not a route or a named-export contract', () => {
    expect(typeof TodayExtra).toBe('function');
    const collected = collectSlot({ today: { '../features/offline/today-extra.tsx': todayExtraModule } }, 'today');
    expect(collected).toEqual([TodayExtra]);
  });
});

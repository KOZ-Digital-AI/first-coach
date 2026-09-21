import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Locale } from '@api-types/primitives';
import { I18nextProvider } from 'react-i18next';
import type { ReactElement } from 'react';
import { createI18n } from '../../lib/i18n';
import { Route, SummaryDepsContext } from '../../routes/train/summary';
import summaryMessages from './summary.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web, but the bead's verify command
// may run from the repo root, where there is no DOM. Register happy-dom here BEFORE Testing Library is imported (same order
// rule as test/setup.ts and today.test.tsx); the `document` guard keeps it a no-op under the preload.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Written from the bead's acceptance criteria (fc-mol-urn.10) and the coordinator's decision, not from the implementation:
 *  - /train/summary shows "Session complete", the drills completed, the minutes trained so far, the current streak and the next
 *    session date, with links to My Journey (/progress) and back home (/), in a calm tone;
 *  - the values come from the query cache: ['session-summary'] = { progress, nextSessionDate, sessionId } written by the events
 *    client, and the session in ['today']. The screen makes NO request of its own;
 *  - "finished" = ['session-summary'] exists AND its sessionId equals the ['today'] session's id (and every drill of that session
 *    is done). Otherwise the player is sent to /train (history replace) and meanwhile sees a friendly empty state linking there;
 *  - states: loading (the cache is still being restored), empty (nothing finished), error (the cached summary is unreadable),
 *    success. The screen has no mutation, so there is no button to disable (the criterion is vacuously met).
 * The cache is the real React Query client; navigation goes through the route's small context seam, as on /train.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const SESSION_ID = 'session-1';

const progress = { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 };
const summary = (patch: Record<string, unknown> = {}) => ({ progress, nextSessionDate: '2026-09-23', sessionId: SESSION_ID, ...patch });

const drill = (n: number, done = true) => ({ itemId: `item-${n}`, drillVersionId: `item-${n}-v1`, minutes: 5, done });
const todaySession = (patch: Record<string, unknown> = {}) => ({ id: SESSION_ID, date: '2026-09-21', items: [drill(1), drill(2), drill(3)], ...patch });

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

type Setup = {
  locale?: Locale;
  /** Default: the finished session. `null` leaves ['today'] empty. */
  today?: unknown;
  /** Default: the matching summary. `null` leaves ['session-summary'] empty. */
  summary?: unknown;
  restoring?: boolean;
};

function mountSummary(setup: Setup = {}) {
  const locale = setup.locale ?? 'en';
  const navigations: Array<{ to: string; options?: { replace?: boolean } }> = [];
  const navigate = (to: string, options?: { replace?: boolean }) => void navigations.push({ to, options });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const today = setup.today === undefined ? todaySession() : setup.today;
  const cached = setup.summary === undefined ? summary() : setup.summary;
  if (today !== null) queryClient.setQueryData(['today'], today);
  if (cached !== null) queryClient.setQueryData(['session-summary'], cached);

  const i18n = createI18n({ modules: { './summary.messages.ts': { default: summaryMessages } }, languages: [locale], storage: memoryStorage(), root: { lang: '' }, dev: false });
  const Page = Route.options.component;
  if (Page === undefined) throw new Error('the /train/summary route has no component');
  const tree = (restoring: boolean): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <IsRestoringProvider value={restoring}>
        <I18nextProvider i18n={i18n}>
          <SummaryDepsContext.Provider value={{ navigate }}>
            <Page />
          </SummaryDepsContext.Provider>
        </I18nextProvider>
      </IsRestoringProvider>
    </QueryClientProvider>
  );
  const view = render(tree(setup.restoring ?? false));
  return { navigations, queryClient, user: userEvent.setup(), setRestoring: (restoring: boolean) => view.rerender(tree(restoring)) };
}

afterEach(() => {
  cleanup();
});

const words = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** The value (dd) that belongs to a stat label (dt). */
const valueOf = (label: string) => words(screen.getByText(label, { selector: 'dt' }).nextElementSibling);

// --- success --------------------------------------------------------------------------------------------------------

describe('a finished session', () => {
  test('says "Session complete" in a level-1 heading and shows the drills completed, out of the session total', () => {
    mountSummary();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Session complete');
    expect(valueOf('Drills completed')).toBe('3 of 3');
  });

  test('shows the minutes, sessions, streak and next session date from the cached summary', () => {
    mountSummary();
    expect(valueOf('Minutes trained so far')).toBe('80');
    expect(valueOf('Sessions finished')).toBe('4');
    expect(valueOf('Current streak (days in a row)')).toBe('2');
    const next = valueOf('Next session');
    expect(next).toContain('23');
    expect(next).toContain('September');
  });

  test('renders whatever is in the cache, not fixed values', () => {
    mountSummary({
      summary: summary({ progress: { sessionsCompleted: 12, minutesTrained: 345, streakDays: 7 }, nextSessionDate: '2026-10-05' }),
      today: todaySession({ items: [drill(1), drill(2)] }),
    });
    expect(valueOf('Minutes trained so far')).toBe('345');
    expect(valueOf('Sessions finished')).toBe('12');
    expect(valueOf('Current streak (days in a row)')).toBe('7');
    expect(valueOf('Drills completed')).toBe('2 of 2');
    const next = valueOf('Next session');
    expect(next).toContain('5');
    expect(next).toContain('October');
  });

  test('the next session date is the calendar day as sent, whatever the device time zone', () => {
    mountSummary({ summary: summary({ nextSessionDate: '2026-01-01' }) });
    const next = valueOf('Next session');
    expect(next).toContain('January');
    expect(next).toContain('1');
    expect(next).toContain('Thursday');
  });

  test('the minutes are worded as a cumulative figure, never as "today"', () => {
    mountSummary();
    expect(screen.queryByText(/today/i)).toBeNull();
    expect(screen.getByText('Minutes trained so far')).toBeTruthy();
  });

  test('a large number is grouped for the language (thousands)', () => {
    mountSummary({ summary: summary({ progress: { sessionsCompleted: 1, minutesTrained: 12345, streakDays: 1 } }) });
    expect(valueOf('Minutes trained so far').replace(/[\s  ,]/g, '')).toBe('12345');
    expect(valueOf('Minutes trained so far')).not.toBe('12345');
  });

  test('links to My Journey and back home, each a real link', () => {
    mountSummary();
    expect(screen.getByRole('link', { name: 'My Journey' }).getAttribute('href')).toBe('/progress');
    expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/');
  });

  test('a plain click on a link goes through the router seam; the summary stays a finished session, no redirect', async () => {
    const page = mountSummary();
    await page.user.click(screen.getByRole('link', { name: 'My Journey' }));
    await page.user.click(screen.getByRole('link', { name: 'Back home' }));
    expect(page.navigations.map((call) => call.to)).toEqual(['/progress', '/']);
  });

  test('makes no request of its own: the cache is read, nothing is fetched', () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      mountSummary();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('does not redirect', () => {
    const page = mountSummary();
    expect(page.navigations).toEqual([]);
  });

  test('the tone is calm: no ranking, no career promise, no confetti or flame, nothing that compares with others', () => {
    mountSummary();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/professional|\bpro\b|champion|leaderboard|\brank|best|winner|top \d|confetti|🔥|🎉|🏆/i);
    expect(document.body.querySelector('canvas, [data-confetti]')).toBeNull();
  });

  test('speaks Russian and Kazakh from the messages file, numbers formatted for the language', () => {
    for (const locale of ['ru', 'kk'] as const) {
      mountSummary({ locale });
      const messages = summaryMessages[locale];
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(messages.title);
      expect(screen.getByRole('link', { name: messages.links.journey }).getAttribute('href')).toBe('/progress');
      expect(screen.getByRole('link', { name: messages.links.home }).getAttribute('href')).toBe('/');
      expect(valueOf(messages.stats.minutes).replace(/\s/g, '')).toBe('80');
      cleanup();
    }
    mountSummary({ locale: 'ru' });
    expect(valueOf(summaryMessages.ru.stats.next)).toContain('сентября');
    cleanup();
    mountSummary({ locale: 'kk' });
    expect(valueOf(summaryMessages.kk.stats.next)).toContain('қыркүйек');
  });
});

// --- not finished ---------------------------------------------------------------------------------------------------

describe('a session that is not finished redirects to /train', () => {
  const expectSentToTrain = (page: ReturnType<typeof mountSummary>) => {
    expect(page.navigations).toHaveLength(1);
    expect(page.navigations[0]).toEqual({ to: '/train', options: { replace: true } });
    expect(screen.queryByRole('heading', { level: 1, name: 'Session complete' })).toBeNull();
    expect(screen.queryByText('Minutes trained so far')).toBeNull();
  };

  test('when there is no cached summary, once, with history replace, and a friendly empty state that links to /train', async () => {
    const page = mountSummary({ summary: null });
    await waitFor(() => expect(page.navigations).toHaveLength(1));
    expectSentToTrain(page);
    expect(screen.getByText(summaryMessages.en.empty.title)).toBeTruthy();
    expect(screen.getByText(summaryMessages.en.empty.hint)).toBeTruthy();
    expect(screen.getByRole('link', { name: summaryMessages.en.empty.action }).getAttribute('href')).toBe('/train');
  });

  test("when the summary belongs to another session than today's", async () => {
    const page = mountSummary({ summary: summary({ sessionId: 'yesterdays-session' }) });
    await waitFor(() => expect(page.navigations).toHaveLength(1));
    expectSentToTrain(page);
  });

  test("when there is a summary but today's session is not cached", async () => {
    const page = mountSummary({ today: null });
    await waitFor(() => expect(page.navigations).toHaveLength(1));
    expectSentToTrain(page);
  });

  test('when a drill of the session is still to do', async () => {
    const page = mountSummary({ today: todaySession({ items: [drill(1), drill(2, false), drill(3)] }) });
    await waitFor(() => expect(page.navigations).toHaveLength(1));
    expectSentToTrain(page);
  });

  test('the empty state link is a plain click through the router seam', async () => {
    const page = mountSummary({ summary: null });
    await waitFor(() => expect(page.navigations).toHaveLength(1));
    await page.user.click(screen.getByRole('link', { name: summaryMessages.en.empty.action }));
    expect(page.navigations.map((call) => call.to)).toEqual(['/train', '/train']);
  });

  test('the empty state is worded in every language and never scolds', () => {
    for (const locale of ['kk', 'ru', 'en'] as const) {
      const empty = summaryMessages[locale].empty;
      expect(empty.title.length).toBeGreaterThan(0);
      expect(empty.hint.length).toBeGreaterThan(0);
      expect(empty.action.length).toBeGreaterThan(0);
    }
    expect(summaryMessages.en.empty.hint).not.toMatch(/you (must|forgot|failed|should have)|didn't|did not/i);
  });
});

// --- loading and error ----------------------------------------------------------------------------------------------

describe('loading', () => {
  test('while the cache is still being restored it says so, busy, and does not redirect', () => {
    const page = mountSummary({ summary: null, today: null, restoring: true });
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(within(status).getByText(summaryMessages.en.loading)).toBeTruthy();
    expect(page.navigations).toEqual([]);
    expect(screen.queryByText(summaryMessages.en.empty.title)).toBeNull();
  });

  test('once the restore is done it shows the summary, without a redirect, when the cache holds a finished session', () => {
    const page = mountSummary({ restoring: true });
    expect(screen.queryByText('Minutes trained so far')).toBeNull();
    page.setRestoring(false);
    expect(valueOf('Minutes trained so far')).toBe('80');
    expect(page.navigations).toEqual([]);
  });

  test('once the restore is done with nothing finished it redirects to /train', async () => {
    const page = mountSummary({ summary: null, restoring: true });
    page.setRestoring(false);
    await waitFor(() => expect(page.navigations).toEqual([{ to: '/train', options: { replace: true } }]));
  });
});

describe('an unreadable cached summary', () => {
  test('shows a calm alert with a way back to /train instead of blank or NaN values, and does not redirect by itself', async () => {
    const page = mountSummary({ summary: { sessionId: SESSION_ID, nextSessionDate: '2026-09-23', progress: { minutesTrained: 'lots' } } });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(summaryMessages.en.error.title)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|undefined|null/);
    expect(page.navigations).toEqual([]);
    await page.user.click(within(alert).getByRole('button', { name: summaryMessages.en.error.action }));
    expect(page.navigations).toEqual([{ to: '/train' }]);
  });

  test('a date that is not a calendar day is unreadable too', () => {
    mountSummary({ summary: summary({ nextSessionDate: 'soon' }) });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Minutes trained so far')).toBeNull();
  });
});

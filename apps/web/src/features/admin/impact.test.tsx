import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ImpactMetrics } from '@api-types/admin';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/admin/impact';
import messages from './impact.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as settings.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Contract under test (fc-mol-0v3.12): /admin/impact answers "Are people getting better?" from GET /api/admin/impact
 * (ImpactMetrics, apps/api/src/shared/admin.ts). The headline is the median improvement, then cards for players with a
 * baseline, players who retested, sessions completed, training hours, active contributors, verified coaches and open
 * methodologies, and a weekly bar series built with CSS (no chart library, so no canvas or svg in the series). Zero data
 * shows an honest empty state. The screen has loading, empty, error, disabled and success states, its refresh control is
 * disabled while a request is in flight, and every string exists in kk, ru and en.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network
 * (globalThis.fetch). Kazakh and Russian copy still needs a native-speaker review: for those locales these tests pin only
 * that text exists, is Cyrillic and never leaks 'undefined', 'NaN', a raw key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - "headline = players who improved / median improvement": ImpactMetrics has no "players who improved" count (aggregates
 *   only), so the headline is the MEDIAN IMPROVEMENT, with the number of players who retested beside it as its basis.
 * - No retest yet (playersRetested is 0) means there is nothing to compare: the headline shows a dash and says so, never "0%".
 * - The sign is written out (+ or a minus), so a decline is never told by colour alone, and a sentence says which way it went.
 * - "Zero data" = every number is 0 and no week has a session: an empty state replaces the cards.
 * - A refresh control is the screen's only action ("mutation buttons"); it is disabled and aria-busy while any request runs.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const weeks = (sessions: readonly number[]) =>
  sessions.map((sessionsCompleted, index) => ({
    weekStart: new Date(Date.UTC(2026, 5, 29) + index * 7 * 86_400_000).toISOString().slice(0, 10),
    sessionsCompleted,
  }));

/** Twelve weeks; the busiest has 20 sessions, so a week with 10 is half as long and one with 0 has no bar. */
const WEEK_SESSIONS = [0, 2, 4, 8, 10, 6, 12, 20, 16, 14, 18, 10] as const;

const IMPACT = ImpactMetrics.parse({
  playersWithBaseline: 1240,
  playersRetested: 318,
  medianImprovementPct: 12.46,
  sessionsCompleted: 5321,
  trainingHours: 1234.56,
  activeContributors: 27,
  verifiedCoaches: 9,
  openMethodologies: 154,
  byWeek: weeks(WEEK_SESSIONS),
});

const ZEROS = ImpactMetrics.parse({
  playersWithBaseline: 0,
  playersRetested: 0,
  medianImprovementPct: 0,
  sessionsCompleted: 0,
  trainingHours: 0,
  activeContributors: 0,
  verifiedCoaches: 0,
  openMethodologies: 0,
  byWeek: weeks(new Array<number>(12).fill(0)),
});

const impact = (patch: Partial<ImpactMetrics> = {}): ImpactMetrics => ({ ...IMPACT, ...patch });

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const problem = (status: number, title: string) =>
  json({ type: 'about:blank', title, status, detail: `${title} (server text)`, errors: [] }, { status }, 'application/problem+json');

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: Array<{ url: URL; init: RequestInit | undefined }> = [];

/** Every request the screen makes lands in `calls` and is answered by `handler`. */
function stubNetwork(handler: Handler): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

const IMPACT_PATH = '/api/admin/impact';
const impactCalls = () => calls.filter((call) => call.url.pathname === IMPACT_PATH);

/** Answers each GET /api/admin/impact with the next response in the list (the last one repeats). */
function serve(...responses: Array<() => Response | Promise<Response>>): void {
  let index = 0;
  stubNetwork((url) => {
    if (url.pathname !== IMPACT_PATH) return problem(404, 'Not Found');
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  });
}
const serveImpact = (body: unknown = IMPACT) => serve(() => json(body));

/** A response the test releases by hand, to hold a request in flight. */
function deferred() {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release };
}

beforeEach(() => serveImpact());
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './impact.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };
const ImpactPage = Route.options.component as () => ReactNode;

function renderImpact(locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <ImpactPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, instance, queryClient };
}

const HEADLINE = 'Median improvement';
const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const en = (value: number) => new Intl.NumberFormat('en-US').format(value);

/** Renders and waits for the headline, so every later assertion sees the loaded screen. */
async function renderLoaded(locale: Locale = 'en') {
  const view = renderImpact(locale);
  // The headline's own label in that language (the groups are regions too, so a bare /.+/ would match several).
  await screen.findByRole('region', { name: messages[locale].headline.label });
  return view;
}

const headline = () => screen.getByRole('region', { name: HEADLINE });
/** The card whose label (a <dt>) is `label`; its figure is the first <dd>. */
const card = (label: string): HTMLElement => {
  const found = screen.getByText(label).closest('div');
  if (found === null) throw new Error(`no card for "${label}"`);
  return found;
};
const figure = (label: string): string => text(card(label).querySelector('dd') as Element);
const refreshButton = () => screen.getByRole('button', { name: /^(Refresh|Refreshing…)$/ }) as HTMLButtonElement;
const weekList = (locale: Locale = 'en') => screen.getByRole('list', { name: messages[locale].weeks.title });
const weekRows = (locale: Locale = 'en') => within(weekList(locale)).getAllByRole('listitem');
/** The element of a week row that the bar's length is written on (an inline width in percent). */
const barOf = (row: HTMLElement): HTMLElement | undefined =>
  Array.from(row.querySelectorAll<HTMLElement>('*')).find((element) => element.style.width.endsWith('%'));

const LEAKS = ['undefined', 'NaN', 'null', '{{', '[object'];

// --- the request --------------------------------------------------------------------------------

describe('the request', () => {
  test('loads with exactly one GET /api/admin/impact and sends nothing else', async () => {
    await renderLoaded();
    expect(impactCalls()).toHaveLength(1);
    expect(impactCalls()[0]?.init?.method).toBe('GET');
    expect(calls).toHaveLength(1);
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until the numbers arrive, and no number is invented meanwhile', async () => {
    const held = deferred();
    serve(() => held.promise);
    renderImpact();

    const status = await screen.findByRole('status', { name: 'Loading impact numbers' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Are people getting better?' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: HEADLINE }) === null).toBe(true);
    expect(screen.queryByText('Players with a baseline') === null).toBe(true);
    expect(screen.queryByRole('list', { name: 'Sessions completed per week' }) === null).toBe(true);

    held.release(json(IMPACT));
    await screen.findByRole('region', { name: HEADLINE });
    expect(screen.queryByRole('status', { name: 'Loading impact numbers' }) === null).toBe(true);
  });
});

// --- success ------------------------------------------------------------------------------------

describe('success: the numbers from the response', () => {
  test('the headline is the median improvement, signed and rounded to one decimal, with the players who retested as its basis', async () => {
    await renderLoaded();
    const region = text(headline());
    expect(region).toContain('+12.5%');
    expect(region).toContain('Players who retested: 318');
    expect(region).toContain('The typical retest is better than the first result.');
    expect(screen.getByRole('heading', { level: 1, name: 'Are people getting better?' })).toBeTruthy();
  });

  test('every card shows its own number, formatted for the language, under its own label', async () => {
    await renderLoaded();
    expect(figure('Players with a baseline')).toBe(en(1240));
    expect(figure('Players who retested')).toBe(en(318));
    expect(figure('Sessions completed')).toBe(en(5321));
    // 1234.56 hours: rounded to one decimal, not to a whole hour and not shown with two.
    expect(figure('Training hours')).toBe('1,234.6');
    expect(figure('Active contributors')).toBe(en(27));
    expect(figure('Verified coaches')).toBe(en(9));
    expect(figure('Open methodologies')).toBe(en(154));
  });

  test('every card carries a one-line hint saying what it counts, so a bare number is never left to be guessed', async () => {
    await renderLoaded();
    for (const label of [
      'Players with a baseline',
      'Players who retested',
      'Sessions completed',
      'Training hours',
      'Active contributors',
      'Verified coaches',
      'Open methodologies',
    ]) {
      expect(card(label).querySelectorAll('dd').length).toBeGreaterThanOrEqual(2);
    }
    expect(text(card('Active contributors'))).toContain('last 90 days');
  });

  test('a whole number of hours has no trailing decimal', async () => {
    serveImpact(impact({ trainingHours: 12 }));
    await renderLoaded();
    expect(figure('Training hours')).toBe('12');
  });

  test('the weekly series is a CSS bar list: twelve rows, each with its number, bar length relative to the busiest week', async () => {
    await renderLoaded();
    const rows = weekRows();
    expect(rows).toHaveLength(12);

    const max = Math.max(...WEEK_SESSIONS);
    rows.forEach((row, index) => {
      const sessions = WEEK_SESSIONS[index]!;
      // The number is written on every row, so the bar is never the only carrier of the value.
      expect(text(row)).toContain(String(sessions));
      const bar = barOf(row);
      expect(bar === undefined).toBe(false);
      expect(bar!.style.width).toBe(`${(sessions / max) * 100}%`);
    });

    // No chart library: no canvas, svg or image anywhere in the series.
    expect(weekList().querySelector('canvas, svg, img') === null).toBe(true);
  });

  test('rows follow the order of the response, oldest first, and each shows a date', async () => {
    await renderLoaded();
    const rows = weekRows();
    const first = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date('2026-06-29T00:00:00Z'));
    const last = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date('2026-09-14T00:00:00Z'));
    expect(text(rows[0]!)).toContain(first);
    expect(text(rows[11]!)).toContain(last);
  });

  test('a decline is written with a minus sign and a sentence, not left to a colour', async () => {
    serveImpact(impact({ medianImprovementPct: -3.24 }));
    await renderLoaded();
    const region = text(headline());
    expect(region).toMatch(/[−-]3\.2%/);
    expect(region).not.toContain('+3.2%');
    expect(region).toContain('The typical retest is below the first result.');
  });

  test('a median of exactly zero says so in words, with no plus or minus sign', async () => {
    serveImpact(impact({ medianImprovementPct: 0 }));
    await renderLoaded();
    const region = text(headline());
    expect(region).toContain('0%');
    expect(region).not.toMatch(/[+−-]\s?0%/);
    expect(region).toContain('The typical retest matches the first result.');
  });

  test('with players but no retest yet, the headline shows a dash and says there is nothing to compare, never 0%', async () => {
    serveImpact(impact({ playersRetested: 0, medianImprovementPct: 0 }));
    await renderLoaded();
    const region = text(headline());
    expect(region).toContain('No player has retested yet, so there is nothing to compare.');
    expect(region).toContain('—');
    expect(region).not.toContain('%');
    // The other cards are still real numbers.
    expect(figure('Players with a baseline')).toBe(en(1240));
    expect(figure('Players who retested')).toBe('0');
  });

  test('weeks with no sessions at all get an honest sentence instead of twelve empty bars', async () => {
    serveImpact(impact({ byWeek: weeks(new Array<number>(12).fill(0)) }));
    await renderLoaded();
    expect(screen.getByText('No sessions were completed in these 12 weeks.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Sessions completed per week' }) === null).toBe(true);
    // The all-time total is still shown.
    expect(figure('Sessions completed')).toBe(en(5321));
  });

  test('an empty week list from the server is handled the same way', async () => {
    serveImpact(impact({ byWeek: [] }));
    await renderLoaded();
    expect(screen.getByText('No sessions were completed in these 12 weeks.')).toBeTruthy();
  });

  test('shows only totals: nothing on the screen names, ranks or compares people', async () => {
    await renderLoaded();
    const all = text(screen.getByRole('main')).toLowerCase();
    for (const word of ['leaderboard', 'ranking', 'top player', 'rank #']) expect(all).not.toContain(word);
    for (const leak of LEAKS) expect(text(screen.getByRole('main'))).not.toContain(leak);
  });
});

// --- empty --------------------------------------------------------------------------------------

describe('empty', () => {
  test('all zeros show one honest empty state and no cards, no headline number, no bars', async () => {
    serveImpact(ZEROS);
    renderImpact();
    await screen.findByText('No impact to show yet');

    expect(screen.getByText(/Nothing has been recorded so far/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: HEADLINE }) === null).toBe(true);
    expect(screen.queryByText('Players with a baseline') === null).toBe(true);
    expect(screen.queryByRole('list', { name: 'Sessions completed per week' }) === null).toBe(true);
    const all = text(screen.getByRole('main'));
    expect(all).not.toContain('%');
    for (const leak of LEAKS) expect(all).not.toContain(leak);
    // The screen can still be refreshed, and the title is still there.
    expect(refreshButton().disabled).toBe(false);
    expect(screen.getByRole('heading', { level: 1, name: 'Are people getting better?' })).toBeTruthy();
  });

  test('a single non-zero number is enough to leave the empty state', async () => {
    serveImpact({ ...ZEROS, openMethodologies: 12 });
    await renderLoaded();
    expect(screen.queryByText('No impact to show yet') === null).toBe(true);
    expect(figure('Open methodologies')).toBe('12');
    expect(figure('Players with a baseline')).toBe('0');
  });

  test('a session in a week is enough to leave the empty state', async () => {
    serveImpact({ ...ZEROS, byWeek: weeks([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) });
    await renderLoaded();
    expect(screen.queryByText('No impact to show yet') === null).toBe(true);
  });
});

// --- error --------------------------------------------------------------------------------------

describe('error', () => {
  test('a failed load is an alert with words, a retry, and no number; the server text is never shown', async () => {
    serve(() => problem(500, 'Boom'));
    renderImpact();

    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load the impact numbers');
    expect(text(alert)).not.toContain('(server text)');
    expect(text(alert)).not.toContain('Boom');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: HEADLINE }) === null).toBe(true);
    expect(screen.queryByText('No impact to show yet') === null).toBe(true);
  });

  test('a refusal (403) is the same error state, not an empty screen', async () => {
    serve(() => problem(403, 'Forbidden'));
    renderImpact();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load the impact numbers');
    expect(text(alert)).not.toContain('(server text)');
  });

  test('a network failure is the error state', async () => {
    stubNetwork(() => {
      throw new TypeError('Failed to fetch');
    });
    renderImpact();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load the impact numbers');
  });

  test('an answer that does not match the contract is an error, never NaN or a blank card', async () => {
    serveImpact({ ...IMPACT, medianImprovementPct: null });
    renderImpact();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load the impact numbers');
    for (const leak of LEAKS) expect(text(screen.getByRole('main'))).not.toContain(leak);
  });

  test('Try again asks again, is disabled and busy while the request runs, then shows the numbers', async () => {
    const held = deferred();
    serve(
      () => problem(500, 'Boom'),
      () => held.promise,
    );
    renderImpact();
    await screen.findByRole('alert');

    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(impactCalls()).toHaveLength(2));

    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    // No second request can be started meanwhile.
    await u.click(retry);
    expect(impactCalls()).toHaveLength(2);

    held.release(json(IMPACT));
    await screen.findByRole('region', { name: HEADLINE });
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(figure('Verified coaches')).toBe('9');
  });
});

// --- disabled -----------------------------------------------------------------------------------

describe('disabled while a request is in flight', () => {
  test('Refresh is enabled at rest, disabled and busy during a refresh, keeps the numbers on screen, then shows the new ones', async () => {
    const held = deferred();
    serve(
      () => json(IMPACT),
      () => held.promise,
    );
    await renderLoaded();

    expect(refreshButton().disabled).toBe(false);
    expect(refreshButton().textContent).toBe('Refresh');

    const u = userEvent.setup();
    await u.click(refreshButton());
    await waitFor(() => expect(impactCalls()).toHaveLength(2));

    const busy = refreshButton();
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.textContent).toBe('Refreshing…');
    // The old numbers stay: a refresh is not a return to the loading state.
    expect(text(headline())).toContain('+12.5%');
    expect(screen.queryByRole('status', { name: 'Loading impact numbers' }) === null).toBe(true);

    // A second click while in flight sends nothing.
    await u.click(busy);
    expect(impactCalls()).toHaveLength(2);

    held.release(json(impact({ medianImprovementPct: 20, playersRetested: 400 })));
    await waitFor(() => expect(text(headline())).toContain('+20%'));
    expect(text(headline())).toContain('Players who retested: 400');
    expect(refreshButton().disabled).toBe(false);
    expect(refreshButton().textContent).toBe('Refresh');
  });

  test('a refresh that fails keeps the last good numbers and says so in words', async () => {
    serve(
      () => json(IMPACT),
      () => problem(500, 'Boom'),
    );
    await renderLoaded();
    const u = userEvent.setup();
    await u.click(refreshButton());

    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not refresh the numbers');
    expect(text(alert)).not.toContain('(server text)');
    // Nothing was thrown away: the previous numbers are still there.
    expect(text(headline())).toContain('+12.5%');
    expect(figure('Verified coaches')).toBe('9');
    expect(refreshButton().disabled).toBe(false);
  });
});

// --- languages ----------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  test('every locale renders the whole success screen with real text and no leaked key or placeholder', async () => {
    const titles = new Set<string>();
    for (const locale of LOCALES) {
      serveImpact();
      const view = await renderLoaded(locale);
      const main = screen.getByRole('main');
      const all = text(main);
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      // Raw keys look like "headline.up" or "cards.hours.label".
      expect(all).not.toMatch(/\b(headline|cards|weeks|groups|error|empty)\.[a-z]/i);
      expect(all).toContain(`+${new Intl.NumberFormat(locale === 'en' ? 'en-US' : locale === 'ru' ? 'ru-RU' : 'kk-KZ').format(12.5)}%`);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      titles.add(text(screen.getByRole('heading', { level: 1 })));
      expect(weekRows(locale)).toHaveLength(12);
      view.unmount();
    }
    // Three different titles: no locale falls back to another one's text.
    expect(titles.size).toBe(3);
  });

  test('the numbers use the language: 1 240 in Russian, 1,240 in English', async () => {
    const ru = new Intl.NumberFormat('ru-RU').format(1240).replace(/\s+/g, ' ');
    const view = await renderLoaded('ru');
    expect(text(screen.getByRole('main'))).toContain(ru);
    view.unmount();

    await renderLoaded('en');
    expect(text(screen.getByRole('main'))).toContain('1,240');
  });

  test('the empty and error states are also written in every locale', async () => {
    for (const locale of LOCALES) {
      serveImpact(ZEROS);
      let view = renderImpact(locale);
      // Only the empty state has the refresh button and no headline, so a button means the load is done.
      await screen.findByRole('button', { name: /.+/ });
      let all = text(screen.getByRole('main'));
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      expect(all).not.toMatch(/\b(empty|error|headline)\.[a-z]/i);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      view.unmount();

      serve(() => problem(500, 'Boom'));
      view = renderImpact(locale);
      const alert = await screen.findByRole('alert');
      all = text(alert);
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      expect(all).not.toMatch(/\b(empty|error|headline)\.[a-z]/i);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      view.unmount();
    }
  });
});

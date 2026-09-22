import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { NavTierProvider, type NavTier } from '../shell/Shell';
import { createI18n, LOCALES } from '../../lib/i18n';
import { Route } from '../../routes/index';
import messages from './landing.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as lib/i18n.test.ts).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, waitFor, within } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];
type Tree = { [key: string]: string | Tree };

// Kazakh copy is flagged for a native-speaker review (bead fc-cjh). These tests pin the structure and the facts the
// acceptance criteria name (the English wording is fixed by them; ru and kk are matched by stems), so a reviewer can
// polish the Kazakh without touching them.

// --- the criteria, written out ------------------------------------------------------------------
const EN = {
  headline: 'Every child deserves a great first coach.',
  summary: '60 YEARS. 60 OPEN TRAINING SESSIONS. FREE FOR EVERYONE.',
  credit: 'Created by KOZ AI.',
  dedication: 'Opened to everyone on the 60th birthday of Kairat Boranbayev.',
};

// Lower-case stems that must appear in the dedication and the summary in each language.
const DEDICATION_STEMS: Record<Locale, string[]> = {
  en: ['kairat boranbayev', '60th birthday'],
  ru: ['боранбаев', '60'],
  kk: ['боранбаев', '60'],
};
const SUMMARY_STEMS: Record<Locale, string[]> = {
  en: ['60 years', '60 open training sessions', 'free for everyone'],
  ru: ['60 лет', '60 открытых тренировок', 'бесплатно'],
  kk: ['60 жыл', '60 ашық жаттығу', 'тегін'],
};

// Things the landing page must never claim, in any language: a monument, or a professional career for a child.
const FORBIDDEN_CLAIMS = /monument|memorial|professional|pro career|памятник|мемориал|профессионал|ескерткіш|кәсіпқой|кәсіби/i;

const STEP_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'] as const;
const STAT_IDS = ['drills', 'tracks', 'contributions', 'sports'] as const;

// --- helpers ------------------------------------------------------------------------------------

const modules = { './landing.messages.ts': { default: messages } };
const noStorage = { getItem: () => null, setItem: () => {} };

const Landing = Route.options.component as () => ReactNode;

const at = (tree: Tree, path: string): string => {
  const value = path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);
  if (typeof value !== 'string') throw new Error(`landing.messages has no string at "${path}"`);
  return value;
};
const copy = (locale: Locale, path: string): string => at(messages[locale] as Tree, path);

function leaves(tree: Tree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`),
  );
}

const STATS = { drills: 60, tracks: 5, contributions: 12, sports: 1 };
const problem = (status: number) =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'Server error', status }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string };
const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Replaces the global fetch (which lib/api.ts reads on every call). Nothing else is mocked. */
function stubFetch(handler: (n: number) => Response | Promise<Response>): Call[] {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return handler(calls.length);
  }) as typeof fetch;
  return calls;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let clients: QueryClient[] = [];
// auth-gate-spec.md §3.3: the CTA hrefs read the tier `AppShell` publishes through NavTierContext (features/shell/Shell.tsx),
// never a session hook of their own — see routes/index.tsx's `useCtaHrefs`. `tier` defaults to `'visitor'`, matching both
// the context's own default (rendering Landing outside a shell, as this file does) and Shell's fail-closed default.
const START_HREF = '/account/sign-in?redirect=%2Ftrain';
const CONTRIBUTE_HREF = '/account/sign-in?redirect=%2Fcontribute';

/** A default-configured QueryClient (library defaults, as the app's own one has): the page must set its own retry policy. */
function renderLanding(locale: Locale = 'en', tier: NavTier = 'visitor') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const client = new QueryClient();
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={instance}>
        <NavTierProvider tier={tier}>
          <Landing />
        </NavTierProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, instance, client, text: () => (view.container.textContent ?? '').replace(/\s+/g, ' ') };
}

const tokens = (element: Element): string[] => Array.from(element.classList);
const numberFormat = (locale: Locale) =>
  new Intl.NumberFormat({ kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' }[locale]);
const findLink = (container: HTMLElement, href: string) => container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
const statList = (container: HTMLElement): HTMLElement | null =>
  Array.from(container.querySelectorAll<HTMLElement>('ul')).find((ul) => ul.querySelectorAll('li').length === STAT_IDS.length && !ul.closest('ol')) ?? null;

beforeEach(() => {
  clients = [];
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  globalThis.fetch = realFetch;
});

// --- messages -----------------------------------------------------------------------------------

describe('landing messages', () => {
  test('kk, ru and en carry exactly the same keys', () => {
    const shape = (locale: Locale) => leaves(messages[locale] as Tree).map(([key]) => key).sort();
    expect(shape('kk')).toEqual(shape('en'));
    expect(shape('ru')).toEqual(shape('en'));
  });

  test('every key the page reads exists in every locale and none is blank', () => {
    const paths = [
      'eyebrow',
      'headline',
      'intro',
      'cta.start',
      'cta.contribute',
      'card.label',
      'card.summary.years',
      'card.summary.sessions',
      'card.summary.free',
      'card.credit',
      'card.dedication',
      'stats.label',
      ...STAT_IDS.map((id) => `stats.${id}`),
      'stats.loading',
      'stats.empty.title',
      'stats.empty.hint',
      'stats.error.title',
      'stats.error.message',
      'stats.error.retry',
      'how.eyebrow',
      'how.title',
      'how.intro',
      ...STEP_IDS.flatMap((id) => [`how.steps.${id}.title`, `how.steps.${id}.body`]),
    ];
    for (const locale of LOCALES) {
      for (const path of paths) expect(copy(locale, path).trim().length, `${locale} ${path}`).toBeGreaterThan(0);
      for (const [key, value] of leaves(messages[locale] as Tree)) {
        expect(value, `${locale} ${key}`).not.toMatch(/todo|tbd|lorem|undefined|\{\{/i);
      }
    }
  });

  test('the English copy is the criteria wording', () => {
    expect(copy('en', 'headline')).toBe(EN.headline);
    expect(copy('en', 'card.credit')).toBe(EN.credit);
    expect(copy('en', 'card.dedication')).toBe(EN.dedication);
    const summary = ['years', 'sessions', 'free'].map((key) => copy('en', `card.summary.${key}`)).join(' ');
    expect(summary).toBe(EN.summary);
  });

  test('no language claims a monument or a professional career', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(messages[locale] as Tree)) {
        expect(value, `${locale} ${key}`).not.toMatch(FORBIDDEN_CLAIMS);
      }
    }
  });

  test('the Kazakh copy uses Kazakh letters and the Russian copy is not left in English', () => {
    expect(copy('kk', 'headline')).toMatch(/[әғқңөұүһі]/i);
    expect(copy('kk', 'intro')).toMatch(/[әғқңөұүһі]/i);
    expect(copy('ru', 'headline')).toMatch(/\p{Script=Cyrillic}/u);
    expect(copy('ru', 'intro')).not.toBe(copy('en', 'intro'));
    expect(copy('kk', 'intro')).not.toBe(copy('ru', 'intro'));
  });
});

// --- the page, once the numbers have arrived ----------------------------------------------------

describe.each([...LOCALES])('landing page in %s', (locale) => {
  test('shows the eyebrow, one h1 headline and the intro paragraph', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h1')?.textContent?.trim()).toBe(copy(locale, 'headline'));
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain(copy(locale, 'eyebrow'));
    expect(text).toContain(copy(locale, 'intro'));
    if (locale === 'en') expect(container.querySelector('h1')?.textContent?.trim()).toBe(EN.headline);
    await waitFor(() => expect(statList(container)).not.toBeNull());
  });

  test('START TRAINING and CONTRIBUTE send a signed-out visitor to the sign-in gate with their return path', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale);
    const start = findLink(container, START_HREF);
    const contribute = findLink(container, CONTRIBUTE_HREF);
    expect(start?.textContent?.trim()).toBe(copy(locale, 'cta.start'));
    expect(contribute?.textContent?.trim()).toBe(copy(locale, 'cta.contribute'));
    expect(tokens(start!)).toContain('min-h-tap');
    expect(tokens(contribute!)).toContain('min-h-tap');
    await waitFor(() => expect(statList(container)).not.toBeNull());
  });

  test('a player who already has a session goes straight to /train', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale, 'player');
    const start = findLink(container, '/train');
    expect(start?.textContent?.trim()).toBe(copy(locale, 'cta.start'));
    await waitFor(() => expect(statList(container)).not.toBeNull());
  });

  test("an anonymous player's CONTRIBUTE still goes to the sign-in gate (contributing needs an account)", async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale, 'player');
    const contribute = findLink(container, CONTRIBUTE_HREF);
    expect(contribute?.textContent?.trim()).toBe(copy(locale, 'cta.contribute'));
    await waitFor(() => expect(statList(container)).not.toBeNull());
  });

  test('a coach account goes straight to both /train and /contribute', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale, 'account');
    expect(findLink(container, '/train')?.textContent?.trim()).toBe(copy(locale, 'cta.start'));
    expect(findLink(container, '/contribute')?.textContent?.trim()).toBe(copy(locale, 'cta.contribute'));
    await waitFor(() => expect(statList(container)).not.toBeNull());
  });

  test('the dark hero card carries the large 60, the summary, the credit and the dedication', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale);
    const card = container.querySelector<HTMLElement>('aside');
    expect(card, 'the hero card is an <aside>').not.toBeNull();
    expect(card?.getAttribute('aria-label')).toBe(copy(locale, 'card.label'));
    expect(card?.querySelector('[data-variant="ink"]'), 'uses the ink Card').not.toBeNull();

    const numeral = Array.from(card!.querySelectorAll('*')).find((el) => el.children.length === 0 && el.textContent?.trim() === '60');
    expect(numeral, 'a leaf element holding exactly "60"').toBeDefined();
    const numeralClasses = tokens(numeral!).join(' ');
    expect(numeralClasses).toMatch(/128px/);
    expect(numeralClasses).toMatch(/96px/);
    expect(numeralClasses).toMatch(/font-extrabold/);
    // The summary already starts with "60", so the numeral is decoration for assistive tech.
    expect(numeral?.closest('[aria-hidden="true"]')).not.toBeNull();

    const cardText = (card!.textContent ?? '').replace(/\s+/g, ' ');
    const summary = ['years', 'sessions', 'free'].map((key) => copy(locale, `card.summary.${key}`)).join(' ');
    expect(cardText).toContain(summary);
    expect(cardText).toContain(copy(locale, 'card.credit'));
    expect(cardText).toContain(copy(locale, 'card.dedication'));
    expect(cardText).toContain('KOZ AI');
    for (const stem of SUMMARY_STEMS[locale]) expect(cardText.toLowerCase(), stem).toContain(stem);
    for (const stem of DEDICATION_STEMS[locale]) expect(cardText.toLowerCase(), stem).toContain(stem);
    await waitFor(() => expect(statList(container)).not.toBeNull());
  });

  test('the how-it-works section is an h2 with an ordered list of six steps, each with an h3 and a sentence', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale);
    const section = container.querySelector<HTMLElement>('section[aria-labelledby]:has(ol)');
    expect(section, 'a labelled section holding the steps').not.toBeNull();
    const heading = section!.querySelector('h2');
    expect(heading?.textContent?.trim()).toBe(copy(locale, 'how.title'));
    expect(section!.getAttribute('aria-labelledby')).toBe(heading?.id ?? null);
    expect(heading?.id).toBeTruthy();
    expect(section!.textContent).toContain(copy(locale, 'how.eyebrow'));
    expect(section!.textContent).toContain(copy(locale, 'how.intro'));

    const items = Array.from(section!.querySelectorAll('ol > li'));
    expect(items).toHaveLength(STEP_IDS.length);
    STEP_IDS.forEach((id, index) => {
      const item = items[index]!;
      expect(item.querySelector('h3')?.textContent?.trim()).toBe(copy(locale, `how.steps.${id}.title`));
      expect(item.textContent).toContain(copy(locale, `how.steps.${id}.body`));
      // The step number is visible and in reading order.
      expect(item.textContent).toContain(String(index + 1));
    });
    await waitFor(() => expect(statList(container)).not.toBeNull());
  });

  test('makes exactly one API call, a GET of /api/commons/stats', async () => {
    const seen = stubFetch(() => ok(STATS));
    const { container } = renderLanding(locale);
    await waitFor(() => expect(statList(container)).not.toBeNull());
    expect(seen).toEqual([{ url: '/api/commons/stats', method: 'GET' }]);
  });

  test('renders the numbers the stubbed fetch returned, formatted for the language, each next to its label', async () => {
    stubFetch(() => ok({ drills: 1234, tracks: 5, contributions: 4567, sports: 1 }));
    const { container } = renderLanding(locale);
    await waitFor(() => expect(statList(container)).not.toBeNull());
    const items = Array.from(statList(container)!.querySelectorAll('li'));
    const expected = { drills: 1234, tracks: 5, contributions: 4567, sports: 1 };
    STAT_IDS.forEach((id, index) => {
      const item = (items[index]?.textContent ?? '').replace(/\s+/g, ' ');
      expect(item, `${locale} ${id} label`).toContain(copy(locale, `stats.${id}`));
      // Intl groups thousands with a no-break space in ru and kk; the text above has all whitespace folded, so fold it here too.
      expect(item, `${locale} ${id} number`).toContain(numberFormat(locale).format(expected[id]).replace(/\s/g, ' '));
    });
    const region = statList(container)!.closest('[aria-label]');
    expect(region?.getAttribute('aria-label')).toBe(copy(locale, 'stats.label'));
    expect(region?.getAttribute('aria-busy')).not.toBe('true');
  });

  test('never renders an unresolved key, "undefined" or an object', async () => {
    stubFetch(() => ok(STATS));
    const { container, text } = renderLanding(locale);
    await waitFor(() => expect(statList(container)).not.toBeNull());
    for (const bad of ['undefined', '[object', 'landing:', 'stats.', 'how.', 'card.', 'cta.', 'null', 'NaN', '{{']) {
      expect(text()).not.toContain(bad);
    }
  });

  test('never claims a monument or a professional career', async () => {
    stubFetch(() => ok(STATS));
    const { container, text } = renderLanding(locale);
    await waitFor(() => expect(statList(container)).not.toBeNull());
    expect(text()).not.toMatch(FORBIDDEN_CLAIMS);
  });
});

// --- states of the stat strip -------------------------------------------------------------------

describe('stat strip states', () => {
  test('loading: a busy region with skeletons and no numbers, while the headline, CTAs and steps already show', async () => {
    const gate = deferred<Response>();
    stubFetch(() => gate.promise);
    const { container, text } = renderLanding('en');
    const region = container.querySelector<HTMLElement>('[aria-busy="true"]');
    expect(region, 'the strip is aria-busy while loading').not.toBeNull();
    expect(region?.getAttribute('aria-label')).toBe(copy('en', 'stats.label'));
    expect(region?.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(STAT_IDS.length);
    expect(within(region!).getAllByText(copy('en', 'stats.loading')).length).toBeGreaterThan(0);
    expect(statList(container)).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe(EN.headline);
    expect(findLink(container, START_HREF)).not.toBeNull();
    expect(findLink(container, CONTRIBUTE_HREF)).not.toBeNull();
    expect(container.querySelectorAll('ol > li')).toHaveLength(6);
    expect(text()).not.toContain(copy('en', 'stats.error.retry'));

    await act(async () => gate.resolve(ok(STATS)));
    await waitFor(() => expect(statList(container)).not.toBeNull());
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(within(container).queryByText(copy('en', 'stats.loading'))).toBeNull();
  });

  test('empty: when every count is zero the strip says so calmly instead of showing four zeros', async () => {
    stubFetch(() => ok({ drills: 0, tracks: 0, contributions: 0, sports: 0 }));
    const { container, findByText, text } = renderLanding('en');
    await findByText(copy('en', 'stats.empty.title'));
    expect(text()).toContain(copy('en', 'stats.empty.hint'));
    expect(statList(container)).toBeNull();
    expect(within(container).queryByRole('button')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(findLink(container, START_HREF)).not.toBeNull();
  });

  test('a single zero is still a number: only the all-zero strip is empty', async () => {
    stubFetch(() => ok({ drills: 60, tracks: 5, contributions: 0, sports: 1 }));
    const { container, text } = renderLanding('en');
    await waitFor(() => expect(statList(container)).not.toBeNull());
    expect(text()).not.toContain(copy('en', 'stats.empty.title'));
    const items = Array.from(statList(container)!.querySelectorAll('li'));
    expect(items[2]?.textContent).toContain('0');
  });

  test.each([
    ['a 500 problem response', () => problem(500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a body that does not match the CommonsStats schema', () => ok({ drills: 'sixty' })],
    ['an HTML page instead of JSON', () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
  ])('error (%s): a quiet retry replaces the strip and the rest of the page still renders', async (_name, handler) => {
    stubFetch(handler);
    const { container, findByRole, text } = renderLanding('en');
    const retry = await findByRole('button', { name: copy('en', 'stats.error.retry') });
    expect(text()).toContain(copy('en', 'stats.error.title'));
    expect(text()).toContain(copy('en', 'stats.error.message'));
    expect(statList(container)).toBeNull();
    // Quiet: announced politely, not as an assertive alert, and the retry is not a full-width alarm.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(tokens(retry)).toContain('min-h-tap');
    // The rest of the page is intact and the CTAs are usable links.
    expect(container.querySelector('h1')?.textContent).toBe(EN.headline);
    expect(container.querySelector('aside')?.textContent).toContain(EN.credit);
    expect(container.querySelectorAll('ol > li')).toHaveLength(6);
    for (const href of [START_HREF, CONTRIBUTE_HREF]) {
      const link = findLink(container, href);
      expect(link).not.toBeNull();
      expect(link?.getAttribute('aria-disabled')).toBeNull();
      expect(link?.getAttribute('tabindex')).not.toBe('-1');
    }
  });

  test('error: the failed call is not retried on its own, so the retry appears at once (one call, no back-off)', async () => {
    const seen = stubFetch(() => problem(500));
    const { findByRole } = renderLanding('en');
    await findByRole('button', { name: copy('en', 'stats.error.retry') });
    expect(seen).toHaveLength(1);
  });

  test('retry: the button is disabled and busy while the request is in flight, then the numbers appear', async () => {
    const second = deferred<Response>();
    const seen = stubFetch((n) => (n === 1 ? problem(503) : second.promise));
    const { container, findByRole, queryByRole } = renderLanding('en');
    const retry = await findByRole('button', { name: copy('en', 'stats.error.retry') });
    expect((retry as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(retry);
    await waitFor(() => expect(seen).toHaveLength(2));
    const busy = await findByRole('button', { name: copy('en', 'stats.error.retry') });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // Clicking a disabled retry does not send a third request.
    fireEvent.click(busy);
    expect(seen).toHaveLength(2);
    // The CTAs stay usable while the retry is in flight.
    expect(findLink(container, START_HREF)).not.toBeNull();

    await act(async () => second.resolve(ok(STATS)));
    await waitFor(() => expect(statList(container)).not.toBeNull());
    expect(queryByRole('button', { name: copy('en', 'stats.error.retry') })).toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen.every((call) => call.method === 'GET' && call.url === '/api/commons/stats')).toBe(true);
  });

  test('retry that fails again keeps the retry, enabled again', async () => {
    const seen = stubFetch(() => problem(500));
    const { findByRole } = renderLanding('en');
    const retry = await findByRole('button', { name: copy('en', 'stats.error.retry') });
    fireEvent.click(retry);
    await waitFor(() => expect(seen).toHaveLength(2));
    await waitFor(async () => {
      const again = await findByRole('button', { name: copy('en', 'stats.error.retry') });
      expect((again as HTMLButtonElement).disabled).toBe(false);
    });
  });

  test('focus: a failed retry gives focus back to the retry button, a successful one moves it to the numbers', async () => {
    const seen = stubFetch((n) => (n === 3 ? ok(STATS) : problem(500)));
    const { container, findByRole, queryByRole } = renderLanding('en');
    const name = { name: copy('en', 'stats.error.retry') };
    const retry = await findByRole('button', name);
    retry.focus();
    fireEvent.click(retry);
    // A natively disabled button drops focus in a real browser; do the same here, then let the request settle.
    retry.blur();
    await waitFor(() => expect(seen).toHaveLength(2));
    await waitFor(async () => expect(((await findByRole('button', name)) as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(retry));

    fireEvent.click(retry);
    retry.blur();
    await waitFor(() => expect(statList(container)).not.toBeNull());
    expect(queryByRole('button', name)).toBeNull();
    const region = statList(container)!.closest<HTMLElement>('[aria-label]');
    expect(region?.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(document.activeElement).toBe(region));
  });

  test('a page load that fails does not steal focus', async () => {
    stubFetch(() => problem(500));
    const { findByRole } = renderLanding('en');
    await findByRole('button', { name: copy('en', 'stats.error.retry') });
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  test('coming back to the tab does not make a second call', async () => {
    const seen = stubFetch(() => ok(STATS));
    const { container } = renderLanding('en');
    await waitFor(() => expect(statList(container)).not.toBeNull());
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(seen).toHaveLength(1);
  });

  test('real data only: a different response gives different numbers', async () => {
    stubFetch(() => ok({ drills: 71, tracks: 6, contributions: 9, sports: 2 }));
    const { container } = renderLanding('en');
    await waitFor(() => expect(statList(container)).not.toBeNull());
    const text = (statList(container)!.textContent ?? '').replace(/\s+/g, ' ');
    for (const value of ['71', '6', '9', '2']) expect(text).toContain(value);
    expect(text).not.toContain('60');
  });
});

// --- language, layout and hygiene ---------------------------------------------------------------

describe('landing page structure', () => {
  test('follows the active language: switching it re-renders the copy', async () => {
    stubFetch(() => ok(STATS));
    const { container, instance } = renderLanding('en');
    await waitFor(() => expect(statList(container)).not.toBeNull());
    expect(container.querySelector('h1')?.textContent).toBe(copy('en', 'headline'));
    await act(async () => {
      await instance.changeLanguage('ru');
    });
    expect(container.querySelector('h1')?.textContent).toBe(copy('ru', 'headline'));
    expect(findLink(container, START_HREF)?.textContent?.trim()).toBe(copy('ru', 'cta.start'));
    expect(statList(container)?.textContent).toContain(copy('ru', 'stats.drills'));
    await act(async () => {
      await instance.changeLanguage('kk');
    });
    expect(container.querySelector('h1')?.textContent).toBe(copy('kk', 'headline'));
  });

  test('headings are ordered: one h1, then h2 for the how-it-works section, then h3 for the steps', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding('en');
    await waitFor(() => expect(statList(container)).not.toBeNull());
    const levels = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => h.tagName);
    expect(levels[0]).toBe('H1');
    expect(levels.filter((tag) => tag === 'H1')).toHaveLength(1);
    expect(levels.filter((tag) => tag === 'H2')).toHaveLength(1);
    expect(levels.filter((tag) => tag === 'H3')).toHaveLength(6);
    expect(levels.filter((tag) => tag === 'H4' || tag === 'H5' || tag === 'H6')).toHaveLength(0);
  });

  test('works at 360px: one column by default, breakpoints only add columns, nothing is a fixed pixel width', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding('en');
    await waitFor(() => expect(statList(container)).not.toBeNull());
    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const token of tokens(element)) {
        // A column count without a breakpoint prefix would force columns on a 360px screen.
        expect(token, element.outerHTML.slice(0, 120)).not.toMatch(/^grid-cols-([2-9]|\[)/);
        // A fixed width (w-96, w-[400px], min-w-[...]) is the usual cause of horizontal scroll.
        expect(token, element.outerHTML.slice(0, 120)).not.toMatch(/^(min-)?w-(\d{2,}|\[\d{3,}px\])$/);
      }
    }
    expect(container.querySelector('main')).not.toBeNull();
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });

  test('has no inline colours: tokens and classes only', async () => {
    stubFetch(() => ok(STATS));
    const { container } = renderLanding('en');
    await waitFor(() => expect(statList(container)).not.toBeNull());
    for (const element of Array.from(container.querySelectorAll('*'))) {
      expect(element.getAttribute('style') ?? '').not.toMatch(/#|rgb|hsl/);
    }
  });

  test('the CTA links are plain, usable anchors: they are visible in the loading state too, and are never disabled', async () => {
    const gate = deferred<Response>();
    stubFetch(() => gate.promise);
    const { container } = renderLanding('en');
    // Only the href expectation moves (auth-gate-spec.md §3.3): a signed-out visitor's CTAs point at the sign-in gate.
    for (const href of [START_HREF, CONTRIBUTE_HREF]) {
      const link = findLink(container, href);
      expect(link).not.toBeNull();
      expect(link?.hasAttribute('disabled')).toBe(false);
      expect(link?.getAttribute('aria-disabled')).toBeNull();
    }
    await act(async () => gate.resolve(ok(STATS)));
  });
});

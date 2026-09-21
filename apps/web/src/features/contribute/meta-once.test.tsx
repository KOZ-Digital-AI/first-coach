import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { Contribution, ContributionMeta } from '@api-types/contributions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, type LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { ContributeDepsContext, Route, type XhrLike } from '../../routes/contribute/index';
import messages from './form.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as form.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');

/*
 * Contract under test (fc-mol-70i.14, found by the j5 gate: 1 of 3 cold runs saw GET /api/contribute/meta TWICE before the POST,
 * 3 non-auth /api calls against a budget of 2): the form's GET /api/contribute/meta happens exactly once per visit.
 *
 * Why it fired twice. The screen hides the form whenever the session is being re-read (a Better Auth refetch keeps the PREVIOUS
 * data, which may be another person, so it is never acted on): the form unmounts, and when the session settles it mounts again.
 * The app's QueryClient keeps a query for 14 days (bootstrap.ts gcTime), so the meta is still in the cache on that remount, but a
 * query with the default staleTime 0 is stale the moment it lands and is fetched again on mount. The same default makes a
 * reconnect (and a focus) refetch it. The meta is static reference data (sports, skill tree, limits), so it is fresh for a long time.
 *
 * Readings the tests pin (the simplest reading each time):
 * - "per visit": while the cache holds it. Signing out clears the whole QueryClient (features/account/header-extra.tsx), so the next
 *   visit fetches again; a language change is a different query (the names come back localised) and fetches its own.
 * - The client here has the app's gcTime (PERSIST_MAX_AGE_MS, bootstrap.ts); with react-query's own gcTime of 0 (form.test.tsx)
 *   the query would be dropped at unmount and this bug could not show.
 * - "long staleTime": the tests move the clock a whole day ahead before the focus / reconnect events, so they fail whichever of
 *   staleTime or the refetchOn* flags is missing.
 */

type Locale = (typeof LOCALES)[number];

const META = ContributionMeta.parse({
  sports: [{ slug: 'football', name: { kk: 'Футбол', ru: 'Футбол', en: 'Football' } }],
  skills: [
    { slug: 'inside-touches', name: { kk: 'Ішкі жағымен', ru: 'Касания внутренней стороной', en: 'Inside Touches' }, children: [] },
    { slug: 'passing', name: { kk: 'Пас беру', ru: 'Передачи', en: 'Passing' }, children: [] },
  ],
  levels: ['beginner', 'basic', 'intermediate'],
  equipment: ['nothing', 'ball', 'ball_wall', 'cones', 'full_field'],
  spaces: ['home_3x3', 'yard', 'field', 'gym'],
  licenses: ['CC-BY-SA-4.0', 'CC-BY-4.0', 'CC0-1.0'],
  improvementKinds: ['explanation', 'progression'],
  upload: { maxMb: 50, mimeTypes: ['video/mp4'] },
});

const CREATED = Contribution.parse({
  id: 'c-1',
  state: 'pending',
  payload: {
    kind: 'new',
    locale: 'en',
    name: 'Wall passes',
    sport: 'football',
    skill: 'inside-touches',
    ageMin: 8,
    ageMax: 12,
    level: 'basic',
    goal: 'passing',
    instructions: 'Pass the ball against the wall 20 times with the inside of your foot.',
    durationMin: 15,
    equipment: 'ball_wall',
    mistakes: 'Looking at the ball.',
    progression: 'Weaker foot.',
    regression: 'Stand closer.',
    safety: 'Keep clear of windows.',
    source: 'My own practice',
    author: 'Aigerim Coach',
  },
  attachments: [],
  createdAt: '2026-09-22T09:00:00Z',
  updatedAt: '2026-09-22T09:00:00Z',
});

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const realFetch = globalThis.fetch;
let calls: URL[] = [];
let failNext = 0;

function stubNetwork(): void {
  calls = [];
  failNext = 0;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push(url);
    if (url.pathname !== '/api/contribute/meta') return json({ type: 'about:blank', title: 'Not Found', status: 404 }, { status: 404 });
    if (failNext > 0) {
      failNext -= 1;
      return json({ type: 'about:blank', title: 'Boom', status: 500 }, { status: 500 }, 'application/problem+json');
    }
    return json(META);
  }) as unknown as typeof fetch;
}
const metaCalls = () => calls.filter((url) => url.pathname === '/api/contribute/meta');

/** The upload: a fake XMLHttpRequest the test answers by hand. */
class FakeXhr implements XhrLike {
  upload: XhrLike['upload'] = { onprogress: null };
  onload: XhrLike['onload'] = null;
  onerror: XhrLike['onerror'] = null;
  onabort: XhrLike['onabort'] = null;
  ontimeout: XhrLike['ontimeout'] = null;
  withCredentials = false;
  status = 0;
  responseText = '';
  method = '';
  url = '';
  responseHeaders: Record<string, string> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send() {}
  abort() {}
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseHeaders['content-type'] = 'application/json';
    this.onload?.();
  }
}
let xhrs: FakeXhr[] = [];
const createXhr = (): XhrLike => {
  const xhr = new FakeXhr();
  xhrs.push(xhr);
  return xhr;
};

// --- cross-file hygiene (see form.test.tsx): happy-dom's query bookkeeping grows without bound in one shared window ----------------

function resetHappyDomCaches(): void {
  const targets: object[] = [document, document.documentElement, document.body, window];
  for (const target of targets) {
    for (const symbol of Object.getOwnPropertySymbols(target)) {
      const value: unknown = (target as Record<symbol, unknown>)[symbol];
      if ((symbol.description === 'affectsCache' || symbol.description === 'affectsComputedStyleCache') && Array.isArray(value)) {
        for (const item of value) if (typeof item === 'object' && item !== null) (item as { result: unknown }).result = null;
        value.length = 0;
      } else if (symbol.description === 'querySelectorCache' && value instanceof Map) {
        value.clear();
      }
    }
  }
}

const clients: QueryClient[] = [];

beforeEach(() => {
  xhrs = [];
  stubNetwork();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = realFetch;
  setSystemTime(); // the clock the tests moved
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------

type SessionState = { data?: unknown; isPending: boolean; isRefetching?: boolean; error?: unknown; refetch: () => unknown };
const ready = (): SessionState => ({
  data: { user: { id: 'u-1', name: 'Aigerim', isAnonymous: false } },
  isPending: false,
  error: null,
  refetch: () => {},
});
/** What Better Auth reports while it re-reads the session: the previous data is still there, the flag is up. */
const rereading = (): SessionState => ({ ...ready(), isRefetching: true });

const modules = {
  './form.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };
const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};
const APP_GC_TIME = 14 * 24 * 60 * 60 * 1000; // PERSIST_MAX_AGE_MS: bootstrap.ts createAppQueryClient

/** A QueryClient with the app's defaults (bootstrap.ts createAppQueryClient), not react-query's own gcTime. */
function appClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: APP_GC_TIME } } });
  clients.push(client);
  return client;
}

function mount(options: { client?: QueryClient; locale?: Locale; session?: SessionState } = {}) {
  const { client = appClient(), locale = 'en', session = ready() } = options;
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const storage = memoryStorage();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const contribute = createRoute({ getParentRoute: () => rootRoute, path: '/contribute', component: Route.options.component });
  const signIn = createRoute({ getParentRoute: () => rootRoute, path: '/account/sign-in', component: () => <p>sign in page</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([contribute, signIn]),
    history: createMemoryHistory({ initialEntries: ['/contribute'] }),
  });
  const tree = (current: SessionState): ReactElement => (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={instance}>
        <ContributeDepsContext.Provider value={{ session: current, createXhr, storage, now: () => 1_700_000_000_000, navigate: () => {} }}>
          <RouterProvider router={router} />
        </ContributeDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>
  );
  const view = render(tree(session));
  return { ...view, client, show: (next: SessionState) => view.rerender(tree(next)) };
}

const formButton = (locale: Locale = 'en') => screen.findByRole('button', { name: new RegExp(`^(${messages[locale].submit.label})$`) });
const formIsShown = () => screen.queryByLabelText(/^Name of the method/) !== null;
const tick = (ms = 40) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

/** The browser telling the page it came back into view, and the network dropping and returning. */
async function focusAndReconnect() {
  await act(async () => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

// --- the bug ------------------------------------------------------------------------------------

describe('GET /api/contribute/meta happens once per visit', () => {
  test('the first visit reads it exactly once', async () => {
    mount();
    await formButton();
    await tick();
    expect(metaCalls()).toHaveLength(1);
    expect(metaCalls()[0]!.searchParams.get('locale')).toBe('en');
  });

  test('a session re-read that hides the form and brings it back (a remount) does not read it again', async () => {
    const view = mount();
    await formButton();
    view.show(rereading());
    await waitFor(() => expect(formIsShown()).toBe(false));
    view.show(ready());
    await formButton();
    await tick();
    expect(metaCalls()).toHaveLength(1);
  });

  test('several session re-reads in a row still read it once', async () => {
    const view = mount();
    await formButton();
    for (let round = 0; round < 3; round += 1) {
      view.show(rereading());
      await waitFor(() => expect(formIsShown()).toBe(false));
      view.show(ready());
      await formButton();
    }
    await tick();
    expect(metaCalls()).toHaveLength(1);
  });

  test('a re-render after mount (a new session object, same person) does not read it again', async () => {
    const view = mount();
    await formButton();
    view.show(ready());
    view.show(ready());
    await tick();
    expect(formIsShown()).toBe(true);
    expect(metaCalls()).toHaveLength(1);
  });

  test('window focus, visibility and going offline then online do not read it again, even a day later', async () => {
    const view = mount();
    await formButton();
    await focusAndReconnect();
    expect(metaCalls()).toHaveLength(1);
    setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
    await focusAndReconnect();
    expect(formIsShown()).toBe(true);
    expect(metaCalls()).toHaveLength(1);
    view.show(rereading());
    view.show(ready());
    await formButton();
    await tick();
    expect(metaCalls()).toHaveLength(1);
  });

  test('a failed read is not remembered as good: the next mount reads it again, and a good one is then kept', async () => {
    failNext = 1;
    const view = mount();
    await screen.findByRole('button', { name: messages.en.load.error.retry });
    view.show(rereading());
    await waitFor(() => expect(screen.queryByRole('button', { name: messages.en.load.error.retry }) === null).toBe(true));
    view.show(ready());
    await formButton();
    await tick();
    expect(metaCalls()).toHaveLength(2);
    view.show(rereading());
    view.show(ready());
    await formButton();
    await tick();
    expect(metaCalls()).toHaveLength(2);
  });
});

describe('a fresh visit still reads it', () => {
  test('after sign-out cleared the client (features/account/header-extra.tsx), the next visit reads it again', async () => {
    const client = appClient();
    const first = mount({ client });
    await formButton();
    first.unmount();
    client.clear(); // what the sign-out does
    mount({ client });
    await formButton();
    await tick();
    expect(metaCalls()).toHaveLength(2);
  });

  test('a visit on another language is its own query and reads the localised meta', async () => {
    const client = appClient();
    const en = mount({ client, locale: 'en' });
    await formButton('en');
    en.unmount();
    mount({ client, locale: 'ru' });
    await formButton('ru');
    await tick();
    expect(metaCalls().map((url) => url.searchParams.get('locale'))).toEqual(['en', 'ru']);
  });

  test('a visit on a new client (a page load) reads it', async () => {
    mount();
    await formButton();
    cleanup();
    mount();
    await formButton();
    await tick();
    expect(metaCalls()).toHaveLength(2);
  });
});

// --- the gate's budget --------------------------------------------------------------------------

describe('submitting after the single read', () => {
  const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  test('costs exactly one POST /api/contributions: one meta read and one upload in all, session re-read in between', async () => {
    const view = mount();
    await formButton();
    view.show(rereading());
    await waitFor(() => expect(formIsShown()).toBe(false));
    view.show(ready());
    await formButton();

    type(/^Name of the method/, 'Wall passes');
    type(/^Skill/, 'inside-touches');
    type(/^Age from/, '8');
    type(/^Age to/, '12');
    type(/^Difficulty/, 'basic');
    type(/^Goal/, 'passing');
    type(/^Duration/, '15');
    type(/^Equipment/, 'ball_wall');
    type(/^Instructions/, 'Pass the ball against the wall 20 times with the inside of your foot.');
    type(/^Common mistakes/, 'Looking at the ball.');
    type(/^Progression/, 'Weaker foot.');
    type(/^Regression/, 'Stand closer.');
    type(/^Safety/, 'Keep clear of windows.');
    type(/^Source/, 'My own practice');
    type(/^Author/, 'Aigerim Coach');
    fireEvent.click(screen.getByRole('checkbox', { name: /permission to share/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /not FIFA, UEFA or commercial content/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send for review$/ }));
    });
    await waitFor(() => expect(xhrs).toHaveLength(1));
    await act(async () => xhrs[0]!.respond(201, CREATED));
    await screen.findByText(/will become part of the Open Sport Commons after review/i);
    await focusAndReconnect();

    expect(metaCalls()).toHaveLength(1);
    expect(calls).toHaveLength(1); // nothing else went through fetch
    expect(xhrs).toHaveLength(1);
    expect(xhrs[0]!.method).toBe('POST');
    expect(new URL(xhrs[0]!.url, 'http://localhost/').pathname).toBe('/api/contributions');
  });
});

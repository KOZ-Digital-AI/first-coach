import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Contribution, ContributionMeta, ContributionPayloadRequest } from '@api-types/contributions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/contribute/$id.edit';
import messages from './edit.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as impact.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.

/*
 * Contract under test (fc-mol-70i.10): /contribute/:id/edit loads the coach's contribution, shows the reviewer's note on top,
 * reuses the form fields pre-filled, and saves with PUT /api/contributions/:id (multipart: a `payload` part, plus a `video` part
 * when a new one was chosen), returning to My contributions with the state back to pending. Items in a decided state are
 * read-only. The screen has loading, empty, error, disabled and success states, its mutation buttons are disabled while a request
 * is in flight, and every string exists in kk, ru and en. An anonymous player is not a contributor: sign-in with a return path.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query inside a real (memory-history) router; the only
 * stand-in is the network (globalThis.fetch). Fixtures are parsed with the shared contract schema, so they cannot drift from it.
 * Kazakh and Russian copy still needs a native-speaker review: for those locales the tests pin only that text exists, is
 * Cyrillic and never leaks 'undefined', 'NaN', a raw key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - "loads the coach's contribution": the contract has no GET /api/contributions/:id, so the one contribution is found in
 *   GET /api/contributions/mine (the list My contributions uses) by id. An id that is not in it is "not found" (empty state).
 * - "decided state" = the states the owner cannot edit: approved, rejected, withdrawn. pending and changes_requested are editable
 *   (the contract's EDITABLE_STATES).
 * - "reuses the form fields pre-filled": the contribute form's fields, filled from the stored payload. The two attestations are
 *   asked again every time (never pre-ticked); the video is optional and, when chosen, replaces all stored files (the API's rule).
 *   What the screen does not edit is sent back as stored: kind, targetDrillSlug, improvementKind, sourceUrl and the content locale.
 * - "returning to My contributions with the state back to pending": on success the returned Contribution replaces the item in the
 *   cached list (['contributions', 'mine']) and the screen goes to /contribute/mine (history replace).
 * - Sign-in: a 401 or 403 on the list means "not a contributor" -> /account/sign-in?redirect=/contribute/<id>/edit (history replace).
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const SENT = '2026-09-01T09:00:00.000Z';
const UPDATED = '2026-09-03T09:00:00.000Z';
const RESENT = '2026-09-22T10:00:00.000Z';

const META = ContributionMeta.parse({
  sports: [{ slug: 'football', name: { kk: 'Футбол', ru: 'Футбол', en: 'Football' } }],
  skills: [
    {
      slug: 'ball-mastery',
      name: { kk: 'Допты меңгеру', ru: 'Владение мячом', en: 'Ball Mastery' },
      children: [
        { slug: 'inside-touches', name: { kk: 'Ішкі жағымен', ru: 'Касания внутренней стороной', en: 'Inside Touches' }, children: [] },
        { slug: 'outside-touches', name: { kk: 'Сыртқы жағымен', ru: 'Касания внешней стороной', en: 'Outside Touches' }, children: [] },
      ],
    },
    { slug: 'passing', name: { kk: 'Пас беру', ru: 'Передачи', en: 'Passing' }, children: [] },
  ],
  levels: ['beginner', 'basic', 'intermediate'],
  equipment: ['nothing', 'ball', 'ball_wall', 'cones', 'full_field'],
  spaces: ['home_3x3', 'yard', 'field', 'gym'],
  licenses: ['CC-BY-SA-4.0', 'CC-BY-4.0', 'CC0-1.0'],
  improvementKinds: ['explanation', 'progression'],
  upload: { maxMb: 50, mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/png', 'application/pdf'] },
});

const BASE_PAYLOAD = {
  kind: 'new',
  locale: 'ru',
  name: 'Cone slalom',
  sport: 'football',
  skill: 'inside-touches',
  ageMin: 8,
  ageMax: 12,
  level: 'basic',
  goal: 'dribbling',
  instructions: 'Weave through five cones, keeping the ball close.',
  durationMin: 10,
  equipment: 'cones',
  mistakes: 'The ball runs too far ahead.',
  progression: 'Use only the weaker foot.',
  regression: 'Use three cones.',
  safety: '',
  source: 'My own session',
  author: 'Aidar Coach',
};

const contribution = (id: string, state: Contribution['state'], name: string, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
  Contribution.parse({
    id,
    state,
    payload: { ...BASE_PAYLOAD, name, ...payload },
    attachments: [],
    createdAt: SENT,
    updatedAt: UPDATED,
    ...extra,
  });

const NOTE = 'Please add a safety note for the cones.';
const CHANGES = contribution('c-changes', 'changes_requested', 'Cone slalom', {
  reviewerNote: NOTE,
  attachments: [
    { id: 'a-1', kind: 'video', url: '/media/a-1.mp4', filename: 'slalom.mp4' },
    { id: 'a-2', kind: 'image', url: '/media/a-2.jpg' },
  ],
});
const PENDING = contribution(
  'c-pending',
  'pending',
  'Wall passes',
  {},
  { kind: 'improvement', targetDrillSlug: 'wall-passes-basic', improvementKind: 'progression', sourceUrl: 'https://example.org/wall', locale: 'en' },
);
const APPROVED = contribution('c-approved', 'approved', 'Two-touch turns', { reviewerNote: 'Thanks, this is published.', resultingDrillSlug: 'two-touch-turns' });
const REJECTED = contribution('c-rejected', 'rejected', 'Sprint relay', { reviewerNote: 'This is a fitness drill without a ball.' });
const WITHDRAWN = contribution('c-withdrawn', 'withdrawn', 'Old idea');
const ITEMS = [PENDING, CHANGES, APPROVED, REJECTED, WITHDRAWN];

/** What PUT answers after a good save: the updated resource, back to pending. */
const RESAVED = (name = 'Cone slalom 2') => contribution('c-changes', 'pending', name, { updatedAt: RESENT, attachments: CHANGES.attachments });

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const problem = (status: number, title: string, extra: Record<string, unknown> = {}) =>
  json({ type: 'about:blank', title, status, detail: `${title} (server text)`, errors: [], ...extra }, { status }, 'application/problem+json');
const invalid = (...pointers: string[]) =>
  problem(422, 'Unprocessable Entity', { errors: pointers.map((pointer) => ({ pointer, detail: `${pointer} is bad (server text)` })) });

type Answer = () => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: Array<{ url: URL; init: RequestInit | undefined }> = [];

const LIST_PATH = '/api/contributions/mine';
const META_PATH = '/api/contribute/meta';
const listCalls = () => calls.filter((call) => call.url.pathname === LIST_PATH);
const metaCalls = () => calls.filter((call) => call.url.pathname === META_PATH);
const putCalls = () => calls.filter((call) => call.init?.method === 'PUT');

/**
 * `list`, `meta`, `put`: the answers to GET /api/contributions/mine, GET /api/contribute/meta and PUT /api/contributions/:id, one
 * per call (the last one repeats). Anything else is a 404. Every request lands in `calls`.
 */
function serve({ list = [() => json(ITEMS)], meta = [() => json(META)], put = [] }: { list?: Answer[]; meta?: Answer[]; put?: Answer[] } = {}): void {
  const counts = { list: 0, meta: 0, put: 0 };
  const next = (answers: Answer[], key: keyof typeof counts): Answer => {
    const answer = answers[Math.min(counts[key], answers.length - 1)]!;
    counts[key] += 1;
    return answer;
  };
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ url, init });
    const method = init?.method ?? 'GET';
    if (url.pathname === LIST_PATH && method === 'GET') return next(list, 'list')();
    if (url.pathname === META_PATH && method === 'GET') return next(meta, 'meta')();
    if (url.pathname.startsWith('/api/contributions/') && method === 'PUT' && put.length > 0) return next(put, 'put')();
    return problem(404, 'Not Found');
  }) as unknown as typeof fetch;
}

/** A response the test releases by hand, to hold a request in flight. */
function deferred() {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release };
}

/*
 * Cross-file hygiene. bun runs every test file of the web package in ONE process with ONE happy-dom window, so whatever this
 * file leaves on the window/document is still there for the files that run after it. happy-dom records every element query it
 * has answered (each `querySelectorAll` behind a Testing Library query) in bookkeeping lists on the document and on <html>
 * (`affectsCache`, `affectsComputedStyleCache`) and in the window's selector cache, and never trims them; a heavy file leaves
 * thousands of entries there and slows (or times out) the files that run after it. After every test the DOM is empty, so the
 * lists are emptied the way happy-dom itself empties them when a node changes: every recorded result is invalidated first, then
 * the list is cleared. Written against happy-dom 20.x symbols by description; if they are not there it does nothing.
 */
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

let clients: QueryClient[] = [];

beforeEach(() => serve());
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients = [];
  globalThis.fetch = realFetch;
  window.history.pushState({}, '', '/'); // the 401 tests move the real location into the coach area
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './edit.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** The real route component inside a real (memory) router that also knows the screens it links to. */
function renderEdit(id = 'c-changes', locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  // gcTime Infinity: the success test reads the list back from the cache after the screen has left (nothing observes it any more).
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  clients.push(queryClient);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const editRoute = createRoute({ getParentRoute: () => rootRoute, path: '/contribute/$id/edit', component: Route.options.component });
  const mineRoute = createRoute({ getParentRoute: () => rootRoute, path: '/contribute/mine', component: () => <p>mine screen</p> });
  const signInRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/account/sign-in',
    validateSearch: (search: Record<string, unknown>) => ({ redirect: typeof search.redirect === 'string' ? search.redirect : undefined }),
    component: () => <p>sign-in screen</p>,
  });
  const drillRoute = createRoute({ getParentRoute: () => rootRoute, path: '/commons/$slug', component: () => <p>drill page</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editRoute, mineRoute, signInRoute, drillRoute]),
    history: createMemoryHistory({ initialEntries: [`/contribute/${id}/edit`] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, instance, queryClient, router };
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const LEAKS = ['undefined', 'NaN', 'null', '{{', '[object'];
const fill = (template: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce((out, [key, value]) => out.replaceAll(`{{${key}}}`, String(value)), template);

const saveButton = () => screen.getByRole('button', { name: /^(Save and resubmit|Saving…)$/ }) as HTMLButtonElement;
const control = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const type = (label: RegExp, value: string) => fireEvent.change(control(label), { target: { value } });
const rightsBox = () => screen.getByRole('checkbox', { name: /permission to share/i }) as HTMLInputElement;
const commercialBox = () => screen.getByRole('checkbox', { name: /not FIFA, UEFA or commercial content/i }) as HTMLInputElement;
const honeypot = () => document.querySelector('input[name="website"]') as HTMLInputElement;
const attestBoth = () => {
  fireEvent.click(rightsBox());
  fireEvent.click(commercialBox());
};
const isFlagged = (element: Element): boolean => element.getAttribute('aria-invalid') === 'true';
function describedBy(element: Element): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id))
    .map((node) => (node === null ? '' : text(node)))
    .join(' ');
}
const videoFile = (name = 'slalom-2.mp4', type_ = 'video/mp4', size?: number) => {
  const file = new File(['not really a video'], name, { type: type_ });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};
const chooseVideo = (file: File) => fireEvent.change(control(/^New video/), { target: { files: [file] } });

async function save() {
  await act(async () => {
    fireEvent.click(saveButton());
  });
}

/** The two attestations and the save button in any language (the English helpers above match English words). */
const attestBothIn = () => {
  const boxes = screen.getAllByRole('checkbox');
  expect(boxes).toHaveLength(2);
  for (const box of boxes) fireEvent.click(box);
};
const saveIn = async (locale: Locale) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: messages[locale].submit.label }));
  });
};

/** Renders and waits for the editable form. */
async function renderForm(id = 'c-changes', locale: Locale = 'en') {
  const view = renderEdit(id, locale);
  await screen.findByRole('button', { name: new RegExp(`^(${messages[locale].submit.label}|${messages[locale].submit.busy})$`) });
  return view;
}

/** Renders a decided contribution and waits for its read-only view (the tag with the state word). */
async function renderReadOnly(id: string, stateWord: string, locale: Locale = 'en') {
  const view = renderEdit(id, locale);
  await screen.findByText(stateWord, { selector: 'span' });
  return view;
}

/** The FormData of a PUT call and its parsed `payload` part. */
const formOf = (call: { init: RequestInit | undefined }): FormData => call.init?.body as FormData;
const payloadOf = (call: { init: RequestInit | undefined }): Record<string, unknown> => JSON.parse(String(formOf(call).get('payload'))) as Record<string, unknown>;

/** What the screen must send for CHANGES when only the name was edited and both boxes were ticked. */
const EXPECTED_PUT = {
  ...BASE_PAYLOAD,
  name: 'Cone slalom 2',
  rightsAttested: true,
  noCommercialContent: true,
  website: '',
};

// --- the requests -------------------------------------------------------------------------------

describe('the requests', () => {
  test('loads with one GET of the list and one GET of the meta for the language, and sends nothing else', async () => {
    await renderForm();
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]?.init?.method).toBe('GET');
    expect(metaCalls()).toHaveLength(1);
    expect(metaCalls()[0]?.url.searchParams.get('locale')).toBe('en');
    expect(calls).toHaveLength(2);
  });
});

// --- loading, empty, error ----------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status shows until the contribution arrives, with the title and no form, no invented data', async () => {
    const held = deferred();
    serve({ list: [() => held.promise] });
    renderEdit();

    const status = await screen.findByRole('status', { name: 'Loading your method' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Edit and resubmit' })).toBeTruthy();
    expect(document.querySelector('form') === null).toBe(true);
    expect(screen.queryByText(NOTE) === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);

    held.release(json(ITEMS));
    await screen.findByRole('button', { name: 'Save and resubmit' });
    expect(screen.queryByRole('status', { name: 'Loading your method' }) === null).toBe(true);
  });

  test('an editable contribution waits for the form lists (meta) before it shows the form', async () => {
    const held = deferred();
    serve({ meta: [() => held.promise] });
    renderEdit();
    await screen.findByRole('status', { name: 'Loading your method' });
    await waitFor(() => expect(metaCalls()).toHaveLength(1));
    expect(document.querySelector('form') === null).toBe(true);
    held.release(json(META));
    await screen.findByRole('button', { name: 'Save and resubmit' });
  });
});

describe('empty: nothing to edit', () => {
  for (const [name, list, id] of [
    ['an id that is not in the coach list', ITEMS, 'c-missing'],
    ['an empty list', [], 'c-changes'],
  ] as const) {
    test(`${name} is "not found": calm words, a way back, no form`, async () => {
      serve({ list: [() => json(list)] });
      renderEdit(id);
      await screen.findByText('We could not find this method');
      expect(screen.getByText('It may have been removed, or it may belong to another account.')).toBeTruthy();
      const back = screen.getByRole('link', { name: 'My contributions' });
      expect(back.getAttribute('href')).toBe('/contribute/mine');
      expect(document.querySelector('form') === null).toBe(true);
      expect(screen.queryByRole('button', { name: /Save and resubmit/ }) === null).toBe(true);
      expect(putCalls()).toHaveLength(0);
    });
  }

  test('a meta with no skill to choose says so and shows no form (the contract requires a skill)', async () => {
    serve({ meta: [() => json({ ...META, skills: [] })] });
    renderEdit();
    await screen.findByText('No skills to choose from yet');
    expect(document.querySelector('form') === null).toBe(true);
  });
});

describe('error', () => {
  test('a failed list read shows a localised error with Try again; retrying loads the form', async () => {
    serve({ list: [() => problem(500, 'Boom'), () => json(ITEMS)] });
    renderEdit();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load this method');
    expect(text(alert)).toContain(problemMessages.en.server);
    expect(text(alert)).not.toContain('Boom');
    expect(document.querySelector('form') === null).toBe(true);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Save and resubmit' });
    expect(listCalls()).toHaveLength(2);
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('a failed meta read shows its own error with Try again; retrying loads the form', async () => {
    serve({ meta: [() => problem(500, 'Boom'), () => json(META)] });
    renderEdit();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load the form lists');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Save and resubmit' });
    expect(metaCalls()).toHaveLength(2);
    expect(listCalls()).toHaveLength(1);
  });

  test('a network failure on the list is the offline message, not a raw error', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    renderEdit();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain(problemMessages.en.offline);
  });
});

// --- anonymous players --------------------------------------------------------------------------

describe('anonymous players are not contributors', () => {
  test('a 403 sends them to sign-in with this page as the return path, replacing it in the history, and shows no form and no error', async () => {
    serve({ list: [() => problem(403, 'Forbidden')] });
    const { router } = renderEdit();
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/sign-in'));
    expect((router.state.location.search as { redirect?: string }).redirect).toBe('/contribute/c-changes/edit');
    await screen.findByText('sign-in screen');
    expect(document.querySelector('form') === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(router.history.length).toBe(1);
    expect(putCalls()).toHaveLength(0);
  });

  test('a 401 (no session at all) is treated the same way', async () => {
    // A 401 in a coach area is not retried as an anonymous player (features/account/session-expired.ts): be in one.
    window.history.pushState({}, '', '/contribute/c-changes/edit');
    serve({ list: [() => problem(401, 'Unauthorized')] });
    const { router } = renderEdit();
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/sign-in'));
    expect((router.state.location.search as { redirect?: string }).redirect).toBe('/contribute/c-changes/edit');
  });

  test('a 404 or a 500 on the list is an ordinary error, not a sign-in redirect', async () => {
    serve({ list: [() => problem(404, 'Not Found')] });
    const { router } = renderEdit();
    await screen.findByRole('alert');
    expect(router.state.location.pathname).toBe('/contribute/c-changes/edit');
  });
});

// --- the reviewer's note ------------------------------------------------------------------------

describe("the reviewer's note is on top", () => {
  test('a changes-requested contribution shows its name, its state word and the note, all before the form', async () => {
    await renderForm();
    const note = screen.getByText(NOTE);
    expect(screen.getByText('Note from the reviewer')).toBeTruthy();
    const form = document.querySelector('form')!;
    // DOCUMENT_POSITION_FOLLOWING (4): the form comes after the note.
    expect(note.compareDocumentPosition(form) & 4).toBe(4);
    expect(screen.getByText('Changes requested', { selector: 'span' })).toBeTruthy();
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 2, name: 'Cone slalom' })).toBeTruthy();
    expect(screen.getByText(/The reviewer asked for changes/)).toBeTruthy();
  });

  test('a pending contribution has no note block (nothing invented) but says it can still be changed', async () => {
    await renderForm('c-pending');
    expect(screen.queryByText('Note from the reviewer') === null).toBe(true);
    expect(screen.getByText('Pending', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText(/You can still change it/)).toBeTruthy();
  });
});

// --- prefill ------------------------------------------------------------------------------------

describe('the form is pre-filled from the stored contribution', () => {
  test('every field shows what was stored', async () => {
    await renderForm();
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Cone slalom');
    expect((control(/^Sport/) as HTMLSelectElement).value).toBe('football');
    expect((control(/^Skill/) as HTMLSelectElement).value).toBe('inside-touches');
    expect((control(/^Age from/) as HTMLInputElement).value).toBe('8');
    expect((control(/^Age to/) as HTMLInputElement).value).toBe('12');
    expect((control(/^Difficulty/) as HTMLSelectElement).value).toBe('basic');
    expect((control(/^Goal/) as HTMLSelectElement).value).toBe('dribbling');
    expect((control(/^Duration/) as HTMLInputElement).value).toBe('10');
    expect((control(/^Equipment/) as HTMLSelectElement).value).toBe('cones');
    expect((control(/^Instructions/) as HTMLTextAreaElement).value).toBe(BASE_PAYLOAD.instructions);
    expect((control(/^Common mistakes/) as HTMLTextAreaElement).value).toBe(BASE_PAYLOAD.mistakes);
    expect((control(/^Progression/) as HTMLTextAreaElement).value).toBe(BASE_PAYLOAD.progression);
    expect((control(/^Regression/) as HTMLTextAreaElement).value).toBe(BASE_PAYLOAD.regression);
    expect((control(/^Safety/) as HTMLTextAreaElement).value).toBe('');
    expect((control(/^Source/) as HTMLInputElement).value).toBe('My own session');
    expect((control(/^Author/) as HTMLInputElement).value).toBe('Aidar Coach');
  });

  test('the choice fields offer the meta lists, and the skill is shown by its name', async () => {
    await renderForm();
    const skill = control(/^Skill/) as HTMLSelectElement;
    expect(Array.from(skill.options).map((option) => text(option))).toContain('– Inside Touches');
    expect(Array.from((control(/^Difficulty/) as HTMLSelectElement).options).map((o) => o.value)).toEqual(['', 'beginner', 'basic', 'intermediate']);
  });

  test('the attestations start unticked every time, the honeypot is empty, and no video is chosen', async () => {
    await renderForm();
    expect(rightsBox().checked).toBe(false);
    expect(commercialBox().checked).toBe(false);
    expect(honeypot().value).toBe('');
    expect(((control(/^New video/) as HTMLInputElement).files?.length ?? 0)).toBe(0);
  });

  test('the stored files are listed as links (the filename, or the kind when there is none), with the replace rule', async () => {
    await renderForm();
    const files = screen.getByRole('list', { name: 'Current files' });
    const video = within(files).getByRole('link', { name: 'slalom.mp4' });
    expect(video.getAttribute('href')).toBe('/media/a-1.mp4');
    expect(within(files).getByRole('link', { name: 'Image' }).getAttribute('href')).toBe('/media/a-2.jpg');
    expect(screen.getByText('If you choose a new video, it replaces all of these files.')).toBeTruthy();
  });

  test('a contribution with no files lists none', async () => {
    await renderForm('c-pending');
    expect(screen.queryByRole('list', { name: 'Current files' }) === null).toBe(true);
  });

  test('a stored choice the meta no longer offers is left blank and must be chosen again before saving', async () => {
    serve({ list: [() => json([contribution('c-changes', 'changes_requested', 'Cone slalom', {}, { skill: 'retired-skill' })])] });
    await renderForm();
    expect((control(/^Skill/) as HTMLSelectElement).value).toBe('');
    attestBoth();
    await save();
    expect(isFlagged(control(/^Skill/))).toBe(true);
    expect(describedBy(control(/^Skill/))).toContain('Choose one.');
    expect(putCalls()).toHaveLength(0);
  });
});

// --- the PUT ------------------------------------------------------------------------------------

describe('saving: PUT /api/contributions/:id', () => {
  test('one multipart PUT to the contribution, with the edited answers as a contract-valid payload part and nothing else', async () => {
    serve({ put: [() => json(RESAVED())] });
    await renderForm();
    type(/^Name of the method/, '  Cone slalom 2  ');
    attestBoth();
    await save();
    await waitFor(() => expect(putCalls()).toHaveLength(1));

    const call = putCalls()[0]!;
    expect(call.url.pathname).toBe('/api/contributions/c-changes');
    expect(call.init?.body instanceof FormData).toBe(true);
    expect(Array.from(formOf(call).keys())).toEqual(['payload']);
    const payload = payloadOf(call);
    expect(payload).toEqual(EXPECTED_PUT);
    expect(ContributionPayloadRequest.safeParse(payload).success).toBe(true);
    expect(new Headers(call.init?.headers).get('accept-language')).toBe('en');
    // one PUT, and the two reads: nothing else was called
    expect(calls).toHaveLength(3);
  });

  test('edited numbers, choices and texts are what is sent (numbers as numbers, blanks kept blank)', async () => {
    serve({ put: [() => json(RESAVED())] });
    await renderForm();
    type(/^Age from/, '7');
    type(/^Age to/, '10');
    type(/^Duration/, '20');
    type(/^Difficulty/, 'beginner');
    type(/^Goal/, 'passing');
    type(/^Equipment/, 'ball');
    type(/^Skill/, 'passing');
    type(/^Instructions/, '  New steps.  ');
    type(/^Common mistakes/, '');
    type(/^Safety/, 'Keep clear of the fence.');
    attestBoth();
    await save();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(payloadOf(putCalls()[0]!)).toEqual({
      ...EXPECTED_PUT,
      name: 'Cone slalom',
      ageMin: 7,
      ageMax: 10,
      durationMin: 20,
      level: 'beginner',
      goal: 'passing',
      equipment: 'ball',
      skill: 'passing',
      instructions: 'New steps.',
      mistakes: '',
      safety: 'Keep clear of the fence.',
    });
  });

  test('what the screen does not edit goes back as it was stored: the content language, and an improvement’s target, kind and link', async () => {
    serve({ put: [() => json(contribution('c-pending', 'pending', 'Wall passes 2', { updatedAt: RESENT }))] });
    await renderForm('c-pending');
    type(/^Name of the method/, 'Wall passes 2');
    attestBoth();
    await save();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const call = putCalls()[0]!;
    expect(call.url.pathname).toBe('/api/contributions/c-pending');
    const payload = payloadOf(call);
    expect(payload).toEqual({
      ...BASE_PAYLOAD,
      name: 'Wall passes 2',
      kind: 'improvement',
      targetDrillSlug: 'wall-passes-basic',
      improvementKind: 'progression',
      sourceUrl: 'https://example.org/wall',
      locale: 'en',
      rightsAttested: true,
      noCommercialContent: true,
      website: '',
    });
    expect(ContributionPayloadRequest.safeParse(payload).success).toBe(true);
  });

  test('the content language is the stored one, not the language of the screen', async () => {
    serve({ put: [() => json(RESAVED())] });
    await renderForm('c-changes', 'kk');
    attestBothIn();
    await saveIn('kk');
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(payloadOf(putCalls()[0]!).locale).toBe('ru');
    expect(new Headers(putCalls()[0]!.init?.headers).get('accept-language')).toBe('kk');
  });

  test('a new video goes as the `video` part, in the same one request', async () => {
    serve({ put: [() => json(RESAVED())] });
    await renderForm();
    const file = videoFile();
    chooseVideo(file);
    attestBoth();
    await save();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const form = formOf(putCalls()[0]!);
    expect(Array.from(form.keys()).sort()).toEqual(['payload', 'video']);
    const sent = form.get('video') as File;
    expect(sent instanceof File).toBe(true);
    expect(sent.name).toBe('slalom-2.mp4');
    expect(putCalls()).toHaveLength(1);
  });

  test('on success the returned contribution replaces the item in the list cache (pending) and the screen goes to My contributions', async () => {
    serve({ put: [() => json(RESAVED())] });
    const { router, queryClient } = await renderForm();
    type(/^Name of the method/, 'Cone slalom 2');
    attestBoth();
    await save();
    await waitFor(() => expect(router.state.location.pathname).toBe('/contribute/mine'));
    await screen.findByText('mine screen');

    const cached = queryClient.getQueryData<Contribution[]>(['contributions', 'mine']);
    expect(cached?.map((item) => item.id)).toEqual(ITEMS.map((item) => item.id));
    const item = cached?.find((entry) => entry.id === 'c-changes');
    expect(item?.state).toBe('pending');
    expect(item?.payload.name).toBe('Cone slalom 2');
    expect(item?.updatedAt).toBe(RESENT);
    // the other items are untouched
    expect(cached?.find((entry) => entry.id === 'c-approved')?.state).toBe('approved');
    // it went there by replacing this page, so Back does not return to a form that was just sent
    expect(router.history.length).toBe(1);
  });
});

// --- validation ---------------------------------------------------------------------------------

describe('validation: nothing is sent while an answer is bad', () => {
  test('both attestations are required: none, then only one', async () => {
    await renderForm();
    await save();
    expect(putCalls()).toHaveLength(0);
    expect(isFlagged(rightsBox())).toBe(true);
    expect(isFlagged(commercialBox())).toBe(true);
    expect(describedBy(rightsBox())).toContain('Tick this to confirm you may share the method.');
    expect(describedBy(commercialBox())).toContain('Tick this to confirm the method is not FIFA, UEFA or commercial content.');
    expect(screen.getByText('Some answers need a look. They are marked below.')).toBeTruthy();
    // focus lands on the first problem
    expect(document.activeElement === rightsBox()).toBe(true);

    fireEvent.click(rightsBox());
    expect(isFlagged(rightsBox())).toBe(false);
    await save();
    expect(putCalls()).toHaveLength(0);
    expect(isFlagged(commercialBox())).toBe(true);
  });

  test('a blank name is refused in the app’s words, flagged, and focused', async () => {
    await renderForm();
    type(/^Name of the method/, '   ');
    attestBoth();
    await save();
    expect(putCalls()).toHaveLength(0);
    const name = control(/^Name of the method/);
    expect(isFlagged(name)).toBe(true);
    expect(describedBy(name)).toContain('Fill this in.');
    expect(document.activeElement === name).toBe(true);
  });

  test('ages, duration and choices are checked', async () => {
    await renderForm();
    type(/^Age from/, '12');
    type(/^Age to/, '8');
    type(/^Duration/, '0');
    type(/^Goal/, '');
    attestBoth();
    await save();
    expect(putCalls()).toHaveLength(0);
    expect(describedBy(control(/^Age to/))).toContain('This cannot be lower than the youngest age.');
    expect(describedBy(control(/^Duration/))).toContain('Enter the minutes as a whole number above 0.');
    expect(describedBy(control(/^Goal/))).toContain('Choose one.');

    type(/^Age from/, 'eight');
    await save();
    expect(describedBy(control(/^Age from/))).toContain('Use a whole number, like 8.');
    expect(putCalls()).toHaveLength(0);
  });

  test('a video that is too big or of a wrong type is refused before anything is sent', async () => {
    await renderForm();
    attestBoth();
    chooseVideo(videoFile('big.mp4', 'video/mp4', 51 * 1024 * 1024));
    await save();
    expect(describedBy(control(/^New video/))).toContain('This video is over 50 MB.');
    chooseVideo(videoFile('clip.zip', 'application/zip'));
    await save();
    expect(describedBy(control(/^New video/))).toContain('This is not an allowed video type.');
    expect(putCalls()).toHaveLength(0);
  });

  test('the video hint says the limit and the types from the meta', async () => {
    await renderForm();
    expect(text(document.getElementById(control(/^New video/).id + '-hint')!)).toBe('Up to 50 MB. Allowed: MP4, WEBM, MOV.');
  });
});

// --- disabled while in flight -------------------------------------------------------------------

describe('disabled while a request is in flight', () => {
  test('the save button is disabled and busy, every field is disabled, a second submit sends nothing, then it goes to My contributions', async () => {
    const held = deferred();
    serve({ put: [() => held.promise] });
    const { router } = await renderForm();
    attestBoth();
    await save();
    await waitFor(() => expect(putCalls()).toHaveLength(1));

    const button = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    const controls = Array.from(document.querySelectorAll('form input:not([name="website"]), form select, form textarea')) as HTMLInputElement[];
    expect(controls.length).toBeGreaterThan(15);
    expect(controls.filter((c) => !c.disabled).map((c) => c.id)).toEqual([]);
    expect(screen.getByText('Saving your changes…')).toBeTruthy();

    fireEvent.click(button);
    fireEvent.submit(document.querySelector('form')!);
    await act(async () => {});
    expect(putCalls()).toHaveLength(1);

    held.release(json(RESAVED()));
    await waitFor(() => expect(router.state.location.pathname).toBe('/contribute/mine'));
    expect(putCalls()).toHaveLength(1);
  });

  test('with a new video the wait says it can take a while', async () => {
    const held = deferred();
    serve({ put: [() => held.promise] });
    await renderForm();
    chooseVideo(videoFile());
    attestBoth();
    await save();
    await screen.findByText('Saving your changes and the new video. This can take a while.');
    held.release(json(RESAVED()));
  });
});

// --- failures -----------------------------------------------------------------------------------

describe('a refused or failed save keeps the answers and the form editable', () => {
  test('422 pointers land on their fields with localised words (never the server’s text), the first one is focused', async () => {
    serve({ put: [() => invalid('/durationMin', '/name', '/rightsAttested')] });
    await renderForm();
    type(/^Name of the method/, 'Cone slalom 2');
    attestBoth();
    await save();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    await waitFor(() => expect(isFlagged(control(/^Name of the method/))).toBe(true));

    expect(describedBy(control(/^Name of the method/))).toContain('This answer was not accepted. Check it and try again.');
    expect(isFlagged(control(/^Duration/))).toBe(true);
    expect(isFlagged(rightsBox())).toBe(true);
    expect(isFlagged(control(/^Instructions/))).toBe(false);
    expect(document.body.textContent).not.toContain('server text');
    // the answers are kept, the form is editable and can be sent again
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Cone slalom 2');
    expect(saveButton().disabled).toBe(false);
    expect(document.activeElement === control(/^Name of the method/)).toBe(true);
  });

  test('a pointer that names no field, or the honeypot, becomes a form-level message', async () => {
    serve({ put: [() => invalid('/sourceUrl', '/website')] });
    await renderForm();
    attestBoth();
    await save();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain(problemMessages.en.unknown);
    expect(document.body.textContent).not.toContain('server text');
    expect(saveButton().disabled).toBe(false);
  });

  test('413 and 415 with a chosen video land on the video field with the limit or the types', async () => {
    serve({ put: [() => problem(413, 'Payload Too Large'), () => problem(415, 'Unsupported Media Type')] });
    await renderForm();
    chooseVideo(videoFile());
    attestBoth();
    await save();
    await waitFor(() => expect(describedBy(control(/^New video/))).toContain('The video is over 50 MB. Choose a smaller file.'));
    await save();
    await waitFor(() => expect(describedBy(control(/^New video/))).toContain('This video type was not accepted. Choose another file.'));
    expect(putCalls()).toHaveLength(2);
  });

  test('429 and a network failure say so in words, keep the answers, and the second try can succeed', async () => {
    serve({ put: [() => problem(429, 'Too Many Requests'), () => Promise.reject(new TypeError('Failed to fetch')), () => json(RESAVED())] });
    const { router } = await renderForm();
    type(/^Name of the method/, 'Cone slalom 2');
    attestBoth();
    await save();
    expect(text(await screen.findByRole('alert'))).toContain(problemMessages.en.rateLimited);
    expect(saveButton().disabled).toBe(false);

    await save();
    await waitFor(() => expect(text(screen.getByRole('alert'))).toContain(problemMessages.en.offline));
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Cone slalom 2');

    await save();
    await waitFor(() => expect(router.state.location.pathname).toBe('/contribute/mine'));
    expect(putCalls()).toHaveLength(3);
  });

  test('a 404 says so and re-reads the list: a contribution that is gone becomes "not found"', async () => {
    serve({ list: [() => json(ITEMS), () => json(ITEMS.filter((item) => item.id !== 'c-changes'))], put: [() => problem(404, 'Not Found')] });
    await renderForm();
    attestBoth();
    await save();
    await screen.findByText('We could not find this method');
    expect(listCalls()).toHaveLength(2);
    expect(document.querySelector('form') === null).toBe(true);
  });

  test('a 409 because someone decided meanwhile re-reads the list: the screen becomes the read-only view of the real state', async () => {
    const decided = contribution('c-changes', 'approved', 'Cone slalom', { reviewerNote: 'Approved after all.', resultingDrillSlug: 'cone-slalom' });
    serve({ list: [() => json(ITEMS), () => json([decided])], put: [() => problem(409, 'Conflict')] });
    await renderForm();
    attestBoth();
    await save();
    await screen.findByText('Approved', { selector: 'span' });
    expect(listCalls()).toHaveLength(2);
    expect(document.querySelector('form') === null).toBe(true);
    expect(screen.getByText('Approved after all.')).toBeTruthy();
    expect(putCalls()).toHaveLength(1);
  });

  test('a 409 duplicate (its `instance` names another contribution of yours) says so and links to editing that one', async () => {
    serve({ put: [() => problem(409, 'Conflict', { instance: '/api/contributions/c-pending', contributionId: 'c-pending' })] });
    await renderForm();
    attestBoth();
    await save();
    const notice = await screen.findByRole('alert');
    expect(text(notice)).toContain('You already have an identical method waiting for a decision. Edit that one instead.');
    const link = within(notice).getByRole('link', { name: 'Edit that method' });
    expect(link.getAttribute('href')).toBe('/contribute/c-pending/edit');
    // it is not a stale-list conflict: the list is not read again, and the form stays
    expect(listCalls()).toHaveLength(1);
    expect(saveButton().disabled).toBe(false);
  });
});

// --- decided states are read-only ---------------------------------------------------------------

describe('decided contributions are read-only', () => {
  for (const [id, word, note] of [
    ['c-approved', 'Approved', 'Thanks, this is published.'],
    ['c-rejected', 'Rejected', 'This is a fitness drill without a ball.'],
  ] as const) {
    test(`${word}: the state, the note and the answers are shown; there is no form, no field and no save button`, async () => {
      await renderReadOnly(id, word);
      expect(screen.getByText(note)).toBeTruthy();
      expect(screen.getByText('Note from the reviewer')).toBeTruthy();
      expect(screen.getByText(/can no longer be edited/)).toBeTruthy();
      expect(document.querySelector('form') === null).toBe(true);
      expect(screen.queryAllByRole('textbox')).toHaveLength(0);
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: /Save and resubmit|Saving/ }) === null).toBe(true);
      // what was sent is still readable
      expect(screen.getByText(BASE_PAYLOAD.instructions)).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Back to My contributions' }).getAttribute('href')).toBe('/contribute/mine');
      expect(putCalls()).toHaveLength(0);
    });
  }

  test('withdrawn: read-only too, and with no note there is no note block', async () => {
    await renderReadOnly('c-withdrawn', 'Withdrawn');
    expect(screen.queryByText('Note from the reviewer') === null).toBe(true);
    expect(document.querySelector('form') === null).toBe(true);
    expect(screen.queryByRole('button', { name: /Save and resubmit/ }) === null).toBe(true);
  });

  test('approved with a published drill links to it; without a slug there is no link', async () => {
    await renderReadOnly('c-approved', 'Approved');
    expect(screen.getByRole('link', { name: 'View the published drill' }).getAttribute('href')).toBe('/commons/two-touch-turns');
    cleanup();
    serve({ list: [() => json([contribution('c-approved', 'approved', 'Two-touch turns')])] });
    await renderReadOnly('c-approved', 'Approved');
    expect(screen.queryByRole('link', { name: 'View the published drill' }) === null).toBe(true);
  });

  test('the answers show the stored words: names from the meta when it loaded, choices in the language', async () => {
    await renderReadOnly('c-rejected', 'Rejected');
    await screen.findByText('Inside Touches');
    expect(screen.getByText('Football')).toBeTruthy();
    expect(screen.getByText('Basic')).toBeTruthy();
    expect(screen.getByText('Dribbling')).toBeTruthy();
    expect(screen.getByText('Cones')).toBeTruthy();
  });

  test('a meta that cannot be read does not block the read-only view (it needs no lists): the slug is shown instead', async () => {
    serve({ meta: [() => problem(500, 'Boom')] });
    await renderReadOnly('c-rejected', 'Rejected');
    await screen.findByText('inside-touches');
    expect(screen.queryByRole('alert') === null).toBe(true);
  });
});

// --- languages ----------------------------------------------------------------------------------

/** Dotted paths of every string leaf. */
function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
  );
}

describe('kk, ru and en', () => {
  test('every locale has exactly the same keys, and every string is real text', () => {
    const en = leafKeys(messages.en).sort();
    expect(en.length).toBeGreaterThan(80);
    expect(leafKeys(messages.kk).sort()).toEqual(en);
    expect(leafKeys(messages.ru).sort()).toEqual(en);
    for (const locale of LOCALES) {
      for (const key of en) {
        const value = key.split('.').reduce<unknown>((tree, part) => (tree as Record<string, unknown>)[part], messages[locale]);
        expect(typeof value === 'string' && value.trim() !== '').toBe(true);
      }
    }
  });

  for (const locale of ['kk', 'ru'] as const) {
    test(`${locale}: the whole editable screen is in ${locale}, with the note on top and no leaked key or placeholder`, async () => {
      await renderForm('c-changes', locale);
      const main = screen.getByRole('main');
      expect(screen.getByRole('heading', { level: 1, name: messages[locale].title })).toBeTruthy();
      expect(screen.getByText(NOTE)).toBeTruthy();
      expect(screen.getByText(messages[locale].note.label)).toBeTruthy();
      expect(screen.getByText(messages[locale].state.changes_requested, { selector: 'span' })).toBeTruthy();
      expect(control(new RegExp(`^${messages[locale].fields.name.label}`))).toBeTruthy();
      expect(screen.getByRole('checkbox', { name: messages[locale].attest.noCommercial })).toBeTruthy();
      expect(screen.getByText(fill(messages[locale].fields.video.hint, { maxMb: 50, types: 'MP4, WEBM, MOV' }))).toBeTruthy();
      const body = text(main);
      expect(/\p{Script=Cyrillic}/u.test(body)).toBe(true);
      for (const leak of LEAKS) expect(body).not.toContain(leak);
    });

    test(`${locale}: the read-only view, the not-found state and a refused save are in ${locale}`, async () => {
      await renderReadOnly('c-approved', messages[locale].state.approved, locale);
      expect(screen.getByText(messages[locale].stateHint.approved)).toBeTruthy();
      expect(document.querySelector('form') === null).toBe(true);
      cleanup();
      renderEdit('c-missing', locale);
      await screen.findByText(messages[locale].notFound.title);
      cleanup();

      serve({ put: [() => invalid('/name')] });
      await renderForm('c-changes', locale);
      attestBothIn();
      await saveIn(locale);
      await waitFor(() => expect(putCalls()).toHaveLength(1));
      await waitFor(() => expect(describedBy(control(new RegExp(`^${messages[locale].fields.name.label}`)))).toContain(messages[locale].errors.fieldRejected));
      const body = text(screen.getByRole('main'));
      for (const leak of LEAKS) expect(body).not.toContain(leak);
    });
  }
});

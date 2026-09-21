import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DecisionResponse, ModerationQueueItem } from '@api-types/admin';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import trustMessages from '../commons/trust-badge.messages';
import queueMessages from './queue.messages';
import messages from './review.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as queue.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { Route } = await import('../../routes/admin/contributions.$id');
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Contract under test (fc-mol-0v3.10, narrowed by the coordinator): /admin/contributions/:id is the dedicated review screen for ONE
 * contribution. The queue (routes/admin/index.tsx) already shows the submission, the diff and a note-only decision; this screen adds
 * what the queue has no room for: the private video, a moderation checklist, inline edits of the content fields the API accepts for
 * the contribution's kind, and an approval that carries the edits, the initial trust status and an organisation label in ONE request
 * (POST /api/admin/contributions/:id/decision, apps/api/src/shared/admin.ts). Request changes and Reject need a note.
 *
 * There is no single-contribution endpoint, so the screen reads GET /api/admin/contributions?state=<state> and picks its id out of
 * the answer, asking pending first and then the other queue states until it finds it, or says it is not waiting for review.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query inside a real (memory-history) router; the only stand-in
 * is the network (globalThis.fetch). Fixtures are parsed with the shared contract schemas. Kazakh and Russian copy still needs a
 * native-speaker review: for those locales these tests pin only that text exists, is Cyrillic and never leaks 'undefined', a raw
 * key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - The video plays from the private media route /api/media/<attachment id> (never the attachment's own url), other files are links to it.
 * - The checklist (three ticks) gates Approve only: an approval with an unticked item is refused on the screen with no request.
 *   Nothing about it is sent (the contract has no field for it). Reject and Request changes do not need it.
 * - Editable = the content fields the API takes: for a NEW method name, sport, skill, goal, ages, level, instructions, duration,
 *   equipment, the four notes, source and source link; for an IMPROVEMENT the same minus sport, skill and goal (the drill keeps its
 *   own). Author, language, kind and the drill it improves are never editable, so they get no control. Only CHANGED fields are sent,
 *   in `edits`, and only with an approval. A blank source link is never sent (the API cannot remove a link).
 * - Approve always names the trust status (Community is preselected). Expert and Academy verified need a note; Academy verified also
 *   needs the organisation, which is offered for the two verified statuses only and sent when it is not blank.
 * - The screen's own words are shown for a server 422 (never the server's text), at the field the pointer names.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const SENT = '2026-09-01T09:00:00.000Z';
const UPDATED = '2026-09-03T09:00:00.000Z';

interface Options {
  payload?: Record<string, unknown>;
  contribution?: Record<string, unknown>;
  submitter?: { id: string; name: string };
  diff?: unknown[];
}

const queueItem = (id: string, state: string, name: string, options: Options = {}) =>
  ModerationQueueItem.parse({
    contribution: {
      id,
      state,
      payload: {
        kind: 'new',
        locale: 'en',
        name,
        sport: 'football',
        skill: 'dribbling-basics',
        ageMin: 8,
        ageMax: 12,
        level: 'beginner',
        goal: 'dribbling',
        instructions: 'Weave the ball through the cones.',
        durationMin: 10,
        equipment: 'cones',
        mistakes: 'Looking only at the ball.',
        progression: '',
        regression: '',
        safety: 'Use soft cones.',
        source: 'My own session',
        sourceUrl: 'https://example.org/cone-slalom',
        author: 'Aidar Coach',
        ...options.payload,
      },
      attachments: [],
      createdAt: SENT,
      updatedAt: UPDATED,
      ...options.contribution,
    },
    submitter: options.submitter ?? { id: 'u-1', name: 'Aidar Coach' },
    ...(options.diff === undefined ? {} : { diff: options.diff }),
  });

const NEW_ITEM = queueItem('c-new', 'pending', 'Cone slalom', {
  contribution: {
    attachments: [
      { id: 'a-1', kind: 'video', url: '/uploads/a-1.mp4', filename: 'slalom.mp4', mimeType: 'video/mp4', size: 3_145_728 },
      { id: 'a-2', kind: 'image', url: '/uploads/a-2.png', filename: 'cones.png', mimeType: 'image/png', size: 20_480 },
      { id: 'a-3', kind: 'document', url: '/uploads/a-3.pdf', filename: 'rules.pdf', mimeType: 'application/pdf', size: 2048 },
    ],
  },
});

const IMPROVEMENT = queueItem('c-imp', 'pending', 'Wall passes', {
  submitter: { id: 'u-2', name: 'Dana Coach' },
  payload: { kind: 'improvement', targetDrillSlug: 'wall-passes-basic', improvementKind: 'explanation', skill: 'passing-basics', goal: 'passing', author: 'Dana Coach' },
  diff: [{ field: 'instructions.en', before: 'Pass hard.', after: 'Pass firmly, then trap the ball.' }],
});

const CHANGES = queueItem('c-changes', 'changes_requested', 'Zig-zag runs', { contribution: { reviewerNote: 'Please add a safety note for the cones.' } });
const APPROVED = queueItem('c-approved', 'approved', 'Two-touch turns', {
  contribution: { reviewerNote: 'Thanks, this is published.', resultingDrillSlug: 'two-touch-turns' },
});

const BY_STATE: Record<string, unknown[]> = {
  pending: [NEW_ITEM, IMPROVEMENT],
  changes_requested: [CHANGES],
  approved: [APPROVED],
  rejected: [],
};

/** What the API answers to an approval: the updated contribution (as the reviewer left it) and the drill it created. */
const approvedResponse = (from: ReturnType<typeof queueItem>, payload: Record<string, unknown> = {}, slug = 'cone-slalom') =>
  DecisionResponse.parse({
    contribution: {
      ...from.contribution,
      state: 'approved',
      payload: { ...from.contribution.payload, ...payload },
      reviewerNote: 'Checked on site.',
      resultingDrillSlug: slug,
      updatedAt: '2026-09-05T09:00:00.000Z',
    },
    drill: {
      slug,
      versionId: 'ver-1',
      content: {
        title: { en: 'Cone slalom' },
        goal: { en: 'Dribbling' },
        instructions: { en: 'Weave.' },
        dose: { reps: 5 },
        conditions: { equipment: 'cones', spaces: ['field'], partner: false },
      },
      attribution: { author: 'Aidar Coach', source: 'My own session', license: 'CC-BY-SA-4.0', createdAt: '2026-09-05T09:00:00.000Z', semver: '1.0.0' },
      history: [],
      reviews: [],
    },
  });

const decidedResponse = (from: ReturnType<typeof queueItem>, state: 'rejected' | 'changes_requested', note: string) =>
  DecisionResponse.parse({ contribution: { ...from.contribution, state, reviewerNote: note, updatedAt: '2026-09-05T09:00:00.000Z' } });

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const problem = (status: number, title: string, errors: Array<{ pointer: string; detail: string }> = []) =>
  json({ type: 'about:blank', title, status, detail: `${title} (server text)`, errors }, { status }, 'application/problem+json');

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
type Answer = () => Response | Promise<Response>;
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

const LIST_PATH = '/api/admin/contributions';
const listCalls = () => calls.filter((call) => call.url.pathname === LIST_PATH);
const listedStates = () => listCalls().map((call) => call.url.searchParams.get('state'));
const decisionCalls = () => calls.filter((call) => call.url.pathname.endsWith('/decision'));
const bodyOf = (call: { init: RequestInit | undefined } | undefined): unknown => JSON.parse(String(call?.init?.body));

/**
 * `lists`: per state, the answers to GET /api/admin/contributions?state=<state>, one per call (the last repeats); a state with no
 * entry answers with BY_STATE. `decide`: the answers to POST /api/admin/contributions/:id/decision, one per call (the last repeats).
 * Anything else is a 404.
 */
function serve({ lists = {}, decide = [] }: { lists?: Record<string, Answer[]>; decide?: Answer[] } = {}): void {
  const listed: Record<string, number> = {};
  let decided = 0;
  stubNetwork((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.pathname === LIST_PATH && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'all';
      const answers = lists[state] ?? [() => json(BY_STATE[state] ?? [])];
      const index = listed[state] ?? 0;
      listed[state] = index + 1;
      return answers[Math.min(index, answers.length - 1)]!();
    }
    if (url.pathname.startsWith(`${LIST_PATH}/`) && url.pathname.endsWith('/decision') && method === 'POST' && decide.length > 0) {
      const next = decide[Math.min(decided, decide.length - 1)]!;
      decided += 1;
      return next();
    }
    return problem(404, 'Not Found');
  });
}

/** A response the test releases by hand, to hold a request in flight. */
function deferred() {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release };
}

/*
 * Cross-file hygiene. bun runs every test file of the web package in ONE process with ONE happy-dom window, so whatever this file
 * leaves on the window/document is still there for the files that run after it. happy-dom records every element query it has answered
 * (each `querySelectorAll` behind a Testing Library query) in bookkeeping lists on the document and on <html> (`affectsCache`,
 * `affectsComputedStyleCache`) and in the window's selector cache, and never trims them. This file asks thousands of questions, so in
 * the whole-package run it would leave many thousands of entries there and slow down (to the point of a 5 s timeout) whichever file
 * fails an `expect(element)` after it. After every test the DOM is empty, so the lists are emptied the way happy-dom itself empties
 * them when a node changes: every recorded result is invalidated first, then the list is cleared (same pattern as
 * features/contribute/form.test.tsx). Written against happy-dom 20.x symbols by description; if they are not there it does nothing.
 * The other globals this file touches are put back below: fetch and the location. It never touches localStorage (`noStorage`), the
 * app's i18n singleton (isolated instances), the session atom or timers.
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

beforeEach(() => serve());
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.history.pushState({}, '', '/');
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './review.messages.ts': { default: messages },
  './queue.messages.ts': { default: queueMessages },
  '../commons/trust-badge.messages.ts': { default: trustMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** The real route component inside a real (memory) router that also knows the two screens it links to. */
function renderReview(id: string, locale: Locale = 'en', gcTime = 0) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const reviewRoute = Route.update({ id: '/admin/contributions/$id', path: '/admin/contributions/$id', getParentRoute: () => rootRoute } as never);
  const queueRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: () => <p>QUEUE STAND-IN</p> });
  const drillRoute = createRoute({ getParentRoute: () => rootRoute, path: '/commons/$slug', component: () => <p>drill page</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([reviewRoute as never, queueRoute, drillRoute]),
    history: createMemoryHistory({ initialEntries: [`/admin/contributions/${encodeURIComponent(id)}`] }),
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
const CYRILLIC = /[Ѐ-ӿ]/;
const absent = (element: unknown): boolean => element === null;

/** Renders and waits for the contribution's page title. */
async function renderLoaded(id: string, name: string, locale: Locale = 'en') {
  const view = renderReview(id, locale);
  await screen.findByRole('heading', { level: 1, name });
  return view;
}

type User = ReturnType<typeof userEvent.setup>;
type Field = HTMLInputElement | HTMLTextAreaElement;

const box = (name: string) => screen.getByRole('textbox', { name }) as Field;
const maybeBox = (name: string) => screen.queryByRole('textbox', { name });
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;
const tick = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const approveButton = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
const changesButton = () => screen.getByRole('button', { name: 'Request changes' }) as HTMLButtonElement;
const rejectButton = () => screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
const noteBox = () => box('Note to the coach');
const backLink = () => screen.getByRole('link', { name: 'Back to the queue' });

const ORIGINAL = /^The content is original/;
const SAFE = /^It is safe for children/;
const MINORS = /^No identifiable child/;
/** Ticks the three moderation checks. */
async function tickAll(user: User) {
  for (const name of [ORIGINAL, SAFE, MINORS]) await user.click(tick(name));
}

/** The words an element is described by (its aria-describedby targets), which is where its hint and its error live. */
function describedBy(element: Element): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const target = document.getElementById(id);
      return target === null ? '' : text(target);
    })
    .join(' ');
}

const replace = async (user: User, field: HTMLElement, value: string) => {
  await user.clear(field);
  await user.type(field, value);
};

const NOTE_REQUIRED = 'A note is required for this decision. Tell the coach why.';
const SERVER_VALUE = 'The server did not accept this value. Change it and try again.';

// --- finding the contribution -------------------------------------------------------------------

describe('finding the contribution', () => {
  test('a busy, named status shows until it is found; then one GET for the pending state, and its id is picked out of the answer', async () => {
    const held = deferred();
    serve({ lists: { pending: [() => held.promise] } });
    renderReview('c-imp');
    const status = await screen.findByRole('status', { name: 'Loading the contribution' });
    expect(status.getAttribute('aria-busy')).toBe('true');

    held.release(json(BY_STATE.pending));
    await screen.findByRole('heading', { level: 1, name: 'Wall passes' });
    expect(listedStates()).toEqual(['pending']);
    expect(calls.every((call) => (call.init?.method ?? 'GET') === 'GET')).toBe(true);
    // the other contribution in the answer is not shown
    expect(absent(screen.queryByText('Cone slalom'))).toBe(true);
  });

  test('a contribution that is not pending is looked for in the other states, one at a time, and shown without a decision', async () => {
    serve();
    await renderLoaded('c-changes', 'Zig-zag runs');
    expect(listedStates()).toEqual(['pending', 'changes_requested']);
  });

  test.each([
    { id: 'c-changes', name: 'Zig-zag runs', sentence: 'Waiting for the coach to send a new version. There is nothing for you to do.', state: 'Changes requested' },
    { id: 'c-approved', name: 'Two-touch turns', sentence: 'This method is approved. There is nothing more to decide.', state: 'Approved' },
  ])('a $state contribution offers no decision, no edit and no checklist, and says why', async ({ id, name, sentence, state }) => {
    await renderLoaded(id, name);
    expect(text(screen.getByRole('main'))).toContain(sentence);
    expect(text(screen.getByRole('main'))).toContain(state);
    for (const label of ['Approve', 'Request changes', 'Reject']) expect(absent(screen.queryByRole('button', { name: label }))).toBe(true);
    expect(absent(maybeBox('Name'))).toBe(true);
    expect(absent(maybeBox('Note to the coach'))).toBe(true);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  test('an id that no state has says it is not waiting for review, with a way back, and shows no form', async () => {
    renderReview('c-nope');
    await screen.findByText('This contribution is not waiting for review');
    expect(listedStates()).toEqual(['pending', 'changes_requested', 'approved', 'rejected']);
    expect(backLink().getAttribute('href')).toBe('/admin');
    expect(absent(screen.queryByRole('button', { name: 'Approve' }))).toBe(true);
    // the page still has its one title: the statement itself, not a contribution's name
    expect(screen.getAllByRole('heading', { level: 1 }).map(text)).toEqual(['This contribution is not waiting for review']);
  });

  test('a failed load shows an alert with the plain message and Try again, which asks once more and shows the contribution', async () => {
    const user = userEvent.setup();
    serve({ lists: { pending: [() => problem(500, 'Boom'), () => json(BY_STATE.pending)] } });
    renderReview('c-new');
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load this contribution');
    expect(text(alert)).toContain('Something went wrong on our side. Try again in a moment.');
    expect(absent(screen.queryByRole('heading', { level: 1 }))).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 1, name: 'Cone slalom' });
    expect(listedStates()).toEqual(['pending', 'pending']);
  });

  test('a refusal on any state is an ordinary load failure, not a missing contribution', async () => {
    serve({ lists: { pending: [() => problem(403, 'Forbidden')] } });
    renderReview('c-new');
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load this contribution');
    expect(absent(screen.queryByText('This contribution is not waiting for review'))).toBe(true);
  });

  test('Back goes to the queue', async () => {
    const user = userEvent.setup();
    await renderLoaded('c-new', 'Cone slalom');
    expect(backLink().getAttribute('href')).toBe('/admin');
    await user.click(backLink());
    await screen.findByText('QUEUE STAND-IN');
  });
});

// --- the submission and its video ---------------------------------------------------------------

describe('the submission', () => {
  test('names who sent it, when, and what the coach set that an admin cannot change (author, language, kind, target drill)', async () => {
    await renderLoaded('c-imp', 'Wall passes');
    const main = text(screen.getByRole('main'));
    expect(main).toContain('Dana Coach');
    expect(main).toContain('Improvement');
    expect(main).toContain('wall-passes-basic');
    expect(main).toContain('Explanation');
    expect(main).toContain('English');
    expect(main).toContain('Pending');
  });
});

describe('the video', () => {
  test('plays from the private media route by attachment id, not from the attachment url, with controls and a name', async () => {
    await renderLoaded('c-new', 'Cone slalom');
    const video = screen.getByLabelText('Video: slalom.mp4') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('src')).toBe('/api/media/a-1');
    expect(document.querySelectorAll('video')).toHaveLength(1);
    // the player is not a second request of the screen's own: only the list was asked for
    expect(calls.every((call) => call.url.pathname === LIST_PATH)).toBe(true);
  });

  test('the other files are links to the same private route, opened in a new tab, with their kind and size', async () => {
    await renderLoaded('c-new', 'Cone slalom');
    const image = screen.getByRole('link', { name: 'cones.png' });
    expect(image.getAttribute('href')).toBe('/api/media/a-2');
    expect(image.getAttribute('target')).toBe('_blank');
    expect(image.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: 'rules.pdf' }).getAttribute('href')).toBe('/api/media/a-3');
    expect(text(screen.getByRole('main'))).toContain('Image');
    // the video is not repeated as a link
    expect(absent(screen.queryByRole('link', { name: 'slalom.mp4' }))).toBe(true);
  });

  test('a contribution with no video says so and has no player', async () => {
    await renderLoaded('c-imp', 'Wall passes');
    expect(document.querySelectorAll('video')).toHaveLength(0);
    expect(text(screen.getByRole('main'))).toContain('No video was attached.');
  });
});

// --- the checklist ------------------------------------------------------------------------------

describe('the moderation checklist', () => {
  test('is a named group of three unticked checks: original content, safe for unsupervised children, no identifiable minors without consent', async () => {
    await renderLoaded('c-new', 'Cone slalom');
    const group = screen.getByRole('group', { name: 'Before you approve' });
    expect(group.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
    expect(tick(/^The content is original: not copied from FIFA, UEFA or any commercial source\.$/).checked).toBe(false);
    expect(tick(/^It is safe for children to do without an adult watching\.$/).checked).toBe(false);
    expect(tick(/^No identifiable child is in the photos or video, or a parent agreed to it\.$/).checked).toBe(false);
  });

  test('Approve with an item unticked is refused on the screen: a written error at the checklist, no request', async () => {
    const user = userEvent.setup();
    await renderLoaded('c-new', 'Cone slalom');
    await user.click(tick(ORIGINAL));
    await user.click(tick(SAFE));
    await user.click(approveButton());

    const error = screen.getByText('Tick all three checks before you approve.');
    expect(error.closest('[role="alert"]') === null).toBe(false);
    expect(decisionCalls()).toHaveLength(0);
    // ticking the last one and trying again sends the request
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await user.click(tick(MINORS));
    expect(absent(screen.queryByText('Tick all three checks before you approve.'))).toBe(true);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(decisionCalls()).toHaveLength(1);
  });

  test('Reject and Request changes do not need the checklist', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(decidedResponse(NEW_ITEM, 'rejected', 'Not for us.'))] });
    await renderLoaded('c-new', 'Cone slalom');
    await user.type(noteBox(), 'Not for us.');
    await user.click(rejectButton());
    await screen.findByText('Rejected. The coach can read your note.');
    expect(decisionCalls()).toHaveLength(1);
  });
});

// --- inline edits -------------------------------------------------------------------------------

describe('inline edits: which fields are offered', () => {
  test('a new method offers every content field the API accepts, filled with what the coach wrote', async () => {
    await renderLoaded('c-new', 'Cone slalom');
    expect(box('Name').value).toBe('Cone slalom');
    expect(box('Sport').value).toBe('football');
    expect(box('Skill').value).toBe('dribbling-basics');
    expect(select('Goal').value).toBe('dribbling');
    expect(box('Youngest age').value).toBe('8');
    expect(box('Oldest age').value).toBe('12');
    expect(select('Level').value).toBe('beginner');
    expect(box('Instructions').value).toBe('Weave the ball through the cones.');
    expect(box('Duration in minutes').value).toBe('10');
    expect(select('Equipment').value).toBe('cones');
    expect(box('Common mistakes').value).toBe('Looking only at the ball.');
    expect(box('Progression').value).toBe('');
    expect(box('Regression').value).toBe('');
    expect(box('Safety').value).toBe('Use soft cones.');
    expect(box('Source').value).toBe('My own session');
    expect(box('Source link').value).toBe('https://example.org/cone-slalom');
  });

  test('an improvement offers the same minus sport, skill and goal: the drill keeps its own, so no control is offered', async () => {
    await renderLoaded('c-imp', 'Wall passes');
    for (const name of ['Name', 'Youngest age', 'Oldest age', 'Instructions', 'Duration in minutes', 'Common mistakes', 'Progression', 'Regression', 'Safety', 'Source']) {
      expect(box(name)).toBeTruthy();
    }
    expect(select('Level')).toBeTruthy();
    expect(select('Equipment')).toBeTruthy();
    expect(absent(maybeBox('Sport'))).toBe(true);
    expect(absent(maybeBox('Skill'))).toBe(true);
    expect(absent(screen.queryByRole('combobox', { name: 'Goal' }))).toBe(true);
  });

  test.each([
    ['c-new', 'Cone slalom'],
    ['c-imp', 'Wall passes'],
  ])('%s: the author, the language, the kind and the drill it improves have no control (the API refuses them)', async (id, name) => {
    await renderLoaded(id, name);
    for (const label of ['Author', 'Language', 'Kind', 'Kind of change', 'Improves the drill']) {
      expect(absent(maybeBox(label))).toBe(true);
      expect(absent(screen.queryByRole('combobox', { name: label }))).toBe(true);
    }
    expect(text(screen.getByRole('main'))).toContain(id === 'c-new' ? 'Aidar Coach' : 'Dana Coach');
  });
});

describe('inline edits: what is sent', () => {
  test('an approval sends the edits and the status in ONE request, and only the fields that changed', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Name'), 'Cone slalom 2');
    await replace(user, box('Oldest age'), '13');
    await user.selectOptions(select('Level'), 'basic');
    await replace(user, box('Instructions'), 'Weave through six cones.');
    await user.click(radio('Reviewed'));
    await tickAll(user);
    await user.click(approveButton());

    await screen.findByText('Approved. The method is now in the commons.');
    expect(decisionCalls()).toHaveLength(1);
    const call = decisionCalls()[0];
    expect(call?.url.pathname).toBe('/api/admin/contributions/c-new/decision');
    expect(call?.init?.method).toBe('POST');
    expect(bodyOf(call)).toEqual({
      action: 'approve',
      edits: { name: 'Cone slalom 2', ageMax: 13, level: 'basic', instructions: 'Weave through six cones.' },
      status: 'REVIEWED',
    });
    // nothing but the list and the one decision was asked for
    expect(calls.filter((c) => c !== call && c.url.pathname !== LIST_PATH)).toHaveLength(0);
  });

  test('a new method may change its sport, skill and goal', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Sport'), 'futsal');
    await replace(user, box('Skill'), 'passing-basics');
    await user.selectOptions(select('Goal'), 'passing');
    await tickAll(user);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', edits: { sport: 'futsal', skill: 'passing-basics', goal: 'passing' }, status: 'COMMUNITY' });
  });

  test('a changed source link is sent; a source link cleared to blank is not (the API cannot remove one)', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Source link'), 'https://example.org/other');
    await replace(user, box('Source'), '  Club notes  ');
    await tickAll(user);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', edits: { source: 'Club notes', sourceUrl: 'https://example.org/other' }, status: 'COMMUNITY' });
  });

  test('a blank source link sends no edits key at all when nothing else changed', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await user.clear(box('Source link'));
    await tickAll(user);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', status: 'COMMUNITY' });
  });

  test('an improvement approved untouched sends the action and the default status, no edits, no locked key', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(IMPROVEMENT, {}, 'wall-passes-basic'))] });
    await renderLoaded('c-imp', 'Wall passes');
    await tickAll(user);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', status: 'COMMUNITY' });
  });

  test('an edit to an improvement never carries sport, skill, goal, author, locale, kind or the target', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(IMPROVEMENT, {}, 'wall-passes-basic'))] });
    await renderLoaded('c-imp', 'Wall passes');
    await replace(user, box('Name'), 'Wall passes 2');
    await tickAll(user);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    const { edits } = bodyOf(decisionCalls()[0]) as { edits: Record<string, unknown> };
    expect(edits).toEqual({ name: 'Wall passes 2' });
  });

  test('Request changes and Reject send the note only, never the edits or a status', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(decidedResponse(NEW_ITEM, 'changes_requested', 'Add the age range.'))] });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Name'), 'Cone slalom 2');
    await user.click(radio('Reviewed'));
    await user.type(noteBox(), ' Add the age range. ');
    await user.click(changesButton());
    await screen.findByText('Sent back. The coach can now edit the method and send it again.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'request_changes', note: 'Add the age range.' });
  });
});

describe('inline edits: what is refused on the screen, with no request', () => {
  test.each([
    { field: 'Name', value: '   ', message: 'This cannot be empty.' },
    { field: 'Instructions', value: '', message: 'This cannot be empty.' },
    { field: 'Source', value: ' ', message: 'This cannot be empty.' },
    { field: 'Youngest age', value: 'abc', message: 'Enter a whole number, 0 or more.' },
    { field: 'Oldest age', value: '-1', message: 'Enter a whole number, 0 or more.' },
    { field: 'Duration in minutes', value: '0', message: 'Enter a whole number above 0.' },
    { field: 'Duration in minutes', value: '1.5', message: 'Enter a whole number above 0.' },
    { field: 'Source link', value: 'ftp://example.org/x', message: 'Enter a web address that starts with http:// or https://.' },
  ])('$field = "$value": $message at that field, focus there, nothing sent', async ({ field, value, message }) => {
    const user = userEvent.setup();
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.clear(box(field));
    if (value !== '') await user.type(box(field), value);
    await user.click(approveButton());

    const control = box(field);
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(control)).toContain(message);
    expect(document.activeElement === control).toBe(true);
    expect(decisionCalls()).toHaveLength(0);
  });

  test('an oldest age below the youngest is refused at the oldest-age field', async () => {
    const user = userEvent.setup();
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await replace(user, box('Oldest age'), '5');
    await user.click(approveButton());
    expect(describedBy(box('Oldest age'))).toContain('The oldest age cannot be lower than the youngest.');
    expect(decisionCalls()).toHaveLength(0);
  });

  test('an error clears when its field is edited', async () => {
    const user = userEvent.setup();
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.clear(box('Name'));
    await user.click(approveButton());
    expect(box('Name').getAttribute('aria-invalid')).toBe('true');
    await user.type(box('Name'), 'Cone slalom 3');
    expect(box('Name').getAttribute('aria-invalid')).toBeNull();
  });

  test('a blank name is not a problem for Reject: edits are not sent with it', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(decidedResponse(NEW_ITEM, 'rejected', 'Not for us.'))] });
    await renderLoaded('c-new', 'Cone slalom');
    await user.clear(box('Name'));
    await user.type(noteBox(), 'Not for us.');
    await user.click(rejectButton());
    await screen.findByText('Rejected. The coach can read your note.');
    expect(decisionCalls()).toHaveLength(1);
  });
});

describe("inline edits: the server's 422", () => {
  test('/edits/<key> is shown at that field in the screen\'s own words, keeps every draft, and the decision can be sent again', async () => {
    const user = userEvent.setup();
    serve({
      decide: [() => problem(422, 'Unprocessable Entity', [{ pointer: '/edits/skill', detail: 'Unknown skill' }]), () => json(approvedResponse(NEW_ITEM))],
    });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Skill'), 'no-such-skill');
    await replace(user, box('Name'), 'Cone slalom 2');
    await tickAll(user);
    await user.click(approveButton());

    await waitFor(() => expect(describedBy(box('Skill'))).toContain(SERVER_VALUE));
    expect(box('Skill').getAttribute('aria-invalid')).toBe('true');
    expect(box('Skill').value).toBe('no-such-skill');
    expect(box('Name').value).toBe('Cone slalom 2');
    expect(box('Name').getAttribute('aria-invalid')).toBeNull();
    expect(absent(screen.queryByText('Unknown skill'))).toBe(true);
    expect(document.activeElement === box('Skill')).toBe(true);
    expect(approveButton().disabled).toBe(false);

    await replace(user, box('Skill'), 'dribbling-basics');
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(decisionCalls()).toHaveLength(2);
  });

  test('/edits on its own (an invalid edit with no field) is a written alert above the buttons, not the server text', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => problem(422, 'Unprocessable Entity', [{ pointer: '/edits', detail: 'ageMax (5) must not be smaller than ageMin (8)' }])] });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Name'), 'Cone slalom 2');
    await tickAll(user);
    await user.click(approveButton());
    const alert = await screen.findByText('The server did not accept the edits. Check the fields and try again.');
    expect(alert.closest('[role="alert"]') === null).toBe(false);
    expect(absent(screen.queryByText(/must not be smaller/))).toBe(true);
    expect(box('Name').value).toBe('Cone slalom 2');
  });
});

// --- the decision panel: status, organisation, note ---------------------------------------------

describe('approve: the initial status', () => {
  test('offers the four trust statuses in a named group, Community chosen, each with a word', async () => {
    await renderLoaded('c-new', 'Cone slalom');
    const group = screen.getByRole('group', { name: 'Trust status when published' });
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(4);
    expect(radio('Community').checked).toBe(true);
    expect(radio('Reviewed').checked).toBe(false);
    expect(radio('Expert verified').checked).toBe(false);
    expect(radio('Academy verified').checked).toBe(false);
  });

  test('the organisation field appears for the two verified statuses only', async () => {
    const user = userEvent.setup();
    await renderLoaded('c-new', 'Cone slalom');
    expect(absent(maybeBox('Organisation'))).toBe(true);
    await user.click(radio('Reviewed'));
    expect(absent(maybeBox('Organisation'))).toBe(true);
    await user.click(radio('Expert verified'));
    expect(maybeBox('Organisation')).toBeTruthy();
    await user.click(radio('Academy verified'));
    expect(maybeBox('Organisation')).toBeTruthy();
    await user.click(radio('Community'));
    expect(absent(maybeBox('Organisation'))).toBe(true);
  });

  test('Community is sent as the status even when the admin never touched the picker', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', status: 'COMMUNITY' });
  });

  test('Academy verified needs the organisation: refused on the screen at that field, focus there, no request; then it is sent trimmed with the note', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.click(radio('Academy verified'));
    await user.type(noteBox(), 'Checked with the academy.');
    await user.click(approveButton());

    const org = box('Organisation');
    expect(org.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(org)).toContain('Academy verified needs the name of the organisation.');
    expect(document.activeElement === org).toBe(true);
    expect(decisionCalls()).toHaveLength(0);

    await user.type(org, '  FC Kairat Academy ');
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({
      action: 'approve',
      status: 'ACADEMY_VERIFIED',
      orgLabel: 'FC Kairat Academy',
      note: 'Checked with the academy.',
    });
  });

  test('Expert verified needs a note but not an organisation; a blank organisation is not sent', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.click(radio('Expert verified'));
    await user.click(approveButton());
    expect(describedBy(noteBox())).toContain(NOTE_REQUIRED);
    expect(document.activeElement === noteBox()).toBe(true);
    expect(decisionCalls()).toHaveLength(0);

    await user.type(noteBox(), 'Verified by the federation.');
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', status: 'EXPERT_VERIFIED', note: 'Verified by the federation.' });
  });

  test('Community and Reviewed need no note; a blank note is not sent and a note is sent trimmed', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.click(radio('Reviewed'));
    await user.type(noteBox(), '  Looks good.  ');
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', status: 'REVIEWED', note: 'Looks good.' });
  });

  test("the server's 422 on /orgLabel and on /note are shown at those fields, in plain words, keeping what was typed", async () => {
    const user = userEvent.setup();
    serve({
      decide: [
        () => problem(422, 'Unprocessable Entity', [{ pointer: '/orgLabel', detail: 'An orgLabel is required' }]),
        () => problem(422, 'Unprocessable Entity', [{ pointer: '/note', detail: 'A note is required' }]),
      ],
    });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.click(radio('Expert verified'));
    await user.type(box('Organisation'), 'FC Kairat');
    await user.type(noteBox(), 'Fine.');
    await user.click(approveButton());
    await waitFor(() => expect(describedBy(box('Organisation'))).toContain('Academy verified needs the name of the organisation.'));
    expect(box('Organisation').value).toBe('FC Kairat');
    expect(absent(screen.queryByText('An orgLabel is required'))).toBe(true);

    await user.click(approveButton());
    await waitFor(() => expect(describedBy(noteBox())).toContain(NOTE_REQUIRED));
    expect(noteBox().value).toBe('Fine.');
    expect(absent(screen.queryByText('A note is required'))).toBe(true);
  });
});

describe('request changes and reject', () => {
  test.each([
    { label: 'Request changes' },
    { label: 'Reject' },
  ])('$label with a blank or spaces-only note is refused on the screen: an error at the note, focus there, no request', async ({ label }) => {
    const user = userEvent.setup();
    await renderLoaded('c-new', 'Cone slalom');
    await user.click(screen.getByRole('button', { name: label }));

    const field = noteBox();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(field)).toContain(NOTE_REQUIRED);
    expect(document.activeElement === field).toBe(true);
    expect(decisionCalls()).toHaveLength(0);
    await user.type(field, '   ');
    await user.click(screen.getByRole('button', { name: label }));
    expect(decisionCalls()).toHaveLength(0);
  });

  test.each([
    { label: 'Request changes', action: 'request_changes', state: 'changes_requested', outcome: 'Sent back. The coach can now edit the method and send it again.', tag: 'Changes requested' },
    { label: 'Reject', action: 'reject', state: 'rejected', outcome: 'Rejected. The coach can read your note.', tag: 'Rejected' },
  ] as const)('$label with a note sends it in one request; the response replaces the screen: outcome, new state, the note, no buttons', async ({ label, action, state, outcome, tag }) => {
    const user = userEvent.setup();
    serve({ decide: [() => json(decidedResponse(NEW_ITEM, state, 'Add the age range.'))] });
    await renderLoaded('c-new', 'Cone slalom');
    await user.type(noteBox(), 'Add the age range.');
    await user.click(screen.getByRole('button', { name: label }));

    await screen.findByText(outcome);
    expect(decisionCalls()).toHaveLength(1);
    expect(bodyOf(decisionCalls()[0])).toEqual({ action, note: 'Add the age range.' });
    const main = text(screen.getByRole('main'));
    expect(main).toContain(tag);
    expect(main).toContain('Add the age range.');
    for (const name of ['Approve', 'Request changes', 'Reject']) expect(absent(screen.queryByRole('button', { name }))).toBe(true);
    expect(absent(maybeBox('Name'))).toBe(true);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(absent(screen.queryByRole('link', { name: /Open the published drill/ }))).toBe(true);
    expect(backLink().getAttribute('href')).toBe('/admin');
  });
});

describe('an approval: the response replaces the screen state', () => {
  test('shows the outcome, the state, the title and the reviewer note from the RESPONSE, a link to the new drill, and no decision', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM, { name: 'Cone slalom 2' }))] });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.click(approveButton());

    await screen.findByText('Approved. The method is now in the commons.');
    expect(screen.getByRole('heading', { level: 1, name: 'Cone slalom 2' })).toBeTruthy();
    const main = text(screen.getByRole('main'));
    expect(main).toContain('Approved');
    expect(main).toContain('Checked on site.');
    expect(screen.getByRole('link', { name: 'Open the published drill' }).getAttribute('href')).toBe('/commons/cone-slalom');
    for (const name of ['Approve', 'Request changes', 'Reject']) expect(absent(screen.queryByRole('button', { name }))).toBe(true);
    expect(absent(maybeBox('Name'))).toBe(true);
    // no second read of the list: the response was enough
    expect(listCalls()).toHaveLength(1);
  });

  test('a decided contribution is dropped from the cached pending list and the other queue lists are marked stale', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    // gcTime is infinite: the lists set below have no observer on this screen, and must stay in the cache to be looked at.
    const { queryClient } = renderReview('c-new', 'en', Number.POSITIVE_INFINITY);
    await screen.findByRole('heading', { level: 1, name: 'Cone slalom' });
    queryClient.setQueryData(['admin', 'contributions', 'pending'], [NEW_ITEM, IMPROVEMENT]);
    queryClient.setQueryData(['admin', 'contributions', 'approved'], []);
    await tickAll(user);
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    const pending = queryClient.getQueryData<ModerationQueueItem[]>(['admin', 'contributions', 'pending']);
    expect(pending?.map((item) => item.contribution.id)).toEqual(['c-imp']);
    expect(queryClient.getQueryState(['admin', 'contributions', 'approved'])?.isInvalidated).toBe(true);
  });
});

// --- in flight, double click, failures ----------------------------------------------------------

describe('in flight', () => {
  test('every mutation button, the note, the status, the checks and the edit fields are locked while the request runs; one click is one request', async () => {
    const user = userEvent.setup();
    const held = deferred();
    serve({ decide: [() => held.promise] });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Name'), 'Cone slalom 2');
    await tickAll(user);
    await user.click(approveButton());
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));

    expect(approveButton().disabled).toBe(true);
    expect(approveButton().getAttribute('aria-busy')).toBe('true');
    expect(changesButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);
    for (const field of [noteBox(), box('Name'), box('Instructions')]) expect(field.disabled || field.readOnly).toBe(true);
    expect(select('Level').disabled).toBe(true);
    expect(radio('Reviewed').disabled).toBe(true);
    expect(tick(ORIGINAL).disabled).toBe(true);
    await user.click(approveButton());
    await user.click(rejectButton());
    expect(decisionCalls()).toHaveLength(1);

    held.release(json(approvedResponse(NEW_ITEM)));
    await screen.findByText('Approved. The method is now in the commons.');
    expect(decisionCalls()).toHaveLength(1);
  });

  test('two clicks in the same instant (before the screen has locked the buttons) send one request', async () => {
    const user = userEvent.setup();
    const held = deferred();
    serve({ decide: [() => held.promise] });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    const button = approveButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decisionCalls()).toHaveLength(1);
    held.release(json(approvedResponse(NEW_ITEM)));
    await screen.findByText('Approved. The method is now in the commons.');
    expect(decisionCalls()).toHaveLength(1);
  });
});

describe('in flight: one batch', () => {
  test('two clicks inside ONE batch (nothing re-rendered between them, so the button is still enabled for both) send one request', async () => {
    const user = userEvent.setup();
    const held = deferred();
    serve({ decide: [() => held.promise] });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    const button = approveButton();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decisionCalls()).toHaveLength(1);
    held.release(json(approvedResponse(NEW_ITEM)));
    await screen.findByText('Approved. The method is now in the commons.');
    expect(decisionCalls()).toHaveLength(1);
  });
});

describe('failures', () => {
  test('a server error says the decision was not saved, keeps the form, the drafts and the note, and the same decision can be sent again', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => problem(500, 'Boom'), () => json(decidedResponse(NEW_ITEM, 'rejected', 'Not for us.'))] });
    await renderLoaded('c-new', 'Cone slalom');
    await replace(user, box('Name'), 'Cone slalom 2');
    await user.type(noteBox(), 'Not for us.');
    await user.click(rejectButton());

    const alert = await screen.findByText('The decision was not saved');
    expect(text(alert.closest('[role="alert"]')!)).toContain('Something went wrong on our side. Try again in a moment.');
    expect(noteBox().value).toBe('Not for us.');
    expect(box('Name').value).toBe('Cone slalom 2');
    expect(approveButton().disabled).toBe(false);
    expect(rejectButton().disabled).toBe(false);
    expect(listCalls()).toHaveLength(1);

    await user.click(rejectButton());
    await screen.findByText('Rejected. The coach can read your note.');
    expect(decisionCalls()).toHaveLength(2);
  });

  test('a 409 says nothing was saved, locks the buttons while the contribution is looked up again, then shows it as the state it now has, with no decision', async () => {
    const user = userEvent.setup();
    const held = deferred();
    const decidedElsewhere = queueItem('c-new', 'approved', 'Cone slalom', { contribution: { reviewerNote: 'Approved by someone else.', resultingDrillSlug: 'cone-slalom' } });
    serve({
      lists: { pending: [() => json(BY_STATE.pending), () => held.promise], changes_requested: [() => json([])], approved: [() => json([decidedElsewhere])] },
      decide: [() => problem(409, 'Conflict')],
    });
    await renderLoaded('c-new', 'Cone slalom');
    await tickAll(user);
    await user.click(approveButton());

    await screen.findByText(/Someone else has already dealt with this contribution/);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(decisionCalls()).toHaveLength(1);
    expect(approveButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);

    held.release(json([IMPROVEMENT]));
    await screen.findByText('Approved by someone else.');
    expect(text(screen.getByRole('main'))).toContain('Someone else has already dealt with this contribution');
    for (const name of ['Approve', 'Request changes', 'Reject']) expect(absent(screen.queryByRole('button', { name }))).toBe(true);
    expect(absent(maybeBox('Name'))).toBe(true);
    // the first list request found it; the look-up after the 409 starts again from pending and stops at the state that holds it
    expect(listedStates().slice(1)).toEqual(['pending', 'changes_requested', 'approved']);
  });

  test('a 404 on the decision is handled like a 409: nothing saved, looked up again, and when it is in no state it says it is not waiting for review', async () => {
    const user = userEvent.setup();
    serve({ lists: { pending: [() => json(BY_STATE.pending), () => json([])] }, decide: [() => problem(404, 'Not Found')] });
    await renderLoaded('c-new', 'Cone slalom');
    await user.type(noteBox(), 'Not for us.');
    await user.click(rejectButton());
    await screen.findByText('This contribution is not waiting for review');
    expect(text(screen.getByRole('main'))).toContain('Someone else has already dealt with this contribution');
    expect(absent(screen.queryByRole('button', { name: 'Reject' }))).toBe(true);
  });
});

// --- languages ----------------------------------------------------------------------------------

describe.each(['kk', 'ru'] as const)('%s', (locale) => {
  test('the review, the checklist, the edit form and the decision are in that language, in Cyrillic, with no leaked key or value', async () => {
    await renderLoaded('c-new', 'Cone slalom', locale);
    const page = text(screen.getByRole('main'));
    expect(CYRILLIC.test(page)).toBe(true);
    for (const leak of LEAKS) expect(page).not.toContain(leak);
    expect(screen.getByRole('link', { name: messages[locale].back })).toBeTruthy();
    expect(screen.getByRole('group', { name: messages[locale].checklist.title })).toBeTruthy();
    expect(screen.getByRole('group', { name: messages[locale].status.legend })).toBeTruthy();
    expect(screen.getByRole('button', { name: messages[locale].decision.approve })).toBeTruthy();
    expect(screen.getByRole('button', { name: messages[locale].decision.requestChanges })).toBeTruthy();
    expect(screen.getByRole('button', { name: messages[locale].decision.reject })).toBeTruthy();
  });

  test('the not-found state and an approval outcome are in that language too', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded('c-new', 'Cone slalom', locale);
    for (const name of [messages[locale].checklist.original, messages[locale].checklist.safe, messages[locale].checklist.minors]) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    await user.click(screen.getByRole('button', { name: messages[locale].decision.approve }));
    await screen.findByText(messages[locale].decision.outcome.approve);
    cleanup();

    renderReview('c-nope', locale);
    await screen.findByText(messages[locale].missing.title);
    const missing = text(screen.getByRole('main'));
    expect(CYRILLIC.test(missing)).toBe(true);
    for (const leak of LEAKS) expect(missing).not.toContain(leak);
  });
});

describe('en', () => {
  test('a review of a new method and of an improvement leak no key, placeholder or raw value', async () => {
    await renderLoaded('c-new', 'Cone slalom', 'en');
    for (const leak of LEAKS) expect(text(screen.getByRole('main'))).not.toContain(leak);
    cleanup();
    await renderLoaded('c-imp', 'Wall passes', 'en');
    for (const leak of LEAKS) expect(text(screen.getByRole('main'))).not.toContain(leak);
  });
});

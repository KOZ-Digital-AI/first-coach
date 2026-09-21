import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DrillDetail } from '@api-types/commons';
import { Contribution, ContributionMeta, ContributionPayloadRequest, IMPROVEMENT_KINDS } from '@api-types/contributions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { collectSlot } from '../../lib/slots';
import * as slotModule from './drill-detail-extra';
import messages from './suggest.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as mine.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Contract under test (fc-mol-70i.11): features/contribute/drill-detail-extra.tsx adds a "Suggest improvement" button to every
 * drill detail page through the `drill-detail` slot. Its dialog asks for the improvement kind (the eight kinds of the contract),
 * the proposed text, an optional video, the author and the two attestations, and posts ONE multipart contribution of kind
 * `improvement` targeting that drill (POST /api/contributions: `payload` JSON + optional `video`). A signed-out visitor, or an
 * anonymous player (not a contributor), is sent to sign-in and returns to the same drill. The dialog has loading, empty, error,
 * disabled and success states, its buttons are disabled while a request is in flight, and every string exists in kk, ru and en.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query inside a real (memory-history) router that renders the
 * slot component the way routes/commons/$slug.tsx does (below its content, no props, reading the route param itself); the only
 * stand-ins are the network (globalThis.fetch) and the session (the seam SuggestDepsContext, as in the other contribute screens).
 * Fixtures are parsed with the shared contract schemas, so they cannot drift from the API. Kazakh and Russian copy still needs a
 * native-speaker review: for those locales these tests pin only that text exists, is Cyrillic and never leaks 'undefined', a raw
 * key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - The dialog asks for nothing else, so the payload fields the contract requires but the dialog does not ask are taken from what
 *   the app already knows: name, age range, equipment and duration from the target drill (the same GET the drill page makes, one
 *   cache entry); sport, skill, level and goal, which no drill read carries (contract gap), are the first valid values of the
 *   contribute meta. The proposal goes in `instructions`; mistakes, progression, regression and safety are sent blank.
 * - "Not a contributor" = anything but a readable session whose user has isAnonymous === false (the API's requireContributor says
 *   the same). Every visitor has a silent anonymous player session, so "has a session" is not enough.
 * - "Video" = one `video` part; only the meta's video/* types are accepted, at most meta.upload.maxMb.
 * - Nothing is requested until the dialog is opened.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const SLUG = 'ball-mastery-ghost-ball';

const META_INPUT = {
  sports: [{ slug: 'football', name: { en: 'Football', ru: 'Футбол', kk: 'Футбол' } }],
  skills: [
    {
      slug: 'ball-control',
      name: { en: 'Ball control' },
      children: [{ slug: 'ghost-touch', name: { en: 'Ghost touch' }, children: [] }],
    },
    { slug: 'passing', name: { en: 'Passing' }, children: [] },
  ],
  levels: ['beginner', 'basic', 'intermediate'],
  equipment: ['nothing', 'ball', 'ball_wall', 'cones', 'full_field'],
  spaces: ['home_3x3', 'yard', 'field', 'gym'],
  licenses: ['CC-BY-SA-4.0'],
  improvementKinds: [...IMPROVEMENT_KINDS],
  upload: { maxMb: 20, mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/png', 'application/pdf'] },
};
const META = ContributionMeta.parse(META_INPUT);
const metaWith = (edit: (draft: typeof META_INPUT) => void) => {
  const draft = structuredClone(META_INPUT);
  edit(draft);
  return ContributionMeta.parse(draft);
};
const SKILL_SLUGS = ['ball-control', 'ghost-touch', 'passing'];

const DRILL_INPUT = {
  slug: SLUG,
  versionId: 'ver-3',
  content: {
    title: { kk: 'Елес доп', ru: 'Воображаемый мяч', en: 'Ghost Ball' },
    goal: { en: 'Get used to soft, quiet foot touches before you use a real ball.' },
    instructions: { en: '1. Stand tall.\n2. Tap the pretend ball softly.' },
    dose: { reps: 10, sets: 2 } as Record<string, number>,
    mistakes: [{ en: 'You stamp your foot down.' }],
    progressions: [{ en: 'Try it with a real ball.' }],
    regressions: [{ en: 'Hold a chair while you balance.' }],
    conditions: { equipment: 'nothing', spaces: ['home_3x3', 'yard'], partner: false, ageMin: 5, ageMax: 99 },
    safety: [{ en: 'Stand next to a sturdy chair.' }],
    media: [],
  } as Record<string, unknown>,
  attribution: { author: 'Test Author', source: 'Test Source Book', license: 'CC-BY-SA-4.0', createdAt: '2026-05-12T10:00:00.000Z', semver: '1.2.0' },
  history: [{ versionId: 'ver-3', semver: '1.2.0', createdAt: '2026-05-12T10:00:00.000Z' }],
  reviews: [],
};
const drill = (edit: (draft: typeof DRILL_INPUT) => void = () => {}) => {
  const draft = structuredClone(DRILL_INPUT);
  edit(draft);
  return DrillDetail.parse(draft);
};
const DRILL = drill();

const NOW = '2026-09-22T09:00:00.000Z';
/** The stored contribution the API answers with; `payload` overrides fields of a complete, valid stored payload. */
const created = (payload: Record<string, unknown> = {}) =>
  Contribution.parse({
    id: 'c-new',
    state: 'pending',
    payload: {
      kind: 'improvement',
      targetDrillSlug: SLUG,
      improvementKind: 'progression',
      locale: 'en',
      name: 'Ghost Ball',
      sport: 'football',
      skill: 'ball-control',
      ageMin: 5,
      ageMax: 99,
      level: 'beginner',
      goal: 'control',
      instructions: 'x',
      durationMin: 1,
      equipment: 'nothing',
      mistakes: '',
      progression: '',
      regression: '',
      safety: '',
      source: `/commons/${SLUG}`,
      author: 'Aidar Coach',
      ...payload,
    },
    attachments: [],
    createdAt: NOW,
    updatedAt: NOW,
  });

const CONTRIBUTOR = { user: { id: 'u-1', name: 'Aidar Coach', isAnonymous: false } };
const ANONYMOUS = { user: { id: 'u-anon', name: 'Anonymous', isAnonymous: true } };

const TEXT = 'Let the child count the taps out loud while doing them.';

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });
const problem = (status: number, extra: Record<string, unknown> = {}) =>
  json({ type: 'about:blank', title: 'Server title', status, detail: 'Server detail in English', errors: [], ...extra }, { status }, 'application/problem+json');
const invalid = (...pointers: string[]) =>
  problem(422, { errors: pointers.map((pointer) => ({ pointer, detail: 'Server says this is wrong' })) });

type Answer = () => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: Array<{ url: URL; init: RequestInit | undefined }> = [];

const isMeta = (call: (typeof calls)[number]) => call.url.pathname === '/api/contribute/meta';
const isDrill = (call: (typeof calls)[number]) => call.url.pathname === `/api/commons/drills/${SLUG}`;
const isPost = (call: (typeof calls)[number]) => call.url.pathname === '/api/contributions' && call.init?.method === 'POST';
const metaCalls = () => calls.filter(isMeta);
const drillCalls = () => calls.filter(isDrill);
const postCalls = () => calls.filter(isPost);

/** Answers per route, one per call (the last repeats). Anything else is a 404. */
function serve({ meta = [() => json(META)], drill: drillAnswers = [() => json(DRILL)], post = [] }: { meta?: Answer[]; drill?: Answer[]; post?: Answer[] } = {}): void {
  calls = [];
  const counters = { meta: 0, drill: 0, post: 0 };
  const next = (list: Answer[], key: keyof typeof counters) => {
    const answer = list[Math.min(counters[key], list.length - 1)]!;
    counters[key] += 1;
    return answer();
  };
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ url, init });
    if (isMeta({ url, init })) return next(meta, 'meta');
    if (isDrill({ url, init })) return next(drillAnswers, 'drill');
    if (isPost({ url, init }) && post.length > 0) return next(post, 'post');
    return problem(404);
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
 * (`affectsCache`, `affectsComputedStyleCache`) and in the window's selector cache, and never trims them. This file asks
 * thousands of questions, so in the whole-package run another file's FAILING or slow `expect(element)...` (bun pretty-prints the
 * element, and with it that bookkeeping) blew its 5 s timeout (offline-reload.test.tsx, "a session that arrives later ...").
 * After every test the DOM is empty, so the lists are emptied the way happy-dom itself empties them when a node changes: every
 * recorded result is invalidated first, then the list is cleared. Written against happy-dom 20.x symbols by description; if they
 * are not there it does nothing. (Same pattern as form.test.tsx.)
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
  // Every global this file patches is put back: the network stub, the URL the router pushed, and the happy-dom bookkeeping.
  // (No timers, no localStorage keys and no session are touched: each render builds its own i18n instance and query client.)
  globalThis.fetch = realFetch;
  window.history.pushState({}, '', '/');
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './suggest.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

interface Session {
  data?: unknown;
  isPending: boolean;
  isRefetching?: boolean;
  error?: unknown;
  refetch: () => unknown;
}
const sessionOf = (data: unknown, extra: Partial<Session> = {}): Session => ({ data, isPending: false, refetch: () => {}, ...extra });

const { default: SuggestImprovement, SuggestDepsContext } = slotModule;

/** The slot component inside a real (memory) router, mounted the way the drill page mounts its slot: no props, below the content. */
function renderSlot({ locale = 'en', session = sessionOf(CONTRIBUTOR), slug = SLUG, primeDrill = false }: { locale?: Locale; session?: Session; slug?: string; primeDrill?: boolean } = {}) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: primeDrill ? Number.POSITIVE_INFINITY : 0 } } });
  if (primeDrill) queryClient.setQueryData(['commons-drill', slug, locale], DRILL);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const drillRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/commons/$slug',
    component: () => (
      <main>
        <h1>The drill page</h1>
        <div data-slot="drill-detail">
          <SuggestDepsContext.Provider value={{ session }}>
            <SuggestImprovement />
          </SuggestDepsContext.Provider>
        </div>
      </main>
    ),
  });
  const signInRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/account/sign-in',
    validateSearch: (search: Record<string, unknown>) => ({ redirect: typeof search.redirect === 'string' ? search.redirect : undefined }),
    component: () => <p>sign-in screen</p>,
  });
  const mineRoute = createRoute({ getParentRoute: () => rootRoute, path: '/contribute/mine', component: () => <p>my contributions</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([drillRoute, signInRoute, mineRoute]),
    history: createMemoryHistory({ initialEntries: [`/commons/${slug}`] }),
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
const setup = () => userEvent.setup({ applyAccept: false });
type User = ReturnType<typeof setup>;

/** A string of the bundle by its dotted path, e.g. `trigger.button`. */
function say(locale: Locale, path: string): string {
  let node: unknown = messages[locale];
  for (const key of path.split('.')) node = (node as Record<string, unknown> | undefined)?.[key];
  if (typeof node !== 'string') throw new Error(`no string at ${locale}:${path}`);
  return node;
}

const triggerButton = (name = 'Suggest improvement') => screen.findByRole('button', { name }) as Promise<HTMLButtonElement>;
const DIALOG = 'Suggest an improvement';
const dialog = () => screen.findByRole('dialog', { name: DIALOG });

/** Opens the dialog for a contributor and waits for the form. */
async function openForm(user: User, options: Parameters<typeof renderSlot>[0] = {}) {
  const locale = options.locale ?? 'en';
  const view = renderSlot(options);
  await user.click(await triggerButton(say(locale, 'trigger.button')));
  const box = await screen.findByRole('dialog', { name: say(locale, 'dialog.title') });
  await within(box).findByRole('button', { name: say(locale, 'actions.send') });
  return { ...view, box };
}

const field = (box: HTMLElement, label: string | RegExp) => within(box).getByLabelText(label) as HTMLInputElement;
const kindSelect = (box: HTMLElement) => field(box, 'What kind of improvement?') as unknown as HTMLSelectElement;
const textArea = (box: HTMLElement) => field(box, 'Your suggestion') as unknown as HTMLTextAreaElement;
const authorInput = (box: HTMLElement) => field(box, 'Your name');
const videoInput = (box: HTMLElement) => field(box, 'Video (optional)');
const rightsBox = (box: HTMLElement) => within(box).getByRole('checkbox', { name: /I wrote this or I have the right to share it/ }) as HTMLInputElement;
const noCommercialBox = (box: HTMLElement) => within(box).getByRole('checkbox', { name: /It contains no advertising/ }) as HTMLInputElement;
const sendButton = (box: HTMLElement) => within(box).getByRole('button', { name: 'Send suggestion' }) as HTMLButtonElement;
const cancelButton = (box: HTMLElement) => within(box).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

/** The message shown for one control: the element its aria-describedby names, together with the flag aria-invalid. */
function errorOf(control: HTMLElement): string {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  return ids
    .map((id) => document.getElementById(id))
    .filter((node): node is HTMLElement => node !== null && node.getAttribute('role') === 'alert')
    .map(text)
    .join(' ');
}

async function fillValid(user: User, box: HTMLElement, kind = 'progression', suggestion = TEXT) {
  await user.selectOptions(kindSelect(box), kind);
  await user.type(textArea(box), suggestion);
  await user.click(rightsBox(box));
  await user.click(noCommercialBox(box));
}

const sentPayload = () => {
  const form = postCalls()[0]!.init!.body as FormData;
  return JSON.parse(String(form.get('payload'))) as Record<string, unknown>;
};
const sentForm = () => postCalls()[0]!.init!.body as FormData;
const video = (name = 'clip.mp4', type = 'video/mp4', bytes = 16) => new File([new Uint8Array(bytes)], name, { type });

// --- the slot -----------------------------------------------------------------------------------

describe('the drill-detail slot', () => {
  test('the module default-exports one component that the slot mechanism collects, in the drill-detail slot', () => {
    const collected = collectSlot({ 'drill-detail': { './drill-detail-extra.tsx': slotModule as Record<string, unknown> } }, 'drill-detail');
    expect(collected).toHaveLength(1);
    expect(collected[0] === slotModule.default).toBe(true);
  });

  test('every drill page gets a "Suggest improvement" button, with words that say what it is for, and no request is made until it is used', async () => {
    renderSlot();
    const button = await triggerButton();
    expect(button.disabled).toBe(false);
    expect(screen.getByText('Help improve this drill')).toBeTruthy();
    expect(screen.queryByRole('dialog') === null).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// --- who may suggest ----------------------------------------------------------------------------

describe('signed-out visitors and anonymous players', () => {
  for (const [label, data] of [
    ['a visitor with no session', null],
    ['an anonymous player', ANONYMOUS],
    ['a session whose isAnonymous is missing', { user: { id: 'u-x', name: 'Sam' } }],
  ] as const) {
    test(`${label} is sent to sign-in with a return path to the same drill, and sees no form`, async () => {
      const { router } = renderSlot({ session: sessionOf(data) });
      await userEvent.setup().click(await triggerButton());
      await waitFor(() => expect(router.state.location.pathname).toBe('/account/sign-in'));
      expect(router.state.location.search).toEqual({ redirect: `/commons/${SLUG}` });
      expect(screen.queryByRole('dialog') === null).toBe(true);
      expect(calls).toHaveLength(0);
    });
  }

  test('says, before any click, that a coach account is needed and that players never need one', async () => {
    renderSlot({ session: sessionOf(null) });
    await triggerButton();
    expect(screen.getByText('Sign in with a coach account to suggest a change. Players never need an account.')).toBeTruthy();
  });

  test('a contributor is not told to sign in', async () => {
    renderSlot();
    await triggerButton();
    expect(screen.queryByText(/Players never need an account/) === null).toBe(true);
  });
});

describe('while the session is being read', () => {
  test('the button is busy and disabled, a click goes nowhere', async () => {
    const { router } = renderSlot({ session: sessionOf(CONTRIBUTOR, { isPending: true }) });
    const button = await triggerButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await userEvent.setup().click(button);
    expect(router.state.location.pathname).toBe(`/commons/${SLUG}`);
    expect(screen.queryByRole('dialog') === null).toBe(true);
  });

  test('a session that is being re-read (its data may be another person) is not a contributor yet', async () => {
    renderSlot({ session: sessionOf(CONTRIBUTOR, { isRefetching: true }) });
    const button = await triggerButton();
    expect(button.disabled).toBe(true);
  });

  test('a session whose data cannot be read (no user object) is treated like a failed read: it fails closed, offers Try again and never opens the form', async () => {
    const refetch = mock(() => {});
    renderSlot({ session: sessionOf({ user: 'nope' }, { refetch }) });
    await screen.findByText('We could not check your account.');
    expect(screen.queryByRole('button', { name: 'Suggest improvement' }) === null).toBe(true);
    expect(screen.queryByRole('dialog') === null).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('a failed session read says so and offers Try again, which reads it again; it never opens the form', async () => {
    const refetch = mock(() => {});
    renderSlot({ session: sessionOf(null, { error: new Error('boom'), refetch }) });
    await screen.findByText('We could not check your account.');
    expect(screen.queryByRole('dialog') === null).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

// --- opening the dialog -------------------------------------------------------------------------

describe('opening the dialog', () => {
  test('makes exactly one GET of the contribute meta (with the language) and one of the drill, and names the drill', async () => {
    const user = setup();
    const { box } = await openForm(user);
    expect(metaCalls()).toHaveLength(1);
    expect(metaCalls()[0]!.url.searchParams.get('locale')).toBe('en');
    expect(drillCalls()).toHaveLength(1);
    expect(drillCalls()[0]!.url.searchParams.get('locale')).toBe('en');
    expect(text(box)).toContain('For “Ghost Ball”');
    expect(postCalls()).toHaveLength(0);
  });

  test('uses the drill the page already loaded: no second GET of it', async () => {
    const user = setup();
    await openForm(user, { primeDrill: true });
    expect(drillCalls()).toHaveLength(0);
    expect(metaCalls()).toHaveLength(1);
  });

  test('asks for the kind, the proposed text, an optional video, the author and the two attestations, each with a visible label', async () => {
    const user = setup();
    const { box } = await openForm(user);
    expect(kindSelect(box).required || kindSelect(box).getAttribute('aria-required') === 'true').toBe(true);
    expect(textArea(box).tagName).toBe('TEXTAREA');
    expect(videoInput(box).type).toBe('file');
    expect(authorInput(box).type).toBe('text');
    expect(rightsBox(box).checked).toBe(false);
    expect(noCommercialBox(box).checked).toBe(false);
    expect(within(box).getByText('MP4, WebM or MOV, up to 20 MB.')).toBeTruthy();
  });

  test('offers exactly the improvement kinds of the meta, in its order, in plain words', async () => {
    const user = setup();
    const { box } = await openForm(user);
    const options = Array.from(kindSelect(box).options).filter((option) => option.value !== '');
    expect(options.map((option) => option.value)).toEqual([...IMPROVEMENT_KINDS]);
    expect(options.map(text)).toEqual([
      'A different explanation',
      'A new progression',
      'A simpler variant',
      'An adaptation for another age',
      'A translation',
      'A new video',
      'An accessibility adaptation',
      'A safety improvement',
    ]);
    expect(kindSelect(box).value).toBe('');
  });

  test('offers only the kinds the meta lists', async () => {
    serve({ meta: [() => json(metaWith((draft) => (draft.improvementKinds = ['safety', 'translation'])))] });
    const user = setup();
    const { box } = await openForm(user);
    expect(Array.from(kindSelect(box).options).map((option) => option.value).filter(Boolean)).toEqual(['safety', 'translation']);
  });

  test('offers the author the name of the account, editable', async () => {
    const user = setup();
    const { box } = await openForm(user);
    expect(authorInput(box).value).toBe('Aidar Coach');
    await user.clear(authorInput(box));
    await user.type(authorInput(box), 'Team Coach');
    expect(authorInput(box).value).toBe('Team Coach');
  });

  test('the video input accepts the meta’s video types only', async () => {
    const user = setup();
    const { box } = await openForm(user);
    expect(videoInput(box).getAttribute('accept')?.split(',').map((type) => type.trim())).toEqual(['video/mp4', 'video/webm', 'video/quicktime']);
  });

  test('a hidden honeypot field named website exists, is out of reach of people and assistive tech, and is empty', async () => {
    const user = setup();
    const { box } = await openForm(user);
    const trap = box.querySelector('input[name="website"]') as HTMLInputElement | null;
    expect(trap === null).toBe(false);
    expect(trap!.value).toBe('');
    expect(trap!.tabIndex).toBe(-1);
    expect(trap!.closest('[aria-hidden="true"]') === null).toBe(false);
    expect(trap!.getAttribute('autocomplete')).toBe('off');
  });
});

// --- loading, empty, error ----------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until both reads arrive, with no form and no invented option', async () => {
    const heldMeta = deferred();
    const heldDrill = deferred();
    serve({ meta: [() => heldMeta.promise], drill: [() => heldDrill.promise] });
    renderSlot();
    await userEvent.setup().click(await triggerButton());
    const box = await dialog();
    const status = await within(box).findByRole('status', { name: 'Loading the suggestion form' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(within(box).queryByRole('button', { name: 'Send suggestion' }) === null).toBe(true);
    expect(within(box).queryByRole('alert') === null).toBe(true);

    heldMeta.release(json(META));
    // one of two reads is not enough
    await waitFor(() => expect(metaCalls()).toHaveLength(1));
    expect(within(box).queryByRole('button', { name: 'Send suggestion' }) === null).toBe(true);
    heldDrill.release(json(DRILL));
    await within(box).findByRole('button', { name: 'Send suggestion' });
    expect(within(box).queryByRole('status', { name: 'Loading the suggestion form' }) === null).toBe(true);
  });
});

describe('empty', () => {
  test('a meta with no improvement kind says suggestions are not open, and offers no way to send', async () => {
    serve({ meta: [() => json(metaWith((draft) => (draft.improvementKinds = [])))] });
    renderSlot();
    await userEvent.setup().click(await triggerButton());
    const box = await dialog();
    await within(box).findByText('Suggestions are not open right now');
    expect(within(box).queryByRole('button', { name: 'Send suggestion' }) === null).toBe(true);
    expect(within(box).queryByRole('alert') === null).toBe(true);
  });
});

describe('error', () => {
  test('a failed meta read shows a calm error with Try again; the server’s words are never shown; Try again is busy while it runs and then shows the form', async () => {
    const retry = deferred();
    serve({ meta: [() => problem(500), () => retry.promise] });
    renderSlot();
    await userEvent.setup().click(await triggerButton());
    const box = await dialog();
    const alert = await within(box).findByRole('alert');
    expect(text(alert)).toContain('We could not open the suggestion form');
    expect(text(alert)).not.toContain('Server');
    expect(within(box).queryByRole('button', { name: 'Send suggestion' }) === null).toBe(true);

    const user = userEvent.setup();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect((within(box).getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(box).getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBe('true');
    retry.release(json(META));
    await within(box).findByRole('button', { name: 'Send suggestion' });
    expect(metaCalls()).toHaveLength(2);
  });

  test('a drill that cannot be read (404) is the same error: nothing can be suggested about it', async () => {
    serve({ drill: [() => problem(404)] });
    renderSlot();
    await userEvent.setup().click(await triggerButton());
    const box = await dialog();
    const alert = await within(box).findByRole('alert');
    expect(text(alert)).toContain('We could not open the suggestion form');
    expect(within(box).queryByRole('button', { name: 'Send suggestion' }) === null).toBe(true);
  });
});

// --- validation: nothing is sent while anything is missing ----------------------------------------

describe('validation', () => {
  test('both attestations are required: sending without them posts nothing and says so next to each one', async () => {
    const user = setup();
    const { box } = await openForm(user);
    await user.selectOptions(kindSelect(box), 'safety');
    await user.type(textArea(box), TEXT);
    await user.click(sendButton(box));

    expect(postCalls()).toHaveLength(0);
    expect(errorOf(rightsBox(box))).toContain('Please confirm this to send your suggestion.');
    expect(errorOf(noCommercialBox(box))).toContain('Please confirm this to send your suggestion.');
    expect(rightsBox(box).getAttribute('aria-invalid')).toBe('true');
    expect(noCommercialBox(box).getAttribute('aria-invalid')).toBe('true');
    // what was typed is kept
    expect(textArea(box).value).toBe(TEXT);
    expect(kindSelect(box).value).toBe('safety');
  });

  test('one attestation is not enough: only the missing one is flagged, and nothing is sent', async () => {
    const user = setup();
    const { box } = await openForm(user);
    await user.selectOptions(kindSelect(box), 'safety');
    await user.type(textArea(box), TEXT);
    await user.click(rightsBox(box));
    await user.click(sendButton(box));

    expect(postCalls()).toHaveLength(0);
    expect(errorOf(rightsBox(box))).toBe('');
    expect(errorOf(noCommercialBox(box))).toContain('Please confirm this to send your suggestion.');

    // the other one alone is flagged the other way round
    await user.click(rightsBox(box));
    await user.click(noCommercialBox(box));
    await user.click(sendButton(box));
    expect(postCalls()).toHaveLength(0);
    expect(errorOf(rightsBox(box))).toContain('Please confirm this to send your suggestion.');
    expect(errorOf(noCommercialBox(box))).toBe('');
  });

  test('an empty form flags the kind, the text and (when cleared) the author, focuses the first of them, and sends nothing', async () => {
    const user = setup();
    const { box } = await openForm(user);
    await user.clear(authorInput(box));
    await user.click(sendButton(box));

    expect(postCalls()).toHaveLength(0);
    expect(errorOf(kindSelect(box))).toContain('Choose the kind of improvement.');
    expect(errorOf(textArea(box))).toContain('Write your suggestion.');
    expect(errorOf(authorInput(box))).toContain('Write your name.');
    expect(document.activeElement === kindSelect(box)).toBe(true);
  });

  test('a suggestion made only of spaces, or an author made only of spaces, is empty', async () => {
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box, 'safety', '   ');
    await user.clear(authorInput(box));
    await user.type(authorInput(box), '   ');
    await user.click(sendButton(box));
    expect(postCalls()).toHaveLength(0);
    expect(errorOf(textArea(box))).toContain('Write your suggestion.');
    expect(errorOf(authorInput(box))).toContain('Write your name.');
  });

  test('a video of another type, or over the size limit, is refused with a sentence and nothing is sent', async () => {
    serve({ meta: [() => json(metaWith((draft) => (draft.upload.maxMb = 1)))] });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box);

    await user.upload(videoInput(box), video('notes.pdf', 'application/pdf'));
    await user.click(sendButton(box));
    expect(postCalls()).toHaveLength(0);
    expect(errorOf(videoInput(box))).toContain('This file type is not accepted. Choose an MP4, WebM or MOV video.');

    await user.upload(videoInput(box), video('big.mp4', 'video/mp4', 1024 * 1024 + 1));
    await user.click(sendButton(box));
    expect(postCalls()).toHaveLength(0);
    expect(errorOf(videoInput(box))).toContain('This video is larger than 1 MB.');
  });

  test('a video exactly at the limit is accepted', async () => {
    serve({ meta: [() => json(metaWith((draft) => (draft.upload.maxMb = 1)))], post: [() => json(created(), { status: 201 })] });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box);
    await user.upload(videoInput(box), video('exact.mp4', 'video/mp4', 1024 * 1024));
    await user.click(sendButton(box));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
  });
});

// --- the request --------------------------------------------------------------------------------

describe('the request', () => {
  const answer = () => json(created(sentPayload()), { status: 201 });

  test('sends ONE multipart POST /api/contributions whose payload is an improvement of this drill, valid by the contract', async () => {
    serve({ post: [answer] });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box, 'progression');
    await user.click(sendButton(box));

    await within(box).findByText('Thank you');
    expect(postCalls()).toHaveLength(1);
    const call = postCalls()[0]!;
    expect(call.init!.body instanceof FormData).toBe(true);
    // no hand-set Content-Type: fetch must generate the multipart boundary
    expect(Object.keys(call.init?.headers ?? {}).map((key) => key.toLowerCase())).not.toContain('content-type');

    const payload = sentPayload();
    expect(payload.kind).toBe('improvement');
    expect(payload.targetDrillSlug).toBe(SLUG);
    expect(payload.improvementKind).toBe('progression');
    expect(payload.instructions).toBe(TEXT);
    expect(payload.author).toBe('Aidar Coach');
    expect(payload.rightsAttested).toBe(true);
    expect(payload.noCommercialContent).toBe(true);
    expect(payload.website).toBe('');
    expect(payload.locale).toBe('en');
    expect(ContributionPayloadRequest.safeParse(payload).success).toBe(true);
  });

  test('the other fields of the payload come from the drill and the meta: name, age, equipment, duration, and valid sport, skill and level', async () => {
    serve({ drill: [() => json(drill((draft) => (draft.content.dose = { durationSec: 90 })))], post: [answer] });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box);
    await user.click(sendButton(box));
    await within(box).findByText('Thank you');

    const payload = sentPayload();
    expect(payload.name).toBe('Ghost Ball');
    expect(payload.ageMin).toBe(5);
    expect(payload.ageMax).toBe(99);
    expect(payload.equipment).toBe('nothing');
    expect(payload.durationMin).toBe(2);
    expect(META.sports.map((sport) => sport.slug)).toContain(payload.sport as string);
    expect(SKILL_SLUGS).toContain(payload.skill as string);
    expect(META.levels).toContain(payload.level as (typeof META.levels)[number]);
    for (const blank of ['mistakes', 'progression', 'regression', 'safety']) expect(payload[blank]).toBe('');
    expect(typeof payload.source === 'string' && payload.source.length > 0).toBe(true);
  });

  test('a drill with no title, no ages and a repetition-only dose still makes a valid payload named after its slug', async () => {
    serve({
      drill: [
        () =>
          json(
            drill((draft) => {
              delete draft.content.title;
              draft.content.conditions = { equipment: 'ball', spaces: ['yard'], partner: false };
              draft.content.dose = { reps: 12 };
            }),
          ),
      ],
      post: [answer],
    });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box);
    await user.click(sendButton(box));
    await within(box).findByText('Thank you');

    const payload = sentPayload();
    expect(payload.name).toBe('Ball mastery ghost ball');
    expect(payload.equipment).toBe('ball');
    expect(payload.durationMin).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(payload.durationMin)).toBe(true);
    expect(payload.ageMin).toBeGreaterThanOrEqual(0);
    expect((payload.ageMax as number) >= (payload.ageMin as number)).toBe(true);
    expect(ContributionPayloadRequest.safeParse(payload).success).toBe(true);
  });

  test('without a video there is no video part; with one, the file itself is the `video` part', async () => {
    serve({ post: [answer] });
    let user = setup();
    let view = await openForm(user);
    await fillValid(user, view.box);
    await user.click(sendButton(view.box));
    await within(view.box).findByText('Thank you');
    expect(sentForm().has('video')).toBe(false);
    view.unmount();

    serve({ post: [answer] });
    user = setup();
    view = await openForm(user);
    await fillValid(user, view.box, 'video');
    const file = video('demo.mp4');
    await user.upload(videoInput(view.box), file);
    await user.click(sendButton(view.box));
    await within(view.box).findByText('Thank you');
    const part = sentForm().get('video') as File;
    expect(part instanceof File).toBe(true);
    expect(part.name).toBe('demo.mp4');
    expect(part.type).toBe('video/mp4');
    expect(sentPayload().improvementKind).toBe('video');
  });

  test('the author can be changed, and the language of the page is the language of the payload', async () => {
    serve({ post: [answer] });
    const user = setup();
    const { box } = await openForm(user, { locale: 'ru' });
    await user.selectOptions(within(box).getByRole('combobox'), 'safety');
    await user.type(within(box).getByRole('textbox', { name: say('ru', 'fields.text.label') }), 'Проверьте площадку.');
    await user.click(within(box).getAllByRole('checkbox')[0]!);
    await user.click(within(box).getAllByRole('checkbox')[1]!);
    const author = within(box).getByRole('textbox', { name: say('ru', 'fields.author.label') });
    await user.clear(author);
    await user.type(author, 'Тренер Айдар');
    await user.click(within(box).getByRole('button', { name: say('ru', 'actions.send') }));
    await within(box).findByText(say('ru', 'success.title'));
    const payload = sentPayload();
    expect(payload.locale).toBe('ru');
    expect(payload.author).toBe('Тренер Айдар');
    expect(payload.name).toBe('Воображаемый мяч');
    expect(metaCalls()[0]!.url.searchParams.get('locale')).toBe('ru');
  });
});

// --- disabled while in flight -------------------------------------------------------------------

describe('while the request is in flight', () => {
  test('every control is disabled, Send is busy, the dialog cannot be dismissed, and the request is sent once however hard it is pressed', async () => {
    const held = deferred();
    serve({ post: [() => held.promise] });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box);
    await user.click(sendButton(box));

    await waitFor(() => expect(sendButton(box).disabled).toBe(true));
    expect(sendButton(box).getAttribute('aria-busy')).toBe('true');
    expect(cancelButton(box).disabled).toBe(true);
    for (const control of [kindSelect(box), textArea(box), authorInput(box), videoInput(box), rightsBox(box), noCommercialBox(box)]) {
      expect(control.disabled).toBe(true);
    }
    expect(within(box).getByText('Sending your suggestion. A video can take a minute.').closest('[role="status"]') === null).toBe(false);

    // pressing again, submitting again and Escape change nothing
    await user.click(sendButton(box));
    const form = box.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await user.keyboard('{Escape}');
    expect(postCalls()).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: DIALOG }) === null).toBe(false);

    held.release(json(created(sentPayload()), { status: 201 }));
    await within(box).findByText('Thank you');
    expect(postCalls()).toHaveLength(1);
  });

  test('after a failure everything is enabled again, what was typed is kept, and Send can be pressed once more', async () => {
    serve({ post: [() => problem(500), () => json(created(), { status: 201 })] });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box, 'translation');
    await user.click(sendButton(box));

    const alert = await within(box).findByRole('alert');
    expect(text(alert)).toContain('Your suggestion was not sent');
    expect(sendButton(box).disabled).toBe(false);
    expect(sendButton(box).getAttribute('aria-busy')).not.toBe('true');
    expect(cancelButton(box).disabled).toBe(false);
    expect(textArea(box).value).toBe(TEXT);
    expect(kindSelect(box).value).toBe('translation');
    expect(rightsBox(box).checked).toBe(true);
    expect(noCommercialBox(box).checked).toBe(true);

    await user.click(sendButton(box));
    await within(box).findByText('Thank you');
    expect(postCalls()).toHaveLength(2);
  });
});

// --- failures of the request ------------------------------------------------------------------------

describe('failures of the request', () => {
  async function send(answer: Answer, edit?: (user: User, box: HTMLElement) => Promise<void>) {
    serve({ post: [answer] });
    const user = setup();
    const view = await openForm(user);
    await fillValid(user, view.box);
    await edit?.(user, view.box);
    await user.click(sendButton(view.box));
    return { ...view, user };
  }

  test('a 422 with pointers puts a written sentence on the field they name, never the server’s words, and keeps the form', async () => {
    const { box } = await send(() => invalid('/instructions', '/author'));
    await waitFor(() => expect(errorOf(textArea(box))).toContain('Please check this field.'));
    expect(errorOf(authorInput(box))).toContain('Please check this field.');
    expect(textArea(box).getAttribute('aria-invalid')).toBe('true');
    expect(text(box)).not.toContain('Server says this is wrong');
    expect(text(box)).not.toContain('Server detail in English');
    expect(within(box).getByText('Your suggestion was not sent') === null).toBe(false);
    expect(sendButton(box).disabled).toBe(false);
  });

  test('a 422 on an improvement kind and on the attestations lands on those controls', async () => {
    const { box } = await send(() => invalid('/improvementKind', '/rightsAttested', '/noCommercialContent'));
    await waitFor(() => expect(errorOf(kindSelect(box))).toContain('Please check this field.'));
    expect(errorOf(rightsBox(box))).toContain('Please check this field.');
    expect(errorOf(noCommercialBox(box))).toContain('Please check this field.');
  });

  test('a 422 on the video part lands on the video field', async () => {
    const { box } = await send(() => invalid('/video'));
    await waitFor(() => expect(errorOf(videoInput(box))).toContain('Please check this field.'));
  });

  test('a 422 on something the dialog has no field for (the drill, the honeypot) is a form-level message that does not point at nothing', async () => {
    const { box } = await send(() => invalid('/targetDrillSlug', '/website'));
    const alert = await within(box).findByRole('alert');
    expect(text(alert)).toContain('Your suggestion was not sent');
    expect(text(alert)).toContain('Something in your suggestion was not accepted. Check it and try again.');
    expect(text(alert)).not.toContain('Check the highlighted fields.');
    expect(text(box)).not.toContain('website');
    expect(text(box)).not.toContain('Server says this is wrong');
  });

  test('a 409 (the same suggestion is already waiting) says so in words and links to My contributions; the form stays', async () => {
    const { box } = await send(() => problem(409, { instance: '/api/contributions/c-existing', title: 'Conflict' }));
    const alert = await within(box).findByRole('alert');
    expect(text(alert)).toContain('You have already sent this suggestion. It is waiting for a reviewer.');
    const link = within(alert).getByRole('link', { name: 'See my contributions' });
    expect(link.getAttribute('href')).toBe('/contribute/mine');
    expect(text(alert)).not.toContain('Conflict');
    expect(textArea(box).value).toBe(TEXT);
    expect(sendButton(box).disabled).toBe(false);
  });

  test('a 413 and a 415 land on the video field with their own sentence', async () => {
    let view = await send(() => problem(413), (user, box) => user.upload(videoInput(box), video()));
    await waitFor(() => expect(errorOf(videoInput(view.box))).toContain('This video is larger than 20 MB.'));
    view.unmount();

    view = await send(() => problem(415), (user, box) => user.upload(videoInput(box), video()));
    await waitFor(() => expect(errorOf(videoInput(view.box))).toContain('This file type is not accepted. Choose an MP4, WebM or MOV video.'));
  });

  test('a 429 and a network failure show the app’s generic localised messages, in a form-level alert', async () => {
    let view = await send(() => problem(429));
    let alert = await within(view.box).findByRole('alert');
    expect(text(alert)).toContain('Your suggestion was not sent');
    expect(text(alert)).toContain(problemMessages.en.rateLimited);
    view.unmount();

    view = await send(() => Promise.reject(new TypeError('Failed to fetch')));
    alert = await within(view.box).findByRole('alert');
    expect(text(alert)).toContain(problemMessages.en.offline);
    expect(text(alert)).not.toContain('Failed to fetch');
  });
});

// --- success ------------------------------------------------------------------------------------

describe('success', () => {
  test('replaces the form with a thank-you that says a reviewer decides, links to My contributions and can be closed; the form is gone', async () => {
    serve({ post: [() => json(created(), { status: 201 })] });
    const user = setup();
    const { box } = await openForm(user);
    await fillValid(user, box);
    await user.click(sendButton(box));

    const done = await within(box).findByRole('status');
    expect(text(done)).toContain('Thank you');
    expect(text(done)).toContain('A reviewer will read your suggestion. The drill changes only if they accept it.');
    expect(within(box).getByRole('link', { name: 'See my contributions' }).getAttribute('href')).toBe('/contribute/mine');
    expect(within(box).queryByRole('button', { name: 'Send suggestion' }) === null).toBe(true);
    expect(within(box).queryByLabelText('Your suggestion') === null).toBe(true);

    await user.click(within(box).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(postCalls()).toHaveLength(1);
  });

  test('the dialog can be closed with Cancel before anything is sent, and nothing is sent', async () => {
    const user = setup();
    const { box } = await openForm(user);
    await user.click(cancelButton(box));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(postCalls()).toHaveLength(0);
    // the button is still there for another try
    await triggerButton();
  });
});

// --- languages ----------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  const keyPaths = (node: unknown, prefix = ''): string[] =>
    typeof node === 'string'
      ? [prefix]
      : Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => keyPaths(value, prefix === '' ? key : `${prefix}.${key}`));

  test('the three bundles have exactly the same keys and no empty string', () => {
    const en = keyPaths(messages.en).sort();
    expect(en.length).toBeGreaterThan(30);
    for (const locale of ['kk', 'ru'] as const) expect(keyPaths(messages[locale]).sort()).toEqual(en);
    for (const locale of LOCALES) for (const path of en) expect(say(locale, path).trim()).not.toBe('');
  });

  test('there is a sentence for every improvement kind of the contract in every language', () => {
    for (const locale of LOCALES) for (const kind of IMPROVEMENT_KINDS) expect(say(locale, `kinds.${kind}`).length).toBeGreaterThan(2);
    expect(new Set(IMPROVEMENT_KINDS.map((kind) => say('en', `kinds.${kind}`))).size).toBe(IMPROVEMENT_KINDS.length);
  });

  test('every locale renders the trigger, the form and the thank-you with real text and no leaked key or placeholder', async () => {
    const buttons = new Set<string>();
    for (const locale of LOCALES) {
      serve({ post: [() => json(created(), { status: 201 })] });
      const user = setup();
      const view = renderSlot({ locale });
      const button = (await screen.findByRole('button', { name: say(locale, 'trigger.button') })) as HTMLButtonElement;
      buttons.add(text(button));
      const page = text(screen.getByRole('main'));
      for (const leak of LEAKS) expect(page).not.toContain(leak);
      expect(page).not.toMatch(/\b(trigger|dialog|fields|errors|success|actions|kinds)\.[a-z]/i);
      if (locale !== 'en') expect(page).toMatch(/[Ѐ-ӿ]{4,}/);

      await user.click(button);
      const box = await screen.findByRole('dialog', { name: say(locale, 'dialog.title') });
      await within(box).findByRole('button', { name: say(locale, 'actions.send') });
      const form = text(box);
      for (const leak of LEAKS) expect(form).not.toContain(leak);
      expect(form).not.toMatch(/\b(trigger|dialog|fields|errors|success|actions|kinds)\.[a-z]/i);
      if (locale !== 'en') expect(form).toMatch(/[Ѐ-ӿ]{4,}/);
      expect(within(box).getAllByRole('option')).toHaveLength(IMPROVEMENT_KINDS.length + 1);

      // the validation sentences are written too
      await user.click(within(box).getByRole('button', { name: say(locale, 'actions.send') }));
      const flagged = text(box);
      expect(flagged).toContain(say(locale, 'errors.rights'));
      for (const leak of LEAKS) expect(flagged).not.toContain(leak);

      await user.selectOptions(within(box).getByRole('combobox'), 'safety');
      await user.type(within(box).getAllByRole('textbox')[0]!, 'x');
      await user.click(within(box).getAllByRole('checkbox')[0]!);
      await user.click(within(box).getAllByRole('checkbox')[1]!);
      await user.click(within(box).getByRole('button', { name: say(locale, 'actions.send') }));
      const thanks = await within(box).findByText(say(locale, 'success.title'));
      expect(thanks === null).toBe(false);
      const done = text(box);
      for (const leak of LEAKS) expect(done).not.toContain(leak);
      expect(done).not.toMatch(/\b(trigger|dialog|fields|errors|success|actions|kinds)\.[a-z]/i);
      view.unmount();
    }
    expect(buttons.size).toBe(3);
  });

  test('the empty and the error states are written in every language', async () => {
    for (const locale of LOCALES) {
      serve({ meta: [() => json(metaWith((draft) => (draft.improvementKinds = [])))] });
      let view = renderSlot({ locale });
      await userEvent.setup().click(await screen.findByRole('button', { name: say(locale, 'trigger.button') }));
      let box = await screen.findByRole('dialog', { name: say(locale, 'dialog.title') });
      await within(box).findByText(say(locale, 'empty.title'));
      let all = text(box);
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      view.unmount();

      serve({ meta: [() => problem(500)] });
      view = renderSlot({ locale });
      await userEvent.setup().click(await screen.findByRole('button', { name: say(locale, 'trigger.button') }));
      box = await screen.findByRole('dialog', { name: say(locale, 'dialog.title') });
      const alert = await within(box).findByRole('alert');
      all = text(alert);
      expect(all).toContain(say(locale, 'error.title'));
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      view.unmount();
    }
  });

  test('the signed-out hint and the session-error text are written in every language', async () => {
    for (const locale of LOCALES) {
      let view = renderSlot({ locale, session: sessionOf(null) });
      await screen.findByText(say(locale, 'trigger.signInHint'));
      view.unmount();
      view = renderSlot({ locale, session: sessionOf(null, { error: new Error('x') }) });
      await screen.findByText(say(locale, 'trigger.sessionError'));
      view.unmount();
    }
  });
});

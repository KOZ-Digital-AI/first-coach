import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Contribution, ContributionMeta, ContributionPayloadRequest } from '@api-types/contributions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { ContributeDepsContext, Route, type XhrLike } from '../../routes/contribute/index';
import messages from './form.messages';

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
 * Contract under test (fc-mol-70i.8): /contribute is the CONTRIBUTE A METHOD form (spec section 17).
 *  - Only a contributor (a signed-in, NON-anonymous account) sees the form. Anyone else is sent to
 *    /account/sign-in?redirect=/contribute; a broken form is never shown.
 *  - Fields: name, sport, skill, age range, difficulty, goal, instructions, duration, equipment, common mistakes, progression,
 *    regression, safety, video (with the size and type hint from GET /api/contribute/meta), source, author; two required
 *    checkboxes (rights attestation, "not FIFA, UEFA or commercial content"); a hidden honeypot; a notice that the method
 *    stays out of training plans until reviewed.
 *  - ONE multipart POST /api/contributions (a `payload` part, plus a `video` part when a video was chosen) with upload
 *    progress (XMLHttpRequest through the typed client's injectable fetch). Success shows the thank-you sentence and a link to
 *    My contributions. Server field errors (RFC 6901 pointers) land on their fields. An unsent draft survives a reload.
 *  - loading, empty, error, disabled and success states; mutation buttons are disabled while a request is in flight; every
 *    string exists in kk, ru and en.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-ins are the network
 * (globalThis.fetch for the meta call, a fake XMLHttpRequest for the upload) and the session state.
 * Kazakh and Russian copy still needs a native-speaker review: for those locales the tests pin only that text exists, is
 * Cyrillic and never leaks 'undefined', 'NaN', a raw key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - "video upload": one `video` part. The contract's extra `files` (photos, PDF) are not part of the criteria's field list.
 * - "sign-in required": a session that is loading, unreadable or has no user is not a contributor; only `isAnonymous === false` is.
 * - "empty": the meta lists no skill, so nothing can be chosen and nothing can be sent.
 * - "server field errors land on their fields": the field is flagged (aria-invalid) with a LOCALISED sentence; the server's English
 *   text is never shown. A pointer that names no field (e.g. /sourceUrl) becomes a form-level message.
 * - Drafts: same storage format as features/account/session-expired.ts (`fc:draft:contribute-form`), so sign-out clears it.
 *   The two attestations, the honeypot and the video file are never part of a draft.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

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

const meta = (patch: Partial<ContributionMeta> = {}): ContributionMeta => ({ ...META, ...patch });

const VALUES = {
  name: 'Wall passes',
  ageMin: '8',
  ageMax: '12',
  duration: '15',
  instructions: 'Pass the ball against the wall 20 times with the inside of your foot.',
  mistakes: 'Looking at the ball, not at the wall.',
  progression: 'Use only the weaker foot.',
  regression: 'Stand closer to the wall.',
  safety: 'Keep clear of windows.',
  source: 'My own practice',
  author: 'Aigerim Coach',
};

const EXPECTED_PAYLOAD = {
  kind: 'new',
  locale: 'en',
  name: 'Wall passes',
  sport: 'football',
  skill: 'inside-touches',
  ageMin: 8,
  ageMax: 12,
  level: 'basic',
  goal: 'passing',
  instructions: VALUES.instructions,
  durationMin: 15,
  equipment: 'ball_wall',
  mistakes: VALUES.mistakes,
  progression: VALUES.progression,
  regression: VALUES.regression,
  safety: VALUES.safety,
  source: 'My own practice',
  author: 'Aigerim Coach',
  rightsAttested: true,
  noCommercialContent: true,
  website: '',
};

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
    instructions: VALUES.instructions,
    durationMin: 15,
    equipment: 'ball_wall',
    mistakes: VALUES.mistakes,
    progression: VALUES.progression,
    regression: VALUES.regression,
    safety: VALUES.safety,
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

const problemBody = (status: number, title: string, errors: Array<{ pointer: string; detail: string }> = []) => ({
  type: 'about:blank',
  title,
  status,
  detail: `${title} (server text)`,
  errors,
});
const problem = (status: number, title: string, errors: Array<{ pointer: string; detail: string }> = []) =>
  json(problemBody(status, title, errors), { status }, 'application/problem+json');

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: Array<{ url: URL; init: RequestInit | undefined }> = [];

function stubNetwork(handler: Handler): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

const META_PATH = '/api/contribute/meta';
const metaCalls = () => calls.filter((call) => call.url.pathname === META_PATH);

/** Answers each GET /api/contribute/meta with the next response in the list (the last one repeats). */
function serve(...responses: Array<() => Response | Promise<Response>>): void {
  let index = 0;
  stubNetwork((url) => {
    if (url.pathname !== META_PATH) return problem(404, 'Not Found');
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  });
}
const serveMeta = (body: unknown = META) => serve(() => json(body));

/** A response the test releases by hand, to hold a request in flight. */
function deferred() {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release };
}

/** The upload: a fake XMLHttpRequest the test drives by hand (progress, answer, failure). */
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
  headers: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  body: unknown;
  sent = 0;
  aborted = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: unknown) {
    this.sent += 1;
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  // -- test controls
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown, type = 'application/json') {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseHeaders['content-type'] = type;
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
  get form(): FormData {
    return this.body as FormData;
  }
  get payload(): Record<string, unknown> {
    return JSON.parse(String(this.form.get('payload'))) as Record<string, unknown>;
  }
}

let xhrs: FakeXhr[] = [];
const createXhr = (): XhrLike => {
  const xhr = new FakeXhr();
  xhrs.push(xhr);
  return xhr;
};

beforeEach(() => {
  xhrs = [];
  serveMeta();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

type SessionState = { data?: unknown; isPending: boolean; isRefetching?: boolean; error?: unknown; refetch: () => unknown };
const ready = (data: unknown, refetch: () => unknown = () => {}): SessionState => ({ data, isPending: false, error: null, refetch });
const CONTRIBUTOR = ready({ user: { id: 'u-1', name: 'Aigerim', isAnonymous: false } });

const modules = {
  './form.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const DRAFT_KEY = 'fc:draft:contribute-form';

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}
type Storage = ReturnType<typeof fakeStorage>;
const savedDraft = (storage: Storage): { savedAt: number; value: Record<string, unknown> } | null => {
  const raw = storage.data.get(DRAFT_KEY);
  return raw === undefined ? null : (JSON.parse(raw) as { savedAt: number; value: Record<string, unknown> });
};

interface Options {
  session?: SessionState;
  locale?: Locale;
  storage?: Storage | null;
  /** Leave sign-in navigation to the real router instead of a logging spy. */
  realNavigate?: boolean;
}

function renderScreen(options: Options = {}) {
  const { session = CONTRIBUTOR, locale = 'en', realNavigate = false } = options;
  const storage = options.storage === undefined ? fakeStorage() : options.storage;
  const navigations: string[] = [];
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const contribute = createRoute({ getParentRoute: () => rootRoute, path: '/contribute', component: Route.options.component });
  const mine = createRoute({ getParentRoute: () => rootRoute, path: '/contribute/mine', component: () => <p>mine</p> });
  const signIn = createRoute({ getParentRoute: () => rootRoute, path: '/account/sign-in', component: () => <p>sign in page</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([contribute, mine, signIn]),
    history: createMemoryHistory({ initialEntries: ['/contribute'] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <ContributeDepsContext.Provider
          value={{
            session,
            createXhr,
            storage,
            now: () => NOW,
            ...(realNavigate ? {} : { navigate: (to: string) => void navigations.push(to) }),
          }}
        >
          <RouterProvider router={router} />
        </ContributeDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  // `storage` is null only when a test asks for no storage at all; those tests never read it back.
  return { ...view, router, storage: storage as Storage, navigations, instance, queryClient };
}

/** Renders as a contributor and waits for the form. */
async function renderForm(options: Options = {}) {
  const view = renderScreen(options);
  const { submit } = messages[options.locale ?? 'en'];
  await screen.findByRole('button', { name: new RegExp(`^(${submit.label}|${submit.busy})$`) });
  return view;
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const fill = (template: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce((out, [key, value]) => out.replaceAll(`{{${key}}}`, String(value)), template);

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const control = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const submitButton = () => screen.getByRole('button', { name: /^(Send for review|Sending…)$/ }) as HTMLButtonElement;
const rightsBox = () => screen.getByRole('checkbox', { name: /permission to share/i }) as HTMLInputElement;
const commercialBox = () => screen.getByRole('checkbox', { name: /not FIFA, UEFA or commercial content/i }) as HTMLInputElement;
const honeypot = () => document.querySelector('input[name="website"]') as HTMLInputElement;
const videoInput = () => control(/^Video/) as HTMLInputElement;

/** The visible error text a control points at with aria-describedby (empty when it has none). */
function describedBy(element: Element): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id))
    .map((node) => (node === null ? '' : text(node)))
    .join(' ');
}
const isFlagged = (element: Element): boolean => element.getAttribute('aria-invalid') === 'true';

function fillValid(patch: Partial<typeof VALUES> = {}) {
  const v = { ...VALUES, ...patch };
  type(/^Name of the method/, v.name);
  type(/^Skill/, 'inside-touches');
  type(/^Age from/, v.ageMin);
  type(/^Age to/, v.ageMax);
  type(/^Difficulty/, 'basic');
  type(/^Goal/, 'passing');
  type(/^Duration/, v.duration);
  type(/^Equipment/, 'ball_wall');
  type(/^Instructions/, v.instructions);
  type(/^Common mistakes/, v.mistakes);
  type(/^Progression/, v.progression);
  type(/^Regression/, v.regression);
  type(/^Safety/, v.safety);
  type(/^Source/, v.source);
  type(/^Author/, v.author);
}
const attestBoth = () => {
  fireEvent.click(rightsBox());
  fireEvent.click(commercialBox());
};
async function submit() {
  await act(async () => {
    fireEvent.click(submitButton());
  });
}
/** Fills everything, attests, and submits; resolves with the one upload the screen started. */
async function sendValid(patch: Partial<typeof VALUES> = {}): Promise<FakeXhr> {
  fillValid(patch);
  attestBoth();
  await submit();
  await waitFor(() => expect(xhrs.length).toBe(1));
  return xhrs[0]!;
}

const videoFile = (name = 'wall-passes.mp4', type_ = 'video/mp4', size?: number) => {
  const file = new File(['not really a video'], name, { type: type_ });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};
const chooseVideo = (file: File) => fireEvent.change(videoInput(), { target: { files: [file] } });

/** Dotted paths of every string leaf. */
function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
  );
}

// --- who may see the form ----------------------------------------------------------------------------------------

describe('sign-in is required', () => {
  test('a signed-out visitor is sent to /account/sign-in with redirect=/contribute, and no form and no request', async () => {
    const view = renderScreen({ session: ready(null) });
    await waitFor(() => expect(view.navigations.length).toBeGreaterThan(0));
    const target = new URL(view.navigations[0]!, 'http://localhost');
    expect(target.pathname).toBe('/account/sign-in');
    expect(target.searchParams.get('redirect')).toBe('/contribute');
    expect(screen.queryByRole('button', { name: /send for review/i }) === null).toBe(true);
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(calls).toHaveLength(0);
    expect(xhrs).toHaveLength(0);
  });

  test('an anonymous player is NOT a contributor: same redirect, never a broken form', async () => {
    const view = renderScreen({ session: ready({ user: { id: 'guest', isAnonymous: true } }) });
    await waitFor(() => expect(view.navigations.length).toBeGreaterThan(0));
    expect(new URL(view.navigations[0]!, 'http://localhost').searchParams.get('redirect')).toBe('/contribute');
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('a session whose isAnonymous flag is missing is not trusted as an account', async () => {
    const view = renderScreen({ session: ready({ user: { id: 'u-x' } }) });
    await waitFor(() => expect(view.navigations.length).toBeGreaterThan(0));
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
  });

  test('the default navigation is the router: the visitor lands on the sign-in page carrying the return path', async () => {
    const view = renderScreen({ session: ready(null), realNavigate: true });
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/account/sign-in'));
    expect(new URL(view.router.state.location.href, 'http://localhost').searchParams.get('redirect')).toBe('/contribute');
  });

  test('while the session is loading: a busy status, no form, no redirect, no request', async () => {
    const view = renderScreen({ session: { isPending: true, refetch: () => {} } });
    const status = await screen.findByRole('status', { name: 'Loading the form' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(view.navigations).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('a session that is being re-read may still hold the previous person: no form, no redirect, until it settles', async () => {
    const view = renderScreen({ session: { data: { user: { id: 'u-1', isAnonymous: false } }, isPending: false, isRefetching: true, refetch: () => {} } });
    await screen.findByRole('status', { name: 'Loading the form' });
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(view.navigations).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('a session that could not be read shows an error with Try again (which re-reads it), and no form', async () => {
    const refetch = mock(() => {});
    const view = renderScreen({ session: { isPending: false, error: new Error('boom'), refetch } });
    await screen.findByText('We could not check your account');
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(view.navigations).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('a contributor gets the form, and no redirect', async () => {
    const view = await renderForm();
    expect(view.navigations).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1, name: 'Contribute a method' })).toBeTruthy();
  });
});

// --- the form -------------------------------------------------------------------------------------------------

describe('the form and its fields', () => {
  test('loads the option lists with exactly one GET /api/contribute/meta?locale=<ui locale>', async () => {
    await renderForm({ locale: 'ru' });
    expect(metaCalls()).toHaveLength(1);
    expect(metaCalls()[0]?.init?.method).toBe('GET');
    expect(metaCalls()[0]?.url.searchParams.get('locale')).toBe('ru');
    expect(calls).toHaveLength(1);
  });

  test('has every field of spec section 17, each with a visible label', async () => {
    await renderForm();
    for (const label of [
      /^Name of the method/,
      /^Sport/,
      /^Skill/,
      /^Age from/,
      /^Age to/,
      /^Difficulty/,
      /^Goal/,
      /^Instructions/,
      /^Duration/,
      /^Equipment/,
      /^Common mistakes/,
      /^Progression/,
      /^Regression/,
      /^Safety/,
      /^Video/,
      /^Source/,
      /^Author/,
    ]) {
      expect(control(label)).toBeTruthy();
    }
    expect((videoInput()).type).toBe('file');
  });

  test('the option lists come from the meta response: sports, the skills tree, levels and equipment', async () => {
    await renderForm();
    const skills = within(control(/^Skill/) as HTMLSelectElement);
    for (const name of ['Ball Mastery', 'Inside Touches', 'Outside Touches', 'Passing']) {
      expect(skills.getByRole('option', { name: new RegExp(name) })).toBeTruthy();
    }
    expect(within(control(/^Sport/) as HTMLSelectElement).getByRole('option', { name: 'Football' })).toBeTruthy();
    const levels = within(control(/^Difficulty/) as HTMLSelectElement);
    for (const name of ['Beginner', 'Basic', 'Intermediate']) expect(levels.getByRole('option', { name })).toBeTruthy();
    expect(within(control(/^Equipment/) as HTMLSelectElement).getAllByRole('option').length).toBe(META.equipment.length + 1); // + the "Choose" placeholder
    expect(within(control(/^Goal/) as HTMLSelectElement).getAllByRole('option').length).toBe(5 + 1);
  });

  test('the only sport is preselected; with several sports none is guessed', async () => {
    await renderForm();
    expect((control(/^Sport/) as HTMLSelectElement).value).toBe('football');
    cleanup();
    serveMeta(meta({ sports: [...META.sports, { slug: 'futsal', name: { en: 'Futsal' } }] }));
    await renderForm();
    expect((control(/^Sport/) as HTMLSelectElement).value).toBe('');
  });

  test('a child skill is shown under its track: indented, while the track itself is not', async () => {
    await renderForm();
    const labels = within(control(/^Skill/) as HTMLSelectElement).getAllByRole('option').map((option) => option.textContent ?? '');
    const track = labels.findIndex((label) => /Ball Mastery/.test(label));
    const child = labels.findIndex((label) => /Inside Touches/.test(label));
    expect(child).toBeGreaterThan(track);
    expect(labels[track]).toBe('Ball Mastery');
    expect(labels[child]).not.toBe('Inside Touches');
    expect(labels[child]?.endsWith('Inside Touches')).toBe(true);
  });

  test('the video field hints at the size limit and the allowed types from meta, and only accepts video types', async () => {
    await renderForm();
    const hint = describedBy(videoInput());
    expect(hint).toContain('50 MB');
    expect(hint).toMatch(/MP4/);
    expect(hint).toMatch(/WEBM/);
    expect(hint).toMatch(/MOV/);
    expect(hint).not.toMatch(/PDF|JPEG|PNG/);
    const accept = videoInput().accept.split(',').map((part) => part.trim());
    expect(accept.sort()).toEqual(['video/mp4', 'video/quicktime', 'video/webm']);
  });

  test('the hint follows the meta: another limit and another type list', async () => {
    serveMeta(meta({ upload: { maxMb: 120, mimeTypes: ['video/mp4', 'application/pdf'] } }));
    await renderForm();
    const hint = describedBy(videoInput());
    expect(hint).toContain('120 MB');
    expect(hint).toMatch(/MP4/);
    expect(hint).not.toMatch(/WEBM|MOV/);
    expect(videoInput().accept).toBe('video/mp4');
  });

  test('the optional fields say so; the required ones do not', async () => {
    await renderForm();
    const labelOf = (label: RegExp) => text(document.querySelector(`label[for="${control(label).id}"]`) as Element);
    for (const label of [/^Common mistakes/, /^Progression/, /^Regression/, /^Safety/, /^Video/]) expect(labelOf(label)).toMatch(/optional/i);
    for (const label of [/^Name of the method/, /^Instructions/, /^Source/, /^Author/]) expect(labelOf(label)).not.toMatch(/optional/i);
  });

  test('the two attestations are unchecked checkboxes, worded as the spec asks', async () => {
    await renderForm();
    expect(rightsBox().checked).toBe(false);
    expect(commercialBox().checked).toBe(false);
    expect(screen.getByText(/not FIFA, UEFA or commercial content/i)).toBeTruthy();
    expect(screen.getByText(/CC BY-SA 4\.0/)).toBeTruthy();
  });

  test('a notice says the method stays out of training plans until reviewed', async () => {
    await renderForm();
    expect(screen.getByText('Your method stays out of training plans until it has been reviewed.')).toBeTruthy();
  });

  test('a hidden honeypot: named website, empty, out of the tab order and out of the accessibility tree', async () => {
    await renderForm();
    const trap = honeypot();
    expect(trap).not.toBeNull();
    expect(trap.value).toBe('');
    expect(trap.tabIndex).toBe(-1);
    expect(trap.autocomplete).toBe('off');
    expect(trap.closest('[aria-hidden="true"]') !== null).toBe(true);
  });

  test('every control is at least 44px tall (min-h-tap)', async () => {
    await renderForm();
    for (const element of [
      control(/^Name of the method/),
      control(/^Sport/),
      control(/^Age from/),
      control(/^Duration/),
      control(/^Source/),
      submitButton(),
    ]) {
      expect(element.className).toContain('min-h-tap');
    }
  });

  test('the number fields ask for a numeric keyboard', async () => {
    await renderForm();
    for (const label of [/^Age from/, /^Age to/, /^Duration/]) expect((control(label) as HTMLInputElement).inputMode).toBe('numeric');
  });
});

// --- validation: nothing is sent while something is missing ----------------------------------------------------------

describe('required answers block the submit', () => {
  test('the two required checkboxes: without them nothing is sent, and each says so', async () => {
    await renderForm();
    fillValid();
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(isFlagged(rightsBox())).toBe(true);
    expect(isFlagged(commercialBox())).toBe(true);
    expect(describedBy(rightsBox())).toContain(messages.en.validation.rightsAttested);
    expect(describedBy(commercialBox())).toContain(messages.en.validation.noCommercialContent);
  });

  test('only the rights attestation is not enough; only "not FIFA/UEFA" is not enough', async () => {
    await renderForm();
    fillValid();
    fireEvent.click(rightsBox());
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(isFlagged(rightsBox())).toBe(false);
    expect(isFlagged(commercialBox())).toBe(true);

    fireEvent.click(rightsBox());
    fireEvent.click(commercialBox());
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(isFlagged(rightsBox())).toBe(true);
    expect(isFlagged(commercialBox())).toBe(false);
  });

  test('an empty form flags every required field (and only those) and moves focus to the first one', async () => {
    await renderForm();
    attestBoth();
    await submit();
    expect(xhrs).toHaveLength(0);
    for (const label of [/^Name of the method/, /^Skill/, /^Age from/, /^Age to/, /^Difficulty/, /^Goal/, /^Duration/, /^Equipment/, /^Instructions/, /^Source/, /^Author/]) {
      expect(isFlagged(control(label))).toBe(true);
      expect(describedBy(control(label)).length).toBeGreaterThan(0);
    }
    for (const label of [/^Sport/, /^Common mistakes/, /^Progression/, /^Regression/, /^Safety/, /^Video/]) {
      expect(isFlagged(control(label))).toBe(false);
    }
    expect(document.activeElement?.id).toBe(control(/^Name of the method/).id);
    expect(screen.getAllByRole('alert').some((node) => text(node).includes(messages.en.validation.checkFields))).toBe(true);
  });

  test('a name of only spaces is empty', async () => {
    await renderForm();
    fillValid({ name: '    ' });
    attestBoth();
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(isFlagged(control(/^Name of the method/))).toBe(true);
  });

  test('ages and duration must be whole numbers; the oldest age cannot be below the youngest; duration must be positive', async () => {
    await renderForm();
    fillValid({ ageMin: '12', ageMax: '8', duration: '0' });
    attestBoth();
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(describedBy(control(/^Age to/))).toContain(messages.en.validation.ageOrder);
    expect(describedBy(control(/^Duration/))).toContain(messages.en.validation.duration);
    expect(isFlagged(control(/^Age from/))).toBe(false);

    type(/^Age from/, '8.5');
    type(/^Age to/, 'ten');
    type(/^Duration/, '-3');
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(describedBy(control(/^Age from/))).toContain(messages.en.validation.wholeNumber);
    expect(describedBy(control(/^Age to/))).toContain(messages.en.validation.wholeNumber);
    expect(describedBy(control(/^Duration/))).toContain(messages.en.validation.duration);
  });

  test('equal ages are a valid range (8 to 8)', async () => {
    await renderForm();
    const xhr = await sendValid({ ageMin: '8', ageMax: '8' });
    expect(xhr.payload.ageMin).toBe(8);
    expect(xhr.payload.ageMax).toBe(8);
  });

  test('a flagged field is un-flagged as soon as its answer is changed', async () => {
    await renderForm();
    await submit();
    expect(isFlagged(control(/^Name of the method/))).toBe(true);
    expect(isFlagged(rightsBox())).toBe(true);
    type(/^Name of the method/, 'W');
    expect(isFlagged(control(/^Name of the method/))).toBe(false);
    expect(isFlagged(control(/^Author/))).toBe(true);
    fireEvent.click(rightsBox());
    expect(isFlagged(rightsBox())).toBe(false);
    expect(isFlagged(commercialBox())).toBe(true);
  });

  test('an error is never shown by colour alone: each carries an icon and a written message', async () => {
    await renderForm();
    attestBoth();
    await submit();
    const message = document.getElementById((control(/^Name of the method/).getAttribute('aria-describedby') ?? '').split(' ').pop() ?? '');
    expect(message?.querySelector('svg') !== null).toBe(true);
    expect(text(message as Element).length).toBeGreaterThan(0);
  });
});

// --- the payload ----------------------------------------------------------------------------------------------------

describe('the one multipart POST', () => {
  test('sends POST /api/contributions with a payload part that is exactly the contract payload', async () => {
    await renderForm();
    const xhr = await sendValid();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/contributions');
    expect(xhr.payload).toEqual(EXPECTED_PAYLOAD);
    expect(ContributionPayloadRequest.safeParse(xhr.payload).success).toBe(true);
    expect(xhr.sent).toBe(1);
  });

  test('is multipart: a FormData body, no Content-Type set by hand (the boundary is the browser\'s), and the UI language is sent', async () => {
    await renderForm();
    fillValid();
    attestBoth();
    await submit();
    await waitFor(() => expect(xhrs.length).toBe(1));
    const xhr = xhrs[0]!;
    expect(xhr.body instanceof FormData).toBe(true);
    expect(xhr.headers['content-type']).toBeUndefined();
    expect(xhr.headers['accept-language']).toBe('en');
    expect(xhr.payload.locale).toBe('en');
    expect(xhr.withCredentials).toBe(false); // same-origin: cookies go along without CORS mode
  });

  test('without a video there is exactly one part, `payload`', async () => {
    await renderForm();
    const xhr = await sendValid();
    expect([...xhr.form.keys()]).toEqual(['payload']);
  });

  test('with a video there are two parts: `payload` and `video` (the very file chosen); still ONE request', async () => {
    await renderForm();
    const file = videoFile();
    chooseVideo(file);
    const xhr = await sendValid();
    expect([...xhr.form.keys()].sort()).toEqual(['payload', 'video']);
    const sent = xhr.form.get('video') as File;
    expect(sent.name).toBe('wall-passes.mp4');
    expect(sent.type).toBe('video/mp4');
    expect(xhrs).toHaveLength(1);
    expect(xhr.payload).toEqual(EXPECTED_PAYLOAD);
  });

  test('texts are trimmed; a blank optional field is sent as an empty string, not left out', async () => {
    await renderForm();
    const xhr = await sendValid({ name: '  Wall passes  ', author: ' Aigerim Coach ', mistakes: '   ', safety: '' });
    expect(xhr.payload.name).toBe('Wall passes');
    expect(xhr.payload.author).toBe('Aigerim Coach');
    expect(xhr.payload.mistakes).toBe('');
    expect(xhr.payload.safety).toBe('');
    expect(ContributionPayloadRequest.safeParse(xhr.payload).success).toBe(true);
  });

  test('numbers are sent as numbers; the new-method kind and both attestations are literal true', async () => {
    await renderForm();
    const xhr = await sendValid({ ageMin: '07', duration: '20' });
    expect(xhr.payload.ageMin).toBe(7);
    expect(xhr.payload.durationMin).toBe(20);
    expect(xhr.payload.kind).toBe('new');
    expect(xhr.payload.rightsAttested).toBe(true);
    expect(xhr.payload.noCommercialContent).toBe(true);
    expect('targetDrillSlug' in xhr.payload).toBe(false);
  });

  test('the honeypot rides along empty for a person; a bot that fills it sends its value (the server rejects it)', async () => {
    await renderForm();
    fireEvent.change(honeypot(), { target: { value: 'http://spam.example' } });
    const xhr = await sendValid();
    expect(xhr.payload.website).toBe('http://spam.example');
  });
});

// --- upload progress and the in-flight state -----------------------------------------------------------------------------------------

describe('while the request is in flight', () => {
  test('shows upload progress: a progressbar with the percentage, in words and in a number', async () => {
    await renderForm();
    const xhr = await sendValid();
    expect(screen.getByRole('progressbar', { name: 'Upload progress' })).toBeTruthy();
    act(() => xhr.progress(40, 100));
    const bar = screen.getByRole('progressbar', { name: 'Upload progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(text(screen.getByRole('main'))).toContain('40%');
    act(() => xhr.progress(100, 100));
    expect(screen.getByRole('progressbar', { name: 'Upload progress' }).getAttribute('aria-valuenow')).toBe('100');
  });

  test('there is no progress bar before sending, and none once the answer is in', async () => {
    await renderForm();
    expect(screen.queryByRole('progressbar') === null).toBe(true);
    const xhr = await sendValid();
    await act(async () => xhr.respond(201, CREATED));
    expect(screen.queryByRole('progressbar') === null).toBe(true);
  });

  test('the submit button is disabled and busy, and a second click sends nothing more', async () => {
    await renderForm();
    const xhr = await sendValid();
    const button = submitButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(text(button)).toBe('Sending…');
    await submit();
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    expect(xhrs).toHaveLength(1);
    expect(xhr.sent).toBe(1);
  });

  test('every field is disabled while sending, so nothing changes under the upload', async () => {
    await renderForm();
    await sendValid();
    for (const label of [/^Name of the method/, /^Skill/, /^Instructions/, /^Video/, /^Author/]) {
      expect((control(label) as HTMLInputElement).disabled).toBe(true);
    }
    expect(rightsBox().disabled).toBe(true);
    expect(commercialBox().disabled).toBe(true);
  });

  test('when it fails, everything is enabled again and every answer is still there', async () => {
    await renderForm();
    const xhr = await sendValid();
    await act(async () => xhr.respond(500, problemBody(500, 'Internal Server Error'), 'application/problem+json'));
    expect(submitButton().disabled).toBe(false);
    expect((control(/^Name of the method/) as HTMLInputElement).disabled).toBe(false);
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Wall passes');
    expect(rightsBox().checked).toBe(true);
    expect(commercialBox().checked).toBe(true);
  });
});

// --- success -----------------------------------------------------------------------------------------------------------

describe('success: the thank-you state', () => {
  async function sent() {
    const view = await renderForm();
    const xhr = await sendValid();
    await act(async () => xhr.respond(201, CREATED));
    await screen.findByRole('heading', { name: 'Thank you.' });
    return view;
  }

  test('says the exact sentence, and the form is gone', async () => {
    await sent();
    expect(screen.getByText('Your contribution will become part of the Open Sport Commons after review.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(screen.queryByRole('button', { name: /^(Send for review|Sending…)$/ }) === null).toBe(true);
  });

  test('links to My contributions', async () => {
    await sent();
    const link = screen.getByRole('link', { name: 'My contributions' });
    expect(link.getAttribute('href')).toBe('/contribute/mine');
  });

  test('names the state in words (waiting for review), not only by tone', async () => {
    await sent();
    expect(screen.getByText('Waiting for review')).toBeTruthy();
  });

  test('moves focus to the thank-you heading, so a keyboard or screen-reader user lands on it', async () => {
    await sent();
    expect(document.activeElement?.id).toBe(screen.getByRole('heading', { name: 'Thank you.' }).id);
  });

  test('forgets the draft: nothing of the sent method stays in storage', async () => {
    const view = await sent();
    expect(view.storage.data.has(DRAFT_KEY)).toBe(false);
  });

  test('"Add another method" brings back an empty form (no old answers, no attestations, no draft)', async () => {
    const view = await sent();
    fireEvent.click(screen.getByRole('button', { name: 'Add another method' }));
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('');
    expect((control(/^Author/) as HTMLInputElement).value).toBe('');
    expect(rightsBox().checked).toBe(false);
    expect(commercialBox().checked).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Thank you.' }) === null).toBe(true);
    expect(view.storage.data.has(DRAFT_KEY)).toBe(false);
  });

  test('only a 2xx that parses as a Contribution is a success: an odd 200 is an error, and the form stays', async () => {
    await renderForm();
    const xhr = await sendValid();
    await act(async () => xhr.respond(200, { ok: true }));
    expect(screen.queryByRole('heading', { name: 'Thank you.' }) === null).toBe(true);
    expect(screen.getByText(problemMessages.en.schema)).toBeTruthy();
    expect(submitButton().disabled).toBe(false);
  });
});

// --- server errors -----------------------------------------------------------------------------------------------------

describe('server errors land on their fields', () => {
  const rejected = messages.en.errors.fieldRejected;

  async function rejectWith(errors: Array<{ pointer: string; detail: string }>, status = 422) {
    const view = await renderForm();
    const xhr = await sendValid();
    await act(async () => xhr.respond(status, problemBody(status, 'Unprocessable Entity', errors), 'application/problem+json'));
    return { view, xhr };
  }

  test('each pointer flags its own field with a localised sentence; the server English is not shown', async () => {
    await rejectWith([
      { pointer: '/name', detail: 'Too small: expected string to have >=1 characters' },
      { pointer: '/ageMax', detail: 'ageMax must not be below ageMin' },
      { pointer: '/rightsAttested', detail: 'Invalid input: expected true' },
      { pointer: '/noCommercialContent', detail: 'Invalid input: expected true' },
      { pointer: '/durationMin', detail: 'Too small' },
      { pointer: '/goal', detail: 'Invalid option' },
    ]);
    for (const label of [/^Name of the method/, /^Age to/, /^Duration/, /^Goal/]) {
      expect(isFlagged(control(label))).toBe(true);
      expect(describedBy(control(label))).toContain(rejected);
    }
    expect(isFlagged(rightsBox())).toBe(true);
    expect(isFlagged(commercialBox())).toBe(true);
    expect(describedBy(rightsBox())).toContain(rejected);
    // Fields the server did not name stay clean.
    expect(isFlagged(control(/^Author/))).toBe(false);
    expect(isFlagged(control(/^Age from/))).toBe(false);
    expect(text(screen.getByRole('main'))).not.toContain('Too small');
    expect(text(screen.getByRole('main'))).not.toContain('Invalid input');
  });

  test('the answers are kept, the form is editable again, and focus goes to the first flagged field in form order', async () => {
    await rejectWith([
      { pointer: '/author', detail: 'x' },
      { pointer: '/name', detail: 'x' },
    ]);
    expect(submitButton().disabled).toBe(false);
    expect((control(/^Author/) as HTMLInputElement).value).toBe('Aigerim Coach');
    expect(document.activeElement?.id).toBe(control(/^Name of the method/).id);
  });

  test('editing a flagged field clears its own error and no other', async () => {
    await rejectWith([
      { pointer: '/name', detail: 'x' },
      { pointer: '/author', detail: 'x' },
    ]);
    type(/^Name of the method/, 'Wall passes 2');
    expect(isFlagged(control(/^Name of the method/))).toBe(false);
    expect(isFlagged(control(/^Author/))).toBe(true);
  });

  test('a corrected form can be sent again, as a new request', async () => {
    const { view } = await rejectWith([{ pointer: '/name', detail: 'x' }]);
    type(/^Name of the method/, 'Wall passes v2');
    await submit();
    await waitFor(() => expect(xhrs.length).toBe(2));
    expect(xhrs[1]!.payload.name).toBe('Wall passes v2');
    await act(async () => xhrs[1]!.respond(201, CREATED));
    await screen.findByRole('heading', { name: 'Thank you.' });
    expect(view.storage.data.has(DRAFT_KEY)).toBe(false);
  });

  test('a pointer that names no field (/sourceUrl) is a form-level message, in the UI language', async () => {
    await rejectWith([{ pointer: '/sourceUrl', detail: 'Invalid URL' }]);
    const alert = screen.getAllByRole('alert').find((node) => text(node).includes(problemMessages.en.unknown));
    expect(alert).toBeTruthy();
    expect(text(screen.getByRole('main'))).not.toContain('Invalid URL');
    for (const label of [/^Name of the method/, /^Source/, /^Author/]) expect(isFlagged(control(label))).toBe(false);
  });

  test('a filled honeypot the server rejects (/website) is a form-level message, not a field the person can see', async () => {
    await renderForm();
    fireEvent.change(honeypot(), { target: { value: 'bot' } });
    const xhr = await sendValid();
    await act(async () => xhr.respond(422, problemBody(422, 'Unprocessable Entity', [{ pointer: '/website', detail: 'must be empty' }]), 'application/problem+json'));
    expect(screen.getAllByRole('alert').some((node) => text(node).includes(problemMessages.en.unknown))).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Thank you.' }) === null).toBe(true);
  });

  test('413: the video field says how big a video may be', async () => {
    await renderForm();
    chooseVideo(videoFile());
    const xhr = await sendValid();
    await act(async () => xhr.respond(413, problemBody(413, 'Payload Too Large'), 'application/problem+json'));
    expect(isFlagged(videoInput())).toBe(true);
    expect(describedBy(videoInput())).toContain(fill(messages.en.errors.videoTooLarge, { maxMb: 50 }));
    expect(submitButton().disabled).toBe(false);
  });

  test('415: the video field says which types are allowed', async () => {
    await renderForm();
    chooseVideo(videoFile());
    const xhr = await sendValid();
    await act(async () => xhr.respond(415, problemBody(415, 'Unsupported Media Type'), 'application/problem+json'));
    expect(isFlagged(videoInput())).toBe(true);
    expect(describedBy(videoInput())).toContain(messages.en.errors.videoType);
  });

  test('a network failure and a server error say so in words, keep the answers and allow a retry', async () => {
    await renderForm();
    const first = await sendValid();
    await act(async () => first.fail());
    expect(screen.getByText(problemMessages.en.offline)).toBeTruthy();
    expect(submitButton().disabled).toBe(false);
    expect((control(/^Author/) as HTMLInputElement).value).toBe('Aigerim Coach');

    await submit();
    await waitFor(() => expect(xhrs.length).toBe(2));
    await act(async () => xhrs[1]!.respond(503, problemBody(503, 'Service Unavailable'), 'application/problem+json'));
    expect(screen.getByText(problemMessages.en.server)).toBeTruthy();
    expect(screen.queryByText(problemMessages.en.offline) === null).toBe(true);
  });

  test('the error message is an alert (announced), with an icon', async () => {
    await renderForm();
    const xhr = await sendValid();
    await act(async () => xhr.respond(429, problemBody(429, 'Too Many Requests'), 'application/problem+json'));
    const alert = screen.getAllByRole('alert').find((node) => text(node).includes(problemMessages.en.rateLimited));
    expect(alert).toBeTruthy();
    expect(alert?.querySelector('svg') !== null).toBe(true);
  });
});

// --- client-side checks of the video --------------------------------------------------------------------------------------

describe('the video is checked before anything is sent', () => {
  test('a video over the limit from meta is refused on the field, and the request is not made', async () => {
    await renderForm();
    chooseVideo(videoFile('big.mp4', 'video/mp4', 50 * 1024 * 1024 + 1));
    fillValid();
    attestBoth();
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(isFlagged(videoInput())).toBe(true);
    expect(describedBy(videoInput())).toContain(fill(messages.en.validation.videoSize, { maxMb: 50 }));
  });

  test('a video of exactly the limit is fine', async () => {
    await renderForm();
    chooseVideo(videoFile('exact.mp4', 'video/mp4', 50 * 1024 * 1024));
    const xhr = await sendValid();
    expect(xhr.form.get('video') instanceof File).toBe(true);
  });

  test('the limit follows the meta, not a constant', async () => {
    serveMeta(meta({ upload: { maxMb: 5, mimeTypes: ['video/mp4'] } }));
    await renderForm();
    chooseVideo(videoFile('mid.mp4', 'video/mp4', 6 * 1024 * 1024));
    fillValid();
    attestBoth();
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(describedBy(videoInput())).toContain(fill(messages.en.validation.videoSize, { maxMb: 5 }));
  });

  test('a file that is not an allowed video type (a picture, a type meta does not list) is refused on the field', async () => {
    await renderForm();
    chooseVideo(videoFile('photo.png', 'image/png'));
    fillValid();
    attestBoth();
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(describedBy(videoInput())).toContain(messages.en.validation.videoType);

    chooseVideo(videoFile('clip.avi', 'video/x-msvideo'));
    await submit();
    expect(xhrs).toHaveLength(0);
    expect(describedBy(videoInput())).toContain(messages.en.validation.videoType);
  });

  test('choosing a fine file after a bad one clears the error; clearing the choice sends no video part', async () => {
    await renderForm();
    chooseVideo(videoFile('photo.png', 'image/png'));
    fillValid();
    attestBoth();
    await submit();
    expect(isFlagged(videoInput())).toBe(true);
    chooseVideo(videoFile());
    expect(isFlagged(videoInput())).toBe(false);
    fireEvent.change(videoInput(), { target: { files: [] } });
    await submit();
    await waitFor(() => expect(xhrs.length).toBe(1));
    expect([...xhrs[0]!.form.keys()]).toEqual(['payload']);
  });
});

// --- drafts ----------------------------------------------------------------------------------------------------------------

describe('an unsent draft survives a reload', () => {
  test('typing saves a draft under fc:draft:contribute-form, in the format the sign-out cleaner knows', async () => {
    const view = await renderForm();
    type(/^Name of the method/, 'Wall passes');
    type(/^Author/, 'Aigerim Coach');
    const draft = savedDraft(view.storage);
    expect(draft).not.toBeNull();
    expect(draft?.savedAt).toBe(NOW);
    expect(draft?.value.name).toBe('Wall passes');
    expect(draft?.value.author).toBe('Aigerim Coach');
  });

  test('a fresh, untouched form saves no draft', async () => {
    const view = await renderForm();
    expect(view.storage.data.size).toBe(0);
  });

  test('a reload brings the answers back, says so, and keeps them saved for the next reload', async () => {
    const first = await renderForm();
    fillValid();
    const { storage } = first;
    cleanup();

    await renderForm({ storage });
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Wall passes');
    expect((control(/^Skill/) as HTMLSelectElement).value).toBe('inside-touches');
    expect((control(/^Age from/) as HTMLInputElement).value).toBe('8');
    expect((control(/^Difficulty/) as HTMLSelectElement).value).toBe('basic');
    expect((control(/^Instructions/) as HTMLTextAreaElement).value).toBe(VALUES.instructions);
    expect((control(/^Author/) as HTMLInputElement).value).toBe('Aigerim Coach');
    expect(screen.getByText(messages.en.restored)).toBeTruthy();
    expect(storage.data.has(DRAFT_KEY)).toBe(true);
    cleanup();

    await renderForm({ storage }); // a second reload works too
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Wall passes');
  });

  test('the attestations and the honeypot are never restored: the person attests again, every time', async () => {
    const first = await renderForm();
    fillValid();
    attestBoth();
    fireEvent.change(honeypot(), { target: { value: 'bot' } });
    const { storage } = first;
    const draft = savedDraft(storage);
    expect(draft?.value.rightsAttested).toBeUndefined();
    expect(draft?.value.noCommercialContent).toBeUndefined();
    expect(draft?.value.website).toBeUndefined();
    cleanup();

    await renderForm({ storage });
    expect(rightsBox().checked).toBe(false);
    expect(commercialBox().checked).toBe(false);
    expect(honeypot().value).toBe('');
  });

  test('a draft older than 30 minutes is not restored (a shared phone must not show yesterday\'s coach)', async () => {
    const storage = fakeStorage();
    storage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: NOW - 31 * MINUTE, value: { name: 'Old draft' } }));
    await renderForm({ storage });
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(messages.en.restored) === null).toBe(true);
  });

  test('a draft from 29 minutes ago is restored', async () => {
    const storage = fakeStorage();
    storage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: NOW - 29 * MINUTE, value: { name: 'Recent draft' } }));
    await renderForm({ storage });
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Recent draft');
  });

  test('a damaged draft (wrong types, unknown keys, options meta does not list) cannot break the form or plant values', async () => {
    const storage = fakeStorage();
    storage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        savedAt: NOW,
        value: { name: 123, skill: { slug: 'x' }, ageMin: ['8'], level: 'legend', equipment: 'jetpack', author: 'Kept', rightsAttested: true, website: 'bot' },
      }),
    );
    await renderForm({ storage });
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('');
    expect((control(/^Skill/) as HTMLSelectElement).value).toBe('');
    expect((control(/^Age from/) as HTMLInputElement).value).toBe('');
    expect((control(/^Difficulty/) as HTMLSelectElement).value).toBe('');
    expect((control(/^Equipment/) as HTMLSelectElement).value).toBe('');
    expect((control(/^Author/) as HTMLInputElement).value).toBe('Kept');
    expect(rightsBox().checked).toBe(false);
    expect(honeypot().value).toBe('');
  });

  test('a draft that is not JSON is ignored', async () => {
    const storage = fakeStorage();
    storage.setItem(DRAFT_KEY, '{not json');
    await renderForm({ storage });
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('');
  });

  test('with no storage at all (blocked) the form still works', async () => {
    await renderForm({ storage: null });
    type(/^Name of the method/, 'Wall passes');
    expect((control(/^Name of the method/) as HTMLInputElement).value).toBe('Wall passes');
  });

  test('emptying the form again removes the draft', async () => {
    const view = await renderForm();
    type(/^Name of the method/, 'Wall passes');
    expect(view.storage.data.has(DRAFT_KEY)).toBe(true);
    type(/^Name of the method/, '');
    expect(view.storage.data.has(DRAFT_KEY)).toBe(false);
  });
});

// --- the states of the screen ------------------------------------------------------------------------------------------------

describe('loading, empty and error', () => {
  test('loading: a busy, named status is shown until the option lists arrive; the heading is already there; no form', async () => {
    const held = deferred();
    serve(() => held.promise);
    renderScreen();
    const status = await screen.findByRole('status', { name: 'Loading the form' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Contribute a method' })).toBeTruthy();
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    held.release(json(META));
    await screen.findByLabelText(/^Name of the method/);
    expect(screen.queryByRole('status', { name: 'Loading the form' }) === null).toBe(true);
  });

  test('empty: no skill in the meta means nothing can be sent; an honest empty state replaces the form', async () => {
    serveMeta(meta({ skills: [] }));
    renderScreen();
    await screen.findByText('No skills to choose from yet');
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(screen.queryByRole('button', { name: /send for review/i }) === null).toBe(true);
    expect(screen.getByRole('heading', { level: 1, name: 'Contribute a method' })).toBeTruthy();
  });

  test('error: a failed load says so with Try again, and never shows a half form', async () => {
    serve(() => problem(503, 'Service Unavailable'));
    renderScreen();
    await screen.findByText('We could not load the form');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
    expect(text(screen.getByRole('main'))).not.toContain('server text');
  });

  test('Try again asks again, is disabled and busy while the request runs, then shows the form', async () => {
    const held = deferred();
    serve(() => problem(503, 'Service Unavailable'), () => held.promise);
    renderScreen();
    await screen.findByText('We could not load the form');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(metaCalls()).toHaveLength(2));
    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    held.release(json(META));
    await screen.findByLabelText(/^Name of the method/);
    expect(screen.queryByText('We could not load the form') === null).toBe(true);
  });

  test('a meta answer that is not the contract shape is an error, not a form', async () => {
    serveMeta({ sports: [] });
    renderScreen();
    await screen.findByText('We could not load the form');
    expect(screen.queryByLabelText(/^Name of the method/) === null).toBe(true);
  });
});

// --- kk, ru, en ------------------------------------------------------------------------------------------------------------------

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelIn = (locale: Locale, key: keyof (typeof messages)['en']['fields']): RegExp => new RegExp(`^${escapeRegExp(messages[locale].fields[key].label)}`);

/** Renders as a contributor in `locale` and waits for the form (whatever its language). */
async function renderIn(locale: Locale) {
  const view = renderScreen({ locale });
  await screen.findByRole('button', { name: messages[locale].submit.label });
  return view;
}

describe('kk, ru and en', () => {
  test('the three message bundles have the same keys', () => {
    const en = leafKeys(messages.en).sort();
    expect(leafKeys(messages.kk).sort()).toEqual(en);
    expect(leafKeys(messages.ru).sort()).toEqual(en);
  });

  test('every string has text; kk and ru are Cyrillic; none is "undefined", "NaN" or an object', () => {
    const flat = (tree: object, prefix = ''): Array<[string, string]> =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : flat(value as object, `${prefix}${key}.`),
      );
    for (const locale of LOCALES) {
      for (const [key, value] of flat(messages[locale])) {
        expect(value.trim().length).toBeGreaterThan(0);
        expect(value).not.toMatch(/undefined|NaN|\[object/);
        if (locale !== 'en' && key !== 'eyebrow') expect(value).toMatch(/[\u0400-\u04FF]/);
      }
    }
  });

  test('the thank-you sentence is exactly the required one in English, and is written out in ru and kk', () => {
    expect(messages.en.success.sentence).toBe('Your contribution will become part of the Open Sport Commons after review.');
    expect(messages.ru.success.sentence).not.toBe(messages.en.success.sentence);
    expect(messages.kk.success.sentence).not.toBe(messages.en.success.sentence);
  });

  for (const locale of ['ru', 'kk'] as const) {
    test(`${locale}: the form renders in that language: heading, notice, every label, no leaked placeholder`, async () => {
      await renderIn(locale);
      const main = screen.getByRole('main');
      expect(text(main)).not.toMatch(/undefined|NaN|\[object|\{\{/);
      expect(screen.getByRole('heading', { level: 1, name: messages[locale].title })).toBeTruthy();
      expect(screen.getByText(messages[locale].notice.review)).toBeTruthy();
      const labels = Array.from(main.querySelectorAll('label')).filter((label) => label.closest('[aria-hidden="true"]') === null);
      expect(labels.length).toBeGreaterThanOrEqual(19); // 17 fields + 2 attestations
      for (const label of labels) expect(text(label)).toMatch(/[\u0400-\u04FF]/);
      expect(within(control(labelIn(locale, 'level')) as HTMLSelectElement).getByRole('option', { name: messages[locale].levels.beginner })).toBeTruthy();
      expect(metaCalls()[0]?.url.searchParams.get('locale')).toBe(locale);
    });

    test(`${locale}: a full submit sends that locale, and the thank-you state is in that language`, async () => {
      await renderIn(locale);
      type(labelIn(locale, 'name'), VALUES.name);
      type(labelIn(locale, 'skill'), 'inside-touches');
      type(labelIn(locale, 'ageMin'), '8');
      type(labelIn(locale, 'ageMax'), '12');
      type(labelIn(locale, 'level'), 'basic');
      type(labelIn(locale, 'goal'), 'passing');
      type(labelIn(locale, 'duration'), '15');
      type(labelIn(locale, 'equipment'), 'ball_wall');
      type(labelIn(locale, 'instructions'), VALUES.instructions);
      type(labelIn(locale, 'source'), VALUES.source);
      type(labelIn(locale, 'author'), VALUES.author);
      for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: messages[locale].submit.label }));
      });
      await waitFor(() => expect(xhrs.length).toBe(1));
      expect(xhrs[0]!.payload.locale).toBe(locale);
      expect(xhrs[0]!.headers['accept-language']).toBe(locale);
      await act(async () => xhrs[0]!.respond(201, CREATED));
      await screen.findByRole('heading', { name: messages[locale].success.title });
      expect(screen.getByText(messages[locale].success.sentence)).toBeTruthy();
      expect(screen.getByRole('link', { name: messages[locale].success.mine })).toBeTruthy();
    });
  }
});

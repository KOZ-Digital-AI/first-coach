import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DAYS_PER_WEEK, MINUTES_PER_SESSION, type SkillTest } from '@api-types/domain';
import { type OnboardingOptions, StartRequest } from '@api-types/onboarding';
import { EQUIPMENT, EXPERIENCE_LEVELS, GOALS, SPACES, type Locale } from '@api-types/primitives';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route, type WizardDeps, WizardDepsContext } from '../../routes/train/onboarding';
import baselineMessages from './baseline-step.messages';
import conditionsMessages from './conditions-step.messages';
import profileMessages from './profile-step.messages';
import wizardMessages from './wizard.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web, but the bead's verify
// command runs from the repo root, where there is no DOM. Register happy-dom here BEFORE Testing Library is imported
// (same order rule as test/setup.ts and the step tests); the `document` guard keeps it a no-op under the preload.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Written from the bead's acceptance criteria (fc-mol-9l4.11), not from the implementation:
 *  - /train/onboarding loads OnboardingOptions ONCE, shows a 4-segment progress line and "Step n / 4";
 *  - answers live in component state across Back/Continue, backed by a namespaced sessionStorage draft that is
 *    parsed with Zod and reset when it does not parse;
 *  - step components are rendered by index; the LAST step submits POST /api/player/start after ensurePlayerSession(),
 *    and success navigates to /train/roadmap;
 *  - problem-details field errors jump to the step that owns the field;
 *  - loading, empty, error, disabled and success states; mutation controls are disabled while a request is in flight.
 * The server is a fake `fetch` handed to the real `createApi`, so requests, headers, problem parsing and schema parsing
 * are the real thing. Only the network (and the anonymous sign-in, a separate module) is faked.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const DRAFT_KEY = 'fc:onboarding-draft';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function skillTest(fields: Pick<SkillTest, 'slug' | 'skill' | 'metric' | 'unit' | 'direction' | 'equipment'>): SkillTest {
  return {
    ...fields,
    protocol: {
      kk: '1. Жылын.\n2. Өлшеп көр.',
      ru: '1. Разомнись.\n2. Замерь результат.',
      en: '1. Warm up.\n2. Measure your result.',
    },
  };
}

const sprint = skillTest({ slug: 'sprint-20m', skill: 'speed', metric: 'sprint over 20 m', unit: 'seconds', direction: 'lower', equipment: 'nothing' });
const plank = skillTest({ slug: 'plank-hold', skill: 'core', metric: 'plank hold', unit: 'seconds', direction: 'higher', equipment: 'nothing' });

const OPTIONS: OnboardingOptions = {
  levels: [...EXPERIENCE_LEVELS],
  goals: [...GOALS],
  equipment: [...EQUIPMENT],
  spaces: [...SPACES],
  partner: [false, true],
  daysPerWeek: [...DAYS_PER_WEEK],
  minutesPerSession: [...MINUTES_PER_SESSION],
  tests: [sprint, plank],
};

const START_RESPONSE = {
  profile: {
    age: 12,
    level: 'beginner',
    goal: 'control',
    equipment: 'ball',
    space: 'yard',
    partner: false,
    daysPerWeek: 3,
    minutesPerSession: 20,
    locale: 'en',
  },
  roadmap: {
    currentLevelLabel: 'Basic',
    tracks: [
      { skill: 'speed', level: 2, source: 'test' },
      { skill: 'core', level: 3, source: 'self' },
    ],
    goal: 'control',
    weeks: 4,
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'speed', level: 2, targetLevel: 3, reason: 'Your weakest skill.' },
      { skill: 'core', level: 3, targetLevel: 4, reason: 'Supports the goal.' },
    ],
  },
};

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const problem = (status: number, errors: { pointer: string; detail: string }[] = []) =>
  json({ type: 'about:blank', title: 'Problem', status, errors }, status, 'application/problem+json');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Call = { method: string; url: string; body: unknown };
type Reply = Response | Promise<Response>;
type Server = {
  /** Every request the wizard made, in order. */
  calls: Call[];
  options?: () => Reply;
  start?: (body: unknown) => Reply;
};

// --- harness ---------------------------------------------------------------------------------------------------------

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const MODULES = {
  './wizard.messages.ts': { default: wizardMessages },
  './profile-step.messages.ts': { default: profileMessages },
  './conditions-step.messages.ts': { default: conditionsMessages },
  './baseline-step.messages.ts': { default: baselineMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

type Setup = {
  server?: Partial<Server>;
  locale?: Locale;
  storage?: WizardDeps['storage'];
  ensureSession?: () => Promise<unknown>;
};

function mountWizard(setup: Setup = {}) {
  const locale = setup.locale ?? 'en';
  const server: Server = { calls: [], ...setup.server };
  const order: string[] = [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, url: input, body });
    if (method === 'GET' && input.startsWith('/api/onboarding/')) {
      order.push('GET options');
      return (server.options ?? (() => json(OPTIONS)))();
    }
    if (method === 'POST' && input === '/api/player/start') {
      order.push('POST start');
      return (server.start ?? (() => json(START_RESPONSE)))(body);
    }
    return new Response('not found', { status: 404 });
  };

  const ensureSession = mock(
    setup.ensureSession ??
      (async () => {
        order.push('ensurePlayerSession');
        return { user: { id: 'player-1' } };
      }),
  );
  const navigate = mock((to: string) => void order.push(`navigate ${to}`));

  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: memoryStorage(), root: { lang: '' }, dev: false });
  const api = createApi({ fetch: fetchImpl, language: () => locale, online: () => true });

  // The page is the route's own component. Its collaborators arrive through the route module's context seam (the wizard
  // itself is not exported: a non-Route export would pull zod, the auth client and the API client into the entry bundle).
  const Page = Route.options.component;
  if (Page === undefined) throw new Error('the /train/onboarding route has no component');
  const tree = () => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <WizardDepsContext.Provider value={{ api, ensureSession, navigate, ...(setup.storage === undefined ? {} : { storage: setup.storage }) }}>
          <Page />
        </WizardDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    user: userEvent.setup(),
    server,
    order,
    ensureSession,
    navigate,
    unmount: view.unmount,
    remount: () => {
      view.unmount();
      render(tree());
    },
    optionCalls: () => server.calls.filter((call) => call.method === 'GET'),
    startCalls: () => server.calls.filter((call) => call.method === 'POST'),
  };
}

type Wizard = ReturnType<typeof mountWizard>;

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

// --- interactions ----------------------------------------------------------------------------------------------------

const stepText = (n: number, locale: Locale = 'en') => ({ en: `Step ${n} / 4`, ru: `Шаг ${n} / 4`, kk: `Қадам ${n} / 4` })[locale];
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const continueButton = () => button('Continue');

async function atStep(n: number) {
  return screen.findByText(stepText(n));
}

async function answerProfile({ user }: Wizard) {
  await user.type(await screen.findByLabelText('Age'), '12');
  await user.click(screen.getByRole('radio', { name: 'Beginner' }));
  await user.click(screen.getByRole('radio', { name: 'Control the ball with confidence' }));
  await user.click(continueButton());
  await atStep(2);
}

async function answerConditions({ user }: Wizard) {
  await user.click(screen.getByRole('radio', { name: 'Ball only' }));
  await user.click(screen.getByRole('radio', { name: 'Yard' }));
  await user.click(screen.getByRole('radio', { name: 'No' }));
  await user.click(screen.getByRole('radio', { name: '3' }));
  await user.click(screen.getByRole('radio', { name: '20 min' }));
  await user.click(continueButton());
  await atStep(3);
}

async function answerBaseline({ user }: Wizard) {
  const sprintRegion = screen.getByRole('region', { name: sprint.metric });
  await user.type(within(sprintRegion).getByLabelText(/^Your result/), '4.2');
  await user.type(within(sprintRegion).getByLabelText('Errors'), '1');
  const plankRegion = screen.getByRole('region', { name: plank.metric });
  await user.click(within(plankRegion).getByRole('button', { name: /^Skip/ }));
}

async function toLastStep(wizard: Wizard) {
  await answerProfile(wizard);
  await answerConditions(wizard);
  await answerBaseline(wizard);
}

async function submit(wizard: Wizard) {
  await wizard.user.click(continueButton());
}

const alertNamed = (name: string) => screen.getByRole('alert', { name });
const H2 = { profile: 'A few questions to get started', conditions: 'Your training conditions', baseline: 'Quick skill tests' };

// --- the route ---------------------------------------------------------------------------------------------------------

describe('route', () => {
  test('/train/onboarding is a file route with a component', () => {
    expect(typeof Route.options.component).toBe('function');
  });
});

// --- one options call ---------------------------------------------------------------------------------------------------

describe('loads the options once', () => {
  test('one GET /api/onboarding/football?locale=en for the whole flow, Back and Continue included', async () => {
    const wizard = mountWizard();
    await answerProfile(wizard);
    await wizard.user.click(button('Back'));
    await atStep(1);
    await wizard.user.click(continueButton());
    await atStep(2);
    await answerConditions(wizard);
    await wizard.user.click(button('Back'));
    await atStep(2);
    expect(wizard.optionCalls().map((call) => call.url)).toEqual(['/api/onboarding/football?locale=en']);
  });

  test('in Kazakh the same single call asks for the Kazakh protocols', async () => {
    const wizard = mountWizard({ locale: 'kk' });
    await screen.findByText(stepText(1, 'kk'));
    expect(wizard.optionCalls().map((call) => call.url)).toEqual(['/api/onboarding/football?locale=kk']);
  });

  test('nothing is submitted, and no session is created, before the last step', async () => {
    const wizard = mountWizard();
    await answerProfile(wizard);
    await answerConditions(wizard);
    expect(wizard.startCalls()).toHaveLength(0);
    expect(wizard.ensureSession).not.toHaveBeenCalled();
  });
});

// --- state matrix: loading, empty, error --------------------------------------------------------------------------------

describe('loading, empty and error states', () => {
  test('loading: a status is announced and no question is shown until the options arrive', async () => {
    const pending = deferred<Response>();
    const wizard = mountWizard({ server: { options: () => pending.promise } });
    expect(screen.getByRole('status').textContent).toContain('Getting the questions ready');
    expect(screen.queryByLabelText('Age')).toBeNull();
    expect(wizard.startCalls()).toHaveLength(0);
    pending.resolve(json(OPTIONS));
    expect(await screen.findByLabelText('Age')).toBeTruthy();
    expect(screen.queryByText(/Getting the questions ready/)).toBeNull();
  });

  test('error: a failed options call shows a plain alert and Try again loads them (2 calls in total)', async () => {
    let attempt = 0;
    const wizard = mountWizard({ server: { options: () => (++attempt === 1 ? problem(500) : json(OPTIONS)) } });
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('We could not load the questions');
    expect(failed.textContent).toContain('Something went wrong on our side');
    expect(screen.queryByLabelText('Age')).toBeNull();
    await wizard.user.click(button('Try again'));
    await atStep(1);
    expect(wizard.optionCalls()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('error: a body that is not OnboardingOptions is an error, not a broken form', async () => {
    mountWizard({ server: { options: () => json({ levels: 'many' }) } });
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('We could not load the questions');
    expect(screen.queryByLabelText('Age')).toBeNull();
  });

  test('empty: options with no levels to choose from say so and offer Try again instead of an unanswerable form', async () => {
    const wizard = mountWizard({ server: { options: () => json({ ...OPTIONS, levels: [] }) } });
    expect(await screen.findByText('There is nothing to choose from yet')).toBeTruthy();
    expect(screen.queryByLabelText('Age')).toBeNull();
    expect(screen.queryByText(/Step 1 \/ 4/)).toBeNull();
    await wizard.user.click(button('Try again'));
    await waitFor(() => expect(wizard.optionCalls()).toHaveLength(2));
  });

  test('a payload with no skill tests is not "empty": the questions still show (the baseline step handles it)', async () => {
    mountWizard({ server: { options: () => json({ ...OPTIONS, tests: [] }) } });
    await atStep(1);
    expect(screen.queryByText('There is nothing to choose from yet')).toBeNull();
  });
});

// --- progress ----------------------------------------------------------------------------------------------------------

describe('progress', () => {
  test('a 4-segment progress line with the first segment filled and the words "Step 1 / 4"', async () => {
    mountWizard();
    await atStep(1);
    const progress = screen.getByRole('progressbar');
    expect(progress.getAttribute('aria-valuemin')).toBe('1');
    expect(progress.getAttribute('aria-valuemax')).toBe('4');
    expect(progress.getAttribute('aria-valuenow')).toBe('1');
    const segments = [...progress.querySelectorAll('[data-segment]')];
    expect(segments).toHaveLength(4);
    expect(segments.map((segment) => segment.getAttribute('data-filled'))).toEqual(['true', 'false', 'false', 'false']);
  });

  test('advances through the three question steps and shows the matching step component each time', async () => {
    const wizard = mountWizard();
    expect(await screen.findByRole('heading', { level: 2, name: H2.profile })).toBeTruthy();
    await answerProfile(wizard);
    expect(screen.getByRole('heading', { level: 2, name: H2.conditions })).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    await answerConditions(wizard);
    expect(screen.getByRole('heading', { level: 2, name: H2.baseline })).toBeTruthy();
    const filled = [...screen.getByRole('progressbar').querySelectorAll('[data-segment]')].map((s) => s.getAttribute('data-filled'));
    expect(filled).toEqual(['true', 'true', 'true', 'false']);
  });

  test('the page has one h1', async () => {
    mountWizard();
    await atStep(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

// --- back / forward keeps values -----------------------------------------------------------------------------------------

describe('answers survive Back and Continue', () => {
  test('profile, conditions and baseline answers are all still there after going back and forward again', async () => {
    const wizard = mountWizard();
    await answerProfile(wizard);
    await answerConditions(wizard);
    await answerBaseline(wizard);

    await wizard.user.click(button('Back')); // baseline -> conditions
    await atStep(2);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ball only' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Yard' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'No' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '3' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '20 min' }).checked).toBe(true);

    await wizard.user.click(button('Back')); // conditions -> profile
    await atStep(1);
    expect(screen.getByLabelText<HTMLInputElement>('Age').value).toBe('12');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Beginner' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Control the ball with confidence' }).checked).toBe(true);

    await wizard.user.click(continueButton());
    await atStep(2);
    await wizard.user.click(continueButton());
    await atStep(3);
    const sprintRegion = screen.getByRole('region', { name: sprint.metric });
    expect(within(sprintRegion).getByLabelText<HTMLInputElement>(/^Your result/).value).toBe('4.2');
    expect(within(sprintRegion).getByLabelText<HTMLInputElement>('Errors').value).toBe('1');
    const plankRegion = screen.getByRole('region', { name: plank.metric });
    expect(within(plankRegion).getByRole('button', { name: /^Skip/ }).getAttribute('aria-pressed')).toBe('true');
    expect(wizard.startCalls()).toHaveLength(0);
  });

  test('Continue on an incomplete step does not advance (the step components own the gating)', async () => {
    const wizard = mountWizard();
    await atStep(1);
    expect(continueButton().disabled).toBe(true);
    await wizard.user.click(continueButton());
    expect(screen.queryByText(stepText(2))).toBeNull();
  });
});

// --- the sessionStorage draft ---------------------------------------------------------------------------------------------

describe('the sessionStorage draft', () => {
  test('answers are saved under one namespaced key and nothing else is written', async () => {
    const wizard = mountWizard();
    await answerProfile(wizard);
    const keys = Object.keys(sessionStorage);
    expect(keys).toEqual([DRAFT_KEY]);
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
    expect(JSON.stringify(draft)).toContain('beginner');
    expect(JSON.stringify(draft)).toContain('12');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    void wizard;
  });

  test('a reload (remount) restores the answers and the step the player was on', async () => {
    const wizard = mountWizard();
    await answerProfile(wizard);
    wizard.remount();
    await atStep(2);
    expect(wizard.optionCalls().length).toBeGreaterThanOrEqual(1);
    await wizard.user.click(button('Back'));
    await atStep(1);
    expect(screen.getByLabelText<HTMLInputElement>('Age').value).toBe('12');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Beginner' }).checked).toBe(true);
  });

  test.each([
    ['text that is not JSON', 'not json {'],
    ['JSON of the wrong shape', JSON.stringify({ step: 'two', profile: 7 })],
    ['a level the contract does not know', JSON.stringify({ v: 1, step: 0, profile: { age: '12', level: 'pro', goal: null }, conditions: {}, baseline: [] })],
    ['an out-of-range step', JSON.stringify({ v: 1, step: 9, profile: { age: '', level: null, goal: null }, conditions: {}, baseline: [] })],
  ])('a draft that does not parse (%s) is reset: the wizard starts clean and the bad draft is gone', async (_name, stored) => {
    sessionStorage.setItem(DRAFT_KEY, stored);
    mountWizard();
    await atStep(1);
    expect(screen.getByLabelText<HTMLInputElement>('Age').value).toBe('');
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBe(stored);
  });

  test('a draft that jumps ahead of the answers it holds cannot skip a step: it lands on the first unanswered one', async () => {
    const ahead = { v: 1, step: 2, profile: { age: '12', level: 'beginner', goal: 'control' }, conditions: {}, baseline: [] };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(ahead));
    mountWizard();
    await atStep(2);
  });

  test('storage that throws (private mode) never breaks the wizard', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const wizard = mountWizard({ storage: throwing });
    await answerProfile(wizard);
    expect(screen.getByRole('heading', { level: 2, name: H2.conditions })).toBeTruthy();
  });

  test('a successful submit clears the draft', async () => {
    const wizard = mountWizard();
    await toLastStep(wizard);
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await submit(wizard);
    await waitFor(() => expect(wizard.navigate).toHaveBeenCalled());
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

// --- submit -----------------------------------------------------------------------------------------------------------------

describe('submit on the last step', () => {
  test('POSTs a StartRequest with the profile, the UI locale and one baseline entry per test', async () => {
    const wizard = mountWizard();
    await toLastStep(wizard);
    await submit(wizard);
    await waitFor(() => expect(wizard.startCalls()).toHaveLength(1));

    const call = wizard.startCalls()[0]!;
    expect(call.url).toBe('/api/player/start');
    const parsed = StartRequest.safeParse(call.body);
    expect(parsed.success).toBe(true);
    expect(call.body).toMatchObject({
      profile: {
        age: 12,
        level: 'beginner',
        goal: 'control',
        equipment: 'ball',
        space: 'yard',
        partner: false,
        daysPerWeek: 3,
        minutesPerSession: 20,
        locale: 'en',
      },
    });
    const baseline = (call.body as { baseline: Record<string, unknown>[] }).baseline;
    expect(baseline).toHaveLength(2);
    expect(baseline[0]).toMatchObject({ testSlug: 'sprint-20m', value: 4.2, errors: 1 });
    expect(baseline[0]?.skipped).not.toBe(true);
    expect(baseline[1]).toMatchObject({ testSlug: 'plank-hold', value: 0, skipped: true });
    const ids = baseline.map((entry) => entry.clientUuid);
    expect(ids.every((id) => typeof id === 'string' && UUID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  test('the profile locale follows the interface language', async () => {
    const wizard = mountWizard({ locale: 'ru' });
    await screen.findByText(stepText(1, 'ru'));
    await wizard.user.type(screen.getByLabelText('Возраст'), '12');
    await wizard.user.click(screen.getByRole('radio', { name: 'Начинающий' }));
    await wizard.user.click(screen.getByRole('radio', { name: 'Увереннее контролировать мяч' }));
    await wizard.user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await screen.findByText(stepText(2, 'ru'));
    await wizard.user.click(screen.getByRole('radio', { name: 'Только мяч' }));
    await wizard.user.click(screen.getByRole('radio', { name: 'Двор' }));
    await wizard.user.click(screen.getByRole('radio', { name: 'Нет' }));
    await wizard.user.click(screen.getByRole('radio', { name: '3' }));
    await wizard.user.click(screen.getByRole('radio', { name: '20 мин' }));
    await wizard.user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await screen.findByText(stepText(3, 'ru'));
    for (const region of screen.getAllByRole('region')) {
      await wizard.user.click(within(region).getByRole('button', { name: /^Пропустить/ }));
    }
    await wizard.user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await waitFor(() => expect(wizard.startCalls()).toHaveLength(1));
    expect(wizard.startCalls()[0]?.body).toMatchObject({ profile: { locale: 'ru' } });
    expect(wizard.optionCalls()[0]?.url).toBe('/api/onboarding/football?locale=ru');
  });

  test('the anonymous session is ensured once, after the options and before the POST, and success goes to /train/roadmap', async () => {
    const wizard = mountWizard();
    await toLastStep(wizard);
    await submit(wizard);
    await waitFor(() => expect(wizard.navigate).toHaveBeenCalledTimes(1));
    expect(wizard.order).toEqual(['GET options', 'ensurePlayerSession', 'POST start', 'navigate /train/roadmap']);
    expect(wizard.ensureSession).toHaveBeenCalledTimes(1);
  });

  test('success shows a status message rather than a blank screen while the roadmap opens', async () => {
    const wizard = mountWizard();
    await toLastStep(wizard);
    await submit(wizard);
    expect(await screen.findByText('Your roadmap is ready. Opening it now…')).toBeTruthy();
  });

  test('disabled: while the request is in flight the step controls are disabled, a status is shown, and a second click sends nothing', async () => {
    const pending = deferred<Response>();
    const wizard = mountWizard({ server: { start: () => pending.promise } });
    await toLastStep(wizard);
    expect(continueButton().closest('fieldset[disabled]')).toBeNull();
    await submit(wizard);

    await screen.findByText('Building your roadmap…');
    // Real browsers disable every control inside a disabled fieldset; happy-dom does not evaluate that inheritance.
    expect(continueButton().closest('fieldset[disabled]')).not.toBeNull();
    expect(button('Back').closest('fieldset[disabled]')).not.toBeNull();
    await wizard.user.click(continueButton());
    await wizard.user.click(continueButton());
    expect(wizard.startCalls()).toHaveLength(1);
    expect(wizard.ensureSession).toHaveBeenCalledTimes(1);
    expect(wizard.navigate).not.toHaveBeenCalled();

    pending.resolve(json(START_RESPONSE));
    await waitFor(() => expect(wizard.navigate).toHaveBeenCalledTimes(1));
    expect(wizard.startCalls()).toHaveLength(1);
  });

  test('the controls are enabled again after a failure', async () => {
    const wizard = mountWizard({ server: { start: () => problem(500) } });
    await toLastStep(wizard);
    await submit(wizard);
    await screen.findByText('We could not build your roadmap');
    expect(continueButton().closest('fieldset[disabled]')).toBeNull();
    expect(screen.queryByText('Building your roadmap…')).toBeNull();
  });

  test('a server error keeps the player on the last step with an alert; Try again submits the same answers again', async () => {
    let attempt = 0;
    const wizard = mountWizard({ server: { start: () => (++attempt === 1 ? problem(500) : json(START_RESPONSE)) } });
    await toLastStep(wizard);
    await submit(wizard);
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('We could not build your roadmap');
    expect(failed.textContent).toContain('Something went wrong on our side');
    expect(screen.getByRole('heading', { level: 2, name: H2.baseline })).toBeTruthy();
    expect(wizard.navigate).not.toHaveBeenCalled();

    await wizard.user.click(button('Try again'));
    await waitFor(() => expect(wizard.navigate).toHaveBeenCalledWith('/train/roadmap'));
    const [first, second] = wizard.startCalls();
    expect(second?.body).toEqual(first?.body);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a 2xx that is not a StartResponse is an error: no navigation', async () => {
    const wizard = mountWizard({ server: { start: () => json({ profile: null }) } });
    await toLastStep(wizard);
    await submit(wizard);
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('We could not build your roadmap');
    expect(wizard.navigate).not.toHaveBeenCalled();
  });

  test('a failed anonymous sign-in shows the error, never POSTs, and Try again retries the whole submit', async () => {
    let attempt = 0;
    const wizard = mountWizard({
      ensureSession: async () => {
        if (++attempt === 1) throw new Error('sign-in failed');
        return { user: { id: 'player-1' } };
      },
    });
    await toLastStep(wizard);
    await submit(wizard);
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('We could not build your roadmap');
    expect(wizard.startCalls()).toHaveLength(0);
    await wizard.user.click(button('Try again'));
    await waitFor(() => expect(wizard.navigate).toHaveBeenCalledWith('/train/roadmap'));
    expect(wizard.startCalls()).toHaveLength(1);
  });

  test('Try again reuses each test\'s clientUuid, so a retried start cannot look like new results', async () => {
    let attempt = 0;
    const wizard = mountWizard({ server: { start: () => (++attempt === 1 ? problem(503) : json(START_RESPONSE)) } });
    await toLastStep(wizard);
    await submit(wizard);
    await screen.findByText('We could not build your roadmap');
    await wizard.user.click(button('Try again'));
    await waitFor(() => expect(wizard.startCalls()).toHaveLength(2));
    const ids = wizard.startCalls().map((call) => (call.body as { baseline: { clientUuid: string }[] }).baseline.map((entry) => entry.clientUuid));
    expect(ids[1]).toEqual(ids[0]!);
  });
});

// --- field errors route to the owning step ------------------------------------------------------------------------------------

describe('problem-details field errors jump to the step that owns the field', () => {
  const failWith = (...errors: { pointer: string; detail: string }[]) => ({ start: () => problem(422, errors) });

  test.each([
    ['/profile/age', 1, H2.profile, 'Age'],
    ['/profile/level', 1, H2.profile, 'Current level'],
    ['/profile/goal', 1, H2.profile, 'Main goal'],
    ['/profile/equipment', 2, H2.conditions, 'Equipment'],
    ['/profile/space', 2, H2.conditions, 'Where you train'],
    ['/profile/partner', 2, H2.conditions, 'Training partner'],
    ['/profile/daysPerWeek', 2, H2.conditions, 'Days per week'],
    ['/profile/minutesPerSession', 2, H2.conditions, 'Minutes per session'],
    ['/baseline/0/value', 3, H2.baseline, 'Skill test results'],
  ])('%s -> step %i', async (pointer, step, heading, label) => {
    const wizard = mountWizard({ server: failWith({ pointer, detail: 'Not accepted by the server.' }) });
    await toLastStep(wizard);
    await submit(wizard);
    await atStep(step);
    expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy();
    const note = alertNamed('Please check this step');
    expect(within(note).getByText(`${label}: Not accepted by the server.`)).toBeTruthy();
    expect(wizard.navigate).not.toHaveBeenCalled();
  });

  test('with errors on several steps the earliest one is shown first, and the answers already given are kept', async () => {
    const wizard = mountWizard({
      server: failWith({ pointer: '/baseline/1/value', detail: 'Bad value.' }, { pointer: '/profile/age', detail: 'Too old.' }),
    });
    await toLastStep(wizard);
    await submit(wizard);
    await atStep(1);
    expect(within(alertNamed('Please check this step')).getByText('Age: Too old.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Age').value).toBe('12');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Beginner' }).checked).toBe(true);
  });

  test('an error for a later step is still waiting there when the player gets to it', async () => {
    const wizard = mountWizard({
      server: failWith({ pointer: '/profile/age', detail: 'Too old.' }, { pointer: '/profile/space', detail: 'No such space.' }),
    });
    await toLastStep(wizard);
    await submit(wizard);
    await atStep(1);
    await wizard.user.click(continueButton());
    await atStep(2);
    expect(within(alertNamed('Please check this step')).getByText('Where you train: No such space.')).toBeTruthy();
  });

  test('changing the answer that was rejected clears the note on that step', async () => {
    const wizard = mountWizard({ server: failWith({ pointer: '/profile/age', detail: 'Too old.' }) });
    await toLastStep(wizard);
    await submit(wizard);
    await atStep(1);
    expect(screen.queryByRole('alert', { name: 'Please check this step' })).not.toBeNull();
    await wizard.user.type(screen.getByLabelText('Age'), '1');
    expect(screen.queryByRole('alert', { name: 'Please check this step' })).toBeNull();
  });

  test('after fixing it and continuing, the wizard submits again from the last step', async () => {
    let attempt = 0;
    const wizard = mountWizard({
      server: { start: () => (++attempt === 1 ? problem(422, [{ pointer: '/profile/daysPerWeek', detail: 'Pick fewer days.' }]) : json(START_RESPONSE)) },
    });
    await toLastStep(wizard);
    await submit(wizard);
    await atStep(2);
    await wizard.user.click(screen.getByRole('radio', { name: '4' }));
    await wizard.user.click(continueButton());
    await atStep(3);
    await submit(wizard);
    await waitFor(() => expect(wizard.navigate).toHaveBeenCalledWith('/train/roadmap'));
    expect((wizard.startCalls()[1]?.body as { profile: { daysPerWeek: number } }).profile.daysPerWeek).toBe(4);
  });

  test.each([
    ['a pointer no step owns', '/profile/nickname'],
    ['the root pointer', ''],
  ])('%s does not move the player: the last step shows the error with Try again', async (_name, pointer) => {
    const wizard = mountWizard({ server: failWith({ pointer, detail: 'Nope.' }) });
    await toLastStep(wizard);
    await submit(wizard);
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('We could not build your roadmap');
    expect(screen.getByText(stepText(3))).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: H2.baseline })).toBeTruthy();
  });
});

// --- languages ---------------------------------------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  test.each([
    ['kk', 'Қадам 1 / 4', 'Алғашқы жолыңызды бірге құрайық'],
    ['ru', 'Шаг 1 / 4', 'Соберём ваш первый путь'],
    ['en', 'Step 1 / 4', 'Let’s build your first path'],
  ] as const)('%s: step label and page title', async (locale, label, title) => {
    mountWizard({ locale });
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
  });

  test.each([
    ['kk', 'Сұрақтарды дайындап жатырмыз…'],
    ['ru', 'Готовим вопросы…'],
    ['en', 'Getting the questions ready…'],
  ] as const)('%s: loading text', async (locale, text) => {
    const pending = deferred<Response>();
    mountWizard({ locale, server: { options: () => pending.promise } });
    expect(screen.getByRole('status').textContent).toContain(text);
  });

  test.each(['kk', 'ru', 'en'] as const)('%s: no message is blank and no raw key shows through', async (locale) => {
    mountWizard({ locale });
    await screen.findByText(stepText(1, locale));
    expect(document.body.textContent).not.toMatch(/undefined|wizard:|\{\{/);
  });
});

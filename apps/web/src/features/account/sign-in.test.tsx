import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, i18n, LOCALES } from '../../lib/i18n';
import { ApiProblem, notifyUnauthorized } from '../../lib/problem';
import { Route, SignInDepsContext } from '../../routes/account/sign-in';
import { installSessionExpired } from './session-expired';
import sessionMessages from './session-expired.messages';
import messages from './sign-in.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as features/legal/privacy.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];
type Reply = { data?: unknown; error?: unknown };

// The expiry notice is worded by takeExpiredNotice() with the app-wide i18n singleton (features/account/session-expired.ts),
// which has no `session-expired` bundle under bun (import.meta.glob is undefined there). Register it and undo it after.
const INITIAL_LANGUAGE = i18n.language;
const SESSION_NAMESPACE = 'session-expired';
beforeAll(async () => {
  for (const locale of LOCALES) {
    if (!i18n.hasResourceBundle(locale, SESSION_NAMESPACE)) i18n.addResourceBundle(locale, SESSION_NAMESPACE, sessionMessages[locale], true, true);
  }
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  for (const locale of LOCALES) i18n.removeResourceBundle(locale, SESSION_NAMESPACE);
  await i18n.changeLanguage(INITIAL_LANGUAGE);
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

// Note: a failed matcher whose received value is a happy-dom node was seen to pass silently under bun:test (it hid a missing
// focus() call and a missing notice check in a mutation run), so nodes are never the received value of a matcher here:
// presence is `x === null` / `x !== null` and identity is `a === b`, compared as booleans; lists are counted with `.length`.

// --- helpers ----------------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const EXPIRED_KEY = 'fc:session-expired-notice';
const MINUTE = 60_000;
const modules = { './sign-in.messages.ts': { default: messages } };
const noStorage = { getItem: () => null, setItem: () => {} };

const ok = (user: Record<string, unknown> = { id: 'u1', isAnonymous: false }): Reply => ({ data: { token: 't', user }, error: null });
const failure = (status: number, code?: string, message = 'server text'): Reply => ({
  data: null,
  error: { status, statusText: 'x', code, message },
});

/** A promise the test settles by hand, to look at the screen while a request is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeStorage(initial: string | null = null, options: { throwOnRead?: boolean } = {}) {
  const data = new Map<string, string>();
  if (initial !== null) data.set(EXPIRED_KEY, initial);
  return {
    data,
    getItem: (key: string) => {
      if (options.throwOnRead) throw new Error('storage blocked');
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

interface Options {
  path?: string;
  locale?: Locale;
  session?: () => Promise<Reply>;
  signUp?: (input: Record<string, unknown>) => Promise<Reply>;
  signIn?: (input: Record<string, unknown>) => Promise<Reply>;
  storage?: ReturnType<typeof fakeStorage> | null;
  /** Leave resetSessionExpired to the real one from ./session-expired instead of a logging spy. */
  realResetExpired?: boolean;
}

/** The real route component inside a real (memory) router, with the auth client, storage and navigation injected. */
async function renderScreen(options: Options = {}) {
  const { path = '/account/sign-in', locale = 'en', realResetExpired = false } = options;
  const log: string[] = [];
  const calls = { signUp: [] as Record<string, unknown>[], signIn: [] as Record<string, unknown>[] };
  const client = {
    getSession: () => {
      log.push('getSession');
      return (options.session ?? (() => Promise.resolve({ data: null, error: null })))();
    },
    signUp: {
      email: (input: Record<string, unknown>) => {
        log.push('signUp.email');
        calls.signUp.push(input);
        return (options.signUp ?? (() => Promise.resolve(ok())))(input);
      },
    },
    signIn: {
      email: (input: Record<string, unknown>) => {
        log.push('signIn.email');
        calls.signIn.push(input);
        return (options.signIn ?? (() => Promise.resolve(ok())))(input);
      },
    },
  };
  const storage = options.storage === undefined ? fakeStorage() : options.storage;
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const signInRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/account/sign-in',
    component: Route.options.component,
    validateSearch: Route.options.validateSearch,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([signInRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <I18nextProvider i18n={instance}>
      <SignInDepsContext.Provider
        value={{
          client,
          storage,
          now: () => NOW,
          resetSession: () => void log.push('resetSession'),
          ...(realResetExpired ? {} : { resetSessionExpired: () => void log.push('resetSessionExpired') }),
          navigate: (to: string) => void log.push(`navigate:${to}`),
        }}
      >
        <RouterProvider router={router} />
      </SignInDepsContext.Provider>
    </I18nextProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  return { log, calls, storage, router, ...view };
}

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submitButton = (name: RegExp) => screen.getByRole('button', { name });

async function fillSignUp(name = 'Aigerim Coach', email = 'aigerim@example.com', password = 'correct horse battery') {
  type(/^display name/i, name);
  type(/^email/i, email);
  type(/^password/i, password);
}

async function submitSignUp() {
  await act(async () => {
    fireEvent.click(submitButton(/^create coach account$/i));
  });
}

async function chooseSignIn() {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: /^sign in$/i }));
  });
}

async function submitSignIn() {
  await act(async () => {
    fireEvent.click(submitButton(/^sign in$/i));
  });
}

/** Dotted paths of every string leaf. */
function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
  );
}

const search = (redirect: string) => `/account/sign-in?redirect=${encodeURIComponent(redirect)}`;
const navigations = (log: string[]) => log.filter((entry) => entry.startsWith('navigate:'));

// --- the two tabs -----------------------------------------------------------------------------

describe('the two tabs and what the screen says', () => {
  test('offers Create coach account and Sign in as tabs, with the first one selected', async () => {
    await renderScreen();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Create coach account', 'Sign in']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Account options');
  });

  test('explains that players never need an account', async () => {
    await renderScreen();
    expect(screen.getByText(/players never need an account/i)).toBeTruthy();
  });

  test('the selected tab is marked by an icon as well as by colour; the other one is not', async () => {
    await renderScreen();
    const [selected, other] = screen.getAllByRole('tab');
    expect(selected?.querySelector('svg') !== null).toBe(true);
    expect(other?.querySelector('svg') === null).toBe(true);
  });

  test('every tab is at least 44px tall (min-h-tap), like every control', async () => {
    await renderScreen();
    for (const tab of screen.getAllByRole('tab')) expect(tab.className).toContain('min-h-tap');
  });

  test('sign-up asks for display name, email and password; sign-in asks for email and password only', async () => {
    await renderScreen();
    expect(screen.getByLabelText(/^display name/i)).toBeTruthy();
    expect(screen.getByLabelText(/^email/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password/i)).toBeTruthy();
    await chooseSignIn();
    expect(screen.queryByLabelText(/^display name/i) === null).toBe(true);
    expect(screen.getByLabelText(/^email/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password/i)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^sign in$/i }).getAttribute('aria-selected')).toBe('true');
  });

  test('the inputs are labelled, typed and hinted for password managers and phone keyboards', async () => {
    await renderScreen();
    const email = screen.getByLabelText(/^email/i) as HTMLInputElement;
    const password = screen.getByLabelText(/^password/i) as HTMLInputElement;
    expect(email.type).toBe('email');
    expect(email.autocomplete).toBe('email');
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('new-password');
    expect((screen.getByLabelText(/^display name/i) as HTMLInputElement).autocomplete).toBe('name');
    await chooseSignIn();
    expect((screen.getByLabelText(/^password/i) as HTMLInputElement).autocomplete).toBe('current-password');
  });

  test('the sign-up password hint says 10 characters and that there is no reset email', async () => {
    await renderScreen();
    const password = screen.getByLabelText(/^password/i);
    const hint = document.getElementById(password.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/10/);
    expect(hint?.textContent).toMatch(/reset/i);
  });

  test('arrow keys move between the tabs; each tab controls a labelled panel', async () => {
    await renderScreen();
    const [signUpTab] = screen.getAllByRole('tab');
    await act(async () => {
      fireEvent.keyDown(signUpTab as HTMLElement, { key: 'ArrowRight' });
    });
    const signInTab = screen.getByRole('tab', { name: /^sign in$/i });
    expect(signInTab.getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel');
    expect(signInTab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(signInTab.id);
  });

  test('switching tabs keeps what was typed in the email field and drops old errors', async () => {
    await renderScreen();
    await submitSignUp(); // empty: validation errors
    expect(screen.getByText(/enter a display name/i)).toBeTruthy();
    type(/^email/i, 'keep@example.com');
    await chooseSignIn();
    expect((screen.getByLabelText(/^email/i) as HTMLInputElement).value).toBe('keep@example.com');
    expect(screen.queryByText(/enter a display name/i) === null).toBe(true);
    expect(screen.queryAllByRole('alert').length).toBe(0);
  });
});

// --- validation -------------------------------------------------------------------------------

describe('validation happens before any request', () => {
  test('an empty sign-up form names each problem, sends nothing and focuses the first bad field', async () => {
    const { calls } = await renderScreen();
    await submitSignUp();
    expect(screen.getByText(/enter a display name/i)).toBeTruthy();
    expect(screen.getByText(/enter an email address/i)).toBeTruthy();
    expect(screen.getByText(/use at least 10 characters/i)).toBeTruthy();
    expect(calls.signUp).toHaveLength(0);
    expect(document.activeElement === screen.getByLabelText(/^display name/i)).toBe(true);
    expect(screen.getByLabelText(/^display name/i).getAttribute('aria-invalid')).toBe('true');
  });

  test('a display name of only spaces is empty', async () => {
    const { calls } = await renderScreen();
    await fillSignUp('   ');
    await submitSignUp();
    expect(screen.getByText(/enter a display name/i)).toBeTruthy();
    expect(calls.signUp).toHaveLength(0);
  });

  test.each(['plainaddress', 'a@b', '@example.com', 'a b@example.com', 'a@@example.com'])('%p is not an email address', async (email) => {
    const { calls } = await renderScreen();
    await fillSignUp('Aigerim', email);
    await submitSignUp();
    expect(screen.getByText(/enter an email address/i)).toBeTruthy();
    expect(calls.signUp).toHaveLength(0);
  });

  test('9 characters is too short and 10 is enough', async () => {
    const { calls } = await renderScreen();
    await fillSignUp('Aigerim', 'a@example.com', '123456789');
    await submitSignUp();
    expect(screen.getByText(/use at least 10 characters/i)).toBeTruthy();
    expect(calls.signUp).toHaveLength(0);
    type(/^password/i, '1234567890');
    await submitSignUp();
    expect(calls.signUp).toHaveLength(1);
  });

  test('the password is sent exactly as typed, never trimmed', async () => {
    const { calls } = await renderScreen();
    await fillSignUp('Aigerim', 'a@example.com', '  spaces around  ');
    await submitSignUp();
    expect(calls.signUp[0]?.password).toBe('  spaces around  ');
  });

  test('sign-in validates the email and needs a password, but has no minimum length (older accounts)', async () => {
    const { calls } = await renderScreen();
    await chooseSignIn();
    await submitSignIn();
    expect(screen.getByText(/enter an email address/i)).toBeTruthy();
    expect(screen.getByText(/enter your password/i)).toBeTruthy();
    expect(calls.signIn).toHaveLength(0);
    type(/^email/i, 'a@example.com');
    type(/^password/i, 'short');
    await submitSignIn();
    expect(calls.signIn).toHaveLength(1);
  });
});

// --- requests and success ---------------------------------------------------------------------

describe('sign-up and sign-in requests', () => {
  test('sign-up sends the trimmed display name and email and the password, then resets the session memo and goes to /', async () => {
    const { calls, log } = await renderScreen();
    await fillSignUp('  Aigerim Coach  ', '  aigerim@example.com  ', 'correct horse battery');
    await submitSignUp();
    expect(calls.signUp).toEqual([{ name: 'Aigerim Coach', email: 'aigerim@example.com', password: 'correct horse battery' }]);
    expect(calls.signIn).toHaveLength(0);
    await waitFor(() => expect(navigations(log)).toEqual(['navigate:/']));
    expect(log.indexOf('resetSession')).toBeGreaterThan(log.indexOf('signUp.email'));
    expect(log.indexOf('resetSession')).toBeLessThan(log.indexOf('navigate:/'));
  });

  test('sign-in sends the trimmed email and the password only', async () => {
    const { calls, log } = await renderScreen();
    await chooseSignIn();
    type(/^email/i, ' aigerim@example.com ');
    type(/^password/i, 'correct horse battery');
    await submitSignIn();
    expect(calls.signIn).toEqual([{ email: 'aigerim@example.com', password: 'correct horse battery' }]);
    expect(calls.signUp).toHaveLength(0);
    await waitFor(() => expect(navigations(log)).toEqual(['navigate:/']));
  });

  test('success shows a status message and the form stays locked, so it cannot be sent twice', async () => {
    const { calls, container } = await renderScreen();
    await fillSignUp();
    await submitSignUp();
    expect(await screen.findByText(/taking you back/i)).toBeTruthy();
    const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(button);
      fireEvent.submit(button.closest('form') as HTMLFormElement);
    });
    expect(calls.signUp).toHaveLength(1);
  });

  test('a reply without a user is not a success: nothing is reset and nobody is sent on', async () => {
    const { log } = await renderScreen({ signUp: () => Promise.resolve({ data: '<html>proxy</html>', error: null }) });
    await fillSignUp();
    await submitSignUp();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(log).not.toContain('resetSession');
    expect(navigations(log)).toHaveLength(0);
  });

  test('resetSessionExpired runs after a successful sign-in, after the memo reset and before leaving; a failure never calls it', async () => {
    const failed = await renderScreen({ signUp: () => Promise.resolve(failure(500)) });
    await fillSignUp();
    await submitSignUp();
    expect(failed.log).not.toContain('resetSessionExpired');
    cleanup();

    const good = await renderScreen();
    await fillSignUp();
    await submitSignUp();
    await waitFor(() => expect(navigations(good.log)).toHaveLength(1));
    const order = good.log.filter((entry) => entry !== 'getSession');
    expect(order).toEqual(['signUp.email', 'resetSession', 'resetSessionExpired', 'navigate:/']);
  });

  test('wired to the real resetSessionExpired: a successful sign-in arms the 401 handler for the next coach-area 401', async () => {
    const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const redirects: string[] = [];
    const stop = installSessionExpired({
      location: () => ({ pathname: '/admin' }),
      navigate: (url) => void redirects.push(url),
      notify: () => undefined,
      storage: fakeStorage(),
      session: { ensure: () => Promise.resolve({}), reset: () => undefined },
      now: () => NOW,
    });
    try {
      const expired = new ApiProblem({ kind: 'unauthorized', status: 401 });
      notifyUnauthorized(expired);
      await nextMacrotask();
      notifyUnauthorized(expired); // one expiry, one redirect: latched until a sign-in
      await nextMacrotask();
      expect(redirects.length).toBe(1);

      const { log } = await renderScreen({ realResetExpired: true });
      await fillSignUp();
      await submitSignUp();
      await waitFor(() => expect(navigations(log)).toHaveLength(1));
      notifyUnauthorized(expired);
      await nextMacrotask();
      expect(redirects.length).toBe(2);
    } finally {
      stop();
    }
  });
});

describe('while a request is in flight', () => {
  test('the button is busy, every input and both tabs are disabled, and a second click sends nothing', async () => {
    const pending = deferred<Reply>();
    const { calls } = await renderScreen({ signUp: () => pending.promise });
    await fillSignUp();
    await submitSignUp();
    const busy = screen.getByRole('button', { name: /creating your account/i }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    for (const label of [/^display name/i, /^email/i, /^password/i]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    }
    for (const tab of screen.getAllByRole('tab')) expect((tab as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(busy);
      fireEvent.submit(busy.closest('form') as HTMLFormElement);
    });
    expect(calls.signUp).toHaveLength(1);
    await act(async () => pending.resolve(ok()));
  });

  test('sign-in shows its own busy label', async () => {
    const pending = deferred<Reply>();
    await renderScreen({ signIn: () => pending.promise });
    await chooseSignIn();
    type(/^email/i, 'a@example.com');
    type(/^password/i, 'whatever');
    await submitSignIn();
    expect(screen.getByRole('button', { name: /signing in/i })).toBeTruthy();
    await act(async () => pending.resolve(ok()));
  });

  test('after a failure the form is usable again and keeps what was typed', async () => {
    const pending = deferred<Reply>();
    const { calls } = await renderScreen({ signUp: () => pending.promise });
    await fillSignUp('Aigerim', 'keep@example.com', 'correct horse battery');
    await submitSignUp();
    await act(async () => pending.resolve(failure(500)));
    const button = screen.getByRole('button', { name: /^create coach account$/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect((screen.getByLabelText(/^email/i) as HTMLInputElement).value).toBe('keep@example.com');
    expect((screen.getByLabelText(/^display name/i) as HTMLInputElement).value).toBe('Aigerim');
    await submitSignUp();
    expect(calls.signUp).toHaveLength(2);
  });
});

// --- error mapping ----------------------------------------------------------------------------

describe('errors become readable messages', () => {
  async function failWith(reply: Reply | (() => Promise<Reply>), mode: 'signUp' | 'signIn' = 'signUp') {
    const handler = typeof reply === 'function' ? reply : () => Promise.resolve(reply);
    const screenState = await renderScreen({ [mode]: handler });
    if (mode === 'signUp') {
      await fillSignUp();
      await submitSignUp();
    } else {
      await chooseSignIn();
      type(/^email/i, 'a@example.com');
      type(/^password/i, 'not the password');
      await submitSignIn();
    }
    return screenState;
  }

  test('wrong password (401, INVALID_EMAIL_OR_PASSWORD): says the pair does not match, without naming which one', async () => {
    const { log } = await failWith(failure(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password'), 'signIn');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/email and password do not match/i);
    expect(alert.textContent).not.toMatch(/invalid email or password/i); // the server's English is never shown as is
    expect(log).not.toContain('resetSession');
    expect(navigations(log)).toHaveLength(0);
  });

  test('a bare 401 is a wrong password too', async () => {
    await failWith(failure(401), 'signIn');
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match/i);
  });

  test('email taken (422, USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL): says so and offers Sign in instead, which keeps the email', async () => {
    await failWith(failure(422, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'User already exists. Use another email.'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/already has an account/i);
    const instead = within(alert).getByRole('button', { name: /sign in instead/i });
    await act(async () => {
      fireEvent.click(instead);
    });
    expect(screen.getByRole('tab', { name: /^sign in$/i }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText(/^email/i) as HTMLInputElement).value).toBe('aigerim@example.com');
    expect(screen.queryByText(/already has an account/i) === null).toBe(true);
  });

  test('USER_ALREADY_EXISTS (older code) is email taken as well', async () => {
    await failWith(failure(400, 'USER_ALREADY_EXISTS'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already has an account/i);
  });

  test('rate limited (429) says how many tries there are: 10 in 15 minutes', async () => {
    for (const mode of ['signUp', 'signIn'] as const) {
      await failWith(failure(429, undefined, 'Too many requests. Please try again later.'), mode);
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/10 times in 15 minutes/i);
      expect(alert.textContent).not.toMatch(/too many requests/i);
      cleanup();
    }
  });

  test('a rejected request (network failure) says there is no connection', async () => {
    const { log } = await failWith(() => Promise.reject(new TypeError('Failed to fetch')));
    expect((await screen.findByRole('alert')).textContent).toMatch(/no connection/i);
    expect(navigations(log)).toHaveLength(0);
  });

  test('a 5xx says it is on our side', async () => {
    await failWith(failure(503, undefined, 'Service Unavailable'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/on our side/i);
  });

  test('anything else gets a generic message, never the server text', async () => {
    await failWith(failure(418, 'TEAPOT', 'I am a teapot'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not finish/i);
    expect(alert.textContent).not.toMatch(/teapot/i);
  });

  test('PASSWORD_TOO_SHORT and INVALID_EMAIL land on their own fields', async () => {
    await failWith(failure(400, 'PASSWORD_TOO_SHORT'));
    await waitFor(() => expect(screen.getByLabelText(/^password/i).getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(/use at least 10 characters/i)).toBeTruthy();
    cleanup();
    await failWith(failure(400, 'INVALID_EMAIL'));
    await waitFor(() => expect(screen.getByLabelText(/^email/i).getAttribute('aria-invalid')).toBe('true'));
  });

  test('an error is announced once and goes away when the next attempt starts', async () => {
    const replies = [failure(401, 'INVALID_EMAIL_OR_PASSWORD'), ok()];
    await failWith(() => Promise.resolve(replies.shift() as Reply), 'signIn');
    expect((await screen.findAllByRole('alert')).length).toBe(1);
    await submitSignIn();
    expect(screen.queryAllByRole('alert').length).toBe(0);
  });
});

// --- the redirect -----------------------------------------------------------------------------

describe('returns to the redirect search param, only when it is a safe same-origin path', () => {
  async function goAfterSignUp(path: string) {
    const { log } = await renderScreen({ path });
    await fillSignUp();
    await submitSignUp();
    await waitFor(() => expect(navigations(log)).toHaveLength(1));
    return navigations(log)[0];
  }

  test.each(['/train/roadmap', '/contribute', '/train/roadmap?tab=drills', '/commons/abc?x=1#top', '/train?q=100%25'])('goes back to %p', async (target) => {
    expect(await goAfterSignUp(search(target))).toBe(`navigate:${target}`);
  });

  test('a space in the path is encoded by the URL parser, not refused', async () => {
    expect(await goAfterSignUp(search('/commons/a b'))).toBe('navigate:/commons/a%20b');
  });

  test('without a redirect it goes to /', async () => {
    expect(await goAfterSignUp('/account/sign-in')).toBe('navigate:/');
  });

  test('sign-in uses the redirect too', async () => {
    const { log } = await renderScreen({ path: search('/train/roadmap') });
    await chooseSignIn();
    type(/^email/i, 'a@example.com');
    type(/^password/i, 'whatever');
    await submitSignIn();
    await waitFor(() => expect(navigations(log)).toEqual(['navigate:/train/roadmap']));
  });

  test.each([
    ['protocol-relative', '//evil.example'],
    ['protocol-relative with a path', '//evil.example/train'],
    ['backslash after the slash', '/\\evil.example'],
    ['two backslashes', '\\\\evil.example'],
    ['a backslash later in the path', '/train\\..\\evil'],
    ['absolute https URL', 'https://evil.example/'],
    ['absolute http URL', 'http://evil.example/'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>1</script>'],
    ['no leading slash', 'evil.example/train'],
    ['a relative path', 'train/roadmap'],
    ['a leading space', ' //evil.example'],
    ['a tab hiding a second slash', '/\t/evil.example'],
    ['a newline hiding a second slash', '/\n/evil.example'],
    ['a carriage return', '/\r/evil.example'],
    ['a NUL byte', '/train\u0000'],
    ['a DEL character', '/train\u007f'],
    ['an encoded second slash', '/%2Fevil.example'],
    ['an encoded second slash, lower case', '/%2fevil.example'],
    ['an encoded backslash', '/%5Cevil.example'],
    ['an encoded tab', '/%09/evil.example'],
    ['an encoded newline', '/%0A/evil.example'],
    ['an encoded NUL', '/train%00'],
    ['a double-encoded second slash', '/%252Fevil.example'],
    ['a double-encoded backslash', '/%255Cevil.example'],
    ['a triple-encoded second slash', '/%25252Fevil.example'],
    ['a malformed escape', '/train%E0%A4%A'],
    ['an encoded scheme', '%68ttps://evil.example'],
    ['the sign-in page itself (a loop)', '/account/sign-in'],
    ['the sign-in page with a query (a loop)', '/account/sign-in?redirect=/x'],
    ['an empty value', ''],
    ['dot segments that climb into a protocol-relative path', '/..//evil.example'],
  ])('falls back to / for %s', async (_name, value) => {
    expect(await goAfterSignUp(search(value))).toBe('navigate:/');
  });

  test('a value that is not one string (a number, a repeated parameter) falls back to /', async () => {
    expect(await goAfterSignUp('/account/sign-in?redirect=123')).toBe('navigate:/');
    cleanup();
    expect(await goAfterSignUp('/account/sign-in?redirect=/a&redirect=/b')).toBe('navigate:/');
  });

  test('an over-long value falls back to /', async () => {
    expect(await goAfterSignUp(search(`/${'a'.repeat(3000)}`))).toBe('navigate:/');
  });

  test('the route only keeps a string redirect as its search', () => {
    const validate = Route.options.validateSearch as (input: Record<string, unknown>) => { redirect?: string };
    expect(validate({ redirect: '/train' })).toEqual({ redirect: '/train' });
    expect(validate({ redirect: 5 }).redirect).toBeUndefined();
    expect(validate({ redirect: ['/a'] }).redirect).toBeUndefined();
    expect(validate({}).redirect).toBeUndefined();
  });
});

// --- session expired notice -------------------------------------------------------------------

// The 401 handler (features/account/session-expired.ts) leaves `{ savedAt }` under `fc:session-expired-notice` before a full
// page load; takeExpiredNotice() words it in the active language. The screen shows that as an info notice.
describe('the "your session expired" notice left by the 401 handler', () => {
  const EXPIRED_EN = 'Your session expired — sign in again';
  const stored = (savedAt: unknown = NOW - MINUTE) => JSON.stringify({ savedAt });

  test('shows the expiry message as an info notice, removes it, and starts on the Sign in tab', async () => {
    const storage = fakeStorage(stored());
    await renderScreen({ storage });
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain(EXPIRED_EN);
    expect(notice.getAttribute('data-tone')).toBe('info');
    expect(storage.data.has(EXPIRED_KEY)).toBe(false);
    expect(screen.getByRole('tab', { name: /^sign in$/i }).getAttribute('aria-selected')).toBe('true');
  });

  test('is read once: a new render finds nothing more', async () => {
    const storage = fakeStorage(stored());
    await renderScreen({ storage });
    await screen.findByText(EXPIRED_EN);
    cleanup();
    await renderScreen({ storage });
    expect(screen.queryByText(EXPIRED_EN) === null).toBe(true);
  });

  test.each(['kk', 'ru'] as const)('is worded in the active language (%s)', async (locale) => {
    await i18n.changeLanguage(locale);
    await renderScreen({ storage: fakeStorage(stored()), locale });
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain(sessionMessages[locale].message);
    expect(sessionMessages[locale].message).not.toBe(EXPIRED_EN);
  });

  test('a note 4 minutes old is shown; one 6 minutes old is ignored but still removed', async () => {
    const fresh = fakeStorage(stored(NOW - 4 * MINUTE));
    await renderScreen({ storage: fresh });
    expect(await screen.findByText(EXPIRED_EN)).toBeTruthy();
    cleanup();
    const old = fakeStorage(stored(NOW - 6 * MINUTE));
    await renderScreen({ storage: old });
    expect(screen.queryByText(EXPIRED_EN) === null).toBe(true);
    expect(old.data.has(EXPIRED_KEY)).toBe(false);
    expect(screen.getByRole('tab', { name: /^create coach account$/i }).getAttribute('aria-selected')).toBe('true');
  });

  test.each([
    ['a timestamp in the future', stored(NOW + 60 * MINUTE)],
    ['a text timestamp', stored('yesterday')],
    ['no timestamp', JSON.stringify({})],
    ['not JSON', 'not json at all'],
    ['a JSON string instead of an object', JSON.stringify('Just text')],
    ['null', 'null'],
  ])('ignores %s and removes it', async (_name, raw) => {
    const storage = fakeStorage(raw);
    await renderScreen({ storage });
    expect(screen.queryByRole('status') === null).toBe(true);
    expect(storage.data.has(EXPIRED_KEY)).toBe(false);
  });

  test('works with no storage at all, and with storage that throws', async () => {
    await renderScreen({ storage: null });
    expect(screen.getByRole('tablist')).toBeTruthy();
    cleanup();
    await renderScreen({ storage: fakeStorage(stored(), { throwOnRead: true }) });
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.queryByRole('status') === null).toBe(true);
  });

  test('no notice, no status message', async () => {
    await renderScreen();
    expect(screen.queryByRole('status') === null).toBe(true);
  });
});

// --- the anonymous session --------------------------------------------------------------------

describe('a player who is training as a guest keeps their progress', () => {
  const anonymous = () => Promise.resolve<Reply>({ data: { user: { id: 'anon', isAnonymous: true } }, error: null });

  test('sign-up on top of a guest session sends the sign-up request only: no sign-out, no new anonymous sign-in, memo reset before leaving', async () => {
    const { log, calls } = await renderScreen({ session: anonymous });
    await screen.findByText(/training as a guest/i);
    await fillSignUp();
    await submitSignUp();
    await waitFor(() => expect(navigations(log)).toHaveLength(1));
    expect(log).toEqual(['getSession', 'signUp.email', 'resetSession', 'resetSessionExpired', 'navigate:/']);
    expect(calls.signUp).toHaveLength(1);
  });

  test('tells a guest that making an account keeps their progress, and only a guest', async () => {
    await renderScreen({ session: anonymous });
    const note = await screen.findByText(/training as a guest/i);
    expect(note.textContent).toMatch(/progress/i);
    cleanup();
    await renderScreen({ session: () => Promise.resolve({ data: null, error: null }) });
    await waitFor(() => expect(screen.queryByText(/checking your session/i) === null).toBe(true));
    expect(screen.queryByText(/training as a guest/i) === null).toBe(true);
  });

  test('the guest note belongs to the Create tab: the Sign in tab does not show it', async () => {
    await renderScreen({ session: anonymous });
    await screen.findByText(/training as a guest/i);
    await chooseSignIn();
    expect(screen.queryAllByText(/training as a guest/i).length).toBe(0);
  });

  test('while the session is being read, a status line says so and the form is already usable', async () => {
    const pending = deferred<Reply>();
    const { calls } = await renderScreen({ session: () => pending.promise });
    expect(screen.getByText(/checking your session/i)).toBeTruthy();
    await fillSignUp();
    await submitSignUp();
    expect(calls.signUp).toHaveLength(1);
    await act(async () => pending.resolve({ data: null, error: null }));
    expect(screen.queryByText(/checking your session/i) === null).toBe(true);
  });

  test('an unreadable or failed session read shows no guest note and never blocks the form', async () => {
    await renderScreen({ session: () => Promise.resolve({ data: '<html>proxy</html>', error: null }) });
    await waitFor(() => expect(screen.queryByText(/checking your session/i) === null).toBe(true));
    expect(screen.queryByText(/training as a guest/i) === null).toBe(true);
    expect(screen.getByRole('tablist')).toBeTruthy();
    cleanup();
    await renderScreen({ session: () => Promise.reject(new TypeError('offline')) });
    await waitFor(() => expect(screen.queryByText(/checking your session/i) === null).toBe(true));
    expect(screen.getByRole('tablist')).toBeTruthy();
    cleanup();
    await renderScreen({ session: () => Promise.resolve(failure(500)) });
    await waitFor(() => expect(screen.queryByText(/checking your session/i) === null).toBe(true));
    expect(screen.getByRole('tablist')).toBeTruthy();
  });

  test('a user who is already a signed-in account gets "already signed in" and a Continue button instead of the form', async () => {
    const { log } = await renderScreen({
      path: search('/train/roadmap'),
      session: () => Promise.resolve({ data: { user: { id: 'u', isAnonymous: false } }, error: null }),
    });
    expect(await screen.findByText(/already signed in/i)).toBeTruthy();
    expect(screen.queryByRole('tablist') === null).toBe(true);
    expect(screen.queryByLabelText(/^password/i) === null).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    expect(navigations(log)).toEqual(['navigate:/train/roadmap']);
  });

  test('a session whose user says nothing about being anonymous is not taken for an account', async () => {
    await renderScreen({ session: () => Promise.resolve({ data: { user: { id: 'x' } }, error: null }) });
    await waitFor(() => expect(screen.queryByText(/checking your session/i) === null).toBe(true));
    expect(screen.queryByText(/already signed in/i) === null).toBe(true);
    expect(screen.getByRole('tablist')).toBeTruthy();
  });

  test('"Continue" for an account still refuses an unsafe redirect', async () => {
    const { log } = await renderScreen({
      path: search('//evil.example'),
      session: () => Promise.resolve({ data: { user: { id: 'u', isAnonymous: false } }, error: null }),
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));
    });
    expect(navigations(log)).toEqual(['navigate:/']);
  });
});

// --- copy -------------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  test('the three languages have the same keys, none of them empty', () => {
    const en = leafKeys(messages.en).sort();
    expect(en.length).toBeGreaterThan(20);
    for (const locale of ['kk', 'ru'] as const) {
      expect(leafKeys(messages[locale]).sort()).toEqual(en);
    }
    for (const locale of LOCALES) {
      for (const key of leafKeys(messages[locale])) {
        const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages[locale]);
        expect((value as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('every language keeps the numbers the rate-limit and password messages promise', () => {
    for (const locale of LOCALES) {
      expect(messages[locale].errors.rateLimited).toMatch(/10/);
      expect(messages[locale].errors.rateLimited).toMatch(/15/);
      expect(messages[locale].validation.passwordShort).toMatch(/10/);
    }
  });

  test.each(['kk', 'ru'] as const)('%s renders its own tab labels, heading and errors, not English', async (locale) => {
    await renderScreen({ locale, signUp: () => Promise.resolve(failure(429)) });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual([
      messages[locale].tabs.signUp,
      messages[locale].tabs.signIn,
    ]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(messages[locale].title);
    expect(messages[locale].title).not.toBe(messages.en.title);
    // The English label regexes of fillSignUp do not apply here: fill by the labels of this language.
    fireEvent.change(screen.getByLabelText(new RegExp(`^${messages[locale].fields.name.label}`, 'i')), { target: { value: 'Aigerim' } });
    fireEvent.change(screen.getByLabelText(new RegExp(`^${messages[locale].fields.email.label}`, 'i')), {
      target: { value: 'a@example.com' },
    });
    fireEvent.change(screen.getByLabelText(new RegExp(`^${messages[locale].fields.password.label}`, 'i')), {
      target: { value: 'correct horse battery' },
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === messages[locale].submit.signUp) as HTMLElement);
    });
    expect((await screen.findByRole('alert')).textContent).toContain(messages[locale].errors.rateLimited);
  });
});

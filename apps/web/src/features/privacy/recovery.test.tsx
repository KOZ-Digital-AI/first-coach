import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { RecoveryCodeResponse } from '@api-types/privacy';
import { dehydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES, type MessageModules } from '../../lib/i18n';
import { collectSlot } from '../../lib/slots';
import problemMessages from '../../lib/problem.messages';
import RecoveryPanel from './panels/recovery.panel';
import messages from './recovery.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as privacy.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * The recovery code panel (features/privacy/panels/recovery.panel.tsx), written from the acceptance criteria of fc-mol-bjm.7:
 * "creates a code with one button, shows it once in large grouped characters with copy and 'I wrote it down' confirmation,
 * warns that a new code replaces the old one, and never stores the code in browser storage". The panel plugs into the privacy
 * screen through the `privacy-panel` slot (lib/slots.ts), not by editing the screen.
 *
 * Real code goes through the real typed client (lib/api.ts) and React Query; the only stand-ins are the network
 * (globalThis.fetch) and the clipboard. Fixtures are parsed with the shared contract schema so they cannot drift from the API.
 * Kazakh and Russian copy needs a native review; those assertions read the bundle.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const AT = '2026-09-21T10:00:00.000Z';
const FIRST = 'K7QM-3XWP-9RTD-H2VB';
const SECOND = '4NFC-8ZJS-6EAY-2MGU';
const groupsOf = (code: string) => code.split('-');
const issued = (code: string) => RecoveryCodeResponse.parse({ code, createdAt: AT });

// --- the network ----------------------------------------------------------------------------------------------------

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status: number) => json({ type: 'about:blank', title: 'Problem', status }, status, 'application/problem+json');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Call = { method: string; path: string; body: string | undefined };
let calls: Call[] = [];
let respond: () => Response | Promise<Response> = () => json(issued(FIRST));
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => json(issued(FIRST));
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.pathname === '/api/player/recovery-code' && (init?.method ?? 'GET') === 'POST') return respond();
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- the clipboard --------------------------------------------------------------------------------------------------

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let copied: string[] = [];

/** Installed AFTER userEvent.setup(), which puts a clipboard stub of its own on `navigator`. */
function stubClipboard(writeText: (text: string) => Promise<void> = async (text) => void copied.push(text)): void {
  copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}
function removeClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
}
afterEach(() => {
  if (originalClipboard !== undefined) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

// --- rendering ------------------------------------------------------------------------------------------------------

const modules: MessageModules = {
  './recovery.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

function mount(queryClient: QueryClient, locale: Locale) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RecoveryPanel />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function renderPanel(locale: Locale = 'en', queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const view = mount(queryClient, locale);
  const user = userEvent.setup();
  stubClipboard();
  return { ...view, queryClient, user };
}

const makeButton = (name: RegExp = /make my recovery code/i) => screen.getByRole('button', { name });
const codeBlock = () => screen.getByRole('group', { name: /your recovery code/i });
const codeGroups = () => Array.from(document.querySelectorAll('[data-slot="recovery-code-group"]')).map((node) => node.textContent);

/** Clicks the one button and waits for the code to be on screen. */
async function makeCode(view: ReturnType<typeof renderPanel>, name?: RegExp) {
  await view.user.click(makeButton(name));
  await screen.findByRole('group', { name: /your recovery code/i });
}

const posts = () => calls.filter((call) => call.method === 'POST');

// --- creating the code ----------------------------------------------------------------------------------------------

describe('the one button', () => {
  test('is a heading with the explanation, one button, no code yet and no request yet', () => {
    renderPanel();
    expect(screen.getByRole('heading', { level: 2, name: /recovery code/i })).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Make my recovery code']);
    expect(screen.queryByRole('group', { name: /your recovery code/i })).toBeNull();
    expect(calls).toEqual([]);
  });

  test('one click is exactly one POST /api/player/recovery-code without a body', async () => {
    const view = renderPanel();
    await makeCode(view);
    expect(posts().map((call) => [call.path, call.body])).toEqual([['/api/player/recovery-code', undefined]]);
    // An anonymous guest is a player: nothing else is asked (no profile, no session lookup) before the code is made.
    expect(calls.map((call) => call.path)).toEqual(['/api/player/recovery-code']);
  });

  test('is disabled and busy while the request is out, so a second tap cannot make a second code', async () => {
    const pending = deferred<Response>();
    respond = () => pending.promise;
    const view = renderPanel();
    await view.user.click(makeButton());
    const busy = await screen.findByRole('button', { name: /making your code/i });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await view.user.click(busy);
    expect(posts()).toHaveLength(1);
    pending.resolve(json(issued(FIRST)));
    await screen.findByRole('group', { name: /your recovery code/i });
    expect(posts()).toHaveLength(1);
  });
});

describe('the replaced-code warning', () => {
  test('is on screen before the button is pressed: a new code replaces the old one', () => {
    renderPanel();
    expect(screen.getByText(/a new code replaces the old one/i)).toBeTruthy();
    expect(screen.getByText(/the old code stops working/i)).toBeTruthy();
  });

  test('is said again next to the code that was just made', async () => {
    const view = renderPanel();
    await makeCode(view);
    expect(within(codeBlock()).getByText(/replaces any earlier code/i)).toBeTruthy();
  });
});

// --- showing it once ------------------------------------------------------------------------------------------------

describe('the code is shown once', () => {
  test('in four groups of four characters, one element per group, in the order the server sent them', async () => {
    const view = renderPanel();
    await makeCode(view);
    expect(codeGroups()).toEqual(groupsOf(FIRST));
    expect(within(codeBlock()).getAllByText(/^[A-Z0-9]{4}$/)).toHaveLength(4);
  });

  test('a code the server sends without hyphens is still shown in groups of four', async () => {
    respond = () => json(issued('K7QM3XWP9RTDH2VB'));
    const view = renderPanel();
    await makeCode(view);
    expect(codeGroups()).toEqual(groupsOf(FIRST));
  });

  test('says in words that it is to be written down and will not be shown again', async () => {
    const view = renderPanel();
    await makeCode(view);
    expect(within(codeBlock()).getByText(/write it down/i)).toBeTruthy();
    expect(within(codeBlock()).getByText(/will not be shown again/i)).toBeTruthy();
  });

  test('moves focus onto the code, because the button that was pressed is gone', async () => {
    const view = renderPanel();
    await makeCode(view);
    await waitFor(() => expect(document.activeElement).toBe(codeBlock()));
    expect(view.queryByRole('button', { name: /make my recovery code/i })).toBeNull();
  });

  test('"I wrote it down" hides the code for good and says so, and nothing of the code stays in the page', async () => {
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /i wrote it down/i }));
    expect(screen.queryByRole('group', { name: /your recovery code/i })).toBeNull();
    expect(codeGroups()).toEqual([]);
    for (const group of groupsOf(FIRST)) expect(document.body.textContent).not.toContain(group);
    expect(screen.getByRole('status').textContent).toMatch(/will not be shown again/i);
  });

  test('after the confirmation the same warning stays, and the button offers a NEW code (a second POST)', async () => {
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /i wrote it down/i }));
    expect(screen.getByText(/a new code replaces the old one/i)).toBeTruthy();
    respond = () => json(issued(SECOND));
    await makeCode(view, /make a new code/i);
    expect(posts()).toHaveLength(2);
    expect(codeGroups()).toEqual(groupsOf(SECOND));
  });

  test('the new code replaces the old one on screen: the earlier groups are gone', async () => {
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /i wrote it down/i }));
    respond = () => json(issued(SECOND));
    await makeCode(view, /make a new code/i);
    for (const group of groupsOf(FIRST)) expect(document.body.textContent).not.toContain(group);
  });
});

// --- copy -----------------------------------------------------------------------------------------------------------

describe('the copy action', () => {
  test('copies the whole code in its canonical spelling (4x4, hyphens: what the restore screen accepts)', async () => {
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    expect(copied).toEqual([FIRST]);
  });

  test('copies the canonical spelling even when the server sent no hyphens', async () => {
    respond = () => json(issued('K7QM3XWP9RTDH2VB'));
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    expect(copied).toEqual([FIRST]);
  });

  test('says "Copied" in words (a status, not a colour), and the code stays on screen', async () => {
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    await waitFor(() => expect(within(codeBlock()).getByRole('status').textContent).toMatch(/copied/i));
    expect(codeGroups()).toEqual(groupsOf(FIRST));
  });

  test('a clipboard that refuses is said in words, the code stays, and nothing claims it was copied', async () => {
    const view = renderPanel();
    await makeCode(view);
    stubClipboard(async () => {
      throw new Error('denied');
    });
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    await waitFor(() => expect(within(codeBlock()).getByRole('status').textContent).toMatch(/could not copy/i));
    expect(within(codeBlock()).getByRole('status').textContent).not.toMatch(/^copied/i);
    expect(codeGroups()).toEqual(groupsOf(FIRST));
  });

  test('a browser with no clipboard at all is the same failure, not a crash', async () => {
    const view = renderPanel();
    await makeCode(view);
    removeClipboard();
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    await waitFor(() => expect(within(codeBlock()).getByRole('status').textContent).toMatch(/could not copy/i));
  });

  test('a new code starts un-copied: the "Copied" of the old code does not carry over', async () => {
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    await waitFor(() => expect(within(codeBlock()).getByRole('status').textContent).toMatch(/copied/i));
    await view.user.click(screen.getByRole('button', { name: /i wrote it down/i }));
    respond = () => json(issued(SECOND));
    await makeCode(view, /make a new code/i);
    expect(within(codeBlock()).getByRole('status').textContent).toBe('');
  });
});

// --- failures -------------------------------------------------------------------------------------------------------

describe('when no code can be made', () => {
  test('a server failure is an alert in words, no code, and the button stays for another try', async () => {
    respond = () => problem(500);
    const view = renderPanel();
    await view.user.click(makeButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not make a code/i);
    expect(screen.queryByRole('group', { name: /your recovery code/i })).toBeNull();
    expect((makeButton() as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  test('trying again after a failure makes the code', async () => {
    respond = () => problem(500);
    const view = renderPanel();
    await view.user.click(makeButton());
    await screen.findByRole('alert');
    respond = () => json(issued(FIRST));
    await makeCode(view);
    expect(codeGroups()).toEqual(groupsOf(FIRST));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(posts()).toHaveLength(2);
  });

  test('a player with no plan yet (404) is told to set the plan up first', async () => {
    respond = () => problem(404);
    const view = renderPanel();
    await view.user.click(makeButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/set up your training plan first/i);
  });

  test('a network failure shows the shared offline wording', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const view = renderPanel();
    await view.user.click(makeButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(problemMessages.en.offline);
  });

  test('a reply that is not a code (nothing to show) is a failure, never an empty code block', async () => {
    respond = () => json({ createdAt: AT });
    const view = renderPanel();
    await view.user.click(makeButton());
    await screen.findByRole('alert');
    expect(screen.queryByRole('group', { name: /your recovery code/i })).toBeNull();
  });
});

// --- the code is never kept -----------------------------------------------------------------------------------------

describe('the code is never stored', () => {
  const allTexts = (code: string) => [code, ...groupsOf(code), code.replaceAll('-', '')];

  function storageDump(): string {
    const parts: string[] = [];
    for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? '';
        parts.push(key, storage.getItem(key) ?? '');
      }
    }
    return parts.join('\n');
  }

  test('not in localStorage or sessionStorage, and not written to either, at any point of the flow', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const local = spyOn(Storage.prototype, 'setItem');
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    await view.user.click(screen.getByRole('button', { name: /i wrote it down/i }));
    const written = local.mock.calls.map((call) => call.join(' ')).join('\n');
    local.mockRestore();
    for (const text of allTexts(FIRST)) {
      expect(written).not.toContain(text);
      expect(storageDump()).not.toContain(text);
    }
  });

  test('not in the query cache or the mutation cache while it is on screen, and not in what would be persisted', async () => {
    const view = renderPanel();
    await makeCode(view);
    expect(codeGroups()).toEqual(groupsOf(FIRST));
    const everything = JSON.stringify([
      view.queryClient.getQueryCache().getAll().map((query) => [query.queryKey, query.state]),
      view.queryClient.getMutationCache().getAll().map((mutation) => [mutation.options.mutationKey, mutation.state]),
      dehydrate(view.queryClient, { shouldDehydrateMutation: () => true, shouldDehydrateQuery: () => true }),
    ]);
    for (const text of allTexts(FIRST)) expect(everything).not.toContain(text);
    // No query at all is registered by the panel, so the persisted allow-list (lib/query-persist.ts) has nothing of it to keep.
    expect(view.queryClient.getQueryCache().getAll()).toEqual([]);
  });

  test('unmounting drops the code: nothing of it is left in the caches and a fresh panel starts empty', async () => {
    const view = renderPanel();
    await makeCode(view);
    view.unmount();
    const everything = JSON.stringify([
      view.queryClient.getQueryCache().getAll().map((query) => query.state),
      view.queryClient.getMutationCache().getAll().map((mutation) => mutation.state),
    ]);
    for (const text of allTexts(FIRST)) expect(everything).not.toContain(text);
    mount(view.queryClient, 'en');
    expect(screen.queryByRole('group', { name: /your recovery code/i })).toBeNull();
    expect(codeGroups()).toEqual([]);
    expect(makeButton()).toBeTruthy();
  });

  test('never written to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method).mockImplementation(() => {}));
    const view = renderPanel();
    await makeCode(view);
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    stubClipboard(async () => {
      throw new Error('denied');
    });
    await view.user.click(screen.getByRole('button', { name: /^copy code$/i }));
    await view.user.click(screen.getByRole('button', { name: /i wrote it down/i }));
    const logged = spies.map((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')).join('\n');
    for (const spy of spies) spy.mockRestore();
    for (const text of allTexts(FIRST)) expect(logged).not.toContain(text);
  });

  test('the panel source has no browser storage, no logging and no query of its own', async () => {
    const source = await Bun.file(join(import.meta.dir, 'panels/recovery.panel.tsx')).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|idb-keyval|document\.cookie/);
    expect(code).not.toMatch(/console\./);
    expect(code).not.toMatch(/useQuery\(|useSuspenseQuery\(|setQueryData/);
  });
});

// --- the slot -------------------------------------------------------------------------------------------------------

describe('the privacy-panel slot', () => {
  test('the panel module default-exports one component, which the slot collects next to another panel', () => {
    const OtherPanel = () => <p>other</p>;
    const components = collectSlot(
      {
        'privacy-panel': {
          '../features/privacy/panels/recovery.panel.tsx': { default: RecoveryPanel },
          '../features/privacy/panels/data.panel.tsx': { default: OtherPanel },
        },
      },
      'privacy-panel',
    );
    expect(components).toHaveLength(2);
    expect(components).toContain(RecoveryPanel);
    expect(components).toContain(OtherPanel);
  });
});

// --- languages ------------------------------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  for (const locale of LOCALES) {
    test(`${locale}: the heading, the warning and the one button are worded`, () => {
      renderPanel(locale);
      const text = messages[locale] as unknown as Record<string, string>;
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(text.title);
      expect(screen.getByText(text.replaceWarning as string)).toBeTruthy();
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([text.make]);
    });

    test(`${locale}: the code, copy and confirmation are worded`, async () => {
      const view = renderPanel(locale);
      const text = messages[locale] as unknown as Record<string, string>;
      await view.user.click(screen.getByRole('button', { name: text.make }));
      const block = await screen.findByRole('group', { name: text.codeTitle });
      expect(codeGroups()).toEqual(groupsOf(FIRST));
      expect(within(block).getByText(text.writeDown as string)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.copy })).toBeTruthy();
      await view.user.click(screen.getByRole('button', { name: text.confirm }));
      expect(screen.getByRole('status').textContent).toBe(text.hidden);
      expect(screen.getByRole('button', { name: text.makeAgain })).toBeTruthy();
    });
  }
});


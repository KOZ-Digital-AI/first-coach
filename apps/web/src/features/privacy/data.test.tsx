import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { collectSlot } from '../../lib/slots';
import messages from './data.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as privacy.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// The panel pulls in Radix Dialog, which decides at import time whether a DOM exists: import it only after happy-dom is up.
const panelModule = await import('./panels/data.panel');
const { DataPanel } = panelModule;

/*
 * The data controls panel (features/privacy/panels/data.panel.tsx, fc-mol-bjm.8), written from the bead's acceptance criteria:
 *  - offers "Download my data" (saves the export JSON of GET /api/player/export) and "Delete my data" (DELETE /api/player)
 *    behind a confirm dialog that requires typing the LOCALIZED word DELETE and states the consequence;
 *  - after a successful deletion every local store of that player (React Query cache, offline session, outbox, drafts) is
 *    cleared and the app goes to the landing page; a failed deletion changes nothing (error keeps data);
 *  - plugs into the privacy-panel slot without editing the screen or lib/slots.ts;
 *  - loading (in flight), error, disabled and success states; kk, ru and en.
 * Real data goes through the real typed client (lib/api.ts); the only stand-ins are the network (globalThis.fetch), the file
 * saver, the page navigation and IndexedDB (happy-dom has none). localStorage and sessionStorage are happy-dom's own.
 * Kazakh copy needs a native review; the Kazakh assertions read the bundle.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) -----------------------------------------------------------------------

const ID = 'player-1';
const OTHER = 'player-2';
const EXPORT_DOC = {
  exportedAt: '2026-09-21T10:00:00.000Z',
  playerId: ID,
  readme: { about: 'Everything stored about you.', sections: { player_profiles: 'Your profile.' } },
  tables: { player_profiles: [{ player_id: ID, age: 9 }] },
};
const EXPORT_NAME = 'first-coach-export-2026-09-21.json';

const KEY = {
  session: `fc:${ID}:session`,
  outbox: `fc:${ID}:outbox`,
  extra: `fc:${ID}:something-a-later-bead-added`,
  otherSession: `fc:${OTHER}:session`,
  last: 'fc:last-player',
  draft: 'fc:draft:contribute-form',
  onboarding: 'fc:onboarding-draft',
  unrelated: 'fc:unrelated',
};

// --- the network ------------------------------------------------------------------------------------------------------------

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

type Call = { method: string; path: string };
type Server = {
  export?: () => Response | Promise<Response>;
  del?: () => Response | Promise<Response>;
};

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function stubNetwork(server: Server = {}): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    if (url.pathname === '/api/player/export' && method === 'GET') return (server.export ?? (() => json(EXPORT_DOC)))();
    if (url.pathname === '/api/player' && method === 'DELETE') return (server.del ?? (() => new Response(null, { status: 204 })))();
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const exports_ = () => calls.filter((call) => call.method === 'GET' && call.path === '/api/player/export');
const deletes = () => calls.filter((call) => call.method === 'DELETE');

beforeEach(() => {
  stubNetwork();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  localStorage.clear();
  sessionStorage.clear();
});

// --- rendering --------------------------------------------------------------------------------------------------------------

const modules = {
  './data.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

type Saved = { name: string; blob: Blob };

/** The collaborators the panel needs besides the network; every one is a stand-in for a browser API. */
function makeDeps() {
  const saved: Saved[] = [];
  const log: string[] = [];
  const deleted: string[] = [];
  return {
    saved,
    log,
    deleted,
    deps: {
      saveFile: (name: string, blob: Blob) => void saved.push({ name, blob }),
      goHome: mock(() => void log.push('home')),
      resetSession: mock(() => void log.push('reset-session')),
      persistStore: {
        del: mock(async (key: string) => {
          deleted.push(key);
        }),
      },
    },
  };
}

function seedLocalData(): void {
  localStorage.setItem(KEY.session, '{"session":"x"}');
  localStorage.setItem(KEY.outbox, '[]');
  localStorage.setItem(KEY.extra, '1');
  localStorage.setItem(KEY.otherSession, '{"session":"other"}');
  localStorage.setItem(KEY.last, ID);
  localStorage.setItem(KEY.unrelated, 'keep');
  sessionStorage.setItem(KEY.draft, '{"savedAt":1,"value":"x"}');
  sessionStorage.setItem(KEY.onboarding, '{"v":1}');
  sessionStorage.setItem(KEY.unrelated, 'keep');
}

async function renderPanel(options: { locale?: Locale; playerId?: string | undefined; deps?: Record<string, unknown> } = {}) {
  const { locale = 'en', deps = {} } = options;
  // `playerId: undefined` means "could not be identified" (a default would swallow it).
  const playerId = 'playerId' in options ? options.playerId : ID;
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  queryClient.setQueryData(['me'], { age: 9 });
  queryClient.setQueryData(['today'], { id: 'session-1' });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <DataPanel playerId={playerId} deps={deps} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

const downloadButton = () => screen.getByRole('button', { name: 'Download my data' }) as HTMLButtonElement;
const deleteButton = () => screen.getByRole('button', { name: 'Delete my data' }) as HTMLButtonElement;
const dialogOf = () => screen.getByRole('dialog', { name: 'Delete all my data?' });
const confirmButton = () => within(dialogOf()).getByRole('button', { name: 'Yes, delete my data' }) as HTMLButtonElement;
const cancelButton = () => within(dialogOf()).getByRole('button', { name: 'Keep my data' }) as HTMLButtonElement;
const wordBox = (label: RegExp | string = 'Type DELETE to confirm') => within(dialogOf()).getByRole('textbox', { name: label }) as HTMLInputElement;

async function openDialog(user: User) {
  await user.click(deleteButton());
  return screen.findByRole('dialog', { name: 'Delete all my data?' });
}

async function typeWordAndConfirm(user: User, word = 'DELETE') {
  await user.type(wordBox(), word);
  await user.click(confirmButton());
}

const takeText = async (blob: Blob): Promise<string> => blob.text();

// --- the panel and the slot -------------------------------------------------------------------------------------------------

describe('the panel', () => {
  test('is a section named "Your data" with a Download and a Delete button, both real buttons', async () => {
    await renderPanel();
    expect(screen.getByRole('heading', { level: 2, name: 'Your data' })).toBeTruthy();
    expect(downloadButton().tagName).toBe('BUTTON');
    expect(deleteButton().tagName).toBe('BUTTON');
    expect(downloadButton().disabled).toBe(false);
    expect(deleteButton().disabled).toBe(false);
  });

  test('sends nothing until a button is pressed', async () => {
    await renderPanel();
    expect(calls).toEqual([]);
  });

  test('registers itself in the privacy-panel slot: the module default-exports a component that the slot collects', () => {
    expect(typeof panelModule.default).toBe('function');
    const collected = collectSlot({ 'privacy-panel': { '../features/privacy/panels/data.panel.tsx': panelModule } }, 'privacy-panel');
    expect(collected).toEqual([panelModule.default]);
  });
});

// --- download ---------------------------------------------------------------------------------------------------------------

describe('Download my data', () => {
  test('reads GET /api/player/export once and saves its JSON as first-coach-export-<date>.json', async () => {
    const { deps, saved } = makeDeps();
    const { user } = await renderPanel({ deps });
    await user.click(downloadButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(exports_()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(saved[0]!.name).toBe(EXPORT_NAME);
    expect(saved[0]!.blob.type).toBe('application/json');
    expect(JSON.parse(await takeText(saved[0]!.blob))).toEqual(EXPORT_DOC);
  });

  test('says the file was saved, by name, in a status', async () => {
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await user.click(downloadButton());
    const status = await screen.findByText(new RegExp(EXPORT_NAME.replaceAll('.', '\\.')));
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(downloadButton().disabled).toBe(false);
  });

  test('is disabled and busy while the file is being prepared, announces it, and a second press sends nothing', async () => {
    const gate = deferred<Response>();
    stubNetwork({ export: () => gate.promise });
    const { deps, saved } = makeDeps();
    const { user } = await renderPanel({ deps });
    void user.click(downloadButton());
    await waitFor(() => expect(exports_()).toHaveLength(1));
    expect(downloadButton().disabled).toBe(true);
    expect(downloadButton().getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Preparing your file…').closest('[role="status"]')).not.toBeNull();
    await user.click(downloadButton());
    expect(exports_()).toHaveLength(1);
    expect(saved).toEqual([]);

    gate.resolve(json(EXPORT_DOC));
    await waitFor(() => expect(saved).toHaveLength(1));
    await waitFor(() => expect(downloadButton().disabled).toBe(false));
    expect(downloadButton().getAttribute('aria-busy')).toBeNull();
  });

  test('a failed export says so in an alert, saves nothing, and pressing again retries', async () => {
    let fail = true;
    stubNetwork({ export: () => (fail ? problem(500) : json(EXPORT_DOC)) });
    const { deps, saved } = makeDeps();
    const { user } = await renderPanel({ deps });
    await user.click(downloadButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The file could not be made');
    expect(alert.textContent).toContain(problemMessages.en.server);
    expect(saved).toEqual([]);
    expect(downloadButton().disabled).toBe(false);

    fail = false;
    await user.click(downloadButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a network failure is reported in words, not raw', async () => {
    stubNetwork({
      export: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await user.click(downloadButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('Failed to fetch');
    expect(alert.textContent).toContain('The file could not be made');
  });

  test('never deletes or clears anything', async () => {
    seedLocalData();
    const { deps, deleted } = makeDeps();
    const { user, queryClient } = await renderPanel({ deps });
    await user.click(downloadButton());
    await screen.findByText(new RegExp(EXPORT_NAME.replaceAll('.', '\\.')));
    expect(deletes()).toEqual([]);
    expect(deleted).toEqual([]);
    expect(localStorage.getItem(KEY.session)).not.toBeNull();
    expect(sessionStorage.getItem(KEY.draft)).not.toBeNull();
    expect(queryClient.getQueryData(['me'])).toBeDefined();
    expect(deps.goHome).not.toHaveBeenCalled();
  });

  test('the default saver hands the JSON to the browser as a download link named after the file', async () => {
    const blobs: Blob[] = [];
    const links: { download: string; href: string }[] = [];
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return 'blob:first-coach-test';
    };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      links.push({ download: this.download, href: this.getAttribute('href') ?? '' });
    };
    try {
      const { user } = await renderPanel();
      await user.click(downloadButton());
      await waitFor(() => expect(links).toHaveLength(1));
      expect(links[0]).toEqual({ download: EXPORT_NAME, href: 'blob:first-coach-test' });
      expect(blobs[0]!.type).toBe('application/json');
      expect(JSON.parse(await takeText(blobs[0]!))).toEqual(EXPORT_DOC);
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }
  });
});

// --- the confirm gate -------------------------------------------------------------------------------------------------------

describe('Delete my data: the confirm gate', () => {
  test('pressing it only opens a dialog: nothing is sent', async () => {
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    expect(deletes()).toEqual([]);
    expect(deps.goHome).not.toHaveBeenCalled();
  });

  test('the dialog states the consequence: data and account erased, cannot be undone', async () => {
    const { user } = await renderPanel();
    const dialog = await openDialog(user);
    const words = (dialog.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(words).toMatch(/erases/i);
    expect(words).toMatch(/data/i);
    expect(words).toMatch(/account/i);
    expect(words).toMatch(/cannot be undone/i);
  });

  test('the safe button, "Keep my data", has the focus when the dialog opens', async () => {
    const { user } = await renderPanel();
    await openDialog(user);
    // A boolean, not toBe(element): a failing toBe would try to print two whole DOM trees.
    await waitFor(() => expect(document.activeElement === cancelButton()).toBe(true));
  });

  test('the confirm button is off until the word DELETE is typed, and the field is a labelled textbox', async () => {
    const { user } = await renderPanel();
    await openDialog(user);
    expect(wordBox().value).toBe('');
    expect(confirmButton().disabled).toBe(true);
    await user.type(wordBox(), 'DELET');
    expect(confirmButton().disabled).toBe(true);
    await user.type(wordBox(), 'E');
    expect(confirmButton().disabled).toBe(false);
  });

  test('another word does not open the gate, and Enter with the wrong word sends nothing', async () => {
    const { user } = await renderPanel();
    await openDialog(user);
    await user.type(wordBox(), 'REMOVE{Enter}');
    expect(confirmButton().disabled).toBe(true);
    await user.clear(wordBox());
    await user.type(wordBox(), 'DELET{Enter}');
    expect(deletes()).toEqual([]);
  });

  test('a submit of the form with the wrong word sends nothing: the guard does not lean on the disabled button', async () => {
    const { user } = await renderPanel();
    const dialog = await openDialog(user);
    await user.type(wordBox(), 'DELET');
    fireEvent.submit(dialog.querySelector('form')!);
    fireEvent.submit(dialog.querySelector('form')!);
    expect(deletes()).toEqual([]);
  });

  test('the word is matched without regard to case or surrounding spaces', async () => {
    const { user } = await renderPanel();
    await openDialog(user);
    await user.type(wordBox(), '  delete ');
    expect(confirmButton().disabled).toBe(false);
  });

  test('Keep my data closes the dialog, sends nothing, and reopening starts with an empty field', async () => {
    const { user } = await renderPanel();
    await openDialog(user);
    await user.type(wordBox(), 'DELETE');
    await user.click(cancelButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes()).toEqual([]);
    await openDialog(user);
    expect(wordBox().value).toBe('');
    expect(confirmButton().disabled).toBe(true);
  });

  test('Escape closes it too, and nothing is sent', async () => {
    const { user } = await renderPanel();
    await openDialog(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes()).toEqual([]);
  });

  test('typing the word and confirming sends DELETE /api/player once', async () => {
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalledTimes(1));
    expect(deletes()).toEqual([{ method: 'DELETE', path: '/api/player' }]);
  });

  test('pressing Enter in the field with the right word confirms', async () => {
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await user.type(wordBox(), 'DELETE{Enter}');
    await waitFor(() => expect(deps.goHome).toHaveBeenCalledTimes(1));
    expect(deletes()).toHaveLength(1);
  });
});

// --- in flight --------------------------------------------------------------------------------------------------------------

describe('while the deletion is in flight', () => {
  test('every control is disabled, the confirm is busy, Escape does not close, and nothing is cleared or sent twice', async () => {
    seedLocalData();
    const gate = deferred<Response>();
    stubNetwork({ del: () => gate.promise });
    const { deps, deleted } = makeDeps();
    const { user, queryClient } = await renderPanel({ deps });
    await openDialog(user);
    await user.type(wordBox(), 'DELETE');
    void user.click(confirmButton());
    await waitFor(() => expect(deletes()).toHaveLength(1));

    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().getAttribute('aria-busy')).toBe('true');
    expect(cancelButton().disabled).toBe(true);
    expect(wordBox().disabled).toBe(true);
    expect(within(dialogOf()).getByText('Deleting…').closest('[role="status"]')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await user.click(confirmButton());
    expect(deletes()).toHaveLength(1);

    // Nothing local goes until the server has said 204.
    expect(localStorage.getItem(KEY.session)).not.toBeNull();
    expect(sessionStorage.getItem(KEY.draft)).not.toBeNull();
    expect(queryClient.getQueryData(['me'])).toBeDefined();
    expect(deleted).toEqual([]);
    expect(deps.goHome).not.toHaveBeenCalled();

    gate.resolve(new Response(null, { status: 204 }));
    await waitFor(() => expect(deps.goHome).toHaveBeenCalledTimes(1));
  });
});

// --- success ----------------------------------------------------------------------------------------------------------------

describe('after a successful deletion (204)', () => {
  test('the React Query cache is emptied', async () => {
    const { deps } = makeDeps();
    const { user, queryClient } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalled());
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });

  test("the player's offline session, outbox and every other fc:<player>:* key leave localStorage; other keys stay", async () => {
    seedLocalData();
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalled());
    expect(localStorage.getItem(KEY.session)).toBeNull();
    expect(localStorage.getItem(KEY.outbox)).toBeNull();
    expect(localStorage.getItem(KEY.extra)).toBeNull();
    // Another player of the same device, and keys that are nobody's, are not touched.
    expect(localStorage.getItem(KEY.otherSession)).toBe('{"session":"other"}');
    expect(localStorage.getItem(KEY.unrelated)).toBe('keep');
  });

  test('the remembered "last player" goes only when it is this player', async () => {
    seedLocalData();
    const first = makeDeps();
    const { user } = await renderPanel({ deps: first.deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(first.deps.goHome).toHaveBeenCalled());
    expect(localStorage.getItem(KEY.last)).toBeNull();

    cleanup();
    localStorage.setItem(KEY.last, OTHER);
    const second = makeDeps();
    const again = await renderPanel({ deps: second.deps });
    await openDialog(again.user);
    await typeWordAndConfirm(again.user);
    await waitFor(() => expect(second.deps.goHome).toHaveBeenCalled());
    expect(localStorage.getItem(KEY.last)).toBe(OTHER);
  });

  test('the persisted query cache and the outbox of THIS player are removed from IndexedDB, and only those', async () => {
    const { deps, deleted } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalled());
    expect([...deleted].sort()).toEqual([`fc:${ID}:outbox`, `fc:${ID}:query-cache`]);
  });

  test('the drafts (fc:draft:* and the onboarding draft) leave sessionStorage; other keys stay', async () => {
    seedLocalData();
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalled());
    expect(sessionStorage.getItem(KEY.draft)).toBeNull();
    expect(sessionStorage.getItem(KEY.onboarding)).toBeNull();
    expect(sessionStorage.getItem(KEY.unrelated)).toBe('keep');
  });

  test('the remembered player session is forgotten, so the next visit re-reads the (cleared) cookie', async () => {
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalled());
    expect(deps.resetSession).toHaveBeenCalledTimes(1);
  });

  test('all of it is gone BEFORE the app goes to the landing page, which is then opened exactly once', async () => {
    seedLocalData();
    const { deps, deleted } = makeDeps();
    let snapshot: { session: string | null; draft: string | null; deleted: string[]; cache: number } | undefined;
    const { user, queryClient } = await renderPanel({
      deps: {
        ...deps,
        goHome: mock(() => {
          snapshot = {
            session: localStorage.getItem(KEY.session),
            draft: sessionStorage.getItem(KEY.draft),
            deleted: [...deleted].sort(),
            cache: queryClient.getQueryCache().getAll().length,
          };
        }),
      },
    });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(snapshot).toBeDefined());
    expect(snapshot).toEqual({ session: null, draft: null, deleted: [`fc:${ID}:query-cache`, `fc:${ID}:outbox`].sort(), cache: 0 });
  });

  test('says it is done, in a status, while the app goes home', async () => {
    const { deps } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    const done = await screen.findByText('Deleted. Taking you to the start page…');
    expect(done.closest('[role="status"]')).not.toBeNull();
    expect(deps.goHome).toHaveBeenCalledTimes(1);
  });

  test('a store that cannot be cleared does not keep the player from leaving', async () => {
    const { deps } = makeDeps();
    deps.persistStore.del = mock(async () => {
      throw new Error('IndexedDB is blocked');
    });
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalledTimes(1));
  });

  test('a player who could not be identified still loses the cache and the drafts, and no IndexedDB key is guessed', async () => {
    seedLocalData();
    const { deps, deleted } = makeDeps();
    const { user, queryClient } = await renderPanel({ deps, playerId: undefined });
    await openDialog(user);
    await typeWordAndConfirm(user);
    await waitFor(() => expect(deps.goHome).toHaveBeenCalled());
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(sessionStorage.getItem(KEY.draft)).toBeNull();
    expect(deleted).toEqual([]);
    expect(localStorage.getItem(KEY.session)).not.toBeNull();
  });
});

// --- failure ----------------------------------------------------------------------------------------------------------------

describe('when the deletion fails, nothing is lost', () => {
  async function failDeletion(response: () => Response) {
    seedLocalData();
    stubNetwork({ del: response });
    const made = makeDeps();
    const view = await renderPanel({ deps: made.deps });
    await openDialog(view.user);
    await typeWordAndConfirm(view.user);
    await screen.findByRole('alert');
    return { ...made, ...view };
  }

  test('a server error keeps every local store and the cache, and does not leave the page', async () => {
    const { deps, deleted, queryClient } = await failDeletion(() => problem(500));
    expect(localStorage.getItem(KEY.session)).not.toBeNull();
    expect(localStorage.getItem(KEY.outbox)).not.toBeNull();
    expect(localStorage.getItem(KEY.last)).toBe(ID);
    expect(sessionStorage.getItem(KEY.draft)).not.toBeNull();
    expect(sessionStorage.getItem(KEY.onboarding)).not.toBeNull();
    expect(queryClient.getQueryData(['me'])).toBeDefined();
    expect(deleted).toEqual([]);
    expect(deps.resetSession).not.toHaveBeenCalled();
    expect(deps.goHome).not.toHaveBeenCalled();
  });

  test('says in words that the data was not deleted, shows the generic reason, and keeps the dialog open', async () => {
    await failDeletion(() => problem(500));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Your data was not deleted');
    expect(alert.textContent).toContain(problemMessages.en.server);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(screen.queryByText('Deleted. Taking you to the start page…')).toBeNull();
  });

  test('a network failure keeps the data too', async () => {
    const { deps, deleted } = await failDeletion(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(localStorage.getItem(KEY.session)).not.toBeNull();
    expect(deleted).toEqual([]);
    expect(deps.goHome).not.toHaveBeenCalled();
  });

  test('the controls come back, the typed word stays, the focus lands on the message, and trying again works', async () => {
    let fail = true;
    seedLocalData();
    stubNetwork({ del: () => (fail ? problem(500) : new Response(null, { status: 204 })) });
    const { deps, deleted } = makeDeps();
    const { user } = await renderPanel({ deps });
    await openDialog(user);
    await typeWordAndConfirm(user);
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement === alert).toBe(true));
    expect(confirmButton().disabled).toBe(false);
    expect(confirmButton().getAttribute('aria-busy')).toBeNull();
    expect(cancelButton().disabled).toBe(false);
    expect(wordBox().disabled).toBe(false);
    expect(wordBox().value).toBe('DELETE');

    fail = false;
    await user.click(confirmButton());
    await waitFor(() => expect(deps.goHome).toHaveBeenCalledTimes(1));
    expect(deletes()).toHaveLength(2);
    expect(localStorage.getItem(KEY.session)).toBeNull();
    expect(deleted.length).toBe(2);
  });
});

// --- languages --------------------------------------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  for (const locale of LOCALES) {
    test(`${locale}: the panel, the dialog and the word come from the bundle`, async () => {
      const bundle = messages[locale];
      const { user } = await renderPanel({ locale });
      expect(screen.getByRole('heading', { level: 2, name: bundle.title })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: bundle.delete.button }));
      const dialog = await screen.findByRole('dialog', { name: bundle.dialog.title });
      expect(within(dialog).getByText(bundle.dialog.body)).toBeTruthy();
      const box = within(dialog).getByRole('textbox', { name: bundle.dialog.label.replace('{{word}}', bundle.dialog.word) });
      const confirm = within(dialog).getByRole('button', { name: bundle.dialog.confirm }) as HTMLButtonElement;
      expect(within(dialog).getByRole('button', { name: bundle.dialog.cancel })).toBeTruthy();
      expect(confirm.disabled).toBe(true);
      await user.type(box, bundle.dialog.word);
      expect(confirm.disabled).toBe(false);
    });
  }

  test('the word is different in kk, ru and en, and DELETE does not open the gate in ru or kk', async () => {
    expect(new Set(LOCALES.map((locale) => messages[locale].dialog.word)).size).toBe(LOCALES.length);
    expect(messages.en.dialog.word).toBe('DELETE');
    for (const locale of ['ru', 'kk'] as const) {
      cleanup();
      const bundle = messages[locale];
      const { user } = await renderPanel({ locale });
      await user.click(screen.getByRole('button', { name: bundle.delete.button }));
      const dialog = await screen.findByRole('dialog', { name: bundle.dialog.title });
      await user.type(within(dialog).getByRole('textbox'), 'DELETE');
      expect((within(dialog).getByRole('button', { name: bundle.dialog.confirm }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  test('the download says its progress and its failure in the language too (ru)', async () => {
    stubNetwork({ export: () => problem(500) });
    const bundle = messages.ru;
    const { user } = await renderPanel({ locale: 'ru', deps: makeDeps().deps });
    await user.click(screen.getByRole('button', { name: bundle.download.button }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(bundle.download.failed.title);
    expect(alert.textContent).toContain(problemMessages.ru.server);
  });
});

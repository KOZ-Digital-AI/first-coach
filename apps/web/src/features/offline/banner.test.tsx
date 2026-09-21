import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ComponentProps, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, type LOCALES } from '../../lib/i18n';
import { collectSlot } from '../../lib/slots';
import bannerMessages from './banner.messages';
import * as rootExtraModule from './root-extra';
import RootExtra, { ConnectivityBanner } from './root-extra';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as features/shell/shell.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];

const OFFLINE_EN = 'You are offline — training still works';
const RESTORED_EN = 'Back online — syncing';
/** Short hold time for the tests about dismissal; every other test uses a hold so long it never fires. */
const DISMISS_MS = 20;
const NEVER_MS = 60_000;

// --- rig -----------------------------------------------------------------------------------------------------------------

let onLine = true;

beforeEach(() => {
  onLine = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
});

afterEach(() => {
  cleanup();
  // Remove the instance override so the next test file sees happy-dom's own value.
  delete (navigator as { onLine?: boolean }).onLine;
});

const noStorage = { getItem: () => null, setItem: () => {} };

function withI18n(locale: Locale, children: ReactNode) {
  const instance = createI18n({
    modules: { './banner.messages.ts': { default: bannerMessages } },
    languages: [locale],
    storage: noStorage,
    root: { lang: '' },
    dev: false,
  });
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

/** A flush the test settles by hand, so "after the flush" is observable. */
function deferredFlush() {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const flush = mock(() => promise);
  return { flush, resolve, reject };
}

const instantFlush = () => mock(() => Promise.resolve());

function renderBanner(props: Partial<ComponentProps<typeof ConnectivityBanner>> = {}, locale: Locale = 'en') {
  return render(withI18n(locale, <ConnectivityBanner flush={instantFlush()} dismissAfterMs={NEVER_MS} {...props} />));
}

const goOffline = () =>
  act(() => {
    onLine = false;
    window.dispatchEvent(new Event('offline'));
  });
const goOnline = () =>
  act(() => {
    onLine = true;
    window.dispatchEvent(new Event('online'));
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Lets a dismissal timer fire INSIDE act, so React flushes its state update before the assertion (no polling, no act warning). */
const afterHold = () => act(() => sleep(DISMISS_MS * 8));

// --- tests ---------------------------------------------------------------------------------------------------------------

describe('connectivity banner', () => {
  test('shows nothing while the browser is online', () => {
    renderBanner();
    expect(screen.queryByText(OFFLINE_EN)).toBeNull();
    expect(screen.queryByText(RESTORED_EN)).toBeNull();
  });

  test('an offline event shows the offline message', async () => {
    renderBanner();
    await goOffline();
    expect(screen.getByText(OFFLINE_EN)).toBeTruthy();
  });

  test('mounting while navigator is already offline shows the offline message', async () => {
    onLine = false;
    renderBanner();
    expect(await screen.findByText(OFFLINE_EN)).toBeTruthy();
  });

  test('an online event after being offline replaces the offline message with the back-online one', async () => {
    renderBanner();
    await goOffline();
    await goOnline();
    expect(screen.queryByText(OFFLINE_EN)).toBeNull();
    expect(screen.getByText(RESTORED_EN)).toBeTruthy();
  });

  test('an online event without a preceding offline shows nothing and flushes nothing', async () => {
    const flush = instantFlush();
    renderBanner({ flush });
    await goOnline();
    expect(screen.queryByText(OFFLINE_EN)).toBeNull();
    expect(screen.queryByText(RESTORED_EN)).toBeNull();
    expect(flush).not.toHaveBeenCalled();
  });

  test('coming back online flushes the outbox exactly once', async () => {
    const flush = instantFlush();
    renderBanner({ flush });
    await goOffline();
    expect(flush).not.toHaveBeenCalled();
    await goOnline();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test('the back-online confirmation stays until the flush settles, then goes away after the hold time', async () => {
    const { flush, resolve } = deferredFlush();
    renderBanner({ flush, dismissAfterMs: DISMISS_MS });
    await goOffline();
    await goOnline();
    await afterHold();
    expect(screen.getByText(RESTORED_EN)).toBeTruthy(); // flush still in flight: still "syncing"
    await act(async () => resolve());
    expect(screen.getByText(RESTORED_EN)).toBeTruthy(); // brief: not removed the instant the flush settles
    await afterHold();
    expect(screen.queryByText(RESTORED_EN)).toBeNull();
  });

  test('by default the confirmation stays visible for a few seconds after the flush settles, not just an instant', async () => {
    render(withI18n('en', <ConnectivityBanner flush={instantFlush()} />));
    await goOffline();
    await goOnline();
    await act(() => sleep(150));
    expect(screen.getByText(RESTORED_EN)).toBeTruthy();
  });

  test('a flush that rejects (no player yet, storage failure) neither crashes nor leaves the confirmation stuck', async () => {
    const { flush, reject } = deferredFlush();
    renderBanner({ flush, dismissAfterMs: DISMISS_MS });
    await goOffline();
    await goOnline();
    await act(async () => reject(new Error('outbox: call configureOutbox({ playerId }) before using the outbox')));
    await afterHold();
    expect(screen.queryByText(RESTORED_EN)).toBeNull();
    expect(screen.queryByText(OFFLINE_EN)).toBeNull();
  });

  test('going offline again while syncing shows the offline message and a late flush does not hide it', async () => {
    const { flush, resolve } = deferredFlush();
    renderBanner({ flush, dismissAfterMs: DISMISS_MS });
    await goOffline();
    await goOnline();
    await goOffline();
    expect(screen.getByText(OFFLINE_EN)).toBeTruthy();
    expect(screen.queryByText(RESTORED_EN)).toBeNull();
    await act(async () => resolve());
    await afterHold();
    expect(screen.getByText(OFFLINE_EN)).toBeTruthy();
  });

  test('a second offline/online cycle works again', async () => {
    const flush = instantFlush();
    renderBanner({ flush, dismissAfterMs: DISMISS_MS });
    await goOffline();
    await goOnline();
    await afterHold();
    expect(screen.queryByText(RESTORED_EN)).toBeNull();
    await goOffline();
    expect(screen.getByText(OFFLINE_EN)).toBeTruthy();
    await goOnline();
    expect(screen.getByText(RESTORED_EN)).toBeTruthy();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  test('stops listening when unmounted', async () => {
    const flush = instantFlush();
    const { unmount } = renderBanner({ flush });
    await goOffline();
    unmount();
    await goOnline();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('connectivity banner accessibility', () => {
  test('one polite status region is in the page before anything is announced, and it is never an alert', async () => {
    renderBanner();
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    await goOffline();
    expect(screen.getByRole('status')).toBe(region); // same node: the change is announced, not a new mount
    expect(region.textContent).toContain(OFFLINE_EN);
    await goOnline();
    expect(region.textContent).toContain(RESTORED_EN);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('state is never colour alone: each message comes with a decorative icon and its words', async () => {
    renderBanner();
    await goOffline();
    const region = screen.getByRole('status');
    expect(region.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const offlineIcon = region.querySelector('svg')?.outerHTML;
    await goOnline();
    expect(region.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(region.querySelector('svg')?.outerHTML).not.toBe(offlineIcon); // a different shape, not only a different tint
  });

  test('is non-blocking: no dialog, no interactive controls, not fixed over the page', async () => {
    const { container } = renderBanner();
    await goOffline();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelectorAll('button, a, input, [tabindex]').length).toBe(0);
    expect(container.querySelector('.fixed, .absolute, .sticky')).toBeNull();
  });
});

describe('connectivity banner languages', () => {
  test.each(['kk', 'ru', 'en'] as const)('%s: both messages come from the message file', async (locale) => {
    renderBanner({}, locale);
    await goOffline();
    expect(screen.getByText(bannerMessages[locale].offline)).toBeTruthy();
    await goOnline();
    expect(screen.getByText(bannerMessages[locale].restored)).toBeTruthy();
  });

  test('the English copy is the one in the acceptance criteria', () => {
    expect(bannerMessages.en.offline).toBe(OFFLINE_EN);
    expect(bannerMessages.en.restored).toBe(RESTORED_EN);
  });

  test('the three languages are all written out and differ from each other', () => {
    const offline = new Set([bannerMessages.kk.offline, bannerMessages.ru.offline, bannerMessages.en.offline]);
    const restored = new Set([bannerMessages.kk.restored, bannerMessages.ru.restored, bannerMessages.en.restored]);
    expect(offline.size).toBe(3);
    expect(restored.size).toBe(3);
  });
});

describe('root slot module', () => {
  test('default-exports one component that the root slot collects', () => {
    expect(typeof RootExtra).toBe('function');
    const collected = collectSlot({ root: { '../features/offline/root-extra.tsx': rootExtraModule } }, 'root');
    expect(collected).toEqual([RootExtra]);
  });

  test('the default export renders inside the app i18n provider without props and shows the offline message', async () => {
    render(withI18n('en', <RootExtra />));
    await goOffline();
    expect(screen.getByText(OFFLINE_EN)).toBeTruthy();
  });
});

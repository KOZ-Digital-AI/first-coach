import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { ComponentProps, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, type LOCALES } from '../../lib/i18n';
import { resolveBuildVersion } from '../../lib/query-persist';
import { collectSlot } from '../../lib/slots';
import * as rootExtraModule from './root-extra';
import RootExtra, { getBuildVersion, UpdatePrompt } from './root-extra';
import updateMessages from './update.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as features/offline/banner.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];
type RegisterProp = NonNullable<ComponentProps<typeof UpdatePrompt>['register']>;
type Callbacks = Parameters<RegisterProp>[0];

const PROMPT_EN = 'New version available';
const UPDATE_EN = 'Update';
const LATER_EN = 'Later';
const FAILED_EN = 'Could not update. Try again.';

// --- rig -----------------------------------------------------------------------------------------------------------------
// The `virtual:pwa-register` module only exists inside a vite build. The component takes it through the `register` prop, so
// no test here (and nothing it imports) ever touches that module: the seam is a plain function the test drives by hand.

afterEach(() => cleanup());

const noStorage = { getItem: () => null, setItem: () => {} };

function withI18n(locale: Locale, children: ReactNode) {
  const instance = createI18n({
    modules: { './update.messages.ts': { default: updateMessages } },
    languages: [locale],
    storage: noStorage,
    root: { lang: '' },
    dev: false,
  });
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

/** A stand-in for registerSW: records the callbacks it was given and hands back `updateServiceWorker`. */
function rig(updateServiceWorker: (reloadPage?: boolean) => Promise<void> = () => Promise.resolve()) {
  let callbacks: Callbacks | undefined;
  const update = mock(updateServiceWorker);
  const register = mock<RegisterProp>((cb) => {
    callbacks = cb;
    return update;
  });
  return {
    register,
    update,
    /** What the service-worker script does when a new worker is installed and waiting. */
    needRefresh: () =>
      act(() => {
        callbacks?.onNeedRefresh?.();
      }),
  };
}

function renderPrompt(props: Partial<ComponentProps<typeof UpdatePrompt>> = {}, locale: Locale = 'en') {
  return render(withI18n(locale, <UpdatePrompt version="build-1" {...props} />));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const updateButton = () => screen.getByRole('button', { name: UPDATE_EN });
const laterButton = () => screen.getByRole('button', { name: LATER_EN });

// --- the acceptance criteria -----------------------------------------------------------------------------------------------

describe('update prompt', () => {
  test('registers the service worker once when it mounts, and shows nothing until a new version is waiting', async () => {
    const { register } = rig();
    renderPrompt({ register });
    await act(() => sleep(0));
    expect(register).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PROMPT_EN)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('needRefresh shows the "New version available" prompt with an Update button', async () => {
    const r = rig();
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    await r.needRefresh();
    expect(screen.getByText(PROMPT_EN)).toBeTruthy();
    expect(updateButton()).toBeTruthy();
  });

  test('accepting calls updateServiceWorker(true), exactly once', async () => {
    const r = rig();
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    await r.needRefresh();
    await act(async () => {
      fireEvent.click(updateButton());
    });
    expect(r.update).toHaveBeenCalledTimes(1);
    expect(r.update).toHaveBeenCalledWith(true);
  });

  test('a registration that resolves asynchronously (a lazily imported module) works the same', async () => {
    const r = rig();
    const lazy = mock<RegisterProp>(async (cb) => {
      await sleep(5);
      return r.register(cb);
    });
    renderPrompt({ register: lazy });
    await act(() => sleep(30));
    await r.needRefresh();
    await act(async () => {
      fireEvent.click(updateButton());
    });
    expect(r.update).toHaveBeenCalledWith(true);
  });

  test('never reloads or updates on its own: a waiting version alone calls nothing', async () => {
    const r = rig();
    const reload = mock(() => {});
    const original = window.location.reload;
    Object.defineProperty(window.location, 'reload', { configurable: true, value: reload });
    try {
      renderPrompt({ register: r.register });
      await act(() => sleep(0));
      await r.needRefresh();
      await act(() => sleep(60));
      expect(screen.getByText(PROMPT_EN)).toBeTruthy(); // still there, still waiting for the person
      expect(r.update).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.location, 'reload', { configurable: true, value: original });
    }
  });

  test('Later dismisses the prompt without updating; a newer waiting version shows it again', async () => {
    const r = rig();
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    await r.needRefresh();
    await act(async () => {
      fireEvent.click(laterButton());
    });
    expect(screen.queryByText(PROMPT_EN)).toBeNull();
    expect(r.update).not.toHaveBeenCalled();
    await r.needRefresh();
    expect(screen.getByText(PROMPT_EN)).toBeTruthy();
  });

  test('while updating the Update button is disabled and busy, so a second tap cannot send a second update', async () => {
    let finish: () => void = () => {};
    const r = rig(() => new Promise<void>((resolve) => (finish = resolve)));
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    await r.needRefresh();
    await act(async () => {
      fireEvent.click(updateButton());
    });
    const button = updateButton() as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(r.update).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  test('a failed update says so, in words, and can be tried again', async () => {
    let attempt = 0;
    const r = rig(() => (++attempt === 1 ? Promise.reject(new Error('skipWaiting failed')) : Promise.resolve()));
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    await r.needRefresh();
    await act(async () => {
      fireEvent.click(updateButton());
    });
    expect(screen.getByText(FAILED_EN)).toBeTruthy();
    expect((updateButton() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(updateButton());
    });
    expect(r.update).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(FAILED_EN)).toBeNull();
  });

  test('a registration that fails (no service worker support, blocked script) neither crashes nor shows a prompt', async () => {
    const rejecting = mock<RegisterProp>(() => Promise.reject(new Error('no service worker')));
    renderPrompt({ register: rejecting });
    await act(() => sleep(10));
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PROMPT_EN)).toBeNull();

    const throwing = mock<RegisterProp>(() => {
      throw new Error('virtual module missing');
    });
    renderPrompt({ register: throwing });
    await act(() => sleep(10));
    expect(screen.queryByText(PROMPT_EN)).toBeNull();
  });

  test('a callback that arrives after unmount changes nothing and does not throw', async () => {
    const r = rig();
    const { container, unmount } = renderPrompt({ register: r.register });
    await act(() => sleep(0));
    unmount();
    await r.needRefresh();
    expect(container.textContent).toBe('');
  });
});

describe('update prompt accessibility', () => {
  test('one polite status region is in the page before anything is announced, and it is never an alert', async () => {
    const r = rig();
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    await r.needRefresh();
    expect(screen.getByRole('status')).toBe(region); // same node: the change is announced, not a new mount
    expect(region.textContent).toContain(PROMPT_EN);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('never interrupts a drill: no dialog, focus stays where it was, not fixed or absolute over the page', async () => {
    const r = rig();
    const { container } = render(
      withI18n(
        'en',
        <>
          <button type="button">Next step</button>
          <UpdatePrompt register={r.register} version="build-1" />
        </>,
      ),
    );
    const drillControl = screen.getByRole('button', { name: 'Next step' });
    drillControl.focus();
    await act(() => sleep(0));
    await r.needRefresh();
    expect(document.activeElement).toBe(drillControl);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.fixed, .absolute, .sticky, [aria-modal]')).toBeNull();
  });

  test('state is never colour alone: a decorative icon comes with the words', async () => {
    const r = rig();
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    await r.needRefresh();
    const region = screen.getByRole('status');
    expect(region.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(region.textContent).toContain(PROMPT_EN);
  });

  test('both actions are real buttons with a 44px minimum touch target', async () => {
    const r = rig();
    renderPrompt({ register: r.register });
    await act(() => sleep(0));
    await r.needRefresh();
    for (const button of [updateButton(), laterButton()]) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.className).toContain('min-h-tap');
    }
  });
});

describe('build version', () => {
  test('the prompt shows the build version it was given', async () => {
    const r = rig();
    renderPrompt({ register: r.register, version: 'abc1234' });
    await act(() => sleep(0));
    await r.needRefresh();
    expect(screen.getByRole('status').textContent).toContain('abc1234');
  });

  test('getBuildVersion() is the build version resolved by lib/query-persist (the same value the cache buster uses)', () => {
    expect(getBuildVersion()).toBe(resolveBuildVersion());
    expect(getBuildVersion().length).toBeGreaterThan(0);
  });
});

describe('update prompt languages', () => {
  test.each(['kk', 'ru', 'en'] as const)('%s: prompt, actions and the failure message come from the message file', async (locale) => {
    let attempt = 0;
    const r = rig(() => (++attempt === 1 ? Promise.reject(new Error('x')) : Promise.resolve()));
    renderPrompt({ register: r.register }, locale);
    await act(() => sleep(0));
    await r.needRefresh();
    expect(screen.getByText(updateMessages[locale].available)).toBeTruthy();
    expect(screen.getByRole('button', { name: updateMessages[locale].update })).toBeTruthy();
    expect(screen.getByRole('button', { name: updateMessages[locale].later })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: updateMessages[locale].update }));
    });
    expect(screen.getByText(updateMessages[locale].failed)).toBeTruthy();
  });

  test('the English copy is the one in the acceptance criteria', () => {
    expect(updateMessages.en.available).toBe(PROMPT_EN);
    expect(updateMessages.en.update).toBe(UPDATE_EN);
    expect(updateMessages.en.later).toBe(LATER_EN);
    expect(updateMessages.en.failed).toBe(FAILED_EN);
  });

  test('the three languages are all written out and differ from each other', () => {
    for (const key of ['available', 'update', 'later', 'failed', 'reloadHint'] as const) {
      const values = new Set([updateMessages.kk[key], updateMessages.ru[key], updateMessages.en[key]]);
      expect(values.size).toBe(3);
      for (const value of values) expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe('root slot module', () => {
  test('default-exports one component that the root slot collects', () => {
    expect(typeof RootExtra).toBe('function');
    const collected = collectSlot({ root: { '../features/pwa/root-extra.tsx': rootExtraModule } }, 'root');
    expect(collected).toEqual([RootExtra]);
  });
});

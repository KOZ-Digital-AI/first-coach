import { afterEach, describe, expect, test } from 'bun:test';
import { isRedirect } from '@tanstack/react-router';
import type { SessionAtomValue } from '../../bootstrap';
import { requireAccount, requireLevel, requireSession, sessionLevel } from './route-guard';

/*
 * Contract under test (auth-gate spec §2.1–2.4): route-guard.ts is the ONE route-level guard.
 *  - sessionLevel(data) is pure: 'account' only for isAnonymous === false, 'anonymous' for any other readable user,
 *    'none' for null/undefined/unreadable.
 *  - requireLevel reads the Better Auth session ATOM (never ensurePlayerSession, never a per-navigation getSession()):
 *    settled with a user -> allow, 0 requests; settled with no session -> redirect; not settled -> await the first
 *    settled value; a failed or timed-out read falls back to the remembered-player rule (fc:last-player).
 *  - the redirect is `/account/sign-in?redirect=<path>`, `replace: true`, keeping the search and hash of the page
 *    that was asked for.
 */

// --- a fake session atom (mimics nanostores: subscribe() calls the listener once, synchronously, with the current
// value, then again on every later `set`) -------------------------------------------------------------------------

function fakeAtom(initial: SessionAtomValue) {
  let current = initial;
  const listeners = new Set<(value: SessionAtomValue) => void>();
  return {
    subscribe(listener: (value: SessionAtomValue) => void) {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: SessionAtomValue) {
      current = next;
      for (const listener of [...listeners]) listener(current);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

const account = { user: { id: 'u-1', isAnonymous: false } };
const anonymous = { user: { id: 'u-2', isAnonymous: true } };

const ready = (data: unknown): SessionAtomValue => ({ data, isPending: false, error: null });
const pending: SessionAtomValue = { isPending: true };
const refetching = (data: unknown): SessionAtomValue => ({ data, isPending: false, isRefetching: true });
const failed = (error: unknown = new Error('offline')): SessionAtomValue => ({ error, data: null, isPending: false });

const storage = (value: string | null) => ({ getItem: () => value });
const throwingStorage = () => ({
  getItem: () => {
    throw new Error('blocked storage');
  },
});

const ctx = (href: string) => ({ location: { href } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- sessionLevel ----------------------------------------------------------------------------------------------------

describe('sessionLevel', () => {
  test('a payload with isAnonymous === false is an account', () => {
    expect(sessionLevel(account)).toBe('account');
  });

  test('an anonymous user is a session, not an account', () => {
    expect(sessionLevel(anonymous)).toBe('anonymous');
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a session whose user is null', { user: null }],
    ['a session whose user is a string', { user: 'admin' }],
    ['a plain string', 'not a session'],
  ])('null, undefined and an unreadable payload (%s) are all "none"', (_name, data) => {
    expect(sessionLevel(data)).toBe('none');
  });
});

// --- the settled atom ------------------------------------------------------------------------------------------------

describe('a settled atom', () => {
  test('that holds a user lets the navigation through without any request', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return realFetch(...args);
    }) as typeof fetch;
    const atom = fakeAtom(ready(account));
    await expect(requireLevel('session', { atom })(ctx('/train'))).resolves.toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  test('that holds no session redirects to /account/sign-in?redirect=<path>', async () => {
    const atom = fakeAtom(ready(null));
    const guard = requireLevel('session', { atom });
    try {
      await guard(ctx('/train'));
      throw new Error('expected a redirect');
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
      const options = (thrown as { options: { href?: string; replace?: boolean } }).options;
      expect(options.href).toBe('/account/sign-in?redirect=%2Ftrain');
      expect(options.replace).toBe(true);
    }
  });

  test('the redirect keeps the search and hash of the page that was asked for', async () => {
    const atom = fakeAtom(ready(undefined));
    const guard = requireLevel('session', { atom });
    try {
      await guard(ctx('/train/drill/7?from=roadmap#top'));
      throw new Error('expected a redirect');
    } catch (thrown) {
      const options = (thrown as { options: { href?: string } }).options;
      expect(options.href).toBe(`/account/sign-in?redirect=${encodeURIComponent('/train/drill/7?from=roadmap#top')}`);
    }
  });
});

// --- an unsettled atom -------------------------------------------------------------------------------------------------

describe('an unsettled atom', () => {
  test('a pending atom is awaited once: the guard subscribes, resolves on the first settled value and unsubscribes', async () => {
    const atom = fakeAtom(pending);
    const guard = requireLevel('session', { atom });
    const outcome = guard(ctx('/train'));
    // Still pending: nothing decided yet.
    await Promise.resolve();
    expect(atom.listenerCount).toBe(1);
    atom.set(ready(account));
    await expect(outcome).resolves.toBeUndefined();
    expect(atom.listenerCount).toBe(0);
  });

  test('isRefetching is not an answer: the guard waits rather than trusting the previous person\'s session', async () => {
    const atom = fakeAtom(refetching(account));
    const guard = requireLevel('session', { atom });
    const outcome = guard(ctx('/train'));
    await Promise.resolve();
    await Promise.resolve();
    expect(atom.listenerCount).toBe(1); // still waiting: refetching data is never trusted
    atom.set(ready(null));
    try {
      await outcome;
      throw new Error('expected a redirect');
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
    }
    expect(atom.listenerCount).toBe(0);
  });
});

// --- a failed read: the offline fallback --------------------------------------------------------------------------------

describe('a failed read', () => {
  test('with a remembered player (fc:last-player) lets the navigation through — an offline child is never signed out', async () => {
    const atom = fakeAtom(failed());
    const guard = requireLevel('session', { atom, device: storage('player-1') });
    await expect(guard(ctx('/train'))).resolves.toBeUndefined();
  });

  test('with nothing remembered redirects to the sign-in gate', async () => {
    const atom = fakeAtom(failed());
    const guard = requireLevel('session', { atom, device: storage(null) });
    try {
      await guard(ctx('/train'));
      throw new Error('expected a redirect');
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
    }
  });

  test('a storage that throws is treated as "nothing remembered", not as a crash', async () => {
    const atom = fakeAtom(failed());
    const guard = requireLevel('session', { atom, device: throwingStorage() });
    try {
      await guard(ctx('/train'));
      throw new Error('expected a redirect');
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
    }
  });
});

// --- the timeout: a navigation never hangs --------------------------------------------------------------------------

describe('the timeout', () => {
  test('the guard gives up after timeoutMs and falls back to the remembered-player rule, so a navigation never hangs', async () => {
    const atom = fakeAtom(pending); // never settles
    const guard = requireLevel('session', { atom, timeoutMs: 15, device: storage('player-1') });
    await expect(guard(ctx('/train'))).resolves.toBeUndefined();
  });

  test('with nothing remembered, a timed-out read redirects like any other failed read', async () => {
    const atom = fakeAtom(pending);
    const guard = requireLevel('session', { atom, timeoutMs: 15, device: storage(null) });
    try {
      await guard(ctx('/train'));
      throw new Error('expected a redirect');
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
    }
  });
});

// --- requireAccount / requireSession ------------------------------------------------------------------------------------

describe('requireAccount', () => {
  test('refuses an anonymous session and redirects with the same return path', async () => {
    const atom = fakeAtom(ready(anonymous));
    const guard = requireAccount({ atom });
    try {
      await guard(ctx('/contribute'));
      throw new Error('expected a redirect');
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
      const options = (thrown as { options: { href?: string } }).options;
      expect(options.href).toBe('/account/sign-in?redirect=%2Fcontribute');
    }
  });

  test('lets a real account through', async () => {
    const atom = fakeAtom(ready(account));
    await expect(requireAccount({ atom })(ctx('/contribute'))).resolves.toBeUndefined();
  });
});

describe('requireSession', () => {
  test('accepts an anonymous session', async () => {
    const atom = fakeAtom(ready(anonymous));
    await expect(requireSession({ atom })(ctx('/train'))).resolves.toBeUndefined();
  });

  test('refuses no session at all', async () => {
    const atom = fakeAtom(ready(null));
    try {
      await requireSession({ atom })(ctx('/train'));
      throw new Error('expected a redirect');
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
    }
  });
});

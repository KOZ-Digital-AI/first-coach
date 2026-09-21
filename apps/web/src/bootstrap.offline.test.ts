import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import config from '../vite.config';
import { createAppQueryClient, watchAuthSession, wireAppPlayerSession } from './bootstrap';
import type { PlayerSessionWiringDeps } from './bootstrap';
import { authClient, createPlayerAuthClient, useSession } from './lib/auth';
import { PERSIST_MAX_AGE_MS, resolveBuildVersion } from './lib/query-persist';

// fc-mol-eay.9: the offline pieces (session events through the outbox, the persisted query cache) were built but nothing called
// them. bootstrap.ts wires them once the player session id is known. Everything the wiring touches is a seam (the session
// read, the session-change signal, the events client's two functions, the persister, the build version), so these tests use
// fakes and no storage, no network and no timers.
//
// Readings of the criteria (where they were open):
// - "exactly once per session id": a second report of the SAME id (the session atom re-emits on every refetch) changes nothing;
//   a DIFFERENT id (sign-in / sign-out / another player) tears the old wiring down first, then wires the new id.
// - "never with a stale id": the events player and the persister are always the id last reported; between a teardown and the
//   next wiring the events player is `undefined`.
// - "sign-out stops sync": the events player becomes undefined, the sync's stop function is called, the persister is
//   unsubscribed, and no new sync is started until an id is known again.
// - fc-mol-eay.10: the wiring never signs anybody in. A fresh visitor (landing, /legal/*) therefore gets no session and no
//   wiring at start-up; a session a SCREEN creates later (train / roadmap / onboarding) reaches the wiring through the atom,
//   exactly once.
// - fc-mol-eay.11: the session-change signal (the shared Better Auth session atom, which the shell's useSession also reads and
//   which fetches get-session itself) is the ONLY source of the id. There is no separate getSession read: a page load makes
//   exactly one get-session request. Like the real atom, the fake signal delivers its current value on subscribe.
// - a player switch (id -> another id, or -> signed out) also empties the in-memory query cache, otherwise the previous
//   player's ['today'] would be saved into the next player's persisted record. The FIRST wiring keeps the cache as it is.

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  calls: string[];
  persisted: { playerId: string; buildVersion: string | undefined; queryClient: QueryClient }[];
  deps: PlayerSessionWiringDeps;
  /** What the session-change signal delivers. */
  emit(playerId: string | undefined): void;
  listening(): number;
}

/**
 * `initial` is what the signal delivers on subscribe (a nanostores atom calls the listener with its current value at once):
 * nothing (the atom is still loading), 'none' (settled without a session) or a session id.
 */
function harness(options: { initial?: 'none' | string } = {}): Harness {
  const calls: string[] = [];
  const persisted: Harness['persisted'] = [];
  const listeners = new Set<(playerId: string | undefined) => void>();
  let syncs = 0;
  const deps: PlayerSessionWiringDeps = {
    watchSession(listener) {
      listeners.add(listener);
      if (options.initial !== undefined) listener(options.initial === 'none' ? undefined : options.initial);
      return () => void listeners.delete(listener);
    },
    configureEventsPlayer(playerId) {
      calls.push(`player:${playerId}`);
    },
    startEventsSync() {
      syncs += 1;
      const n = syncs;
      calls.push(`start:${n}`);
      return () => void calls.push(`stop:${n}`);
    },
    persistAppQueryClient(persist) {
      persisted.push({ playerId: persist.playerId, buildVersion: persist.buildVersion, queryClient: persist.queryClient });
      calls.push(`persist:${persist.playerId}`);
      return [() => void calls.push(`unpersist:${persist.playerId}`), Promise.resolve()];
    },
    resolveBuildVersion: () => 'build-test-1',
  };
  return {
    calls,
    persisted,
    deps,
    emit: (playerId) => {
      for (const listener of [...listeners]) listener(playerId);
    },
    listening: () => listeners.size,
  };
}

describe('createAppQueryClient: persisted queries outlive the restore', () => {
  test('defaultOptions.queries.gcTime is at least PERSIST_MAX_AGE_MS', () => {
    const gcTime = createAppQueryClient().getDefaultOptions().queries?.gcTime;
    expect(typeof gcTime).toBe('number');
    expect(gcTime as number).toBeGreaterThanOrEqual(PERSIST_MAX_AGE_MS);
  });
});

describe('wireAppPlayerSession', () => {
  test('wires nothing before the session id is known', async () => {
    const h = harness();
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    expect(h.calls).toEqual([]);
    expect(h.persisted).toEqual([]);
  });

  test('once the session signal reports an id: the events player is configured, sync started and the cache persisted for that id', async () => {
    const h = harness({ initial: 'p1' });
    const queryClient = new QueryClient();
    wireAppPlayerSession(queryClient, h.deps);
    await flush();
    expect(h.calls.filter((call) => call.startsWith('player:'))).toEqual(['player:p1']);
    expect(h.calls.filter((call) => call.startsWith('start:'))).toEqual(['start:1']);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]?.playerId).toBe('p1');
    expect(h.persisted[0]?.queryClient).toBe(queryClient);
  });

  test('the player is configured BEFORE the sync starts (the first flush must already know its player)', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    expect(h.calls.indexOf('player:p1')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('player:p1')).toBeLessThan(h.calls.indexOf('start:1'));
  });

  test('the persist buster is what resolveBuildVersion() returns', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    expect(h.persisted[0]?.buildVersion).toBe('build-test-1');
  });

  test('the default buster is the real resolveBuildVersion() (no version other than the build one)', async () => {
    const h = harness({ initial: 'p1' });
    const rest: Partial<PlayerSessionWiringDeps> = { ...h.deps };
    delete rest.resolveBuildVersion;
    wireAppPlayerSession(new QueryClient(), rest);
    await flush();
    expect(h.persisted[0]?.buildVersion).toBe(resolveBuildVersion());
  });

  test('exactly once per session id: the same id reported again (the atom re-emits on refetch) wires nothing more', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    const before = [...h.calls];
    h.emit('p1');
    h.emit('p1');
    await flush();
    expect(h.calls).toEqual(before);
    expect(h.persisted).toHaveLength(1);
  });

  test('a different id re-wires: the old sync and persister stop first, then the new id is configured, synced and persisted', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    h.emit('p2');
    await flush();
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'stop:1', 'unpersist:p1', 'player:undefined', 'player:p2', 'persist:p2', 'start:2']);
    expect(h.persisted.map((entry) => entry.playerId)).toEqual(['p1', 'p2']);
  });

  test('never a stale id: after the switch the last events player is the new id and only one sync is running', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    h.emit('p2');
    h.emit('p3');
    await flush();
    const players = h.calls.filter((call) => call.startsWith('player:'));
    expect(players.at(-1)).toBe('player:p3');
    const started = h.calls.filter((call) => call.startsWith('start:')).length;
    const stopped = h.calls.filter((call) => call.startsWith('stop:')).length;
    expect(started - stopped).toBe(1);
    const persistedNow = h.calls.filter((call) => call.startsWith('persist:')).length;
    const unpersisted = h.calls.filter((call) => call.startsWith('unpersist:')).length;
    expect(persistedNow - unpersisted).toBe(1);
  });

  test('sign-out stops the sync, unsubscribes the persister and clears the events player; nothing is started', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    h.emit(undefined);
    await flush();
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'stop:1', 'unpersist:p1', 'player:undefined']);
  });

  test('sign-out twice in a row stops once (nothing is wired the second time)', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    h.emit(undefined);
    h.emit(undefined);
    await flush();
    expect(h.calls.filter((call) => call.startsWith('stop:'))).toEqual(['stop:1']);
  });

  test('after sign-out the next session id is wired again', async () => {
    const h = harness({ initial: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    h.emit(undefined);
    h.emit('p2');
    await flush();
    expect(h.calls.slice(-3)).toEqual(['player:p2', 'persist:p2', 'start:2']);
    expect(h.calls.filter((call) => call === 'stop:2')).toEqual([]);
  });

  test('a player switch empties the in-memory cache, so the previous player is never saved into the next one', async () => {
    const h = harness({ initial: 'p1' });
    const queryClient = new QueryClient();
    wireAppPlayerSession(queryClient, h.deps);
    await flush();
    queryClient.setQueryData(['today'], { id: 'session-of-p1' });
    h.emit('p2');
    await flush();
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('the sign-out also empties the in-memory cache', async () => {
    const h = harness({ initial: 'p1' });
    const queryClient = new QueryClient();
    wireAppPlayerSession(queryClient, h.deps);
    await flush();
    queryClient.setQueryData(['me'], { name: 'p1' });
    h.emit(undefined);
    await flush();
    expect(queryClient.getQueryData(['me'])).toBeUndefined();
  });

  test('the FIRST wiring keeps what the cache already holds (screens may have fetched before the session was known)', async () => {
    const h = harness();
    const queryClient = new QueryClient();
    wireAppPlayerSession(queryClient, h.deps);
    queryClient.setQueryData(['today'], { id: 'early' });
    h.emit('p1');
    await flush();
    expect(queryClient.getQueryData<{ id: string }>(['today'])).toEqual({ id: 'early' });
  });

  test('a persister whose restore rejects does not become an unhandled rejection', async () => {
    const h = harness({ initial: 'p1' });
    const rejecting = new Promise<void>((_, reject) => reject(new Error('idb unavailable')));
    const deps: PlayerSessionWiringDeps = { ...h.deps, persistAppQueryClient: () => [() => {}, rejecting] };
    wireAppPlayerSession(new QueryClient(), deps);
    await flush();
    // reaching here without the runner reporting an unhandled rejection is the assertion; the sync was still started
    expect(h.calls.filter((call) => call.startsWith('start:'))).toEqual(['start:1']);
  });

  test('the returned teardown stops the sync and persister and ignores later signals', async () => {
    const h = harness({ initial: 'p1' });
    const teardown = wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    teardown();
    expect(h.calls.slice(-3)).toEqual(['stop:1', 'unpersist:p1', 'player:undefined']);
    expect(h.listening()).toBe(0);
    const before = [...h.calls];
    h.emit('p2');
    await flush();
    expect(h.calls).toEqual(before);
  });

  test('the teardown before the signal reports an id: the late id is never wired', async () => {
    const h = harness();
    const teardown = wireAppPlayerSession(new QueryClient(), h.deps);
    teardown();
    h.emit('p1');
    await flush();
    expect(h.calls).toEqual([]);
  });
});

describe('wireAppPlayerSession: never signs anybody in (fc-mol-eay.10, fc-mol-eay.11)', () => {
  test('a fresh visitor (the atom settles without a session): nothing is wired at start-up', async () => {
    const h = harness({ initial: 'none' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    expect(h.calls).toEqual([]);
    expect(h.persisted).toEqual([]);
    expect(h.listening()).toBe(1);
  });

  test('a session that a screen creates later reaches the wiring through the signal and is wired exactly once', async () => {
    const h = harness({ initial: 'none' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    h.emit('anon-1');
    h.emit('anon-1');
    await flush();
    expect(h.calls).toEqual(['player:anon-1', 'persist:anon-1', 'start:1']);
  });

  test('bootstrap.ts never imports or calls the anonymous sign-in helpers of lib/auth', () => {
    const source = readFileSync(join(import.meta.dir, 'bootstrap.ts'), 'utf8');
    expect(source).not.toMatch(/ensurePlayerSession/);
    expect(source).not.toMatch(/signIn/);
  });

  test('bootstrap.ts makes no session read of its own (fc-mol-eay.11: the atom is the only source)', () => {
    const source = readFileSync(join(import.meta.dir, 'bootstrap.ts'), 'utf8');
    expect(source).not.toMatch(/getSession/);
    expect(source).not.toMatch(/readExistingSession/);
  });
});

describe('wireAppPlayerSession with the real Better Auth client: one session read per load, a visitor without a session is never signed in', () => {
  const ORIGIN = 'http://coach.test';
  const GET_SESSION = 'GET /api/auth/get-session';

  /**
   * A fake server: get-session answers the current session (or null), sign-in/anonymous creates one. COUNTS every request.
   * `existing`: the visitor already has a session (a cookie) when the page loads.
   */
  function server(existing?: { id: string }) {
    const requests: string[] = [];
    let session: { session: { id: string }; user: { id: string; isAnonymous: boolean } } | null =
      existing === undefined ? null : { session: { id: 's0' }, user: { id: existing.id, isAnonymous: false } };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === '/api/auth/sign-in/anonymous') {
        session = { session: { id: 's1' }, user: { id: 'anon-1', isAnonymous: true } };
        return Response.json({ token: 't', user: session.user });
      }
      if (path === '/api/auth/get-session') return Response.json(session);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { requests, fetchImpl, getSessionCount: () => requests.filter((request) => request === GET_SESSION).length };
  }

  /** main.tsx's order: the wiring first (before the first render). Everything but the session signal is a fake. */
  function wired(existing?: { id: string }) {
    const s = server(existing);
    const client = createPlayerAuthClient({ baseURL: ORIGIN, fetch: s.fetchImpl });
    const h = harness();
    const deps: Partial<PlayerSessionWiringDeps> = {
      ...h.deps,
      watchSession: (listener) => watchAuthSession(client.$store.atoms.session, listener),
    };
    const teardown = wireAppPlayerSession(new QueryClient(), deps);
    return { s, h, client, teardown };
  }

  /** What the app shell does: subscribes to the same client's session through the React hook (Better Auth's useSession). */
  const mountShell = (client: ReturnType<typeof createPlayerAuthClient>) => renderHook(() => client.useSession());

  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  };

  /** Lets the load finish, then gives a late second request time to show up. */
  const settleLoad = async (shell: ReturnType<typeof mountShell>) => {
    await until(() => !shell.result.current.isPending);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  };

  test('a fresh visitor, shell mounted: exactly ONE get-session for the whole load, no sign-in, nothing wired', async () => {
    const { s, h, client, teardown } = wired();
    const shell = mountShell(client);
    await settleLoad(shell);
    expect(s.requests).toEqual([GET_SESSION]);
    expect(h.calls).toEqual([]);
    teardown();
  });

  test('a visitor with a session, shell mounted: exactly ONE get-session, and that session is wired', async () => {
    const { s, h, client, teardown } = wired({ id: 'p1' });
    const shell = mountShell(client);
    await settleLoad(shell);
    expect(s.getSessionCount()).toBe(1);
    expect(s.requests).toEqual([GET_SESSION]);
    expect(shell.result.current.data?.user.id).toBe('p1');
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1']);
    teardown();
  });

  test('the wiring alone (no shell yet): a single get-session, and the shell mounting after it adds none', async () => {
    const { s, client, teardown } = wired({ id: 'p1' });
    await until(() => s.getSessionCount() > 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    const shell = mountShell(client);
    await settleLoad(shell);
    expect(s.getSessionCount()).toBe(1);
    teardown();
  });

  test('the shell is already mounted and settled when the wiring subscribes: still one get-session in total', async () => {
    const s = server({ id: 'p1' });
    const client = createPlayerAuthClient({ baseURL: ORIGIN, fetch: s.fetchImpl });
    const shell = mountShell(client);
    await settleLoad(shell);
    const h = harness();
    const teardown = wireAppPlayerSession(new QueryClient(), {
      ...h.deps,
      watchSession: (listener) => watchAuthSession(client.$store.atoms.session, listener),
    });
    await flush();
    expect(s.getSessionCount()).toBe(1);
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1']);
    teardown();
  });

  test('a screen signs in later (anonymous): the new session id is wired exactly once, and the wiring made no sign-in', async () => {
    const { s, h, client, teardown } = wired();
    const shell = mountShell(client);
    await settleLoad(shell);
    await client.signIn.anonymous();
    await until(() => h.calls.length >= 3);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(h.calls).toEqual(['player:anon-1', 'persist:anon-1', 'start:1']);
    // the one sign-in is the screen's own
    expect(s.requests.filter((request) => request.includes('sign-in'))).toEqual(['POST /api/auth/sign-in/anonymous']);
    teardown();
  });
});

describe('wireAppPlayerSession with the app-wide auth client (the real defaults) and the shell useSession', () => {
  // The whole page load as main.tsx and the shell do it, with only the network faked: the wiring's default session signal (the
  // app-wide authClient's session atom), the shell's `useSession` (lib/auth), and a counting fake in place of the network.
  // The events client, the persister and the build version stay fakes (they are not what is under test). One test, in order,
  // because the app-wide client's atom is module state that outlives a test.
  test('a fresh visitor: exactly ONE get-session for the load, no sign-in; a session a screen creates later is wired exactly once', async () => {
    const requests: string[] = [];
    let session: { session: { id: string }; user: { id: string; isAnonymous: boolean } } | null = null;
    // The app-wide client captured happy-dom's fetch at import, so the counting fake sits one layer down: happy-dom's own
    // request interceptor answers every request itself (nothing reaches a network) and records it.
    const settings = (globalThis as unknown as { happyDOM: { settings: { fetch: { interceptor: unknown } } } }).happyDOM.settings;
    const originalInterceptor = settings.fetch.interceptor;
    settings.fetch.interceptor = {
      beforeAsyncRequest: async ({ request }: { request: { method: string; url: string } }) => {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (path === '/api/auth/sign-in/anonymous') {
          session = { session: { id: 's1' }, user: { id: 'anon-1', isAnonymous: true } };
          return Response.json({ token: 't', user: session.user });
        }
        if (path === '/api/auth/get-session') return Response.json(session);
        return new Response('not found', { status: 404 });
      },
    };
    const h = harness();
    const { watchSession: _fake, ...faked } = h.deps;
    let teardown = () => {};
    try {
      // main.tsx: the wiring runs before the first render; then the shell mounts and subscribes to the session.
      teardown = wireAppPlayerSession(new QueryClient(), faked);
      const shell = renderHook(() => useSession());
      for (let i = 0; i < 100 && shell.result.current.isPending; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      expect(shell.result.current.isPending).toBe(false);
      expect(requests).toEqual(['GET /api/auth/get-session']);
      expect(h.calls).toEqual([]);

      // a screen (train / roadmap / onboarding) signs in on its own
      await authClient.signIn.anonymous();
      for (let i = 0; i < 100 && h.calls.length < 3; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      expect(h.calls).toEqual(['player:anon-1', 'persist:anon-1', 'start:1']);
      expect(requests.filter((request) => request.includes('sign-in'))).toEqual(['POST /api/auth/sign-in/anonymous']);
    } finally {
      teardown();
      settings.fetch.interceptor = originalInterceptor;
    }
  });
});

describe('watchAuthSession: the session-change signal from a Better Auth session atom', () => {
  type Value = { data?: unknown; isPending?: boolean; isRefetching?: boolean };
  function fakeAtom(initial: Value) {
    let value = initial;
    const listeners = new Set<(value: Value) => void>();
    return {
      atom: {
        subscribe(listener: (value: Value) => void) {
          listeners.add(listener);
          listener(value);
          return () => void listeners.delete(listener);
        },
      },
      set(next: Value) {
        value = next;
        for (const listener of [...listeners]) listener(value);
      },
      count: () => listeners.size,
    };
  }

  function collect(initial: Value) {
    const fake = fakeAtom(initial);
    const seen: (string | undefined)[] = [];
    const stop = watchAuthSession(fake.atom, (id) => void seen.push(id));
    return { fake, seen, stop };
  }

  test('a settled session reports its user id', () => {
    const { seen } = collect({ data: { user: { id: 'p1' } }, isPending: false });
    expect(seen).toEqual(['p1']);
  });

  test('a settled "no session" reports undefined', () => {
    const { seen } = collect({ data: null, isPending: false });
    expect(seen).toEqual([undefined]);
  });

  test('still loading: nothing is reported', () => {
    const { seen } = collect({ data: null, isPending: true });
    expect(seen).toEqual([]);
  });

  test('re-reading (isRefetching keeps the PREVIOUS person): nothing is reported until it settles', () => {
    const { fake, seen } = collect({ data: { user: { id: 'p1' } }, isPending: false });
    fake.set({ data: { user: { id: 'p1' } }, isPending: false, isRefetching: true });
    expect(seen).toEqual(['p1']);
    fake.set({ data: null, isPending: false, isRefetching: false });
    expect(seen).toEqual(['p1', undefined]);
  });

  test('a payload without a user id is "no session", not a crash', () => {
    const { seen } = collect({ data: { user: {} }, isPending: false });
    expect(seen).toEqual([undefined]);
  });

  test('an empty-string user id is "no session" (a wiring with id "" would throw in the persister)', () => {
    const { seen } = collect({ data: { user: { id: '' } }, isPending: false });
    expect(seen).toEqual([undefined]);
  });

  test('the returned function unsubscribes', () => {
    const { fake, stop } = collect({ data: null, isPending: true });
    expect(fake.count()).toBe(1);
    stop();
    expect(fake.count()).toBe(0);
  });
});

describe('main.tsx and the build version', () => {
  const mainSource = readFileSync(join(import.meta.dir, 'main.tsx'), 'utf8');

  test('main.tsx wires the player session with the app QueryClient before the first render', () => {
    expect(mainSource).toMatch(/wireAppPlayerSession\(\s*queryClient\s*\)/);
    expect(mainSource.search(/wireAppPlayerSession\(/)).toBeLessThan(mainSource.search(/\.render\(/));
  });

  test('vite.config defines import.meta.env.VITE_BUILD_VERSION as a non-empty JSON string literal', () => {
    const define = config.define as Record<string, string> | undefined;
    const value = define?.['import.meta.env.VITE_BUILD_VERSION'];
    expect(typeof value).toBe('string');
    const parsed: unknown = JSON.parse(value as string);
    expect(typeof parsed).toBe('string');
    expect((parsed as string).length).toBeGreaterThan(0);
  });
});

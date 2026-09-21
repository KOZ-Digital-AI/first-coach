import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HealthResponse, paginated, PROBLEM_CONTENT_TYPE } from '@api-types/primitives';
import { z } from 'zod';
import { fromZodError, problem as serverProblem } from '../../../api/src/http/problem';
import { api, createApi, type FetchLike } from './api';
import { createI18n, i18n, LOCALES } from './i18n';
import { ApiProblem, describeProblem, isApiProblem, MESSAGE_KEYS, onUnauthorized, type ProblemKind } from './problem';
import problemMessages from './problem.messages';

// --- global hygiene ----------------------------------------------------------------------------------------------------
// Nothing global is patched for the wrapper itself: fetch, online and language reach it through createApi's seams.
// The only globals these tests touch are the i18n singleton's language, the unauthorized-handler registry, console.error
// and (once) navigator.onLine. Every test that changes one registers its undo in `restores`; afterEach runs them all.
// Runs from apps/web (preload registers happy-dom) and from the repo root (no DOM): neither needs a document here.

const INITIAL_LANGUAGE = i18n.language;
const restores: Array<() => void> = [];

afterEach(async () => {
  while (restores.length > 0) restores.pop()?.();
  await i18n.changeLanguage(INITIAL_LANGUAGE);
  // Lets the coalescing microtask of any notifyUnauthorized burst run before the next test starts.
  await Promise.resolve();
});

// --- helpers -----------------------------------------------------------------------------------------------------------

type Locale = (typeof LOCALES)[number];
type Call = { url: string; init: RequestInit; headers: Headers };

/** A fetch seam: records every call and answers with `respond`. */
function stub(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchStub: FetchLike = async (input, init = {}) => {
    calls.push({ url: input, init, headers: new Headers(init.headers) });
    return respond(calls[calls.length - 1] as Call);
  };
  return { fetch: fetchStub, calls };
}

const json = (status: number, body: unknown, contentType = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });

/** Same wire shape the API emits (apps/api/src/http/problem.ts). */
const problemResponse = (status: number, title: string, errors?: { pointer: string; detail: string }[], detail?: string) =>
  json(status, { type: 'about:blank', title, status, ...(detail && { detail }), ...(errors && { errors }) }, 'application/problem+json');

/** What the call rejects with, so a test can inspect it. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail');
}

async function problemOf(promise: Promise<unknown>): Promise<ApiProblem> {
  const error = await failure(promise);
  if (!isApiProblem(error)) throw new Error(`expected an ApiProblem, got ${String(error)}`, { cause: error });
  return error;
}

/** Rejects with `signal.reason` the moment the signal aborts, like a real fetch. */
function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === null || signal === undefined) return;
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/** Subscribes for the duration of one test. */
function listen(handler: Parameters<typeof onUnauthorized>[0]): void {
  restores.push(onUnauthorized(handler));
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

/** An isolated i18n instance loaded exactly like the app loads it: file `problem.messages.ts` -> namespace `problem`. */
function translatorFor(locale: Locale): (key: string) => string {
  const instance = createI18n({
    modules: { './problem.messages.ts': { default: problemMessages } },
    languages: [locale],
    storage: memoryStorage(),
    root: { lang: '' },
    dev: false,
  });
  return (key: string) => instance.t(key);
}

const translators: Record<Locale, (key: string) => string> = { kk: translatorFor('kk'), ru: translatorFor('ru'), en: translatorFor('en') };
const text = (locale: Locale, key: keyof (typeof problemMessages)['en']): string => problemMessages[locale][key];

/** Compile-time only: `typeEquals<A, B>(true)` is a type error unless A and B are the same type. */
type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const typeEquals = <A, B>(_proof: Equals<A, B>): void => undefined;

// --- request shape -----------------------------------------------------------------------------------------------------

describe('request', () => {
  test('a GET is same-origin with credentials, Accepts json and problem+json, and sends no body or content-type', async () => {
    const s = stub(() => json(200, { ok: true }));
    await createApi({ fetch: s.fetch }).get('/api/things', { schema: z.object({ ok: z.boolean() }) });
    const call = s.calls[0] as Call;
    expect(call.url).toBe('/api/things');
    expect(call.init.method).toBe('GET');
    expect(call.init.credentials).toBe('same-origin');
    expect(call.headers.get('accept')).toBe('application/json, application/problem+json');
    expect(call.init.body).toBeUndefined();
    expect(call.headers.has('content-type')).toBe(false);
  });

  test('every verb sends its own method', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    const client = createApi({ fetch: s.fetch });
    await client.get('/api/a', { schema: 'none' });
    await client.post('/api/a', { schema: 'none' });
    await client.put('/api/a', { schema: 'none' });
    await client.patch('/api/a', { schema: 'none' });
    await client.delete('/api/a', { schema: 'none' });
    expect(s.calls.map((call) => call.init.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  test('a baseUrl is prefixed; the default is the empty same-origin base', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    await createApi({ fetch: s.fetch, baseUrl: 'http://x.test' }).get('/api/a?x=1', { schema: 'none' });
    await createApi({ fetch: s.fetch }).get('/api/a?x=1', { schema: 'none' });
    expect(s.calls.map((call) => call.url)).toEqual(['http://x.test/api/a?x=1', '/api/a?x=1']);
  });

  test('the caller signal is handed to fetch', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    const controller = new AbortController();
    await createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none', signal: controller.signal });
    expect(s.calls[0]?.init.signal).toBe(controller.signal);
  });

  test('extra caller headers are kept, but Accept and Accept-Language belong to the client', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    await i18n.changeLanguage('ru');
    await createApi({ fetch: s.fetch }).get('/api/a', {
      schema: 'none',
      headers: { 'X-Trace': 'abc', 'Accept-Language': 'de', Accept: 'text/html' },
    });
    const headers = s.calls[0]?.headers as Headers;
    expect(headers.get('x-trace')).toBe('abc');
    expect(headers.get('accept-language')).toBe('ru');
    expect(headers.get('accept')).toBe('application/json, application/problem+json');
  });
});

// --- Accept-Language ---------------------------------------------------------------------------------------------------

describe('Accept-Language', () => {
  test('is the ACTIVE i18n language, read on every request (kk -> ru -> en) from one client made up front', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    const client = createApi({ fetch: s.fetch });
    await i18n.changeLanguage('kk');
    await client.get('/api/a', { schema: 'none' });
    await i18n.changeLanguage('ru');
    await client.get('/api/a', { schema: 'none' });
    await i18n.changeLanguage('en');
    await client.get('/api/a', { schema: 'none' });
    expect(s.calls.map((call) => call.headers.get('accept-language'))).toEqual(['kk', 'ru', 'en']);
  });

  test('a client created AFTER a language change uses the new language too', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    await i18n.changeLanguage('en');
    await createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none' });
    await i18n.changeLanguage('ru');
    await createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none' });
    expect(s.calls.map((call) => call.headers.get('accept-language'))).toEqual(['en', 'ru']);
  });

  test('the language seam replaces the i18n lookup, per request', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    let current = 'ru';
    await i18n.changeLanguage('en');
    const client = createApi({ fetch: s.fetch, language: () => current });
    await client.get('/api/a', { schema: 'none' });
    current = 'kk';
    await client.get('/api/a', { schema: 'none' });
    expect(s.calls.map((call) => call.headers.get('accept-language'))).toEqual(['ru', 'kk']);
  });
});

// --- request bodies ----------------------------------------------------------------------------------------------------

describe('request bodies', () => {
  test('a plain object is sent as JSON with a JSON content-type', async () => {
    const s = stub(() => json(200, {}));
    const body = { profile: { age: 12 }, tags: ['a', 'b'], note: null };
    await createApi({ fetch: s.fetch }).post('/api/a', { body, schema: z.object({}) });
    const call = s.calls[0] as Call;
    expect(call.init.body).toBe('{"profile":{"age":12},"tags":["a","b"],"note":null}');
    expect(call.headers.get('content-type')).toBe('application/json');
  });

  test('an array is sent as JSON too, on PUT and PATCH', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    const client = createApi({ fetch: s.fetch });
    await client.put('/api/a', { body: [1, { a: 2 }], schema: 'none' });
    await client.patch('/api/a', { body: ['x'], schema: 'none' });
    expect(s.calls.map((call) => call.init.body)).toEqual(['[1,{"a":2}]', '["x"]']);
    expect(s.calls.map((call) => call.headers.get('content-type'))).toEqual(['application/json', 'application/json']);
  });

  test('a FormData body is handed to fetch untouched with NO content-type from us, so fetch adds the multipart boundary', async () => {
    const s = stub(() => json(200, {}));
    const form = new FormData();
    form.set('title', 'Warm-up');
    form.set('file', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
    await createApi({ fetch: s.fetch }).post('/api/upload', { body: form, schema: z.object({}) });
    const call = s.calls[0] as Call;
    expect(call.init.body).toBe(form);
    expect(call.headers.has('content-type')).toBe(false);
    // What fetch would then do with exactly these init values: derive the multipart type and boundary.
    const request = new Request('http://x.test/api/upload', { method: 'POST', body: call.init.body, headers: call.headers });
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=\S+/);
  });

  const passthrough: Array<[string, () => BodyInit]> = [
    ['a string', () => 'raw text'],
    ['a Blob', () => new Blob(['blob'], { type: 'text/plain' })],
    ['URLSearchParams', () => new URLSearchParams({ a: '1' })],
    ['an ArrayBuffer', () => new Uint8Array([1, 2, 3]).buffer],
    ['a typed array', () => new Uint8Array([4, 5, 6])],
  ];

  test.each(passthrough)('%s is passed through untouched, with no JSON content-type', async (_label, make) => {
    const s = stub(() => new Response(null, { status: 204 }));
    const body = make();
    await createApi({ fetch: s.fetch }).post('/api/a', { body, schema: 'none' });
    const call = s.calls[0] as Call;
    expect(call.init.body).toBe(body);
    expect(call.headers.has('content-type')).toBe(false);
  });

  test('no body sends none (undefined), with no content-type', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    await createApi({ fetch: s.fetch }).post('/api/a', { schema: 'none' });
    const call = s.calls[0] as Call;
    expect(call.init.body).toBeUndefined();
    expect(call.headers.has('content-type')).toBe(false);
  });
});

// --- paths -------------------------------------------------------------------------------------------------------------

describe('paths', () => {
  const bad: Array<[string, string]> = [
    ['protocol-relative', '//evil.test/x'],
    ['absolute URL', 'https://evil.test/x'],
    ['no leading slash', 'api/x'],
    ['empty', ''],
    ['backslash after the slash', '/\\evil.test'],
    ['a tab the URL parser would strip', '/\t/evil.test'],
    ['a newline the URL parser would strip', '/\n/evil.test'],
  ];

  test.each(bad)('%s is a TypeError before anything is sent', async (_label, path) => {
    const s = stub(() => new Response(null, { status: 204 }));
    const client = createApi({ fetch: s.fetch });
    for (const call of [
      () => client.get(path, { schema: 'none' }),
      () => client.post(path, { schema: 'none' }),
      () => client.put(path, { schema: 'none' }),
      () => client.patch(path, { schema: 'none' }),
      () => client.delete(path, { schema: 'none' }),
    ]) {
      expect(await failure(call())).toBeInstanceOf(TypeError);
    }
    expect(s.calls).toHaveLength(0);
  });

  test('single-slash paths (root, query, nested, encoded) are all fine', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    const client = createApi({ fetch: s.fetch });
    for (const path of ['/', '/api/a', '/api/a?x=1&y=2', '/api/a%20b/c']) await client.get(path, { schema: 'none' });
    expect(s.calls.map((call) => call.url)).toEqual(['/', '/api/a', '/api/a?x=1&y=2', '/api/a%20b/c']);
  });

  test('a call with no schema at all (an untyped caller) is a TypeError before anything is sent', async () => {
    const s = stub(() => json(200, {}));
    const client = createApi({ fetch: s.fetch });
    expect(await failure(client.get('/api/a', {} as never))).toBeInstanceOf(TypeError);
    expect(await failure(client.get('/api/a', undefined as never))).toBeInstanceOf(TypeError);
    expect(s.calls).toHaveLength(0);
  });
});

// --- success and schema ------------------------------------------------------------------------------------------------

describe('schema-parsed responses', () => {
  test('a shared Zod 4 schema parses the response and its output type flows to the caller', async () => {
    const s = stub(() => json(200, { ok: true, version: '1.2.3', database: 'ok', extra: 1 }));
    const health = await createApi({ fetch: s.fetch }).get('/health', { schema: HealthResponse });
    typeEquals<typeof health, HealthResponse>(true);
    expect(health).toEqual({ ok: true, version: '1.2.3', database: 'ok', extra: 1 });
  });

  test('paginated(...) schemas type-check and infer their item type', async () => {
    const Drill = z.object({ id: z.string(), reps: z.int() });
    const Page = paginated(Drill);
    const s = stub(() => json(200, { items: [{ id: 'd1', reps: 3 }], nextCursor: null, total: 1 }));
    const page = await createApi({ fetch: s.fetch }).get('/api/drills', { schema: Page });
    typeEquals<typeof page, z.infer<typeof Page>>(true);
    typeEquals<(typeof page)['items'][number], { id: string; reps: number }>(true);
    expect(page.items[0]?.reps).toBe(3);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(1);
  });

  test('the PARSED value is returned, not the raw JSON (transforms and defaults apply)', async () => {
    const Schema = z.object({ at: z.string().transform((value) => new Date(value)), tags: z.array(z.string()).default([]) });
    const s = stub(() => json(200, { at: '2026-01-02T03:04:05.000Z' }));
    const result = await createApi({ fetch: s.fetch }).get('/api/a', { schema: Schema });
    expect(result.at).toBeInstanceOf(Date);
    expect(result.at.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(result.tags).toEqual([]);
  });

  test('a JSON null body is a valid body for a schema that accepts null', async () => {
    const s = stub(() => json(200, null));
    expect(await createApi({ fetch: s.fetch }).get('/api/a', { schema: z.null() })).toBeNull();
  });

  test('a response that fails the schema is an ApiProblem "schema" carrying the issues, never a raw ZodError', async () => {
    const s = stub(() => json(200, { ok: 'yes', version: '', database: 'maybe' }));
    const error = await problemOf(createApi({ fetch: s.fetch }).get('/health', { schema: HealthResponse }));
    expect(error.kind).toBe('schema');
    expect(error.status).toBe(200);
    expect(error.retryable).toBe(false);
    expect(error.issues?.map((issue) => issue.path?.join('.')).sort()).toEqual(['database', 'ok', 'version']);
    expect(error.issues?.every((issue) => issue.message.length > 0)).toBe(true);
    expect(Array.isArray(error.cause)).toBe(true);
    expect(error.cause).toBe(error.issues);
    expect(error.cause).not.toBeInstanceOf(z.ZodError);
    expect(describeProblem(error, translators.en).formMessage).toBe(text('en', 'schema'));
    expect(describeProblem(error, translators.kk).formMessage).toBe(text('kk', 'schema'));
  });

  test('a 2xx that is not JSON (the SPA index.html served for a missing API route) is "schema", not a crash', async () => {
    const html = stub(() => new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const error = await problemOf(createApi({ fetch: html.fetch }).get('/api/missing', { schema: z.object({ ok: z.boolean() }) }));
    expect(error.kind).toBe('schema');
    expect(error.status).toBe(200);
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test('an empty 200 body when a schema was given is "schema"', async () => {
    const s = stub(() => new Response('', { status: 200 }));
    const error = await problemOf(createApi({ fetch: s.fetch }).get('/api/a', { schema: z.object({}) }));
    expect(error.kind).toBe('schema');
    expect(error.status).toBe(200);
  });

  test.each<[number]>([[204], [205]])('a %d with a schema is "schema": the caller declared content, even for a schema that takes undefined', async (status) => {
    const s = stub(() => new Response(null, { status }));
    const error = await problemOf(createApi({ fetch: s.fetch }).get('/api/a', { schema: z.undefined() }));
    expect(error.kind).toBe('schema');
    expect(error.status).toBe(status);
  });
});

// --- no content --------------------------------------------------------------------------------------------------------

describe("schema: 'none' (no content)", () => {
  test.each<[number, string]>([
    [204, ''],
    [205, ''],
    [200, ''],
  ])('a %d with an empty body resolves undefined', async (status, body) => {
    const s = stub(() => new Response(status === 200 ? body : null, { status }));
    const result = await createApi({ fetch: s.fetch }).delete('/api/a', { schema: 'none' });
    typeEquals<typeof result, void>(true);
    expect(result).toBeUndefined();
  });

  test('a 2xx that has a body is "schema": a no-content call must not swallow a fallback page or a payload', async () => {
    const html = stub(() => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect((await problemOf(createApi({ fetch: html.fetch }).delete('/api/missing', { schema: 'none' }))).kind).toBe('schema');
    const payload = stub(() => json(200, { deleted: 1 }));
    expect((await problemOf(createApi({ fetch: payload.fetch }).delete('/api/a', { schema: 'none' }))).kind).toBe('schema');
  });

  test('failures still throw: a 404 stays not_found', async () => {
    const s = stub(() => problemResponse(404, 'Not Found'));
    expect((await problemOf(createApi({ fetch: s.fetch }).delete('/api/a', { schema: 'none' }))).kind).toBe('not_found');
  });
});

// --- HTTP failures -----------------------------------------------------------------------------------------------------

describe('HTTP failures are ApiProblems', () => {
  const cases: Array<[number, ProblemKind, keyof (typeof problemMessages)['en']]> = [
    [400, 'validation', 'validation'],
    [401, 'unauthorized', 'unauthorized'],
    [403, 'forbidden', 'forbidden'],
    [404, 'not_found', 'notFound'],
    [409, 'conflict', 'conflict'],
    [413, 'too_large', 'tooLarge'],
    [422, 'validation', 'validation'],
    [429, 'rate_limited', 'rateLimited'],
    [500, 'server', 'server'],
    [502, 'server', 'server'],
    [503, 'server', 'server'],
    [418, 'unknown', 'unknown'],
  ];

  test.each(cases)('%d (problem+json) -> kind %s, carrying the parsed problem, generic localised copy', async (status, kind, key) => {
    const s = stub(() => problemResponse(status, 'Server Title', undefined, 'server detail'));
    const error = await problemOf(createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none' }));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.problem?.title).toBe('Server Title');
    expect(error.problem?.detail).toBe('server detail');
    expect(error.problem?.status).toBe(status);
    expect(MESSAGE_KEYS[kind]).toBe(`problem:${key}`);
    for (const locale of LOCALES) {
      const view = describeProblem(error, translators[locale]);
      // 400/422 without field pointers deliberately read "unknown" (nothing to highlight): the wrapper only guarantees the kind.
      if (kind !== 'validation') expect(view.formMessage).toBe(text(locale, key));
      expect(view.kind).toBe(kind);
      expect(view.formMessage).not.toContain('server detail');
    }
  });

  test.each(cases)('%d with a non-JSON body (a proxy page) is still an ApiProblem of kind %s, without a parsed problem', async (status, kind) => {
    const s = stub(() => new Response('<html>Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } }));
    const error = await problemOf(createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none' }));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.problem).toBeUndefined();
  });

  test('an empty error body and a JSON error that is not a problem still map by status', async () => {
    const empty = stub(() => new Response(null, { status: 404 }));
    const notFound = await problemOf(createApi({ fetch: empty.fetch }).get('/api/a', { schema: 'none' }));
    expect(notFound.kind).toBe('not_found');
    expect(notFound.problem).toBeUndefined();
    const odd = stub(() => json(403, { code: 'X', message: 'Better Auth style' }));
    const forbidden = await problemOf(createApi({ fetch: odd.fetch }).get('/api/a', { schema: 'none' }));
    expect(forbidden.kind).toBe('forbidden');
    expect(forbidden.problem).toBeUndefined();
  });

  test('a problem+json body that is malformed JSON maps by status alone', async () => {
    const s = stub(() => new Response('{"title": ', { status: 500, headers: { 'content-type': 'application/problem+json' } }));
    const error = await problemOf(createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none' }));
    expect(error.kind).toBe('server');
    expect(error.problem).toBeUndefined();
  });

  test('a failed response is never schema-parsed: a schema-shaped error body is still an error', async () => {
    const s = stub(() => json(500, { ok: true, version: '1', database: 'ok' }));
    const error = await problemOf(createApi({ fetch: s.fetch }).get('/health', { schema: HealthResponse }));
    expect(error.kind).toBe('server');
  });
});

// --- 422 with pointers -------------------------------------------------------------------------------------------------

describe('422 with RFC 6901 pointers maps to form fields, end to end', () => {
  const errors = [
    { pointer: '/profile/age', detail: 'Too small' },
    { pointer: '/profile/age', detail: 'Must be an integer' },
    { pointer: '/items/0/name', detail: 'Required' },
    { pointer: '/a~1b/c~0d', detail: 'Escaped' },
    { pointer: '', detail: 'Whole form is wrong' },
  ];

  test('through the client: a 422 problem+json -> describeProblem(err).fieldErrors by dotted path, root pointer -> formErrors', async () => {
    const s = stub(() => problemResponse(422, 'Unprocessable Entity', errors));
    const error = await failure(createApi({ fetch: s.fetch }).post('/api/a', { body: {}, schema: 'none' }));
    const view = describeProblem(error, translators.en);
    expect(view.kind).toBe('validation');
    expect(view.status).toBe(422);
    expect(view.fieldErrors).toEqual({
      'profile.age': ['Too small', 'Must be an integer'],
      'items.0.name': ['Required'],
      'a/b.c~d': ['Escaped'],
    });
    expect(view.formErrors).toEqual(['Whole form is wrong']);
    expect(view.formMessage).toBe(text('en', 'validation'));
  });

  test('the real server helper output (fromZodError + problem()) round-trips into field errors', async () => {
    const Input = z.strictObject({ profile: z.strictObject({ age: z.int().min(5) }), items: z.array(z.strictObject({ name: z.string() })) });
    const parsed = Input.safeParse({ profile: { age: 1 }, items: [{ name: 3 }] });
    if (parsed.success) throw new Error('expected a zod failure');
    const s = stub(() => serverProblem(422, 'Unprocessable Entity', 'Validation failed', fromZodError(parsed.error)));
    const error = await failure(createApi({ fetch: s.fetch }).post('/api/a', { body: {}, schema: 'none' }));
    const view = describeProblem(error, translators.ru);
    expect(Object.keys(view.fieldErrors)).toEqual(['profile.age', 'items.0.name']);
    expect(view.fieldErrors['profile.age']?.length).toBe(1);
    expect(view.formMessage).toBe(text('ru', 'validation'));
    expect((error as ApiProblem).problem?.detail).toBe('Validation failed');
    expect((error as ApiProblem).problem?.errors).toEqual(fromZodError(parsed.error));
  });
});

// --- network, offline, timeout, abort ----------------------------------------------------------------------------------

describe('network failures', () => {
  test('fetch rejecting with a TypeError is kind "network", keeps the cause, and shows the offline message in every locale', async () => {
    const cause = new TypeError('Failed to fetch');
    const s = stub(() => Promise.reject(cause));
    const error = await problemOf(createApi({ fetch: s.fetch, online: () => true }).get('/api/a', { schema: 'none' }));
    expect(error.kind).toBe('network');
    expect(error.status).toBeUndefined();
    expect(error.problem).toBeUndefined();
    expect(error.cause).toBe(cause);
    expect(error.retryable).toBe(true);
    expect(MESSAGE_KEYS.network).toBe('problem:offline');
    for (const locale of LOCALES) expect(describeProblem(error, translators[locale]).formMessage).toBe(text(locale, 'offline'));
  });

  test('when the browser says it is offline the kind is "offline" (distinct), with the same message', async () => {
    const s = stub(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await problemOf(createApi({ fetch: s.fetch, online: () => false }).get('/api/a', { schema: 'none' }));
    expect(error.kind).toBe('offline');
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(true);
    expect(describeProblem(error, translators.kk).formMessage).toBe(text('kk', 'offline'));
  });

  test('online is read per request, so going offline between calls changes the kind', async () => {
    const s = stub(() => Promise.reject(new TypeError('Failed to fetch')));
    let online = true;
    const client = createApi({ fetch: s.fetch, online: () => online });
    const first = await problemOf(client.get('/api/a', { schema: 'none' }));
    online = false;
    const second = await problemOf(client.get('/api/a', { schema: 'none' }));
    expect([first.kind, second.kind]).toEqual(['network', 'offline']);
  });

  test('the default online seam reads navigator.onLine', async () => {
    const nav = globalThis.navigator;
    const own = Object.getOwnPropertyDescriptor(nav, 'onLine');
    restores.push(() => {
      if (own) Object.defineProperty(nav, 'onLine', own);
      else delete (nav as { onLine?: boolean }).onLine;
    });
    const s = stub(() => Promise.reject(new TypeError('Failed to fetch')));
    const client = createApi({ fetch: s.fetch });
    Object.defineProperty(nav, 'onLine', { configurable: true, get: () => false });
    expect((await problemOf(client.get('/api/a', { schema: 'none' }))).kind).toBe('offline');
    Object.defineProperty(nav, 'onLine', { configurable: true, get: () => true });
    expect((await problemOf(client.get('/api/a', { schema: 'none' }))).kind).toBe('network');
  });

  test('an error while reading the body of a response is a network problem, not a raw TypeError', async () => {
    const failed = new TypeError('terminated');
    const response = new Response('partial', { status: 200 });
    Object.defineProperty(response, 'text', { value: () => Promise.reject(failed) });
    const s = stub(() => response);
    const error = await problemOf(createApi({ fetch: s.fetch, online: () => true }).get('/api/a', { schema: z.object({}) }));
    expect(error.kind).toBe('network');
    expect(error.cause).toBe(failed);
  });

  test('a network failure never runs onUnauthorized handlers', async () => {
    let fired = 0;
    listen(() => void fired++);
    const s = stub(() => Promise.reject(new TypeError('Failed to fetch')));
    await failure(createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none' }));
    expect(fired).toBe(0);
  });
});

describe('timeout and abort', () => {
  test('AbortSignal.timeout() firing is an ApiProblem "network", not a raw DOMException', async () => {
    const s = stub(({ init }) => rejectOnAbort(init.signal));
    const error = await problemOf(createApi({ fetch: s.fetch, online: () => true }).get('/api/slow', { schema: 'none', signal: AbortSignal.timeout(5) }));
    expect(error.kind).toBe('network');
    expect(error.status).toBeUndefined();
    expect((error.cause as { name?: string }).name).toBe('TimeoutError');
    expect(describeProblem(error, translators.en).formMessage).toBe(text('en', 'offline'));
  });

  test('a TimeoutError raised by fetch itself (no signal involved) is a "network" ApiProblem too', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const s = stub(() => Promise.reject(timeout));
    const error = await problemOf(createApi({ fetch: s.fetch, online: () => true }).get('/api/slow', { schema: 'none' }));
    expect(error.kind).toBe('network');
    expect(error.cause).toBe(timeout);
  });

  test('a signal that already timed out while the body was being read is a "network" ApiProblem', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const response = new Response('partial', { status: 200 });
    Object.defineProperty(response, 'text', { value: () => Promise.reject(timeout) });
    const s = stub(() => response);
    const error = await problemOf(createApi({ fetch: s.fetch, online: () => true }).get('/api/slow', { schema: z.object({}), signal: AbortSignal.abort(timeout) }));
    expect(error.kind).toBe('network');
  });

  test('a caller abort rethrows the native AbortError UNWRAPPED, is never an ApiProblem and never notifies', async () => {
    let fired = 0;
    listen(() => void fired++);
    const controller = new AbortController();
    const s = stub(({ init }) => rejectOnAbort(init.signal));
    const pending = createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none', signal: controller.signal });
    controller.abort();
    const error = await failure(pending);
    expect(isApiProblem(error)).toBe(false);
    expect((error as DOMException).name).toBe('AbortError');
    expect(error).toBe(controller.signal.reason);
    expect(fired).toBe(0);
  });

  test('a caller abort with a custom reason rethrows that very reason', async () => {
    const reason = new Error('user navigated away');
    const controller = new AbortController();
    const s = stub(({ init }) => rejectOnAbort(init.signal));
    const pending = createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none', signal: controller.signal });
    controller.abort(reason);
    expect(await failure(pending)).toBe(reason);
  });

  test('an abort while the body is being read is rethrown unwrapped too', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('The operation was aborted.', 'AbortError');
    const response = new Response('partial', { status: 200 });
    Object.defineProperty(response, 'text', { value: () => Promise.reject(aborted) });
    controller.abort();
    const s = stub(() => response);
    expect(await failure(createApi({ fetch: s.fetch }).get('/api/a', { schema: z.object({}), signal: controller.signal }))).toBe(aborted);
  });

  test('there is no default timeout: no signal is sent unless the caller gives one', async () => {
    const s = stub(() => new Response(null, { status: 204 }));
    await createApi({ fetch: s.fetch }).get('/api/a', { schema: 'none' });
    expect(s.calls[0]?.init.signal ?? undefined).toBeUndefined();
  });
});

// --- onUnauthorized ----------------------------------------------------------------------------------------------------

describe('401 fires onUnauthorized', () => {
  const unauthorized = () => stub(() => problemResponse(401, 'Unauthorized'));

  test('exactly once per call, with the very ApiProblem the call rejects with', async () => {
    const seen: ApiProblem[] = [];
    listen((problem) => void seen.push(problem));
    const error = await problemOf(createApi({ fetch: unauthorized().fetch }).get('/api/me', { schema: 'none' }));
    expect(error.kind).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(error);
  });

  test('two separate 401 calls notify twice: once per call', async () => {
    let fired = 0;
    listen(() => void fired++);
    const client = createApi({ fetch: unauthorized().fetch });
    await failure(client.get('/api/me', { schema: 'none' }));
    await failure(client.get('/api/me', { schema: 'none' }));
    expect(fired).toBe(2);
  });

  test('a 401 whose body is not a problem (Better Auth style) or not JSON still notifies', async () => {
    let fired = 0;
    listen(() => void fired++);
    const odd = stub(() => json(401, { code: 'UNAUTHORIZED', message: 'nope' }));
    await failure(createApi({ fetch: odd.fetch }).get('/api/me', { schema: 'none' }));
    const html = stub(() => new Response('<html>401</html>', { status: 401, headers: { 'content-type': 'text/html' } }));
    await failure(createApi({ fetch: html.fetch }).get('/api/me', { schema: 'none' }));
    expect(fired).toBe(2);
  });

  test('skipUnauthorized suppresses the notification and the call still rejects with the 401 ApiProblem', async () => {
    let fired = 0;
    listen(() => void fired++);
    const error = await problemOf(createApi({ fetch: unauthorized().fetch }).post('/api/auth/sign-in', { body: {}, schema: 'none', skipUnauthorized: true }));
    expect(error.kind).toBe('unauthorized');
    expect(fired).toBe(0);
  });

  test('other statuses do not notify', async () => {
    let fired = 0;
    listen(() => void fired++);
    for (const status of [400, 403, 404, 409, 413, 422, 429, 500, 503]) {
      await failure(createApi({ fetch: stub(() => problemResponse(status, 'x')).fetch }).get('/api/a', { schema: 'none' }));
    }
    expect(fired).toBe(0);
  });

  test('a successful call does not notify', async () => {
    let fired = 0;
    listen(() => void fired++);
    await createApi({ fetch: stub(() => new Response(null, { status: 204 })).fetch }).get('/api/a', { schema: 'none' });
    expect(fired).toBe(0);
  });

  test('an unsubscribed handler is not called', async () => {
    let fired = 0;
    const off = onUnauthorized(() => void fired++);
    off();
    await failure(createApi({ fetch: unauthorized().fetch }).get('/api/me', { schema: 'none' }));
    expect(fired).toBe(0);
  });

  test('a handler that throws, and one that rejects, neither hide the ApiProblem nor starve the other handlers', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    restores.push(() => logged.mockRestore());
    let last = 0;
    listen(() => {
      throw new Error('boom');
    });
    listen(() => Promise.reject(new Error('async boom')));
    listen(() => void last++);
    const error = await problemOf(createApi({ fetch: unauthorized().fetch }).get('/api/me', { schema: 'none' }));
    expect(error.kind).toBe('unauthorized');
    expect(last).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the rejection is logged asynchronously
    expect(logged).toHaveBeenCalledTimes(2);
  });
});

// --- types -------------------------------------------------------------------------------------------------------------

describe('the response schema is required at the type level', () => {
  test('a call without `schema` does not typecheck (checked by tsc: a missing error fails `bun run typecheck`)', () => {
    // Never executed: only compiled. Each line is a type error today; if `schema` ever becomes optional the directive is
    // "unused" and tsc fails.
    const compileOnly = (client: ReturnType<typeof createApi>) => {
      // @ts-expect-error no options at all
      client.get('/api/a');
      // @ts-expect-error options without a schema
      client.post('/api/a', { body: {} });
      // @ts-expect-error a schema that is not 'none' and not a parser
      client.put('/api/a', { schema: 'nope' });
      // @ts-expect-error a schema-less delete
      client.delete('/api/a', { skipUnauthorized: true });
      // @ts-expect-error a typed generic no longer bypasses the schema
      client.patch<{ id: string }>('/api/a');
    };
    expect(typeof compileOnly).toBe('function');
  });

  test("`schema: 'none'` returns void and a Zod schema returns its output type", () => {
    const compileOnly = (client: ReturnType<typeof createApi>) => {
      const none = client.delete('/api/a', { schema: 'none' });
      typeEquals<typeof none, Promise<void>>(true);
      const health = client.get('/health', { schema: HealthResponse });
      typeEquals<typeof health, Promise<HealthResponse>>(true);
    };
    expect(typeof compileOnly).toBe('function');
  });
});

// --- instances ---------------------------------------------------------------------------------------------------------

describe('createApi', () => {
  test('exposes exactly get, post, put, patch and delete', () => {
    expect(Object.keys(createApi()).sort()).toEqual(['delete', 'get', 'patch', 'post', 'put']);
    expect(Object.keys(api).sort()).toEqual(['delete', 'get', 'patch', 'post', 'put']);
  });

  test('the default `api` is a client of its own, not a shared handle on any created one', () => {
    expect(api).not.toBe(createApi());
    expect(api.get).not.toBe(createApi().get);
  });

  test('instances are isolated: each uses its own fetch, baseUrl, online and language', async () => {
    const a = stub(() => new Response(null, { status: 204 }));
    const b = stub(() => Promise.reject(new TypeError('Failed to fetch')));
    const clientA = createApi({ fetch: a.fetch, baseUrl: 'http://a.test', language: () => 'ru' });
    const clientB = createApi({ fetch: b.fetch, baseUrl: 'http://b.test', language: () => 'en', online: () => false });
    await clientA.get('/one', { schema: 'none' });
    const error = await problemOf(clientB.get('/two', { schema: 'none' }));
    await clientA.get('/three', { schema: 'none' });
    expect(a.calls.map((call) => call.url)).toEqual(['http://a.test/one', 'http://a.test/three']);
    expect(a.calls.map((call) => call.headers.get('accept-language'))).toEqual(['ru', 'ru']);
    expect(b.calls.map((call) => call.url)).toEqual(['http://b.test/two']);
    expect(b.calls[0]?.headers.get('accept-language')).toBe('en');
    expect(error.kind).toBe('offline'); // B's `online` seam; A's default was never consulted
  });
});

// --- bundle hygiene ----------------------------------------------------------------------------------------------------

/** Lines of `source` that import zod or sonner in any way, or a RUNTIME value from @api-types. */
function forbiddenImports(source: string): string[] {
  const found: string[] = [];
  // `import ... from 'x'`, `import 'x'` and `export ... from 'x'`, at the start of a line or after a `;`.
  const statement = /(?:^|[\n;])[ \t]*(?:import|export)\b([^;'"`]*?)(['"])([^'"\n]+)\2/g;
  for (const [whole = '', clause = '', , specifier = ''] of source.matchAll(statement)) {
    const typeOnly = /^\s*type\b/.test(clause);
    if (/^(zod|sonner)(\/|$)/.test(specifier)) found.push(whole.trim());
    else if (specifier.startsWith('@api-types/') && !typeOnly) found.push(whole.trim());
  }
  for (const [call = ''] of source.matchAll(/\b(?:import|require)\s*\(\s*(['"])(?:zod|sonner)(?:\/[^'"]*)?\1/g)) found.push(call);
  return found;
}

describe('api.ts stays out of the entry bundle graph', () => {
  test('the scanner flags every way of pulling in zod, sonner or a runtime @api-types value', () => {
    for (const bad of [
      `import { z } from 'zod';`,
      `import type { ZodType } from "zod";`,
      `import * as z from 'zod/v4';`,
      `import 'zod';`,
      `import { toast } from 'sonner';`,
      `import { HealthResponse } from '@api-types/primitives';`,
      `import { type A, HealthResponse } from '@api-types/primitives';`,
      `import {\n  A,\n  B,\n} from '@api-types/primitives';`,
      `export { HealthResponse } from '@api-types/primitives';`,
      `const { z } = await import('zod');`,
      `const toast = require("sonner");`,
    ]) {
      expect(forbiddenImports(bad), bad).not.toEqual([]);
    }
  });

  test('the scanner lets type-only @api-types imports and relative imports through', () => {
    for (const fine of [
      `import type { ProblemDetails } from '@api-types/primitives';`,
      `import type {\n  A,\n  B,\n} from '@api-types/primitives';`,
      `import { i18n } from './i18n';`,
      `// import { z } from 'zod' is not imported here`,
    ]) {
      expect(forbiddenImports(fine), fine).toEqual([]);
    }
  });

  test("api.ts's own source imports no zod, no sonner and no runtime @api-types value", () => {
    const source = readFileSync(join(import.meta.dir, 'api.ts'), 'utf8');
    expect(source).toContain('createApi');
    expect(forbiddenImports(source)).toEqual([]);
  });
});

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROBLEM_CONTENT_TYPE, ProblemDetails as ProblemDetailsSchema } from '@api-types/primitives';
import { z } from 'zod';
import { fromZodError, problem as serverProblem } from '../../../api/src/http/problem';
import { createI18n, i18n, LANGUAGE_STORAGE_KEY, LOCALES, namespaceOf } from './i18n';
import {
  ApiProblem,
  classifyStatus,
  describeProblem,
  isApiProblem,
  MESSAGE_KEYS,
  notifyUnauthorized,
  onUnauthorized,
  parseProblemBody,
  pointerToPath,
  PROBLEM_KINDS,
  type ProblemKind,
  toFieldErrors,
  toFormErrors,
  toToast,
} from './problem';
import problemMessages from './problem.messages';

// --- global hygiene ----------------------------------------------------------------------------------------------------
// The only globals these tests touch: the i18n singleton (language, and a `problem` bundle it does not have under bun
// because import.meta.glob is undefined there), the unauthorized-handler registry and console.error. Every test that
// changes one of them registers its undo in `restores`; afterEach runs them all, so tests are order-independent.
// Runs from apps/web (preload registers happy-dom) and from the repo root (no DOM): neither needs a document here.

const INITIAL_LANGUAGE = i18n.language;
const restores: Array<() => void> = [];

afterEach(async () => {
  while (restores.length > 0) restores.pop()?.();
  await i18n.changeLanguage(INITIAL_LANGUAGE);
  // Lets the coalescing microtask of any notifyUnauthorized burst run before the next test starts.
  await Promise.resolve();
  if (typeof localStorage !== 'undefined') localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  if (typeof document !== 'undefined') document.documentElement.lang = '';
});

// --- helpers -----------------------------------------------------------------------------------------------------------

type Locale = (typeof LOCALES)[number];

/** The messages file as plain text lookups: `text('ru', 'notFound')`. */
const text = (locale: Locale, key: string): string => (problemMessages[locale] as Record<string, string>)[key] ?? '';
const messageKeyName = (key: string): string => key.replace(/^problem:/, '');

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

/** An isolated i18n instance loaded exactly like the app loads it: file `problem.messages.ts` -> namespace `problem`. */
function translatorFor(locale: Locale) {
  const instance = createI18n({
    modules: { './problem.messages.ts': { default: problemMessages } },
    languages: [locale],
    storage: memoryStorage(),
    root: { lang: '' },
    dev: false,
  });
  return (key: string): string => instance.t(key);
}

const translators: Record<Locale, (key: string) => string> = {
  kk: translatorFor('kk'),
  ru: translatorFor('ru'),
  en: translatorFor('en'),
};

/** What lib/api.ts will do with a failed response: classify, parse the body, wrap. */
function problemFor(status: number, body?: unknown): ApiProblem {
  const parsed = body === undefined ? undefined : parseProblemBody(body, status);
  return new ApiProblem({ kind: classifyStatus(status), status, ...(parsed && { problem: parsed }) });
}

const CYRILLIC = /[Ѐ-ӿ]/;

// --- pointerToPath -------------------------------------------------------------------------------------------------------

describe('pointerToPath (RFC 6901 -> dotted form path)', () => {
  test.each<[string, string]>([
    ['/name', 'name'],
    ['/profile/age', 'profile.age'],
    ['/items/0/name', 'items.0.name'],
    ['/items/12', 'items.12'],
    ['/a~1b', 'a/b'],
    ['/a~0b', 'a~b'],
    ['/a~1b/c~0d', 'a/b.c~d'],
    ['/a~01', 'a~1'], // "~01" is "~" then "1": ~1 must be unescaped BEFORE ~0, so this never becomes "/"
    ['/~01~10', '~1/0'],
  ])('%s -> %s', (pointer, path) => {
    expect(pointerToPath(pointer)).toBe(path);
  });

  test('the root pointer (whole document) and a pointer that is not RFC 6901 have no field path', () => {
    expect(pointerToPath('')).toBe('');
    expect(pointerToPath('no-leading-slash')).toBe('');
  });
});

// --- ApiProblem ----------------------------------------------------------------------------------------------------------

describe('ApiProblem', () => {
  test('is an Error that carries kind, status, the parsed problem, issues and cause', () => {
    const body = parseProblemBody({ title: 'Unprocessable', status: 422, detail: 'Bad input' }, 422);
    const cause = new Error('root cause');
    const issues = [{ path: ['a', 0], message: 'Required' }];
    const error = new ApiProblem({ kind: 'validation', status: 422, problem: body, issues, cause });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiProblem);
    expect(error.name).toBe('ApiProblem');
    expect(error.kind).toBe('validation');
    expect(error.status).toBe(422);
    expect(error.problem).toBe(body);
    expect(error.issues).toBe(issues);
    expect(error.cause).toBe(cause);
  });

  test('a failure with no response has no status and no problem', () => {
    const error = new ApiProblem({ kind: 'network', cause: new TypeError('Failed to fetch') });
    expect(error.status).toBeUndefined();
    expect(error.problem).toBeUndefined();
    expect(error.issues).toBeUndefined();
  });

  test('message: the problem detail, else its title, else the kind', () => {
    expect(new ApiProblem({ kind: 'validation', problem: { type: 'about:blank', title: 'T', status: 422, detail: 'D', errors: [] } }).message).toBe('D');
    expect(new ApiProblem({ kind: 'validation', problem: { type: 'about:blank', title: 'T', status: 422, errors: [] } }).message).toBe('T');
    expect(new ApiProblem({ kind: 'offline' }).message).toBe('offline');
  });

  test('a non-string detail or instance in a wire body never becomes the message', () => {
    const error = problemFor(422, { title: 'T', status: 422, detail: 5, instance: {} });
    expect(error.message).toBe('T');
    expect(error.problem?.detail).toBeUndefined();
  });

  test('isApiProblem is true only for real ApiProblem instances', () => {
    expect(isApiProblem(new ApiProblem({ kind: 'server', status: 500 }))).toBe(true);
    expect(isApiProblem(new Error('x'))).toBe(false);
    expect(isApiProblem({ name: 'ApiProblem', kind: 'server', status: 500 })).toBe(false);
    expect(isApiProblem(null)).toBe(false);
    expect(isApiProblem(undefined)).toBe(false);
    expect(isApiProblem('server')).toBe(false);
  });

  test.each<[ProblemKind, boolean]>([
    ['offline', true],
    ['network', true],
    ['rate_limited', true],
    ['server', true],
    ['unauthorized', false],
    ['forbidden', false],
    ['not_found', false],
    ['conflict', false],
    ['too_large', false],
    ['validation', false],
    ['schema', false],
    ['unknown', false],
  ])('kind %s retryable: %p', (kind, retryable) => {
    expect(new ApiProblem({ kind }).retryable).toBe(retryable);
  });
});

describe('classifyStatus', () => {
  test.each<[number, ProblemKind]>([
    [400, 'validation'],
    [422, 'validation'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'too_large'],
    [429, 'rate_limited'],
    [500, 'server'],
    [502, 'server'],
    [503, 'server'],
    [599, 'server'],
    [405, 'unknown'],
    [418, 'unknown'],
  ])('%d -> %s', (status, kind) => {
    expect(classifyStatus(status)).toBe(kind);
  });
});

// --- describeProblem: generic messages -------------------------------------------------------------------------------------

describe('describeProblem: every generic status maps to its localized message in all three locales', () => {
  // [status, kind, message key in problem.messages.ts]
  const cases: [number, ProblemKind, string][] = [
    [401, 'unauthorized', 'unauthorized'],
    [403, 'forbidden', 'forbidden'],
    [404, 'not_found', 'notFound'],
    [413, 'too_large', 'tooLarge'],
    [429, 'rate_limited', 'rateLimited'],
    [500, 'server', 'server'],
    [503, 'server', 'server'],
    [418, 'unknown', 'unknown'],
  ];

  describe.each(cases)('%d -> kind %s -> "problem:%s"', (status, kind, key) => {
    const error = problemFor(status, { title: 'T', status, detail: 'server detail in English' });

    test('maps to the kind, the status and the message key', () => {
      const view = describeProblem(error, translators.en);
      expect(view.kind).toBe(kind);
      expect(view.status).toBe(status);
      expect<string>(MESSAGE_KEYS[kind]).toBe(`problem:${key}`);
    });

    test.each([...LOCALES])('in %s: formMessage and toast carry that locale\'s text for the key', (locale) => {
      const view = describeProblem(error, translators[locale]);
      expect(view.formMessage).toBe(text(locale, key));
      expect(view.formMessage.trim()).not.toBe('');
      expect(view.toast).toEqual({ message: view.formMessage });
      expect(view.formMessage).not.toContain('server detail'); // generic copy: the server's English never reaches the user
    });

    test('the three locales say three different things, and only en is Latin', () => {
      const [kk, ru, en] = [describeProblem(error, translators.kk), describeProblem(error, translators.ru), describeProblem(error, translators.en)];
      expect(new Set([kk.formMessage, ru.formMessage, en.formMessage]).size).toBe(3);
      expect(kk.formMessage).toMatch(CYRILLIC);
      expect(ru.formMessage).toMatch(CYRILLIC);
      expect(en.formMessage).not.toMatch(CYRILLIC);
    });
  });

  test.each([...LOCALES])('in %s the seven generic statuses read as seven different messages (no two collapse into one)', (locale) => {
    const statuses = [401, 403, 404, 413, 429, 500, 418]; // 503 shares 500's message on purpose
    const messages = statuses.map((status) => describeProblem(problemFor(status), translators[locale]).formMessage);
    expect(new Set(messages).size).toBe(statuses.length);
  });

  test('the English copy says what each failure is about (a swapped message would not survive this)', () => {
    const en = (status: number) => describeProblem(problemFor(status), translators.en).formMessage;
    expect(en(401)).toMatch(/session|sign in/i);
    expect(en(403)).toMatch(/access|permission/i);
    expect(en(404)).toMatch(/find|found/i);
    expect(en(413)).toMatch(/large|big/i);
    expect(en(429)).toMatch(/many|wait/i);
    expect(en(500)).toMatch(/wrong|our side/i);
    expect(en(418)).toMatch(/wrong/i);
  });

  test('a network failure shows the offline message in every locale', () => {
    const error = new ApiProblem({ kind: 'network', cause: new TypeError('Failed to fetch') });
    for (const locale of LOCALES) {
      const view = describeProblem(error, translators[locale]);
      expect(view.kind).toBe('network');
      expect(view.status).toBeUndefined();
      expect(view.formMessage).toBe(text(locale, 'offline'));
    }
    expect(describeProblem(error, translators.en).formMessage).toMatch(/connection|internet/i);
  });

  test('offline and network are distinct kinds that share ONE message key', () => {
    expect(PROBLEM_KINDS).toContain('offline');
    expect(PROBLEM_KINDS).toContain('network');
    expect(MESSAGE_KEYS.network).toBe('problem:offline');
    expect(MESSAGE_KEYS.offline).toBe('problem:offline');
    for (const locale of LOCALES) {
      const offline = describeProblem(new ApiProblem({ kind: 'offline' }), translators[locale]);
      const network = describeProblem(new ApiProblem({ kind: 'network' }), translators[locale]);
      expect(offline.kind).toBe('offline');
      expect(network.kind).toBe('network');
      expect(offline.formMessage).toBe(network.formMessage);
      expect(offline.formMessage).toBe(text(locale, 'offline'));
    }
  });

  test('a response whose body fails the caller\'s schema is kind "schema" with its own message', () => {
    expect(PROBLEM_KINDS).toContain('schema');
    expect(PROBLEM_KINDS as readonly string[]).not.toContain('bad_response');
    expect(MESSAGE_KEYS.schema).toBe('problem:schema');
    const error = new ApiProblem({ kind: 'schema', status: 200, issues: [{ path: ['ok'], message: 'Expected boolean' }] });
    for (const locale of LOCALES) {
      const view = describeProblem(error, translators[locale]);
      expect(view.kind).toBe('schema');
      expect(view.status).toBe(200);
      expect(view.formMessage).toBe(text(locale, 'schema'));
      expect(view.formMessage).not.toBe(text(locale, 'unknown'));
    }
  });

  test('anything that is not an ApiProblem is kind "unknown" with the unknown message', () => {
    for (const thrown of [new Error('boom'), 'a string', 42, null, undefined, { kind: 'server' }]) {
      for (const locale of LOCALES) {
        const view = describeProblem(thrown, translators[locale]);
        expect(view.kind).toBe('unknown');
        expect(view.status).toBeUndefined();
        expect(view.fieldErrors).toEqual({});
        expect(view.formErrors).toEqual([]);
        expect(view.formMessage).toBe(text(locale, 'unknown'));
      }
    }
  });
});

// --- describeProblem: 422 with pointers ------------------------------------------------------------------------------------

describe('describeProblem: 422 with RFC 6901 pointers', () => {
  const errors = [
    { pointer: '/profile/age', detail: 'Too small' },
    { pointer: '/profile/age', detail: 'Must be an integer' },
    { pointer: '/items/0/name', detail: 'Required' },
    { pointer: '/a~1b/c~0d', detail: 'Escaped' },
    { pointer: '', detail: 'Whole form is wrong' },
    { pointer: '/profile/age', detail: 'Third on the same field' },
  ];
  const error = problemFor(422, { type: 'about:blank', title: 'Unprocessable Entity', status: 422, errors });

  test('pointers become dotted field paths: nested, array index, ~0 / ~1 escapes; several errors per field accumulate in order', () => {
    const view = describeProblem(error, translators.en);
    expect(view.kind).toBe('validation');
    expect(view.status).toBe(422);
    expect(view.fieldErrors).toEqual({
      'profile.age': ['Too small', 'Must be an integer', 'Third on the same field'],
      'items.0.name': ['Required'],
      'a/b.c~d': ['Escaped'],
    });
    expect(view.fieldErrors['profile.age']?.[0]).toBe('Too small'); // first stays first
  });

  test('the root pointer is form-level, not a field', () => {
    const view = describeProblem(error, translators.en);
    expect(view.formErrors).toEqual(['Whole form is wrong']);
    expect(Object.keys(view.fieldErrors)).not.toContain('');
  });

  test.each([...LOCALES])('the localized "check the highlighted fields" message in %s', (locale) => {
    const view = describeProblem(error, translators[locale]);
    expect(view.formMessage).toBe(text(locale, 'validation'));
    expect(view.toast.message).toBe(text(locale, 'validation'));
    expect(view.formMessage).not.toBe(text(locale, 'unknown'));
  });

  test('a 400 is validation too', () => {
    const view = describeProblem(problemFor(400, { title: 'Bad', status: 400, errors: [{ pointer: '/x', detail: 'no' }] }), translators.en);
    expect(view.kind).toBe('validation');
    expect(view.fieldErrors).toEqual({ x: ['no'] });
  });

  test('the field errors object has no prototype: a "/__proto__" pointer is just a key', () => {
    const view = describeProblem(problemFor(422, { title: 'x', status: 422, errors: [{ pointer: '/__proto__', detail: 'p' }, { pointer: '/ok', detail: 'fine' }] }), translators.en);
    expect(Object.getPrototypeOf(view.fieldErrors)).toBeNull();
    expect(Object.keys(view.fieldErrors)).toEqual(['__proto__', 'ok']);
    expect(view.fieldErrors['__proto__']).toEqual(['p']);
    expect(({} as Record<string, unknown>).ok).toBeUndefined();
  });

  test.each<[string, ApiProblem]>([
    ['no problem body at all', problemFor(422)],
    ['422 with errors: []', problemFor(422, { title: 'x', status: 422, errors: [] })],
    ['422 with no errors member', problemFor(422, { title: 'x', status: 422 })],
    ['400 with no errors member', problemFor(400, { title: 'x', status: 400 })],
    ['422 whose only errors are malformed', problemFor(422, { title: 'x', status: 422, errors: [{ pointer: 1, detail: 'x' }, { detail: 'y' }] })],
    ['422 whose only error is root-level (nothing to highlight)', problemFor(422, { title: 'x', status: 422, errors: [{ pointer: '', detail: 'root' }] })],
  ])('%s: nothing is highlighted, so it must not say "check the highlighted fields"', (_label, withoutFields) => {
    for (const locale of LOCALES) {
      const view = describeProblem(withoutFields, translators[locale]);
      expect(view.kind).toBe('validation');
      expect(view.formMessage).toBe(text(locale, 'unknown'));
      expect(view.formMessage).not.toBe(text(locale, 'validation'));
      expect(view.toast.message).toBe(text(locale, 'unknown'));
      expect(toToast(withoutFields, translators[locale]).message).toBe(text(locale, 'unknown'));
    }
  });

  test('root-level errors are still handed to the screen even when there are no fields', () => {
    const view = describeProblem(problemFor(422, { title: 'x', status: 422, errors: [{ pointer: '', detail: 'root' }] }), translators.en);
    expect(view.formErrors).toEqual(['root']);
    expect(view.fieldErrors).toEqual({});
  });
});

// --- defaultTranslate through the real i18n singleton -----------------------------------------------------------------------

describe('describeProblem without `t` uses the i18n singleton (defaultTranslate)', () => {
  // Under bun `import.meta.glob` is undefined, so the singleton starts without the `problem` namespace; load it the way the
  // app's glob would. If some day it is already loaded, use it as is and leave it alone.
  function loadProblemNamespaceIntoSingleton(): void {
    for (const locale of LOCALES) {
      if (i18n.hasResourceBundle(locale, 'problem')) continue;
      i18n.addResourceBundle(locale, 'problem', problemMessages[locale], true, true);
      restores.push(() => i18n.removeResourceBundle(locale, 'problem'));
    }
  }

  test.each([...LOCALES])('follows the current language: %s', async (locale) => {
    loadProblemNamespaceIntoSingleton();
    await i18n.changeLanguage(locale);
    const error = problemFor(404, { title: 'Not Found', status: 404 });
    expect(describeProblem(error).formMessage).toBe(text(locale, 'notFound'));
    expect(describeProblem(error).toast.message).toBe(text(locale, 'notFound'));
    expect(toToast(error)).toEqual({ message: text(locale, 'notFound') });
    expect(toToast('not an ApiProblem').message).toBe(text(locale, 'unknown'));
  });

  test('the language is read at call time, not captured when the module loads', async () => {
    loadProblemNamespaceIntoSingleton();
    const error = new ApiProblem({ kind: 'network' });
    await i18n.changeLanguage('ru');
    const inRussian = describeProblem(error).formMessage;
    await i18n.changeLanguage('en');
    const inEnglish = describeProblem(error).formMessage;
    expect(inRussian).toBe(text('ru', 'offline'));
    expect(inEnglish).toBe(text('en', 'offline'));
    expect(inRussian).not.toBe(inEnglish);
  });

  test('the namespace is `problem`: the file name maps to it, and the singleton resolves `problem:<key>` from it', async () => {
    expect(namespaceOf('../lib/problem.messages.ts')).toBe('problem');
    loadProblemNamespaceIntoSingleton();
    await i18n.changeLanguage('en');
    expect(i18n.t('problem:offline')).toBe(text('en', 'offline'));
  });
});

// --- toToast / toFieldErrors / toFormErrors ------------------------------------------------------------------------------------

describe('toToast', () => {
  test('returns the toast as data: { message } from the given t, nothing shown here', () => {
    expect(toToast(new ApiProblem({ kind: 'rate_limited', status: 429 }), translators.en)).toEqual({ message: text('en', 'rateLimited') });
    expect(toToast(new ApiProblem({ kind: 'rate_limited', status: 429 }), translators.ru)).toEqual({ message: text('ru', 'rateLimited') });
  });

  test('a non-ApiProblem gets the unknown message', () => {
    expect(toToast(new Error('x'), translators.kk)).toEqual({ message: text('kk', 'unknown') });
  });

  test('t receives the `problem:<key>` message key of the kind', () => {
    const seen: string[] = [];
    toToast(new ApiProblem({ kind: 'not_found', status: 404 }), (key) => (seen.push(key), ''));
    expect(seen).toEqual(['problem:notFound']);
  });
});

describe('toFieldErrors / toFormErrors', () => {
  const wire = (errors: unknown) => ({ type: 'about:blank', title: 'x', status: 422, errors }) as Parameters<typeof toFieldErrors>[0];

  test('nothing to report for no problem, no errors, or errors that is not a list', () => {
    expect(toFieldErrors(undefined)).toEqual({});
    expect(toFormErrors(undefined)).toEqual([]);
    expect(toFieldErrors(wire([]))).toEqual({});
    expect(toFieldErrors(wire('nope'))).toEqual({});
    expect(toFormErrors(wire('nope'))).toEqual([]);
  });

  test('entries that are not { pointer: string, detail: string } are ignored', () => {
    const errors = [{ pointer: '/ok', detail: 'fine' }, { pointer: 1, detail: 'x' }, { pointer: '/b' }, { detail: 'd' }, null, 'str', { pointer: '/c', detail: 3 }];
    expect(toFieldErrors(wire(errors))).toEqual({ ok: ['fine'] });
    expect(toFormErrors(wire(errors))).toEqual([]);
  });

  test('field errors accumulate per path in wire order; root errors are excluded from them', () => {
    const problem = wire([
      { pointer: '/a', detail: '1' },
      { pointer: '', detail: 'root 1' },
      { pointer: '/b', detail: '2' },
      { pointer: '/a', detail: '3' },
      { pointer: '', detail: 'root 2' },
    ]);
    expect(toFieldErrors(problem)).toEqual({ a: ['1', '3'], b: ['2'] });
    expect(toFormErrors(problem)).toEqual(['root 1', 'root 2']);
  });

  test('a pointer that is not RFC 6901 is a form-level error rather than a field called ""', () => {
    const problem = wire([{ pointer: 'oops', detail: 'malformed' }]);
    expect(toFieldErrors(problem)).toEqual({});
    expect(toFormErrors(problem)).toEqual(['malformed']);
  });

  test('the field errors object has no prototype and prototype-named keys do not pollute', () => {
    const fields = toFieldErrors(wire([{ pointer: '/__proto__', detail: 'p' }, { pointer: '/constructor', detail: 'c' }]));
    expect(Object.getPrototypeOf(fields)).toBeNull();
    expect(Object.keys(fields)).toEqual(['__proto__', 'constructor']);
    expect(Object.prototype.hasOwnProperty.call(fields, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).p).toBeUndefined();
  });
});

// --- parseProblemBody ----------------------------------------------------------------------------------------------------------

describe('parseProblemBody', () => {
  test.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'Not Found'],
    ['a number', 404],
    ['an array', [{ title: 'x' }]],
    ['an object without a title (e.g. another framework\'s error shape)', { code: 'X', message: 'Better Auth style' }],
    ['an object whose title is not a string', { title: 5, status: 400 }],
  ])('%s is not a problem', (_label, body) => {
    expect(parseProblemBody(body, 400)).toBeUndefined();
  });

  test('a minimal body gets the schema defaults (type "about:blank", errors [])', () => {
    expect(parseProblemBody({ title: 'Nope', status: 404 }, 500)).toStrictEqual({ type: 'about:blank', title: 'Nope', status: 404, errors: [] });
  });

  test('keeps type, title, status, detail, instance and well-formed errors', () => {
    const wire = { type: 'https://example.test/problems/x', title: 'Nope', status: 422, detail: 'd', instance: '/i', errors: [{ pointer: '/a', detail: 'bad' }] };
    expect(parseProblemBody(wire, 500)).toStrictEqual(wire);
  });

  test('status: the body\'s own valid status wins; anything else falls back to the HTTP status', () => {
    expect(parseProblemBody({ title: 'x', status: 422 }, 500)?.status).toBe(422);
    for (const status of [undefined, '422', 422.5, 99, 600, null, {}]) {
      expect(parseProblemBody({ title: 'x', status }, 503)?.status).toBe(503);
    }
  });

  test('type, detail and instance survive only when they are strings', () => {
    const parsed = parseProblemBody({ title: 'T', status: 422, type: 7, detail: 5, instance: {} }, 422);
    expect(parsed).toStrictEqual({ type: 'about:blank', title: 'T', status: 422, errors: [] });
    expect(parsed && 'detail' in parsed).toBe(false);
    expect(parsed && 'instance' in parsed).toBe(false);
  });

  test('errors: only well-formed { pointer: string, detail: string } entries are kept, and only those two members', () => {
    const parsed = parseProblemBody(
      {
        title: 'x',
        status: 422,
        errors: [
          { pointer: '/a', detail: 'ok', code: 'extra' },
          { pointer: 1, detail: 'no' },
          { pointer: '/b' },
          { detail: 'no pointer' },
          { pointer: '/c', detail: 3 },
          null,
          'str',
          { pointer: '', detail: 'root' },
        ],
      },
      422,
    );
    expect(parsed?.errors).toStrictEqual([
      { pointer: '/a', detail: 'ok' },
      { pointer: '', detail: 'root' },
    ]);
  });

  test('errors that is not a list is dropped to []', () => {
    expect(parseProblemBody({ title: 'x', status: 422, errors: 'nope' }, 422)?.errors).toStrictEqual([]);
    expect(parseProblemBody({ title: 'x', status: 422, errors: { pointer: '/a', detail: 'b' } }, 422)?.errors).toStrictEqual([]);
  });

  test('the result is built field by field: unknown members are NOT copied over from the wire body', () => {
    const wire = JSON.parse('{"title":"T","status":400,"extension":1,"nested":{"a":1},"__proto__":{"polluted":true}}');
    const parsed = parseProblemBody(wire, 400);
    expect(parsed).toStrictEqual({ type: 'about:blank', title: 'T', status: 400, errors: [] });
    expect((parsed as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('never hands out a non-string where the type says string (the ApiProblem message used to become "5")', () => {
    const hostile = [
      { title: 'T', status: 400, detail: 5, instance: {} },
      { title: 'T', status: 400, detail: ['x'], instance: 9, type: null },
      { title: 'T', status: '400', detail: { toString: () => 'evil' } },
    ];
    for (const body of hostile) {
      const parsed = parseProblemBody(body, 400);
      expect(typeof parsed?.title).toBe('string');
      expect(typeof parsed?.type).toBe('string');
      expect(typeof parsed?.status).toBe('number');
      expect(parsed?.detail === undefined || typeof parsed.detail === 'string').toBe(true);
      expect(parsed?.instance === undefined || typeof parsed.instance === 'string').toBe(true);
      expect(new ApiProblem({ kind: 'validation', problem: parsed }).message).toBe('T');
    }
  });
});

// --- drift guard: the hand-written parser vs the shared runtime schema ------------------------------------------------------

describe('parseProblemBody stays in step with the shared ProblemDetails schema (drift guard)', () => {
  const errors = [
    { pointer: '/profile/age', detail: 'Too small' },
    { pointer: '/items/0/name', detail: 'Required' },
    { pointer: '', detail: 'Whole form' },
  ];

  test.each<[string, Record<string, unknown>]>([
    ['title and status only', { title: 'Not Found', status: 404 }],
    ['type given', { type: 'https://example.test/x', title: 'X', status: 409 }],
    ['detail and instance', { type: 'about:blank', title: 'X', status: 500, detail: 'd', instance: '/i/1' }],
    ['errors with pointers, incl. the root', { type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'd', errors }],
    ['empty errors', { title: 'X', status: 400, errors: [] }],
  ])('a valid body (%s) parses identically', (_label, wire) => {
    const expected = ProblemDetailsSchema.parse(wire);
    expect(parseProblemBody(wire, 599)).toStrictEqual(expected);
  });

  test.each<[string, Record<string, unknown>]>([
    ['non-string detail', { title: 'T', status: 422, detail: 5 }],
    ['object instance', { title: 'T', status: 422, instance: {} }],
    ['numeric type', { title: 'T', status: 422, type: 7 }],
    ['string status', { title: 'T', status: '422' }],
    ['status out of range', { title: 'T', status: 700 }],
    ['errors that is not a list', { title: 'T', status: 422, errors: 'x' }],
  ])('a body the schema rejects (%s) never leaks the offending member through the parser', (_label, wire) => {
    expect(ProblemDetailsSchema.safeParse(wire).success).toBe(false);
    const parsed = parseProblemBody(wire, 422);
    // Lenient where the schema is strict: the bad member is dropped/defaulted, the rest is still usable.
    expect(parsed).toStrictEqual({ type: 'about:blank', title: 'T', status: 422, errors: [] });
    expect(ProblemDetailsSchema.safeParse(parsed).success).toBe(true);
  });

  test('a body with no string title is rejected by both', () => {
    for (const wire of [{ status: 422 }, { title: 1, status: 422 }]) {
      expect(ProblemDetailsSchema.safeParse(wire).success).toBe(false);
      expect(parseProblemBody(wire, 422)).toBeUndefined();
    }
  });

  test('whatever the parser returns for a usable body is itself valid for the schema', () => {
    for (const wire of [{ title: 'a', status: 404 }, { title: 'b', status: 422, errors }, { title: 'c', status: 12, detail: 3, instance: [] }]) {
      expect(ProblemDetailsSchema.safeParse(parseProblemBody(wire, 503)).success).toBe(true);
    }
  });
});

describe('real server output (apps/api/src/http/problem.ts) round-trips into fieldErrors', () => {
  const Schema = z.strictObject({
    profile: z.strictObject({ age: z.int().min(5) }),
    items: z.array(z.strictObject({ name: z.string() })),
    'a/b': z.string(),
    'c~d': z.string(),
  });

  async function roundTrip(response: Response): Promise<{ error: ApiProblem; body: unknown }> {
    expect(response.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    const body: unknown = await response.json();
    const parsed = parseProblemBody(body, response.status);
    return { body, error: new ApiProblem({ kind: classifyStatus(response.status), status: response.status, ...(parsed && { problem: parsed }) }) };
  }

  test('fromZodError + problem(): nested, array index and escaped keys reach the form with the server\'s texts', async () => {
    const result = Schema.safeParse({ profile: { age: 1 }, items: [{ name: 3 }], 'a/b': 1, 'c~d': 2 });
    if (result.success) throw new Error('expected a zod failure');
    const { error, body } = await roundTrip(serverProblem(422, 'Unprocessable Entity', 'Validation failed', fromZodError(result.error)));

    expect(parseProblemBody(body, 422)).toStrictEqual(ProblemDetailsSchema.parse(body));
    const view = describeProblem(error, translators.en);
    expect(view.kind).toBe('validation');
    expect(Object.keys(view.fieldErrors)).toEqual(['profile.age', 'items.0.name', 'a/b', 'c~d']);
    const message = (path: (string | number)[]) => result.error.issues.find((issue) => issue.path.join('.') === path.join('.'))?.message ?? '(no such issue)';
    expect(view.fieldErrors['profile.age']).toEqual([message(['profile', 'age'])]);
    expect(view.fieldErrors['items.0.name']).toEqual([message(['items', 0, 'name'])]);
    expect(view.formMessage).toBe(text('en', 'validation'));
    expect(error.message).toBe('Validation failed');
  });

  test('a root-level zod issue (pointer "") lands in formErrors', async () => {
    const result = z.string().safeParse(5);
    if (result.success) throw new Error('expected a zod failure');
    const { error } = await roundTrip(serverProblem(422, 'Unprocessable Entity', undefined, fromZodError(result.error)));
    const view = describeProblem(error, translators.en);
    expect(view.formErrors).toEqual([result.error.issues[0]?.message ?? '']);
    expect(view.fieldErrors).toEqual({});
    expect(view.formMessage).toBe(text('en', 'unknown')); // only a form-level error: nothing to highlight
  });

  test('problem() without errors: a generic status still maps to its message', async () => {
    const { error, body } = await roundTrip(serverProblem(404, 'Not Found'));
    expect(parseProblemBody(body, 404)).toStrictEqual(ProblemDetailsSchema.parse(body));
    const view = describeProblem(error, translators.ru);
    expect(view.kind).toBe('not_found');
    expect(view.fieldErrors).toEqual({});
    expect(view.formMessage).toBe(text('ru', 'notFound'));
  });
});

// --- onUnauthorized ------------------------------------------------------------------------------------------------------------

describe('onUnauthorized', () => {
  const unauthorized = () => new ApiProblem({ kind: 'unauthorized', status: 401 });
  /** Registers a handler for the rest of the test only. */
  function listen(handler: Parameters<typeof onUnauthorized>[0]): () => void {
    const off = onUnauthorized(handler);
    restores.push(off);
    return off;
  }
  const silenceConsoleError = () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    restores.push(() => logged.mockRestore());
    return logged;
  };
  const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test('a registered handler receives the ApiProblem that was notified', () => {
    const seen: ApiProblem[] = [];
    listen((problem) => void seen.push(problem));
    const problem = unauthorized();
    notifyUnauthorized(problem);
    expect(seen).toEqual([problem]);
    expect(seen[0]).toBe(problem);
  });

  test('every registered handler is called, in registration order', () => {
    const order: string[] = [];
    listen(() => void order.push('first'));
    listen(() => void order.push('second'));
    listen(() => void order.push('third'));
    notifyUnauthorized(unauthorized());
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('onUnauthorized returns an unsubscribe function; after it the handler is not called', async () => {
    let calls = 0;
    const off = onUnauthorized(() => void calls++);
    expect(typeof off).toBe('function');
    off();
    notifyUnauthorized(unauthorized());
    expect(calls).toBe(0);
  });

  test('unsubscribing one handler leaves the others; unsubscribing twice is harmless, even for the same function registered twice', async () => {
    const calls: string[] = [];
    const shared = () => void calls.push('shared');
    const offFirst = listen(shared);
    listen(shared);
    listen(() => void calls.push('other'));
    offFirst();
    offFirst();
    notifyUnauthorized(unauthorized());
    expect(calls).toEqual(['shared', 'other']);
  });

  test('a handler registered later hears only later bursts', async () => {
    const early: number[] = [];
    const late: number[] = [];
    listen(() => void early.push(1));
    notifyUnauthorized(unauthorized());
    await nextTick();
    listen(() => void late.push(1));
    notifyUnauthorized(unauthorized());
    expect(early).toHaveLength(2);
    expect(late).toHaveLength(1);
  });

  test('a throwing handler is logged, does not stop the others and does not throw out of notify', () => {
    const logged = silenceConsoleError();
    const failure = new Error('boom');
    let second = 0;
    listen(() => {
      throw failure;
    });
    listen(() => void second++);
    expect(() => notifyUnauthorized(unauthorized())).not.toThrow();
    expect(second).toBe(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toContain(failure);
  });

  test('an async handler that rejects is logged as well, not left as an unhandled rejection', async () => {
    const logged = silenceConsoleError();
    const failure = new Error('refresh failed');
    let second = 0;
    listen(async () => {
      throw failure;
    });
    listen(() => void second++);
    notifyUnauthorized(unauthorized());
    await nextTick();
    expect(second).toBe(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toContain(failure);
  });

  test('the ApiProblem is never hidden: notify returns normally, so the caller still throws its own error', () => {
    silenceConsoleError();
    listen(() => {
      throw new Error('boom');
    });
    const problem = unauthorized();
    const rethrown = (() => {
      try {
        notifyUnauthorized(problem);
        throw problem; // what lib/api.ts does right after notifying
      } catch (error) {
        return error;
      }
    })();
    expect(rethrown).toBe(problem);
  });

  test('with no handler registered notifying is a silent no-op', () => {
    const logged = silenceConsoleError();
    expect(() => notifyUnauthorized(unauthorized())).not.toThrow();
    expect(logged).not.toHaveBeenCalled();
  });

  describe('coalescing: one burst of 401s notifies each handler once', () => {
    test('five synchronous notifications call every handler exactly once, with the first problem', () => {
      const a: ApiProblem[] = [];
      const b: ApiProblem[] = [];
      listen((problem) => void a.push(problem));
      listen((problem) => void b.push(problem));
      const problems = Array.from({ length: 5 }, unauthorized);
      for (const problem of problems) notifyUnauthorized(problem);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]).toBe(problems[0]!);
    });

    test('a later burst notifies again, and is itself coalesced', async () => {
      let calls = 0;
      listen(() => void calls++);
      for (let i = 0; i < 5; i++) notifyUnauthorized(unauthorized());
      expect(calls).toBe(1);
      await Promise.resolve(); // the burst is over once the current microtask checkpoint has passed
      for (let i = 0; i < 3; i++) notifyUnauthorized(unauthorized());
      expect(calls).toBe(2);
      await nextTick();
      notifyUnauthorized(unauthorized());
      expect(calls).toBe(3);
    });

    test('a throwing handler does not leave the burst stuck: the next burst still notifies', async () => {
      silenceConsoleError();
      let calls = 0;
      listen(() => {
        calls++;
        throw new Error('boom');
      });
      notifyUnauthorized(unauthorized());
      await nextTick();
      notifyUnauthorized(unauthorized());
      expect(calls).toBe(2);
    });

    test('notifications while nobody listens still end their burst', async () => {
      notifyUnauthorized(unauthorized());
      await nextTick();
      let calls = 0;
      listen(() => void calls++);
      notifyUnauthorized(unauthorized());
      expect(calls).toBe(1);
    });
  });
});

// --- messages file -------------------------------------------------------------------------------------------------------------

describe('problem.messages.ts', () => {
  const keyOfEveryKind = () => PROBLEM_KINDS.map((kind) => [kind, messageKeyName(MESSAGE_KEYS[kind])] as const);

  test('every problem kind has a message key in the `problem` namespace', () => {
    for (const kind of PROBLEM_KINDS) expect(MESSAGE_KEYS[kind]).toMatch(/^problem:[A-Za-z]+$/);
  });

  test.each([...LOCALES])('in %s every kind\'s key exists with non-blank text, resolved through i18n', (locale) => {
    for (const [kind, key] of keyOfEveryKind()) {
      expect(text(locale, key).trim(), `${locale}.${key} (${kind})`).not.toBe('');
      expect(translators[locale](MESSAGE_KEYS[kind]), `${locale} t(${MESSAGE_KEYS[kind]})`).toBe(text(locale, key));
    }
  });

  test('the kinds keep the agreed keys', () => {
    expect(MESSAGE_KEYS).toMatchObject({
      offline: 'problem:offline',
      network: 'problem:offline',
      unauthorized: 'problem:unauthorized',
      forbidden: 'problem:forbidden',
      not_found: 'problem:notFound',
      too_large: 'problem:tooLarge',
      rate_limited: 'problem:rateLimited',
      validation: 'problem:validation',
      server: 'problem:server',
      schema: 'problem:schema',
      unknown: 'problem:unknown',
    });
  });

  test.each([...new Set(Object.values(MESSAGE_KEYS))].map(messageKeyName).map((key) => [key] as [string]))(
    '"%s" reads differently in kk, ru and en; kk and ru are not English',
    (key) => {
      const [kk, ru, en] = [text('kk', key), text('ru', key), text('en', key)];
      expect(new Set([kk, ru, en]).size).toBe(3);
      expect(kk).toMatch(CYRILLIC);
      expect(ru).toMatch(CYRILLIC);
      expect(en).not.toMatch(CYRILLIC);
    },
  );

  test('413 copy is neutral: a 413 can be a JSON body, so it never says "file"', () => {
    expect(text('en', 'tooLarge')).not.toMatch(/file/i);
    expect(text('ru', 'tooLarge')).not.toMatch(/файл/i);
    expect(text('kk', 'tooLarge')).not.toMatch(/файл/i);
  });

  test('copy fixes from review: kk rate limit, ru not found', () => {
    expect(text('kk', 'rateLimited')).toContain('сұрау');
    expect(text('kk', 'rateLimited')).not.toContain('Әрекет тым көп');
    expect(text('ru', 'notFound')).toBe('Ничего не найдено.');
  });

  test('the validation message points at highlighted fields; the unknown message does not', () => {
    expect(text('en', 'validation')).toMatch(/highlighted/i);
    expect(text('ru', 'validation')).toMatch(/выделенн/i);
    for (const locale of LOCALES) expect(text(locale, 'unknown')).not.toBe(text(locale, 'validation'));
    expect(text('en', 'unknown')).not.toMatch(/highlighted|field/i);
  });

  test('the copy never blames the user (no "you did" / "your fault" / "invalid")', () => {
    for (const key of ['offline', 'server', 'schema', 'unknown', 'notFound', 'tooLarge', 'rateLimited']) {
      expect(text('en', key)).not.toMatch(/\b(fault|invalid|illegal|wrong input|you (did|made|entered))\b/i);
    }
  });
});

// --- bundle hygiene ------------------------------------------------------------------------------------------------------------

/** Every module specifier problem.ts pulls in at runtime: static imports/exports-from (not `import type`), side-effect imports, import(), require(). */
function runtimeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  for (const match of code.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm)) found.push(match[1]!);
  for (const match of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.push(match[1]!);
  for (const match of code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]!);
  return found;
}

const FORBIDDEN = /^(zod|sonner|@api-types\/)/;

describe('problem.ts stays out of the entry bundle graph', () => {
  test('the scanner sees runtime imports and ignores type-only ones (so the scan below is not vacuous)', () => {
    expect(runtimeImports(`import { z } from 'zod';`)).toEqual(['zod']);
    expect(runtimeImports(`import {\n  a,\n  b,\n} from "sonner";`)).toEqual(['sonner']);
    expect(runtimeImports(`import { ProblemDetails } from '@api-types/primitives';`)).toEqual(['@api-types/primitives']);
    expect(runtimeImports(`import { type ProblemDetails } from '@api-types/primitives';`)).toEqual(['@api-types/primitives']);
    expect(runtimeImports(`export { x } from 'zod';`)).toEqual(['zod']);
    expect(runtimeImports(`import 'sonner';`)).toEqual(['sonner']);
    expect(runtimeImports(`const z = await import('zod');`)).toEqual(['zod']);
    expect(runtimeImports(`const z = require("zod");`)).toEqual(['zod']);
    expect(runtimeImports(`import type { ProblemDetails } from '@api-types/primitives';`)).toEqual([]);
    expect(runtimeImports(`// import { z } from 'zod';\n/* import 'sonner'; */`)).toEqual([]);
  });

  test('problem.ts imports no zod, no sonner and no runtime @api-types value', () => {
    const source = readFileSync(join(import.meta.dir, 'problem.ts'), 'utf8');
    const imports = runtimeImports(source);
    expect(imports).toContain('./i18n'); // the scanner really found this file's imports
    expect(imports.filter((specifier) => FORBIDDEN.test(specifier))).toEqual([]);
  });
});

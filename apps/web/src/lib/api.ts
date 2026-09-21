/**
 * The ONE fetch wrapper every screen uses (apps/web).
 *
 *   const health = await api.get('/health', { schema: HealthResponse });          // parsed and typed by a shared Zod schema
 *   const page = await api.get('/api/drills', { schema: paginated(Drill), signal });
 *   await api.post('/api/things', { body: { name }, schema: Thing });             // JSON body
 *   await api.post('/api/upload', { body: formData, schema: Uploaded });          // multipart: we set no Content-Type
 *   await api.delete(`/api/things/${id}`, { schema: 'none' });                    // no content: resolves undefined
 *
 * Requests: same origin (base ''), `credentials: 'same-origin'` (Better Auth cookies),
 * `Accept: application/json, application/problem+json`, and `Accept-Language` = the ACTIVE i18n locale, read on every
 * request (never frozen when the client is created). Both headers belong to the client; a caller's copy is overwritten.
 * There is no timeout by default: pass `signal: AbortSignal.timeout(ms)` to get one. No retries, no dedupe, no request id.
 *
 * Paths: must start with a single "/". `//host`, `https://host`, `api/x` and paths hiding a tab/newline (which URL parsers
 * strip) reject with a TypeError before anything is sent, so a caller-built path can never carry cookies off-origin.
 *
 * Bodies: a plain value (object, array, number, boolean, null) is `JSON.stringify`-ed with `Content-Type:
 * application/json`. `FormData` (we set NO Content-Type, so fetch generates the multipart boundary), Blob, ArrayBuffer,
 * typed arrays, strings and URLSearchParams pass through untouched. `undefined` sends no body. Streams are not supported.
 *
 * Responses: the caller ALWAYS declares what it expects, so nothing unparsed reaches a screen.
 * - `schema: <parser>`: any structural `safeParse` (a Zod 4 schema from `@api-types/*` fits). The PARSED output is returned
 *   and its type is inferred. Failing the parse, a non-JSON or empty 2xx body (e.g. the SPA's index.html served for a missing
 *   API route) and a 204/205 all throw ApiProblem kind "schema" (`issues` and `cause` hold the parser's issues, never a raw
 *   ZodError).
 * - `schema: 'none'`: a call with no content (DELETE, logout). Resolves `undefined` for any 2xx with an empty body; a 2xx
 *   that has a body is kind "schema".
 * Leaving `schema` out is a TYPE error (and a TypeError at runtime for an untyped caller). Blob, text and stream downloads
 * are not supported by this wrapper.
 *
 * Failures: every one is thrown as `ApiProblem` (see problem.ts), except a caller-initiated abort, whose native AbortError is
 * rethrown unwrapped so cancellation is not shown as an error.
 * - HTTP error: kind from the status, carrying the parsed problem+json body when there is one (a non-JSON body, e.g. a
 *   proxy's 502 page, still yields the status-derived kind). Failed responses are never schema-parsed.
 * - `fetch` rejects (or the body cannot be read): kind "network", or "offline" when `online()` is false. A timeout
 *   (`AbortSignal.timeout` -> TimeoutError) is a network failure too.
 * - 401: `notifyUnauthorized(problem)` runs, then the problem is thrown. `skipUnauthorized: true` skips the notification for
 *   calls where 401 means "wrong password" (login, recover).
 *
 * This module imports no zod, no sonner and no runtime `@api-types` value (the app-wide client's retrying fetch comes from
 * features/account/session-expired.ts, which loads sonner lazily); api.test.ts scans this source for that. Tests inject `fetch`, `online` and `language` through `createApi`; nothing global is patched.
 */
import { withSessionRetry } from '../features/account/session-expired';
import { DEFAULT_LOCALE, i18n, toLocale } from './i18n';
import { ApiProblem, classifyStatus, notifyUnauthorized, parseProblemBody } from './problem';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Issues = readonly { path?: readonly PropertyKey[]; message: string }[];

/** Structural twin of a Zod schema: all this module needs is `safeParse`. */
export interface ResponseSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Issues } };
}

export interface CallOptions {
  /** Plain values are sent as JSON; FormData, Blob, URLSearchParams, strings and buffers are sent untouched. */
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers. Accept and Accept-Language are set by the client and cannot be overridden. */
  headers?: HeadersInit;
  /** Do not run onUnauthorized handlers on a 401 (login / recover calls, where 401 means "wrong credentials"). */
  skipUnauthorized?: boolean;
}

/** The response is parsed with `schema` and typed by it. */
export interface SchemaCallOptions<T> extends CallOptions {
  schema: ResponseSchema<T>;
}

/** The call has no content: `schema: 'none'` resolves `undefined` and rejects a 2xx that has a body. */
export interface NoContentCallOptions extends CallOptions {
  schema: 'none';
}

export interface Verb {
  <T>(path: string, options: SchemaCallOptions<T>): Promise<T>;
  (path: string, options: NoContentCallOptions): Promise<void>;
}

export interface ApiDeps {
  /** Default: the global fetch, looked up per call. */
  fetch?: FetchLike;
  /** Default: '' (same origin). */
  baseUrl?: string;
  /** Default: the active i18n locale (kk | ru | en), read per request. */
  language?: () => string;
  /** Default: `navigator.onLine !== false`. */
  online?: () => boolean;
}

export interface Api {
  get: Verb;
  post: Verb;
  put: Verb;
  patch: Verb;
  delete: Verb;
}

const ACCEPT = 'application/json, application/problem+json';

const isPassthroughBody = (body: unknown): body is BodyInit =>
  typeof body === 'string' ||
  body instanceof FormData ||
  body instanceof Blob ||
  body instanceof URLSearchParams ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body);

const nameOf = (error: unknown): unknown => (typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined);

const isJsonType = (contentType: string | null): boolean => /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType ?? '');

/** One "/", then not another "/" or "\" (both make a URL protocol-relative); tab/CR/LF are stripped by URL parsers. */
const isSafePath = (path: string): boolean => /^\/(?![/\\])/.test(path) && !/[\t\n\r]/.test(path);

export function createApi(deps: ApiDeps = {}): Api {
  const baseUrl = deps.baseUrl ?? '';
  const send: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const language = deps.language ?? (() => toLocale(i18n.language) ?? DEFAULT_LOCALE);
  const online = deps.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);

  /** What to throw when fetch (or reading the body) fails: the caller's own abort passes through, the rest is network. */
  function transportFailure(cause: unknown, signal: AbortSignal | undefined): unknown {
    const timedOut = nameOf(cause) === 'TimeoutError' || (signal?.aborted === true && nameOf(signal.reason) === 'TimeoutError');
    if (!timedOut && (signal?.aborted === true || nameOf(cause) === 'AbortError')) return cause;
    return new ApiProblem({ kind: online() ? 'network' : 'offline', cause });
  }

  async function request(method: string, path: string, options: CallOptions & { schema?: ResponseSchema<unknown> | 'none' }): Promise<unknown> {
    if (!isSafePath(path)) throw new TypeError(`api: path must start with a single "/" (got ${JSON.stringify(path)})`);
    const schema = options?.schema;
    if (schema === undefined) throw new TypeError('api: a response schema is required (pass schema: \'none\' for a call with no content)');

    const headers = new Headers(options.headers);
    headers.set('Accept', ACCEPT);
    headers.set('Accept-Language', language());
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (isPassthroughBody(options.body)) {
        body = options.body;
      } else {
        body = JSON.stringify(options.body);
        headers.set('Content-Type', 'application/json');
      }
    }

    let response: Response;
    let text: string;
    try {
      response = await send(baseUrl + path, { method, headers, body, credentials: 'same-origin', signal: options.signal });
      text = await response.text();
    } catch (cause) {
      throw transportFailure(cause, options.signal);
    }

    if (!response.ok) {
      let problem: ApiProblem['problem'];
      if (isJsonType(response.headers.get('content-type'))) {
        try {
          problem = parseProblemBody(JSON.parse(text), response.status);
        } catch {
          // Not JSON after all: the status alone decides.
        }
      }
      const failure = new ApiProblem({ kind: classifyStatus(response.status), status: response.status, problem });
      if (response.status === 401 && options.skipUnauthorized !== true) notifyUnauthorized(failure);
      throw failure;
    }

    const schemaProblem = (init: { issues?: Issues; cause?: unknown }) => new ApiProblem({ kind: 'schema', status: response.status, ...init });
    if (schema === 'none') {
      if (text.trim() !== '') throw schemaProblem({ cause: new Error('api: expected an empty response body') });
      return undefined;
    }
    // 204/205 and any other empty body: the caller declared content, so an empty answer is a mismatch.
    if (text.trim() === '') throw schemaProblem({ cause: new Error('api: expected a response body') });
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (cause) {
      throw schemaProblem({ cause });
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw schemaProblem({ issues: parsed.error.issues, cause: parsed.error.issues });
    return parsed.data;
  }

  // The overloads are the public contract; the implementation is one loosely typed function per verb.
  const verb = (method: string) => ((path: string, options: CallOptions & { schema?: ResponseSchema<unknown> | 'none' }) => request(method, path, options)) as Verb;
  return { get: verb('GET'), post: verb('POST'), put: verb('PUT'), patch: verb('PATCH'), delete: verb('DELETE') };
}

/**
 * The app-wide client: same origin, active locale, and the real fetch wrapped in `withSessionRetry` (a player-route 401
 * silently re-establishes the anonymous session and is retried once; see features/account/session-expired.ts for its limits).
 * The global fetch is looked up on every call, never captured at import, so a test's stub is honoured.
 * The coach-area redirect needs `installSessionExpired()` too: bootstrap.ts installs it at start-up.
 */
export const api: Api = createApi({ fetch: withSessionRetry((input, init) => globalThis.fetch(input, init)) });

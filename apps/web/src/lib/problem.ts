/**
 * Failure model for the API client: `ApiProblem` is the ONE error a request throws, and this module turns it into what a
 * screen renders. No screen parses an error response itself.
 *
 * - `describeProblem(error, t?)` -> { kind, status, fieldErrors, formErrors, formMessage, toast }.
 *   `fieldErrors` is keyed by dotted path (RFC 6901 `/items/0/name` -> `items.0.name`); errors whose pointer is the root ('')
 *   are `formErrors`. Both hold the SERVER's text (English, not localised). `formMessage` and `toast.message` are the
 *   localised generic copy from `problem.messages.ts` (namespace `problem`), resolved through i18n at call time.
 * - The toast is returned as DATA ({ message }); showing it is the caller's job (`toast.error(view.toast.message)`).
 * - A network failure and an offline browser are distinct kinds ('network', 'offline') that share the offline message. A
 *   client-side timeout is a network failure: whoever throws it uses kind 'network'.
 * - Kind 'schema' is a 2xx whose body is not JSON or fails the caller's schema.
 * - `onUnauthorized(handler)` lets session-expiry handling plug in; `notifyUnauthorized` is what the fetch wrapper calls on
 *   a 401. It notifies once per burst, and a throwing handler can neither hide the ApiProblem nor starve the others.
 * - Nothing here imports zod, sonner or a runtime value of @api-types (type-only, like lib/i18n.ts), so this module adds
 *   nothing to the entry bundle. `parseProblemBody` is the hand-written twin of the shared `ProblemDetails` schema;
 *   problem.test.ts pins the two together.
 */
import type { ProblemDetails } from '@api-types/primitives';
import { i18n } from './i18n';

export const PROBLEM_KINDS = [
  'offline', // fetch failed and the browser reports it is offline
  'network', // fetch failed or timed out (DNS, refused, dropped body) while the browser claims to be online
  'unauthorized', // 401
  'forbidden', // 403
  'not_found', // 404
  'conflict', // 409
  'too_large', // 413
  'rate_limited', // 429
  'validation', // 400 / 422
  'server', // 5xx, JSON problem or not
  'schema', // 2xx whose body is not JSON or fails the caller's schema
  'unknown', // any other 4xx, or an error that is not an ApiProblem
] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** kind -> i18n key (`problem:<key>` in problem.messages.ts). offline and network deliberately share one message. */
export const MESSAGE_KEYS = {
  offline: 'problem:offline',
  network: 'problem:offline',
  unauthorized: 'problem:unauthorized',
  forbidden: 'problem:forbidden',
  not_found: 'problem:notFound',
  conflict: 'problem:conflict',
  too_large: 'problem:tooLarge',
  rate_limited: 'problem:rateLimited',
  validation: 'problem:validation',
  server: 'problem:server',
  schema: 'problem:schema',
  unknown: 'problem:unknown',
} as const satisfies Record<ProblemKind, `problem:${string}`>;
export type ProblemMessageKey = (typeof MESSAGE_KEYS)[ProblemKind];

/** Minimal i18n `t`: keeps this module testable with any instance and free of i18next's generics. */
export type Translate = (key: ProblemMessageKey) => string;
const defaultTranslate: Translate = (key) => i18n.t(key);

const RETRYABLE: ReadonlySet<ProblemKind> = new Set(['offline', 'network', 'rate_limited', 'server']);

export function classifyStatus(status: number): ProblemKind {
  switch (status) {
    case 400:
    case 422:
      return 'validation';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'too_large';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'server' : 'unknown';
  }
}

// --- ApiProblem ----------------------------------------------------------------------------------------------------------

export interface ApiProblemInit {
  kind: ProblemKind;
  /** The HTTP status; absent when there was no response (network / offline). */
  status?: number;
  /** The parsed application/problem+json body, when the response had a usable one. */
  problem?: ProblemDetails;
  /** Schema-parse issues for kind "schema". */
  issues?: readonly { path?: readonly PropertyKey[]; message: string }[];
  cause?: unknown;
}

export class ApiProblem extends Error {
  readonly kind: ProblemKind;
  readonly status: number | undefined;
  readonly problem: ProblemDetails | undefined;
  readonly issues: ApiProblemInit['issues'];
  /** Worth another attempt without changing the request (React Query `retry`). */
  readonly retryable: boolean;

  constructor(init: ApiProblemInit) {
    const { problem } = init;
    const message = typeof problem?.detail === 'string' ? problem.detail : typeof problem?.title === 'string' ? problem.title : init.kind;
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiProblem';
    this.kind = init.kind;
    this.status = init.status;
    this.problem = init.problem;
    this.issues = init.issues;
    this.retryable = RETRYABLE.has(init.kind);
  }
}

export function isApiProblem(error: unknown): error is ApiProblem {
  return error instanceof ApiProblem;
}

// --- problem+json body ---------------------------------------------------------------------------------------------------

type ProblemError = { pointer: string; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isProblemError = (value: unknown): value is ProblemError => isRecord(value) && typeof value.pointer === 'string' && typeof value.detail === 'string';

const isHttpStatus = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;

/**
 * Hand-written twin of the shared `ProblemDetails` schema (a runtime import would pull zod into the entry bundle).
 * Lenient where the schema is strict: a member of the wrong type is dropped (or defaulted) instead of failing the whole
 * body, so a usable title/errors survive. Built field by field, never by spreading the wire body, so nothing the type does
 * not promise (a numeric `detail`, extension members) can leak. Undefined only when there is no string `title`.
 */
export function parseProblemBody(input: unknown, fallbackStatus: number): ProblemDetails | undefined {
  if (!isRecord(input) || typeof input.title !== 'string') return undefined;
  const errors: ProblemError[] = Array.isArray(input.errors)
    ? input.errors.filter(isProblemError).map(({ pointer, detail }) => ({ pointer, detail }))
    : [];
  return {
    type: typeof input.type === 'string' ? input.type : 'about:blank',
    title: input.title,
    status: isHttpStatus(input.status) ? input.status : fallbackStatus,
    ...(typeof input.detail === 'string' && { detail: input.detail }),
    ...(typeof input.instance === 'string' && { instance: input.instance }),
    errors,
  };
}

// --- RFC 6901 pointers -> form field paths -------------------------------------------------------------------------------

/**
 * `/profile/age` -> `profile.age`, `/items/0/name` -> `items.0.name`, `/a~1b` -> `a/b`.
 * '' (the root) and anything that is not an RFC 6901 pointer -> '' = form level.
 */
export function pointerToPath(pointer: string): string {
  if (!pointer.startsWith('/')) return '';
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~')) // RFC 6901 §4: ~1 first, then ~0
    .join('.');
}

export type FieldErrors = Record<string, string[]>;

type WithErrors = { errors?: readonly unknown[] } | undefined;
const errorsOf = (problem: WithErrors): ProblemError[] => (Array.isArray(problem?.errors) ? problem.errors.filter(isProblemError) : []);

/** Field-level errors by dotted path, in wire order. Null-prototype object, so a `/__proto__` pointer is just a key. */
export function toFieldErrors(problem: WithErrors): FieldErrors {
  const fields: FieldErrors = Object.create(null);
  for (const { pointer, detail } of errorsOf(problem)) {
    const path = pointerToPath(pointer);
    if (path !== '') (fields[path] ??= []).push(detail);
  }
  return fields;
}

/** Errors that are about the whole form: the root pointer (''), or a pointer with no usable path. */
export function toFormErrors(problem: WithErrors): string[] {
  return errorsOf(problem)
    .filter(({ pointer }) => pointerToPath(pointer) === '')
    .map(({ detail }) => detail);
}

// --- what a screen renders -----------------------------------------------------------------------------------------------

export interface ProblemView {
  kind: ProblemKind;
  status: number | undefined;
  fieldErrors: FieldErrors;
  formErrors: string[];
  /** Localised generic message for the failure. */
  formMessage: string;
  toast: { message: string };
}

/**
 * The message key for an error. A validation failure says "check the highlighted fields" only when there IS a field to
 * highlight; with none (no errors[], or only root-level ones) that sentence would point at nothing, so it is `unknown`.
 */
function messageKeyOf(error: unknown): ProblemMessageKey {
  if (!isApiProblem(error)) return MESSAGE_KEYS.unknown;
  if (error.kind === 'validation' && Object.keys(toFieldErrors(error.problem)).length === 0) return MESSAGE_KEYS.unknown;
  return MESSAGE_KEYS[error.kind];
}

export function toToast(error: unknown, t: Translate = defaultTranslate): { message: string } {
  return { message: t(messageKeyOf(error)) };
}

/** Accepts anything a `catch` or React Query `error` can hold; a non-ApiProblem is kind "unknown". */
export function describeProblem(error: unknown, t: Translate = defaultTranslate): ProblemView {
  const problem = isApiProblem(error) ? error : undefined;
  const toast = toToast(error, t);
  return {
    kind: problem?.kind ?? 'unknown',
    status: problem?.status,
    fieldErrors: toFieldErrors(problem?.problem),
    formErrors: toFormErrors(problem?.problem),
    formMessage: toast.message,
    toast,
  };
}

// --- session expiry ------------------------------------------------------------------------------------------------------

export type UnauthorizedHandler = (problem: ApiProblem) => void | Promise<void>;
const unauthorizedHandlers = new Set<{ handler: UnauthorizedHandler }>();
let burstOpen = false;

/** Registers a handler for 401s. Returns the unsubscribe function (safe to call more than once). */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  const entry = { handler };
  unauthorizedHandlers.add(entry);
  return () => void unauthorizedHandlers.delete(entry);
}

const logHandlerFailure = (error: unknown): void => console.error('onUnauthorized handler failed', error);

/**
 * Called by the fetch wrapper on a 401. Handlers hear ONE notification per burst (the calls made before the current
 * microtask checkpoint ends): five concurrent 401s must not send a refetching handler into a loop. The first problem of the
 * burst is the one delivered. A throwing (or rejecting) handler is logged and cannot hide the ApiProblem or starve the
 * others; this function never throws.
 */
export function notifyUnauthorized(problem: ApiProblem): void {
  if (burstOpen) return;
  burstOpen = true;
  queueMicrotask(() => {
    burstOpen = false;
  });
  for (const { handler } of [...unauthorizedHandlers]) {
    try {
      const result = handler(problem);
      if (typeof result?.then === 'function') result.then(undefined, logHandlerFailure);
    } catch (error) {
      logHandlerFailure(error);
    }
  }
}

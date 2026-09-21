import { createFileRoute, useRouter, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import {
  type DraftStorage,
  resetSessionExpired,
  SIGN_IN_PATH,
  takeExpiredNotice,
} from '../../features/account/session-expired';
import { authClient, resetPlayerSession } from '../../lib/auth';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';

/**
 * /account/sign-in: coach (contributor) sign-up and sign-in with Better Auth. Operate mode: a form, calm and short.
 * All words live in features/account/sign-in.messages.ts (namespace `sign-in`).
 *
 * How it works
 *  - Two tabs, "Create coach account" (display name, email, password >= 10 characters) and "Sign in" (email, password).
 *    Validation runs on submit, in the app's language (the form is noValidate, so no browser-language bubbles), and the
 *    first bad field takes focus. Nothing is sent while a field is bad.
 *  - Upgrading a guest: a player is signed in anonymously behind the scenes (lib/auth.ts). This screen never signs that
 *    session out and never signs in anonymously again: it calls `signUp.email` / `signIn.email` with the guest cookie still
 *    in place, which is what Better Auth's anonymous plugin needs to link the guest to the new account. On success
 *    `resetPlayerSession()` runs BEFORE leaving (lib/auth.ts: the memo would otherwise hand back the dead guest session).
 *    The screen reads the session once to tell a guest that an account keeps their progress; a signed-in account gets
 *    "already signed in" and a Continue button.
 *  - Errors: wrong password (401 / INVALID_EMAIL_OR_PASSWORD), email taken (USER_ALREADY_EXISTS*), rate limited (429; the
 *    limits are 10 per 15 minutes, apps/api/src/auth/rate-limit.ts), offline, 5xx and a generic one. The server's English
 *    text is never shown. Password too short / too long and a bad email land on their own field.
 *  - `?redirect=`: where to go after success. Only a relative same-origin path is followed (see safeRedirect); anything
 *    else, or a path back to this screen, falls back to `/`.
 *  - The "your session expired" note the 401 handler leaves in sessionStorage (`fc:session-expired-notice`) is read once on
 *    mount with takeExpiredNotice() (features/account/session-expired.ts: fresh for 5 minutes, worded in the active language),
 *    shown as an info notice, and the screen then starts on the Sign in tab. After a successful sign-in the screen calls
 *    resetSessionExpired() so the 401 handler redirects again next time.
 *  - The guest note ("your progress stays with you") depends on the API linking the guest to the new account (onLinkAccount,
 *    bug bead fc-mol-70i.12); see sign-in.messages.ts.
 *
 * Readings of the criteria where they are open
 *  - "empty" state: the visitor is already signed in with an account, so there is nothing to fill in (Continue instead).
 *  - "loading": the one-time session read (a small status line; the form is already usable) and the request in flight
 *    (busy button, everything disabled). "success": a status line while the router leaves; the form stays locked.
 *  - The default redirect is `/`: the contributor area does not exist in the route tree yet.
 *  - Navigation is `router.history.push`, like the onboarding wizard: the target is any path, not a typed route.
 *  - Only `Route` and the small SignInDepsContext test seam are exported: a route file's other exports end up in the entry
 *    chunk (see routes/train/onboarding.tsx).
 */

// --- the Better Auth client, as far as this screen uses it ------------------------------------------------------------------

/** The reply shape of a Better Auth client call. `data` is unknown on purpose: it is checked here, not trusted. */
type Reply = { data?: unknown; error?: unknown };

export interface SignInClient {
  getSession(): Promise<Reply>;
  signUp: { email(input: { name: string; email: string; password: string }): Promise<Reply> };
  signIn: { email(input: { email: string; password: string }): Promise<Reply> };
}

export interface SignInDeps {
  client: SignInClient;
  /** lib/auth.ts resetPlayerSession: forget the remembered (guest) session after a successful sign-in. */
  resetSession: () => void;
  /** features/account/session-expired.ts resetSessionExpired: a successful sign-in arms the 401 handler again. */
  resetSessionExpired: () => void;
  navigate: (to: string) => void;
  /** Where the "session expired" note is; `null`: no storage. Absent: sessionStorage, looked up by takeExpiredNotice. */
  storage?: DraftStorage | null;
  now: () => number;
}

/** Test seam: whatever is set replaces the real dependency. */
export const SignInDepsContext = createContext<Partial<SignInDeps>>({});

// --- the redirect ----------------------------------------------------------------------------------------------------------

const DEFAULT_REDIRECT = '/';
const MAX_REDIRECT_LENGTH = 2048;
const MAX_DECODE_ROUNDS = 5;
const PLACEHOLDER_ORIGIN = 'https://redirect.invalid';
// No control character (a tab or newline inside "/\t/host" is dropped by URL parsers and turns it into "//host"), DEL or
// backslash (browsers read "\" as "/"), in the value or in any percent-decoded form of it. A space is fine: the URL parser encodes it.
const DECODED_FORBIDDEN = /[\u0000-\u001f\u007f\\]/;

/** True when the string is not a plain "/path" (protocol-relative "//", "/\\", or anything not starting with one slash). */
const notAPath = (value: string): boolean => value[0] !== '/' || value[1] === '/' || value[1] === '\\' || DECODED_FORBIDDEN.test(value);

/**
 * The path to go to after signing in. A relative, same-origin path only ("/x?y#z"): a string that starts with a single
 * slash, has no backslash or control character, is not protocol-relative, and stays that way after being
 * percent-decoded any number of times (a browser or a proxy may decode it once more than we do). Everything else, and the
 * sign-in page itself, is DEFAULT_REDIRECT. The value returned is the one the URL parser produced, not the raw text.
 */
function safeRedirect(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REDIRECT_LENGTH) return DEFAULT_REDIRECT;
  let current = raw;
  for (let round = 0; ; round += 1) {
    if (round > MAX_DECODE_ROUNDS || notAPath(current)) return DEFAULT_REDIRECT;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      if (round === 0) return DEFAULT_REDIRECT; // a malformed escape in the value itself
      break; // a lone "%" that only appeared after decoding (e.g. from "%25"): nothing more to decode
    }
    if (next === current) break;
    current = next;
  }

  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return DEFAULT_REDIRECT;
  }
  const target = url.pathname + url.search + url.hash;
  if (url.origin !== PLACEHOLDER_ORIGIN || target.startsWith('//')) return DEFAULT_REDIRECT; // e.g. "/..//host" -> "//host"
  if (url.pathname.replace(/\/+$/, '') === SIGN_IN_PATH) return DEFAULT_REDIRECT; // would land back here
  return target;
}

// --- session, validation and error mapping ---------------------------------------------------------------------------------

type SessionKind = 'checking' | 'guest' | 'account' | 'unknown';

/** Only an explicit `isAnonymous: false` is an account (like `requireContributor` in the API); an unreadable reply is unknown. */
function classifySession(reply: Reply): SessionKind {
  if (reply.error !== null && reply.error !== undefined) return 'unknown';
  const user = (reply.data as { user?: { isAnonymous?: unknown } } | null | undefined)?.user;
  if (typeof user !== 'object' || user === null) return 'unknown';
  if (user.isAnonymous === true) return 'guest';
  return user.isAnonymous === false ? 'account' : 'unknown';
}

// Same shape the server's zod email needs: something@domain.tld, no spaces.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 10;

type Mode = 'signUp' | 'signIn';
type FieldName = 'name' | 'email' | 'password';
type FieldErrors = Partial<Record<FieldName, string>>;
/** Keys under `errors.*` in the messages file. */
type FormErrorKind = 'wrongPassword' | 'emailTaken' | 'rateLimited' | 'offline' | 'server' | 'generic';
type Failure = { form: FormErrorKind } | { field: 'email' | 'password'; key: string };

const isNetworkFailure = (cause: unknown): boolean => typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'TypeError';
const browserOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** A Better Auth error object (`{ status, code, message }`) to what the screen shows. The message text is never used. */
function failureOf(error: unknown): Failure {
  const { status, code } = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown };
  if (status === 429) return { form: 'rateLimited' };
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') return { form: 'emailTaken' };
  if (code === 'INVALID_EMAIL_OR_PASSWORD' || status === 401) return { form: 'wrongPassword' };
  if (code === 'PASSWORD_TOO_SHORT') return { field: 'password', key: 'validation.passwordShort' };
  if (code === 'PASSWORD_TOO_LONG') return { field: 'password', key: 'errors.passwordLong' };
  if (code === 'INVALID_EMAIL') return { field: 'email', key: 'validation.email' };
  if (typeof status === 'number' && status >= 500) return { form: 'server' };
  return { form: 'generic' };
}

/** A settled reply: null on success (a user came back), else what failed. */
function failureOfReply(reply: Reply): Failure | null {
  if (reply.error !== null && reply.error !== undefined) return failureOf(reply.error);
  const user = (reply.data as { user?: unknown } | null | undefined)?.user;
  return typeof user === 'object' && user !== null ? null : { form: 'generic' };
}

// --- the screen -----------------------------------------------------------------------------------------------------------

export const Route = createFileRoute('/account/sign-in')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  component: SignInRoute,
});

function SignInRoute() {
  const router = useRouter({ warn: false });
  const search = useSearch({ strict: false }) as { redirect?: unknown };
  const injected = useContext(SignInDepsContext);
  const deps: SignInDeps = {
    client: injected.client ?? authClient,
    resetSession: injected.resetSession ?? resetPlayerSession,
    resetSessionExpired: injected.resetSessionExpired ?? resetSessionExpired,
    navigate: injected.navigate ?? ((to) => router?.history.push(to)),
    storage: injected.storage,
    now: injected.now ?? Date.now,
  };
  return <SignInScreen deps={deps} redirect={safeRedirect(search.redirect)} />;
}

const TAB =
  'flex min-h-tap min-w-0 items-center justify-center gap-2 rounded-control border px-2.5 py-2.5 text-center font-bold wrap-anywhere disabled:cursor-not-allowed disabled:opacity-50';

function SignInScreen({ deps, redirect }: { deps: SignInDeps; redirect: string }) {
  const { t } = useTranslation('sign-in');
  const ids = useId();
  const [mode, setMode] = useState<Mode>('signUp');
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<SessionKind>('checking');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<FormErrorKind | null>(null);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
  // A second submit in the same tick (double tap, Enter plus click) must not send twice, before state has caught up.
  const sending = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const tabs = useRef<Record<Mode, HTMLButtonElement | null>>({ signUp: null, signIn: null });
  // Bumped when an error appears, so focus moves to it (a disabled submit button drops the keyboard's place).
  const [attention, setAttention] = useState<{ n: number; target: FieldName | 'form' }>({ n: 0, target: 'form' });
  const busy = status !== 'idle';
  const client = deps.client;

  // On mount: take the "session expired" note (once; a note that is not there or is stale leaves the defaults).
  useLayoutEffect(() => {
    const found = takeExpiredNotice({ storage: deps.storage, now: deps.now });
    if (found === null) return;
    setNotice(found.message);
    setMode('signIn');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- deliberately once

  // On mount: is this visitor a guest, an account, or unknown? A failed or unreadable read only means no note about it.
  useEffect(() => {
    let alive = true;
    client
      .getSession()
      .then((reply) => alive && setSession(classifySession(reply)))
      .catch(() => alive && setSession('unknown'));
    return () => {
      alive = false;
    };
  }, [client]);

  useEffect(() => {
    if (attention.n === 0) return;
    const target = { name: nameInput, email: emailInput, password: passwordInput, form: errorBox }[attention.target];
    target.current?.focus();
  }, [attention]);

  const choose = (next: Mode, focusTab = false) => {
    if (busy) return;
    setMode(next);
    setFieldErrors({});
    setFormError(null);
    if (focusTab) tabs.current[next]?.focus();
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const order: Mode[] = ['signUp', 'signIn'];
    const at = order.indexOf(mode);
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? order[(at + 1) % order.length]
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? order[(at + order.length - 1) % order.length]
      : event.key === 'Home' ? order[0]
      : event.key === 'End' ? order[order.length - 1]
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    choose(next, true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending.current) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const problems: FieldErrors = {};
    if (mode === 'signUp' && trimmedName === '') problems.name = t('validation.name');
    if (!EMAIL_PATTERN.test(trimmedEmail)) problems.email = t('validation.email');
    if (mode === 'signUp' ? password.length < MIN_PASSWORD_LENGTH : password === '') {
      problems.password = t(mode === 'signUp' ? 'validation.passwordShort' : 'validation.passwordRequired');
    }
    const firstProblem = (['name', 'email', 'password'] as const).find((field) => problems[field] !== undefined);
    setFormError(null);
    setFieldErrors(problems);
    if (firstProblem !== undefined) {
      setAttention((a) => ({ n: a.n + 1, target: firstProblem }));
      return;
    }

    sending.current = true;
    setStatus('submitting');
    let failure: Failure | null;
    try {
      const reply =
        mode === 'signUp'
          ? await client.signUp.email({ name: trimmedName, email: trimmedEmail, password })
          : await client.signIn.email({ email: trimmedEmail, password });
      failure = failureOfReply(reply);
    } catch (cause) {
      failure = { form: isNetworkFailure(cause) || browserOffline() ? 'offline' : 'generic' };
    }

    if (failure === null) {
      // Signed in (or the guest was upgraded): forget the remembered guest session BEFORE anything asks for a session again.
      deps.resetSession();
      deps.resetSessionExpired();
      setStatus('done');
      deps.navigate(redirect);
      return; // `sending` stays set: the form is finished
    }
    sending.current = false;
    setStatus('idle');
    if ('field' in failure) {
      setFieldErrors({ [failure.field]: t(failure.key) });
      setAttention((a) => ({ n: a.n + 1, target: failure.field }));
    } else {
      setFormError(failure.form);
      setAttention((a) => ({ n: a.n + 1, target: 'form' }));
    }
  };

  const tabId = (m: Mode) => `${ids}-tab-${m}`;
  const panelId = `${ids}-panel`;

  return (
    <main className="mx-auto w-[calc(100%-24px)] max-w-120 py-8 sm:w-[calc(100%-40px)] sm:py-12">
      <header>
        <p className="text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
        <h1 className="mt-3 text-[clamp(30px,9vw,44px)] leading-[1.05] font-bold tracking-[-.04em] wrap-break-word">{t('title')}</h1>
        <p className="mt-4 max-w-[65ch] text-lg leading-normal">{t('lead')}</p>
      </header>

      {notice !== null ? <Notice className="mt-6">{notice}</Notice> : null}

      <Card className="mt-6 flex flex-col gap-5">
        {session === 'account' ? (
          <div className="flex flex-col gap-4">
            <p className="text-xl leading-tight font-bold tracking-tight">{t('signedIn.title')}</p>
            <Button className="w-full sm:w-auto sm:self-start" onClick={() => deps.navigate(redirect)}>
              {t('signedIn.continue')}
            </Button>
          </div>
        ) : (
          <>
            <div role="tablist" aria-label={t('tabs.label')} className="grid grid-cols-[3fr_2fr] gap-2">
              {(['signUp', 'signIn'] as const).map((tabMode) => {
                const selected = mode === tabMode;
                return (
                  <button
                    key={tabMode}
                    ref={(node) => {
                      tabs.current[tabMode] = node;
                    }}
                    id={tabId(tabMode)}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={panelId}
                    tabIndex={selected ? 0 : -1}
                    disabled={busy}
                    onClick={() => choose(tabMode)}
                    onKeyDown={onTabKey}
                    className={clsx(TAB, selected ? 'border-accent bg-accent-2 text-ink' : 'border-line bg-paper text-ink')}
                  >
                    {selected ? <Check aria-hidden="true" className="size-5 shrink-0" /> : null}
                    <span className="min-w-0">{t(`tabs.${tabMode}`)}</span>
                  </button>
                );
              })}
            </div>

            {session === 'checking' ? (
              <p aria-live="polite" className="flex items-center gap-2 text-muted">
                <LoaderCircle aria-hidden="true" className="size-5 shrink-0 motion-safe:animate-spin" />
                <span>{t('guest.checking')}</span>
              </p>
            ) : null}
            {session === 'guest' && mode === 'signUp' ? <Notice>{t('guest.note')}</Notice> : null}

            <div role="tabpanel" id={panelId} aria-labelledby={tabId(mode)}>
              <form noValidate onSubmit={submit} className="flex flex-col gap-4">
                {mode === 'signUp' ? (
                  <Field label={t('fields.name.label')} hint={t('fields.name.hint')} error={fieldErrors.name}>
                    {(control) => (
                      <input
                        {...control}
                        ref={nameInput}
                        type="text"
                        name="name"
                        autoComplete="name"
                        disabled={busy}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
                <Field label={t('fields.email.label')} error={fieldErrors.email}>
                  {(control) => (
                    <input
                      {...control}
                      ref={emailInput}
                      type="email"
                      name="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      spellCheck={false}
                      disabled={busy}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label={t('fields.password.label')}
                  hint={mode === 'signUp' ? t('fields.password.hint') : undefined}
                  error={fieldErrors.password}
                >
                  {(control) => (
                    <input
                      {...control}
                      ref={passwordInput}
                      type="password"
                      name="password"
                      autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                      disabled={busy}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  )}
                </Field>

                {formError !== null ? (
                  <div
                    ref={errorBox}
                    role="alert"
                    tabIndex={-1}
                    className="flex min-w-0 flex-col items-start gap-3 rounded-control border border-danger bg-paper px-3.5 py-3 text-ink"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                      <p className="min-w-0 font-bold wrap-anywhere">{t(`errors.${formError}`)}</p>
                    </div>
                    {formError === 'emailTaken' ? (
                      <Button variant="secondary" className="w-full" onClick={() => choose('signIn')}>
                        {t('errors.emailTakenAction')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {status === 'done' ? <Notice>{t('success')}</Notice> : null}

                <Button type="submit" loading={busy} className="w-full">
                  {t(busy ? (mode === 'signUp' ? 'submit.busySignUp' : 'submit.busySignIn') : mode === 'signUp' ? 'submit.signUp' : 'submit.signIn')}
                </Button>
              </form>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}

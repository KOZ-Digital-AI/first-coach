import { ENDPOINTS, normalizeRecoveryCode, RECOVERY_CODE_PATTERN } from '@api-types/privacy';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { Check, CircleAlert, RefreshCw } from 'lucide-react';
import { del } from 'idb-keyval';
import { type FormEvent, createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createLastPlayerStore } from '../bootstrap';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field } from '../components/ui/field';
import { Notice } from '../components/ui/notice';
import { api } from '../lib/api';
import { ensurePlayerSession, type PlayerSession, PlayerSessionError } from '../lib/auth';
import { formatNumber } from '../lib/i18n';
import { describeProblem, isApiProblem } from '../lib/problem';
import { queryCacheKey } from '../lib/query-persist';
import { getDefaultStore, type KeyValueStore, playerKeys } from '../offline/types';

/**
 * /recover: RESTORE PROGRESS. An Operate-mode screen, one calm column at 360px: the player types the recovery code they wrote
 * down (features/privacy/panels/recovery.panel.tsx makes it) and gets their training back on this device. Strings:
 * features/privacy/restore.messages.ts (namespace `restore`; generic failures come from lib/problem.messages.ts).
 *
 * Only `Route` and the small RecoverDepsContext seam are exported (the route splitter leaves other exports in the entry chunk;
 * see routes/settings/privacy.tsx for the same seam).
 *
 * Flow. type the code -> [Restore my progress] -> ensurePlayerSession() (a device with no session gets an ANONYMOUS one; nothing
 * is created just by opening the page) -> POST /api/player/recover { code } (1 call) -> the device's caches are dropped ->
 * /train. A 409 (this device already has training data) turns the form into a question: replace this device's progress with
 * the recovered one (the SAME request again with `replace: true`) or keep it (back to the form, code still typed).
 *
 * THE CODE IS A SECRET AND LIVES ONLY IN THIS COMPONENT'S STATE (memory). The request goes through the api client directly, not
 * through a React Query mutation: the mutation cache would keep the code as `variables` for minutes after the screen is left. It
 * is never logged, never written to browser storage and never put in the URL (no search params, no draft). The input switches
 * off autocomplete, autocorrect and spellcheck, so the browser does not keep or "fix" it either.
 *
 * Readings of the criteria where they are open:
 * - "Forgiving input": what is typed or pasted is kept as typed (upper case is only displayed, so the caret never jumps) and
 *   normalised with the contract's own normalizeRecoveryCode when it is sent: spaces, dashes and case do not matter, and the
 *   body is `{ code: "ABCD-EFGH-IJKL-MNOP" }`. A live count ("6 of 16 characters") helps compare the screen with the paper.
 * - A code that is not 16 letters and numbers (the contract's RECOVERY_CODE_PATTERN, public) is refused in words BEFORE anything
 *   is sent: it costs no try of the server's limit (5 per 15 minutes per IP) and no session. Every code the SERVER refuses (422,
 *   400) is ONE generic sentence: the screen never says whether a code exists or which part was wrong.
 * - The client never parses its request with the contract's RecoverRequest: that schema is a strict object with `code` only and
 *   the server also accepts `replace` (CONTRACT GAP, see api/routes/player-recovery.routes.ts), so the body is built here.
 * - A session that is not anonymous (an account; `isAnonymous === false`) cannot receive progress: it is told so without a
 *   request, and a server 403 reads the same.
 * - After success "drop the per-player caches" is: the in-memory query cache (queryClient.clear()), the persisted cache
 *   `fc:<playerId>:query-cache` (IndexedDB), the downloaded session `fc:<playerId>:session`, and, ONLY when the player chose
 *   Replace, the unsent outbox `fc:<playerId>:outbox` (those events belong to the progress that was replaced). The player id is
 *   the CURRENT session's: the server moves the recovered data to it, so it does not change. `fc:last-player` is written with it,
 *   so it never keeps naming an earlier anonymous id. The sync wiring (bootstrap.ts) already follows the session atom, and does
 *   nothing more when the id is the same; these steps make the device agree with the server now.
 * - Navigation is to /train with history REPLACE, so Back does not return to a form that held a code.
 * - States. empty = the field has nothing typed: the button is disabled and the words say what to do; loading = the button is
 *   disabled and busy ("Restoring your progress") and so is the field; error = words with an icon (the field's own error for
 *   the code, an alert for everything else), focus moves to it; disabled = the button and field while a request runs (a ref
 *   also refuses a second submit in the same tick); success = a status line ("Your progress is back") until the caches are
 *   dropped and the screen is left.
 */

/** What the route needs from the device; the defaults are the real ones. Tests inject fakes. */
export interface RecoverDeps {
  /** Default: lib/auth's ensurePlayerSession (an anonymous session when there is none). */
  ensureSession?: () => Promise<PlayerSession>;
  /** The store the persisted query cache lives in. Default: idb-keyval's IndexedDB, the one lib/query-persist.ts defaults to. */
  persistStore?: { del(key: string): Promise<void> };
  /** The device's localStorage (downloaded session, outbox, last player). Default: the browser's; null: a device without one. */
  deviceStore?: KeyValueStore | null;
}

export const RecoverDepsContext = createContext<RecoverDeps>({});

const TRAIN_PATH = '/train';

/** A session that is an account: progress cannot be restored into it. */
class NotAnonymous extends Error {}

type Failure = { target: 'field' | 'form'; message: string };
type Status = 'idle' | 'sending' | 'restored';

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';
const BODY = 'm-0 text-base leading-[1.45] text-ink wrap-anywhere';

const countOf = (text: string): number => normalizeRecoveryCode(text).replaceAll('-', '').length;

/** Puts this device in step with the server after a restore, see the header. Every step is best effort: none may stop the next. */
async function dropDeviceCaches(queryClient: QueryClient, playerId: string, replaced: boolean, deps: RecoverDeps): Promise<void> {
  try {
    queryClient.clear();
  } catch {
    // best effort
  }
  try {
    await (deps.persistStore ?? { del: (key: string) => del(key) }).del(queryCacheKey(playerId));
  } catch {
    // best effort
  }
  try {
    const store = deps.deviceStore === undefined ? getDefaultStore() : (deps.deviceStore ?? undefined);
    const keys = playerKeys(playerId);
    store?.removeItem(keys.session);
    if (replaced) store?.removeItem(keys.outbox);
  } catch {
    // best effort
  }
  createLastPlayerStore(deps.deviceStore).write(playerId);
}

function RecoverPage() {
  const { t } = useTranslation('restore');
  const deps = useContext(RecoverDepsContext);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const headingId = useId();

  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [failure, setFailure] = useState<Failure | null>(null);
  const running = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLHeadingElement>(null);

  const busy = status !== 'idle';
  const typed = countOf(text);

  // A disabled control cannot keep focus, so focus is put back where the words are once a request has settled.
  useEffect(() => {
    if (failure === null || busy) return;
    if (failure.target === 'field') inputRef.current?.focus();
    else alertRef.current?.focus();
  }, [failure, busy]);
  // The question takes focus when it appears; Keep hands it back to the field (the page load itself never raises the keyboard).
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) questionRef.current?.focus();
    else if (wasConfirming.current) inputRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function failureOf(error: unknown): Failure {
    if (error instanceof NotAnonymous) return { target: 'form', message: t('account') };
    if (error instanceof PlayerSessionError) return { target: 'form', message: t(error.kind === 'offline' ? 'problem:offline' : 'problem:unknown') };
    if (isApiProblem(error)) {
      if (error.kind === 'validation') return { target: 'field', message: t('wrong') };
      if (error.kind === 'rate_limited') return { target: 'form', message: t('rateLimited') };
      if (error.kind === 'forbidden') return { target: 'form', message: t('account') };
    }
    return { target: 'form', message: describeProblem(error, (key) => t(key)).formMessage };
  }

  async function restore(replace: boolean): Promise<void> {
    if (running.current) return;
    const code = normalizeRecoveryCode(text);
    if (code === '') return void setFailure({ target: 'field', message: t('empty') });
    if (!RECOVERY_CODE_PATTERN.test(code)) return void setFailure({ target: 'field', message: t('incomplete') });

    running.current = true;
    setFailure(null);
    setStatus('sending');
    try {
      const session = await (deps.ensureSession ?? ensurePlayerSession)();
      if (session.user.isAnonymous === false) throw new NotAnonymous();
      await api.post(ENDPOINTS.recover.path, {
        body: replace ? { code, replace: true } : { code },
        schema: ENDPOINTS.recover.response,
        skipUnauthorized: true,
      });
      setStatus('restored');
      await dropDeviceCaches(queryClient, session.user.id, replace, deps);
      // The screen is left with the request still "running": it is never used again.
      await navigate({ to: TRAIN_PATH, replace: true });
    } catch (error) {
      if (isApiProblem(error) && error.kind === 'conflict' && !replace) {
        setConfirming(true);
      } else {
        const next = failureOf(error);
        // A code the server refuses at the replace step belongs to the field, which lives on the form.
        if (next.target === 'field') setConfirming(false);
        setFailure(next);
      }
      setStatus('idle');
      running.current = false;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void restore(false);
  }

  const alert =
    failure?.target === 'form' ? (
      <div ref={alertRef} role="alert" tabIndex={-1} className="grid gap-1 rounded-control border border-danger bg-danger-tint p-3.5 text-ink">
        <p className="m-0 flex items-start gap-2 font-bold">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
          <span className="min-w-0 wrap-anywhere">{t('failedTitle')}</span>
        </p>
        <p className="m-0 text-base wrap-anywhere">{failure.message}</p>
      </div>
    ) : null;

  return (
    <main className="mx-auto w-full max-w-295 px-3 pt-4 pb-13.5 sm:px-5">
      <div className="max-w-160">
        <p className="m-0 mt-4 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
        <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">{t('title')}</h1>
        <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>

        <Card elevated className="mt-8 grid gap-4">
          {confirming ? (
            <section aria-labelledby={headingId} className="grid gap-4">
              <h2 id={headingId} ref={questionRef} tabIndex={-1} className={clsx(H2, 'rounded-control')}>
                {t('confirmTitle')}
              </h2>
              <Notice tone="warn" role="note">
                {t('confirmBody')}
              </Notice>
              {alert}
              <div className="grid gap-3">
                <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                  {t('keep')}
                </Button>
                <Button variant="danger" loading={busy} onClick={() => void restore(true)}>
                  {busy ? null : <RefreshCw aria-hidden="true" className="size-5 shrink-0" />}
                  {busy ? t('replacing') : t('replace')}
                </Button>
              </div>
            </section>
          ) : (
            <form onSubmit={onSubmit} noValidate className="grid gap-4">
              <Field label={t('label')} hint={t('hint')} error={failure?.target === 'field' ? failure.message : undefined}>
                {(control) => (
                  <input
                    {...control}
                    ref={inputRef}
                    type="text"
                    value={text}
                    disabled={busy}
                    onChange={(event) => {
                      setText(event.target.value);
                      if (failure !== null) setFailure(null);
                    }}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    enterKeyHint="go"
                    data-1p-ignore=""
                    data-lpignore="true"
                    className={clsx(control.className, 'min-h-14 text-2xl! font-bold tracking-[.08em] uppercase tabular-nums placeholder:normal-case')}
                  />
                )}
              </Field>
              {typed > 0 ? <p className="m-0 text-[13px] text-muted tabular-nums">{t('typed', { typed: formatNumber(typed) })}</p> : null}
              {alert}
              <Button type="submit" loading={busy} disabled={typed === 0}>
                {busy ? t('submitting') : t('submit')}
              </Button>
            </form>
          )}
          {/* A status region that is already on the page when its words arrive, so they are announced. */}
          <div role="status" className="text-base font-bold text-ink empty:hidden">
            {status === 'restored' ? (
              <span className="flex items-start gap-2">
                <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                <span className="min-w-0 wrap-anywhere">{t('done')}</span>
              </span>
            ) : null}
          </div>
        </Card>

        <p className={clsx(BODY, 'mt-6 text-muted')}>{t('noCode')}</p>
      </div>
    </main>
  );
}

export const Route = createFileRoute('/recover')({ component: RecoverPage });

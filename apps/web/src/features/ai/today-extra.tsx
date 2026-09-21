import { AI_NOTE_MAX_CHARS, AI_PLAN_TIMEOUT_MS, ENDPOINTS } from '@api-types/ai';
import type { AiFallbackCode } from '@api-types/ai';
import { HealthResponse, pickLocalized } from '@api-types/primitives';
import type { TodayItem, TodaySession } from '@api-types/session';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Tag } from '../../components/ui/tag';
import { type Api, api as appApi } from '../../lib/api';
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem } from '../../lib/problem';
import { TODAY_QUERY_KEY } from '../train/events-client';

/**
 * "Personalise with AI" on today's session, for the `today` slot of /train (lib/slots.ts: this file default-exports ONE component,
 * takes no props, and reads what it needs itself). Named exports are for tests only.
 *
 * One request: POST /api/player/today/ai-plan {note?} (fc-mol-zo6.7). The server answers 200 for every AI-side failure, so the
 * screen tells three outcomes apart, and only a request that FAILS is an error:
 *   planner 'ai'     the returned session replaces the one in the ['today'] cache (the key the persisted allow-list keeps, so a
 *                    reload still shows it). The card turns into "Why these drills today": the tag "AI-personalised from approved
 *                    drills" and, under each drill, the AI's reason. Finished drills stay listed with "Done".
 *   planner 'rules'  the deterministic session, unchanged, plus `fallback.code`. The session is written back to ['today'] without
 *                    the fallback key, and a quiet note (Notice, role="status", an icon and words, never an alert or a toast)
 *                    says AI is unavailable and gives the reason for THAT code in one sentence.
 *   a failed call    ErrorState with a retry (network, 5xx, an answer that breaks the contract, an unknown fallback code).
 * States: idle (the control), loading (the button is busy and disabled, the field is disabled, progress is announced in words;
 * the session on the page is not touched, so it stays usable), empty/disabled (nothing left to personalise: the button is
 * disabled and the reason is written next to it), error, success (above) and the quiet standard-plan note.
 *
 * Readings of the criteria where they are open, and gaps found:
 *  - "hidden when offline": the whole control is hidden (no button, no field, no request, not even the availability check); the
 *    offline banner already says the device is offline. This follows the bead's words over "disabled with a reason". A session
 *    that is ALREADY AI-planned is content, not a control, so it still shows offline.
 *  - "hidden when the setting disables it" (fc-mol-zo6.12): GET /health carries `aiPlannerEnabled` (the admin setting), read here
 *    through the typed client (cached 5 minutes, one request). The control is hidden entirely only when it is EXACTLY false; an
 *    absent field (an older server), any other value or a failed /health keeps the control (the server decides on the press).
 *    NO KEY (fc-mol-zo6.12, gate j8 U2): /health `aiAvailable` false does NOT hide the control any more. The button stays and a
 *    press is answered by the server with the deterministic session and `fallback: no_key`, which shows the quiet standard-plan
 *    note (no error, no wait for /health). `no_key` and `disabled` then remove the button (nothing to retry); the other codes
 *    (timeout, invalid_output, provider_error) keep a "Try AI again".
 *  - One AI plan per day: the server answers a second request from the stored plan, so once the session is AI-planned there is no
 *    button. CONTRACT GAP (server): a re-plan with a new note the same day has no request to ask for it.
 *  - The request carries `?locale=<ui locale>` and `X-Timezone: <device zone>` exactly as the today screen's GET does: the server
 *    reads today's session through that route, so the day and the drill texts are the screen's own.
 *  - The request is aborted a few seconds after the server's own 20 s limit (AI_PLAN_TIMEOUT_MS), so the server's fallback answer
 *    normally arrives first; an abort is a network error state with a retry.
 *  - The note is trimmed; empty or blank is left out of the body (the contract's body is strict {note?}); the field stops at 200
 *    characters (AI_NOTE_MAX_CHARS).
 *  - The fallback note is component state (it is not persisted): after a reload the control is back, and the server decides again.
 */

/** Wait this much longer than the server's own limit before giving up on the request. */
const CLIENT_GRACE_MS = 5000;
/** Nothing to retry: the AI is switched off or not set up, so asking again cannot change the answer. */
const PERMANENT_CODES: ReadonlySet<AiFallbackCode> = new Set(['disabled', 'no_key']);
/** The deterministic planner's item reason keys: worded by the session screen, not AI text, so never shown as a reason here. */
const PLANNER_REASON_KEYS: ReadonlySet<string> = new Set(['warmup', 'focus', 'fill']);
const AVAILABILITY_STALE_MS = 5 * 60_000;

/** /health is loose; the contract types only ok/version/database, so this adds the one key read here (optional: older servers). */
const HealthWithAi = HealthResponse.extend({ aiPlannerEnabled: z.boolean().optional() });

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(browserOnline);
  useEffect(() => {
    const sync = () => setOnline(browserOnline());
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);
  return online;
}

function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** The session on screen, read from the ['today'] cache (no observer: this control never fetches or refetches it). */
function useCachedToday(): TodaySession | undefined {
  const client = useQueryClient();
  return useSyncExternalStore(
    (notify) => client.getQueryCache().subscribe(notify),
    () => client.getQueryData<TodaySession>(TODAY_QUERY_KEY),
  );
}

const CARD_TITLE = 'm-0 text-xl leading-tight font-bold tracking-tight text-ink wrap-anywhere';

// --- the AI-planned session ----------------------------------------------------------------------------------------------

function PlannedItem({ item }: { item: TodayItem }) {
  const { t, i18n } = useTranslation('ai-plan');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const goal = pickLocalized(item.content.goal, locale) ?? '';
  const title = item.content.title === undefined ? goal : (pickLocalized(item.content.title, locale) ?? goal);
  const reason = item.reason?.trim() ?? '';
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-bold text-ink wrap-anywhere">{title}</span>
        <span className="text-sm font-bold text-muted">{t('ai.minutes', { minutes: formatNumber(item.minutes, locale) })}</span>
        {item.done ? (
          <span className="inline-flex items-center gap-1 text-sm font-bold text-ink">
            <Check aria-hidden="true" className="size-4 shrink-0" />
            {t('ai.done')}
          </span>
        ) : null}
      </span>
      {reason === '' || PLANNER_REASON_KEYS.has(reason) ? null : <p className="m-0 max-w-[65ch] text-base text-muted wrap-anywhere">{reason}</p>}
    </li>
  );
}

function PlannedSession({ session, focusOnMount }: { session: TodaySession; focusOnMount: boolean }) {
  const { t } = useTranslation('ai-plan');
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The button that started the request is gone: hand the keyboard to the result instead of dropping it on the page.
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);
  return (
    <Card role="region" aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-2">
        <h2 id={headingId} ref={heading} tabIndex={-1} className={CARD_TITLE}>
          {t('ai.title')}
        </h2>
        <Tag tone="accent">{t('ai.tag')}</Tag>
      </div>
      <ol role="list" className="m-0 flex list-none flex-col divide-y divide-line p-0">
        {session.items.map((item) => (
          <PlannedItem key={item.itemId} item={item} />
        ))}
      </ol>
    </Card>
  );
}

// --- the control ---------------------------------------------------------------------------------------------------------

export interface AiPlanControlProps {
  /** The typed client. Default: the app-wide one. */
  api?: Pick<Api, 'get' | 'post'>;
  /** The device's IANA time zone, or undefined when it cannot be read (then no X-Timezone header is sent). */
  timeZone?: () => string | undefined;
}

export function AiPlanControl({ api = appApi, timeZone = browserTimeZone }: AiPlanControlProps) {
  const { t, i18n } = useTranslation('ai-plan');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const client = useQueryClient();
  const today = useCachedToday();
  const online = useOnline();
  const headingId = useId();
  const reasonId = useId();

  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{ code: AiFallbackCode; sessionId: string } | null>(null);
  const inFlight = useRef(false);
  const justPlanned = useRef(false);
  const translate = (key: Parameters<NonNullable<Parameters<typeof describeProblem>[1]>>[0]) => String(i18n.t(key));

  const planned = today?.planner === 'ai';
  const visible = today !== undefined && !planned && online;

  // Has the admin switched the AI planner off? One cheap read, only while the control could be shown. Unknown (pending, failed, old
  // server, a value that is not a boolean) keeps it: only an aiPlannerEnabled of exactly false hides the control.
  const availability = useQuery({
    queryKey: ['ai-availability'],
    queryFn: ({ signal }) => api.get('/health', { schema: HealthWithAi, signal }),
    enabled: visible,
    staleTime: AVAILABILITY_STALE_MS,
    retry: false,
  });

  async function personalise() {
    if (inFlight.current || today === undefined) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const trimmed = note.trim();
      const zone = timeZone();
      const answer = await api.post(`${ENDPOINTS.aiPlan.path}?locale=${locale}`, {
        body: trimmed === '' ? {} : { note: trimmed },
        schema: ENDPOINTS.aiPlan.response,
        ...(zone === undefined ? {} : { headers: { 'X-Timezone': zone } }),
        signal: AbortSignal.timeout(AI_PLAN_TIMEOUT_MS + CLIENT_GRACE_MS),
      });
      if (answer.planner === 'ai') {
        justPlanned.current = true;
        client.setQueryData(TODAY_QUERY_KEY, answer);
        setFallback(null);
      } else {
        const { fallback: reason, ...unchanged } = answer;
        client.setQueryData(TODAY_QUERY_KEY, unchanged);
        setFallback({ code: reason.code, sessionId: answer.id });
      }
      setFailure(null);
    } catch (error) {
      setFailure(describeProblem(error, translate).formMessage);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (today === undefined) return null;
  if (planned) return <PlannedSession session={today} focusOnMount={justPlanned.current} />;
  if (!online || availability.data?.aiPlannerEnabled === false) return null;

  const standard = fallback !== null && fallback.sessionId === today.id ? fallback.code : null;
  const finished = standard !== null && PERMANENT_CODES.has(standard);
  const nothingLeft = today.items.every((item) => item.done);

  return (
    <Card role="region" aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 id={headingId} className={CARD_TITLE}>
          {t('title')}
        </h2>
        {finished ? null : <p className="m-0 max-w-[65ch] text-base text-muted">{t('lead')}</p>}
      </div>

      {finished ? null : (
        <Field label={t('noteLabel')} hint={t('noteHint', { max: formatNumber(AI_NOTE_MAX_CHARS, locale) })}>
          {(control) => (
            <textarea {...control} rows={2} maxLength={AI_NOTE_MAX_CHARS} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
          )}
        </Field>
      )}

      {busy ? (
        <div role="status" aria-live="polite" className="flex flex-col gap-1">
          <p className="m-0 text-base font-bold text-ink">{t('running')}</p>
          <p className="m-0 max-w-[65ch] text-base text-muted">{t('runningHint')}</p>
        </div>
      ) : null}

      {standard !== null && !busy ? (
        <Notice tone="info">
          <p className="m-0 font-bold">{t('fallback.standard')}</p>
          <p className="m-0 mt-1">{t(`fallback.reasons.${standard}`)}</p>
        </Notice>
      ) : null}

      {nothingLeft && !finished ? <p id={reasonId} className="m-0 max-w-[65ch] text-base text-ink">{t('nothingLeft')}</p> : null}

      {failure !== null ? (
        <ErrorState title={t('error.title')} message={failure} retryLabel={t('error.retry')} retrying={busy} onRetry={() => void personalise()} />
      ) : finished ? null : (
        <Button
          className="w-full sm:w-auto sm:self-start"
          disabled={nothingLeft}
          loading={busy}
          aria-describedby={nothingLeft ? reasonId : undefined}
          onClick={() => void personalise()}
        >
          {standard === null ? t('action') : t('retryAction')}
        </Button>
      )}
    </Card>
  );
}

/** The slot component: nothing but the default client and the device's own clock zone. */
export default function TodayExtra() {
  return <AiPlanControl />;
}

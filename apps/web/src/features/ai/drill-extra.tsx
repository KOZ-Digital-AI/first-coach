import { AI_PLAN_TIMEOUT_MS, AI_UNAVAILABLE, ENDPOINTS } from '@api-types/ai';
import { HealthResponse } from '@api-types/primitives';
import type { Locale } from '@api-types/primitives';
import type { TodaySession } from '@api-types/session';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { type Api, api as appApi } from '../../lib/api';
import { DEFAULT_LOCALE, toLocale } from '../../lib/i18n';
import { ApiProblem, describeProblem, isApiProblem } from '../../lib/problem';
import { TODAY_QUERY_KEY } from '../train/events-client';

/**
 * "Explain more simply" in the drill player, for the `drill` slot of /train/drill/:itemId (lib/slots.ts: this file default-exports ONE
 * component, takes no props, and reads what it needs itself: the drill id from the route, the drill from the cached ['today'] session).
 * Named exports are for tests only.
 *
 * One request: POST /api/player/drills/<the drill's drillVersionId>/explain {locale, audience: 'child'} (fc-mol-zo6.8). The answer is
 * AI text, so it is NEVER mixed into the coach's own text: it appears in its own inset panel below, named "AI-generated — the coach's
 * original text is above" (a heading with an icon, so the provenance is written, not only styled), as a plain text node (no markdown, no
 * HTML, no links: React escapes it, `whitespace-pre-line` keeps the line breaks). Nothing in the ['today'] cache, the instructions or the
 * safety note is read for writing or changed here.
 *
 * States: idle (the control), loading (the button is busy and disabled, progress is announced in words, the drill stays usable), empty
 * (the drill is not in the cached session: nothing is rendered, the drill screen has its own empty and error states), error (ErrorState
 * with a retry), disabled (offline, or an unavailable AI: a quiet note with the reason), success (the panel).
 *
 * Readings of the criteria where they are open, and gaps found:
 *  - "more simply" is the contract's audience 'child'; the locale is the UI language (the request body, unlike the plan request, has
 *    no query locale). One button, no audience choice.
 *  - "unavailable": the route answers EVERY AI-side failure with one 503 whose problem type is `ai_unavailable`. That is the quiet note
 *    (a status, no alert, the server's own text is never shown) and the button stays, worded "Try again", because a timeout is in that
 *    group and can pass. Every other failure (network, 5xx that is not the AI's, an answer that breaks the contract) is an ErrorState
 *    with a retry. A 404 (unknown or unpublished version) is a quiet note with nothing to retry.
 *  - GET /health carries `aiAvailable` (a key is configured); false shows the quiet note and no button. An unreadable or old /health
 *    keeps the control. CONTRACT GAP: the admin's AI setting is not readable by a player, and the explain route does not consult it.
 *  - offline: the quiet offline note and a disabled button (its reason is linked with aria-describedby), no request, not even the
 *    /health check. An explanation already on screen stays: it is content, not a control.
 *  - the explanation belongs to ONE drill version in ONE language: a swap (the item holds another drillVersionId) or a language change
 *    starts from a clean control (the inner component is keyed by both), and the request of the old one is aborted.
 *  - one explanation per version and language: once it is shown the button is gone (the server would only be asked again, at a cost),
 *    so keyboard focus moves to the panel's heading.
 *  - the request is aborted when the drill is left, and a few seconds after the server's own limit (AI_PLAN_TIMEOUT_MS: the explain
 *    contract has no limit of its own, the server uses the same one). A timeout is a network error with a retry.
 */

/** Wait this much longer than the server's own limit before giving up on the request. */
const CLIENT_GRACE_MS = 5000;
const AVAILABILITY_STALE_MS = 5 * 60_000;

/** /health is loose; the contract types only ok/version/database, so this adds the one key read here (optional: older servers). */
const HealthWithAi = HealthResponse.extend({ aiAvailable: z.boolean().optional() });

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

/** The session on screen, read from the ['today'] cache (no observer: this control never fetches or refetches it). */
function useCachedToday(): TodaySession | undefined {
  const client = useQueryClient();
  return useSyncExternalStore(
    // Only the session's own key: another query (the availability check below) is created while a child renders, and telling React
    // about that from inside a render is an error.
    (notify) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] === TODAY_QUERY_KEY[0]) notify();
      }),
    () => client.getQueryData<TodaySession>(TODAY_QUERY_KEY),
  );
}

const CARD_TITLE = 'm-0 text-xl leading-tight font-bold tracking-tight text-ink wrap-anywhere';

interface BodyProps {
  versionId: string;
  locale: Locale;
  api: Pick<Api, 'get' | 'post'>;
}

/** What the request ended in, when it is not an explanation and not a failure worth an error. */
type Quiet = 'unavailable' | 'gone';

function ExplainBody({ versionId, locale, api }: BodyProps) {
  const { t, i18n } = useTranslation('explain');
  const online = useOnline();
  const offlineId = useId();
  const panelId = useId();
  const panelHeading = useRef<HTMLHeadingElement>(null);

  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quiet, setQuiet] = useState<Quiet | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const translate = (key: Parameters<NonNullable<Parameters<typeof describeProblem>[1]>>[0]) => String(i18n.t(key));

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Leaving the drill (or moving to another version or language) abandons the request; nothing is set afterwards.
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    // The button that started the request is gone: hand the keyboard to the result instead of dropping it on the page.
    if (text !== null) panelHeading.current?.focus();
  }, [text]);

  // Is the AI configured at all? One cheap read, only while it could matter. Unknown (pending, failed, old server) keeps the control.
  const availability = useQuery({
    queryKey: ['ai-availability'],
    queryFn: ({ signal }) => api.get('/health', { schema: HealthWithAi, signal }),
    enabled: online && text === null,
    staleTime: AVAILABILITY_STALE_MS,
    retry: false,
  });

  async function explain() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setQuiet(null);
    setFailure(null);
    const own = new AbortController();
    controller.current = own;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      own.abort();
    }, AI_PLAN_TIMEOUT_MS + CLIENT_GRACE_MS);
    try {
      const answer = await api.post(ENDPOINTS.explainDrill.path.replace(':versionId', encodeURIComponent(versionId)), {
        body: { locale, audience: 'child' },
        schema: ENDPOINTS.explainDrill.response,
        signal: own.signal,
      });
      if (mounted.current) setText(answer.text);
    } catch (error) {
      if (!mounted.current) return;
      if (isApiProblem(error) && error.status === 503 && error.problem?.type === AI_UNAVAILABLE) setQuiet('unavailable');
      else if (isApiProblem(error) && error.kind === 'not_found') setQuiet('gone');
      else setFailure(describeProblem(timedOut ? new ApiProblem({ kind: 'network', cause: error }) : error, translate).formMessage);
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const switchedOff = text === null && availability.data?.aiAvailable === false;
  const offlineNote = text === null && !online && failure === null;
  const note = switchedOff ? 'off' : quiet;

  return (
    <Card role="region" aria-labelledby={`${panelId}-title`} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 id={`${panelId}-title`} className={CARD_TITLE}>
          {t('title')}
        </h2>
        {text !== null || switchedOff ? null : <p className="m-0 max-w-[65ch] text-base text-muted">{t('lead')}</p>}
      </div>

      {busy ? (
        <div role="status" aria-live="polite" className="flex flex-col gap-1">
          <p className="m-0 text-base font-bold text-ink">{t('running')}</p>
          <p className="m-0 max-w-[65ch] text-base text-muted">{t('runningHint')}</p>
        </div>
      ) : null}

      {offlineNote ? (
        <Notice id={offlineId} tone="info">
          <p className="m-0 font-bold">{t('offline.title')}</p>
          <p className="m-0 mt-1">{t('offline.body')}</p>
        </Notice>
      ) : null}

      {note !== null && !busy && text === null ? (
        <Notice tone="info">
          <p className="m-0 font-bold">{t(`${note}.title`)}</p>
          <p className="m-0 mt-1">{t(`${note}.body`)}</p>
        </Notice>
      ) : null}

      {failure !== null ? (
        <ErrorState title={t('error.title')} message={failure} retryLabel={t('error.retry')} retrying={busy} onRetry={() => void explain()} />
      ) : text !== null || switchedOff || quiet === 'gone' ? null : (
        <Button
          className="w-full sm:w-auto sm:self-start"
          disabled={!online}
          loading={busy}
          aria-describedby={offlineNote ? offlineId : undefined}
          onClick={() => void explain()}
        >
          {quiet === 'unavailable' ? t('retryAction') : t('action')}
        </Button>
      )}

      {text === null ? null : (
        <section aria-labelledby={panelId} className="flex flex-col gap-2 rounded-control border border-dashed border-muted bg-bg p-4">
          <h3 id={panelId} ref={panelHeading} tabIndex={-1} className="m-0 flex items-start gap-2 text-base font-bold text-ink wrap-anywhere">
            <Sparkles aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            {t('panel.label')}
          </h3>
          <p lang={locale} className="m-0 max-w-[65ch] text-base leading-relaxed whitespace-pre-line text-ink wrap-anywhere">
            {text}
          </p>
        </section>
      )}
    </Card>
  );
}

export interface ExplainControlProps {
  /** The item of today's session whose drill is explained. */
  itemId: string;
  /** The typed client. Default: the app-wide one. */
  api?: Pick<Api, 'get' | 'post'>;
}

export function ExplainControl({ itemId, api = appApi }: ExplainControlProps) {
  const { i18n } = useTranslation('explain');
  const today = useCachedToday();
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const item = today?.items.find((entry) => entry.itemId === itemId);
  if (item === undefined) return null;
  return <ExplainBody key={`${item.drillVersionId}:${locale}`} versionId={item.drillVersionId} locale={locale} api={api} />;
}

/** The slot component: the drill id comes from the route, everything else from the app-wide client. */
export default function DrillExtra() {
  const { itemId } = useParams({ strict: false }) as { itemId?: string };
  return itemId === undefined ? null : <ExplainControl itemId={itemId} />;
}

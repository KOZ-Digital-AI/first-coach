import type { Locale } from '@api-types/primitives';
import type { TodaySession } from '@api-types/session';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CloudUpload, Download, WifiOff } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { readLastPlayerId } from '../../bootstrap';
import { authClient } from '../../lib/auth';
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem } from '../../lib/problem';
import { configureOutbox, pendingCount as outboxPendingCount } from '../../offline/outbox';
import { downloadToday, getOffline, type SessionStore } from '../../offline/session-store';
import { TODAY_QUERY_KEY } from '../train/events-client';

/**
 * The offline control of today's session, for the `today` slot of /train (lib/slots.ts: this file default-exports ONE
 * component, takes no props, and reads what it needs itself). Named exports are for tests only.
 *
 * States (one region, `role="status"` `aria-live="polite"`, always in the page so a change is announced; the failure is the
 * only `role="alert"`):
 *   checking     the player is still being identified: "Checking this device…" (loading)
 *   unknown      no player could be identified: says so and offers no download (there is no key to store it under)
 *   idle         nothing downloaded for today: "Download today's session" (empty). Offline it is disabled and the text says
 *                how to prepare next time (open the app with internet, tap the button); the button is tied to it by
 *                aria-describedby (disabled)
 *   downloading  the button is disabled and busy and "Downloading today's session…" is announced (a second tap sends nothing)
 *   error        ErrorState with a retry that resends the download (the retry is disabled while it runs)
 *   available    "Available offline" with a check icon, and "Last synced: <download time>" (success)
 * and, in every state that knows the player, "Saved on this device — will sync: N" when the outbox is not empty.
 *
 * Readings of the criteria where they are open, and gaps found:
 *  - "with progress": the store's download is one request with no byte progress to report, so progress is the in-flight state:
 *    spinner on the button plus the words "Downloading today's session…". No fake percentage.
 *  - "Available offline" means the device holds the session for TODAY'S DATE, the date of the session on screen (the ['today']
 *    cache, which is the only thing the slot reads from the page): `getOffline(playerId, date)`. A session stored for another
 *    day is not "available for today". "Last synced" is that stored session's `downloadedAt`, in the UI locale and the device's
 *    time zone.
 *  - Once available there is no re-download button: the store keeps a stored session with the same id untouched, so a second
 *    download could not change anything.
 *  - The player id comes from the auth session (`authClient.useSession`). The device store and the outbox are keyed by it, and
 *    it is not in the ['today'] cache. A cold start OFFLINE has no auth session to read, so (fc-mol-eay.14) the slot component
 *    falls back to the id of the last player of this device, `readLastPlayerId()` (bootstrap.ts, fc-mol-eay.12): a live session
 *    id always wins; with neither the player is "unknown"/"checking" as before. The fallback also applies while the session read
 *    is still pending (offline it may never answer), which changes nothing when a live id arrives: it then wins.
 *  - CONTRACT GAP: `downloadToday` sends no `X-Timezone` (the today screen does), so near midnight the server's "today" for the
 *    download can differ from the screen's; then the stored session's date is not the screen's date and it reads as not
 *    downloaded. Fix in the store (send the device's zone).
 *  - CONTRACT GAP: nothing in the app calls `configureOutbox` yet, and `pendingCount` rejects until it is called. So the count
 *    is read through `configureOutbox({ playerId })` with the player this control already has (the same id the wiring will use).
 *    A count that cannot be read is simply not shown.
 *  - The count is re-read when the download finishes, when the connection changes, when the tab becomes visible and every
 *    `refreshMs` (5 s; 0 turns the timer off), because the flush that empties the outbox happens elsewhere.
 */

const REFRESH_MS = 5000;

/** Same language tags as formatNumber (lib/i18n.ts). */
const DATE_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };
const dateFormatters = new Map<Locale, Intl.DateTimeFormat>();

/** `2026-09-21T12:00:00.000Z` -> "Sep 21, 2026, 5:00 PM" (device zone). An unreadable stamp is shown as stored. */
function formatSynced(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  let formatter = dateFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(DATE_TAGS[locale], { dateStyle: 'medium', timeStyle: 'short' });
    dateFormatters.set(locale, formatter);
  }
  return formatter.format(date);
}

/** The session on screen, read from the ['today'] cache (no observer: this control never fetches or refetches it). */
function useCachedToday(): TodaySession | undefined {
  const client = useQueryClient();
  return useSyncExternalStore(
    (notify) => client.getQueryCache().subscribe(notify),
    () => client.getQueryData<TodaySession>(TODAY_QUERY_KEY),
  );
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

const deviceStore = { downloadToday, getOffline };

const deviceOutbox = (playerId: string): Promise<number> => {
  configureOutbox({ playerId });
  return outboxPendingCount();
};

export interface OfflineDownloadProps {
  /** The signed-in (possibly anonymous) player, or undefined when there is none. */
  playerId: string | undefined;
  /** True while the auth session is still loading. */
  playerPending?: boolean;
  /** The offline session store. Default: the device-wide one. */
  store?: Pick<SessionStore, 'downloadToday' | 'getOffline'>;
  /** How many results wait in the outbox for this player. Default: the outbox's `pendingCount`. */
  pendingCount?: (playerId: string) => Promise<number>;
  /** Milliseconds between re-reads of the pending count; 0 turns the timer off. Default 5000. */
  refreshMs?: number;
}

export function OfflineDownload({
  playerId,
  playerPending = false,
  store = deviceStore,
  pendingCount = deviceOutbox,
  refreshMs = REFRESH_MS,
}: OfflineDownloadProps) {
  const { t, i18n } = useTranslation('download');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const headingId = useId();
  const hintId = useId();
  const today = useCachedToday();
  const date = today?.date;

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

  // --- what is on the device ---
  const [version, setVersion] = useState(0);
  const saved = useMemo(
    () => (playerId === undefined || date === undefined ? undefined : store.getOffline(playerId, date)),
    // `version` is bumped after a download: the read is a synchronous storage read, redone on purpose.
    [store, playerId, date, version],
  );

  // --- what waits to be sent ---
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (playerId === undefined) {
      setWaiting(0);
      return;
    }
    let alive = true;
    let latest = 0;
    const read = () => {
      latest += 1;
      const mine = latest;
      // `new Promise` also turns a synchronous throw of `pendingCount` into a rejection.
      new Promise<number>((resolve) => resolve(pendingCount(playerId))).then(
        (count) => {
          if (alive && mine === latest) setWaiting(Number.isFinite(count) && count > 0 ? count : 0);
        },
        () => {
          if (alive && mine === latest) setWaiting(0);
        },
      );
    };
    read();
    window.addEventListener('online', read);
    window.addEventListener('offline', read);
    document.addEventListener('visibilitychange', read);
    const timer = refreshMs > 0 ? setInterval(read, refreshMs) : undefined;
    return () => {
      alive = false;
      window.removeEventListener('online', read);
      window.removeEventListener('offline', read);
      document.removeEventListener('visibilitychange', read);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [playerId, pendingCount, refreshMs, version]);

  // --- downloading ---
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const translate = (key: Parameters<NonNullable<Parameters<typeof describeProblem>[1]>>[0]) => String(i18n.t(key));

  async function download() {
    if (inFlight.current || playerId === undefined) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await store.downloadToday(playerId, locale);
      setFailure(null);
      setVersion((current) => current + 1);
    } catch (error) {
      setFailure(describeProblem(error, translate).formMessage);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (today === undefined) return null;

  const identified = playerId !== undefined;
  const offlineAndEmpty = identified && saved === undefined && failure === null && !online;

  return (
    <Card role="region" aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 id={headingId} className="m-0 text-xl leading-tight font-bold tracking-tight text-ink wrap-anywhere">
          {t('title')}
        </h2>
        {saved === undefined ? <p className="m-0 max-w-[65ch] text-base text-muted">{t('lead')}</p> : null}
      </div>

      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        {playerPending && !identified ? (
          <>
            <p className="m-0 text-base font-bold text-ink">{t('checking')}</p>
            <Skeleton className="h-11 w-full sm:w-64" />
          </>
        ) : null}
        {!playerPending && !identified ? <p className="m-0 max-w-[65ch] text-base text-ink">{t('unknown')}</p> : null}
        {busy ? <p className="m-0 text-base font-bold text-ink">{t('downloading')}</p> : null}
        {saved === undefined ? null : (
          <div className="flex flex-col gap-2">
            <p
              data-state="available"
              className="m-0 inline-flex items-center gap-2 self-start rounded-pill bg-accent-2 px-3.5 py-1.5 text-base font-bold text-ink"
            >
              <Check aria-hidden="true" className="size-5 shrink-0" />
              <span>{t('available')}</span>
            </p>
            <p className="m-0 text-base text-muted wrap-anywhere">
              {t('lastSynced', { time: formatSynced(saved.downloadedAt, locale) })}
            </p>
          </div>
        )}
        {offlineAndEmpty ? (
          <p id={hintId} data-state="offline" className="m-0 flex max-w-[65ch] items-start gap-2.5 text-base text-ink">
            <WifiOff aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span>{t('offlineHint')}</span>
          </p>
        ) : null}
        {waiting > 0 ? (
          <p data-state="pending" className="m-0 flex items-start gap-2.5 text-base text-ink">
            <CloudUpload aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span>{t('pending', { waiting: formatNumber(waiting, locale) })}</span>
          </p>
        ) : null}
      </div>

      {failure !== null ? (
        <ErrorState title={t('error.title')} message={failure} retryLabel={t('retry')} retrying={busy} onRetry={() => void download()} />
      ) : identified && saved === undefined ? (
        <Button
          className="w-full sm:w-auto sm:self-start"
          disabled={!online}
          loading={busy}
          aria-describedby={online ? undefined : hintId}
          onClick={() => void download()}
        >
          {busy ? null : <Download aria-hidden="true" className="size-5 shrink-0" />}
          {t('download')}
        </Button>
      ) : null}
    </Card>
  );
}

/**
 * The slot component: the auth session supplies the player (else the last player of this device, read at every render: the
 * key is cleared on sign-out), everything else is the device's own store and outbox. `||`, not `??`, on purpose: an empty
 * live id is no id (the device store refuses to build a key from it).
 */
export default function TodayExtra() {
  const session = authClient.useSession();
  return <OfflineDownload playerId={session.data?.user.id || readLastPlayerId()} playerPending={session.isPending} />;
}

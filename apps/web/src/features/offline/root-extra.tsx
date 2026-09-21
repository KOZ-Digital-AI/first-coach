import { Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { flush as flushOutbox } from '../../offline/outbox';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';

/**
 * The connectivity banner for the app shell's root slot (lib/slots.ts: this file default-exports ONE component). The shell
 * renders the root slot under the header, in normal flow, so the banner pushes the page down a little instead of covering it.
 *
 * - Offline (an `offline` event, or `navigator.onLine === false` when it mounts): "You are offline — training still works".
 * - Back online (an `online` event after being offline): the outbox is flushed and "Back online — syncing" is shown.
 *
 * Readings of the criteria (where they were open):
 * - "a brief 'Back online — syncing' confirmation after the outbox flush": the confirmation replaces the offline message as
 *   soon as the browser reports the connection (an "offline" banner while online would be untrue), the flush starts at that
 *   moment, and the confirmation is removed `dismissAfterMs` (default 4 s) AFTER the flush settles, success or failure. While
 *   the flush is still running the text stays: it is still syncing.
 * - The flush is the outbox's own `flush()`, which is single-flight (a second call while one runs returns that run's result),
 *   so this does not double-send next to `start()`'s own `online` handler. Its result is not read, and a rejection (no player
 *   yet, storage failure) only ends the confirmation: the outbox keeps the entries and retries by itself.
 * - An `online` event with no `offline` before it (a spurious event) shows nothing and flushes nothing: `start()` already
 *   flushes on every `online`.
 * - The "N results waiting to sync" line is not in the criteria and is not built.
 *
 * One polite status region (`role="status"`, `aria-live="polite"`, never an alert) is always in the page and only its content
 * changes, because a live region that is created together with its text is often not announced. Each message carries an icon
 * of a different shape (WifiOff / Wifi) plus words, never colour alone (DESIGN.md Second Signal Rule).
 */

/** How long the back-online confirmation stays after the flush settles. */
const DISMISS_AFTER_MS = 4000;

/** The shell's container (DESIGN.md Layout): min(1180px, 100% - 40px), 100% - 24px on phones. */
const CONTAINER = 'mx-auto w-[calc(100%-24px)] max-w-295 sm:w-[calc(100%-40px)]';

type Phase = 'online' | 'offline' | 'restored';

export interface ConnectivityBannerProps {
  /** Delivers the queued results. Default: the outbox's `flush`. Tests inject their own. */
  flush?: () => Promise<unknown>;
  /** Milliseconds the confirmation stays after the flush settles. Default 4000. */
  dismissAfterMs?: number;
}

const defaultFlush = () => flushOutbox();

export function ConnectivityBanner({ flush = defaultFlush, dismissAfterMs = DISMISS_AFTER_MS }: ConnectivityBannerProps) {
  const { t } = useTranslation('banner');
  const [phase, setPhase] = useState<Phase>('online');

  useEffect(() => {
    let current: Phase = 'online';
    // Bumped on every change of direction and on unmount: a flush or timer of an earlier round must not touch the banner.
    let round = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const show = (next: Phase) => {
      current = next;
      setPhase(next);
    };

    const onOffline = () => {
      round += 1;
      clearTimeout(timer);
      show('offline');
    };

    const onOnline = () => {
      if (current !== 'offline') return;
      round += 1;
      const mine = round;
      show('restored');
      const settled = () => {
        if (mine !== round) return;
        timer = setTimeout(() => {
          if (mine === round) show('online');
        }, dismissAfterMs);
      };
      // `new Promise` also turns a synchronous throw of `flush` into a rejection.
      new Promise<unknown>((resolve) => resolve(flush())).then(settled, settled);
    };

    if (navigator.onLine === false) onOffline();
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      round += 1;
      clearTimeout(timer);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [flush, dismissAfterMs]);

  const Icon = phase === 'restored' ? Wifi : WifiOff;
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {phase !== 'online' && (
        <div
          data-state={phase}
          className={`border-b text-base text-ink ${phase === 'restored' ? 'border-transparent bg-accent-2' : 'border-line bg-paper'}`}
        >
          <p className={`${CONTAINER} flex items-center gap-2.5 py-2 wrap-anywhere`}>
            <Icon aria-hidden="true" className="size-5 shrink-0" />
            <span>{t(phase)}</span>
          </p>
        </div>
      )}
    </div>
  );
}

export default function ConnectivityBannerSlot() {
  return <ConnectivityBanner />;
}

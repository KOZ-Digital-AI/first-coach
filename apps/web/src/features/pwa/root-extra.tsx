/// <reference types="vite-plugin-pwa/client" />
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';
import { resolveBuildVersion } from '../../lib/query-persist';

/**
 * The service-worker update prompt for the app shell's root slot (lib/slots.ts: this file default-exports ONE component). The
 * shell renders the root slot under the header, in normal flow. vite.config.ts sets `registerType: 'prompt'`, so a new
 * service worker installs in the background and WAITS: this component registers the worker, and when one is waiting it shows
 * "New version available" with an Update button. Update calls `updateServiceWorker(true)` (skip waiting, then reload).
 *
 * Never interrupt a drill in progress:
 * - Nothing here reloads, focuses, navigates or updates by itself. A waiting version only makes the prompt appear; the page
 *   reloads only after the person taps Update.
 * - The prompt is dismissible ("Later"). Later hides it without updating; a NEWER waiting version shows it again.
 * - It is not a dialog: no focus trap, no focus move, no overlay. It is a polite status band in normal flow (like the
 *   connectivity banner), so it never covers a drill control. It can push the page down once when it appears; that is the
 *   price of never covering anything, and the alternative (a fixed toast) would sit on top of the drill controls.
 *
 * Readings of the criteria (where they were open):
 * - "toast": read as the transient-looking notice, not a Toaster mount (sonner is not wired into the shell by this bead).
 * - "exposes the build version (import.meta.env BUILD_VERSION) for the footer": the footer already gets its version from GET
 *   /health (features/shell/Shell.tsx, which this bead may not edit). This module exposes the build's own version as the named
 *   export `getBuildVersion()` (`resolveBuildVersion()`: VITE_BUILD_VERSION / BUILD_VERSION, else "dev") and shows it in the
 *   prompt as "Current version: ...", so the person can tell which build they run before deciding. The version being
 *   installed is not known to the page, so only the current one is shown.
 * - A failed update (the waiting worker could not be told to activate) puts the button back and says so in words; nothing else
 *   happens. `onOfflineReady` is not in the criteria (the connectivity banner covers offline) and is not used.
 *
 * `virtual:pwa-register` exists only inside a vite build, so it is loaded lazily behind the injectable `register` seam. Tests
 * pass their own `register`; nothing they import loads the virtual module. A failure to load or run it (no service worker
 * support, a dev server without the plugin) is swallowed: the app works without an update prompt.
 *
 * One polite status region (`role="status"`, `aria-live="polite"`, never an alert) is always in the page and only its content
 * changes, because a live region that is created together with its text is often not announced. The state carries an icon of
 * its own shape plus words, never colour alone (DESIGN.md Second Signal Rule).
 */

/** The shell's container (DESIGN.md Layout): min(1180px, 100% - 40px), 100% - 24px on phones. */
const CONTAINER = 'mx-auto w-[calc(100%-24px)] max-w-295 sm:w-[calc(100%-40px)]';

/** The subset of registerSW's options the prompt uses. */
export interface UpdateCallbacks {
  /** A new service worker is installed and waiting. */
  onNeedRefresh: () => void;
}

/** registerSW's return value: `true` activates the waiting worker and reloads the page. */
export type UpdateServiceWorker = (reloadPage?: boolean) => Promise<void> | void;

/** Registers the service worker; resolves to `updateServiceWorker`. */
export type RegisterUpdate = (callbacks: UpdateCallbacks) => UpdateServiceWorker | Promise<UpdateServiceWorker>;

/** The build version of this bundle, the value the persisted-cache buster uses too. */
export function getBuildVersion(): string {
  return resolveBuildVersion();
}

/** The real registration: vite-plugin-pwa's virtual module (workbox-window inside), imported on demand. */
const defaultRegister: RegisterUpdate = async (callbacks) => {
  const { registerSW } = await import('virtual:pwa-register');
  return registerSW({ immediate: true, onNeedRefresh: callbacks.onNeedRefresh });
};

type Phase = 'idle' | 'updating' | 'failed';

export interface UpdatePromptProps {
  /** Registers the service worker. Default: `virtual:pwa-register`'s `registerSW`. Tests inject their own. */
  register?: RegisterUpdate;
  /** The running build's version. Default: `getBuildVersion()`. */
  version?: string;
}

export function UpdatePrompt({ register = defaultRegister, version = getBuildVersion() }: UpdatePromptProps) {
  const { t } = useTranslation('update');
  const [waiting, setWaiting] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const updateRef = useRef<UpdateServiceWorker | undefined>(undefined);

  useEffect(() => {
    let live = true;
    // `new Promise` also turns a synchronous throw of `register` into a rejection.
    new Promise<UpdateServiceWorker>((resolve) =>
      resolve(
        register({
          onNeedRefresh: () => {
            if (!live) return;
            setPhase('idle');
            setWaiting(true);
          },
        }),
      ),
    ).then(
      (update) => {
        if (live) updateRef.current = update;
      },
      () => {
        // No service worker (unsupported, blocked, dev server without the plugin): no prompt, and nothing to report.
      },
    );
    return () => {
      live = false;
    };
  }, [register]);

  const accept = () => {
    const update = updateRef.current;
    setPhase('updating');
    new Promise<void>((resolve, reject) => {
      if (update === undefined) reject(new Error('the service worker is not registered'));
      else resolve(Promise.resolve(update(true)));
    }).catch(() => setPhase('failed'));
  };

  const later = () => {
    setWaiting(false);
    setPhase('idle');
  };

  const updating = phase === 'updating';
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {waiting && (
        <div data-state={phase} className="border-b border-line bg-paper text-base text-ink">
          <div className={`${CONTAINER} flex flex-wrap items-center gap-x-4 gap-y-2 py-3`}>
            <div className="flex min-w-0 flex-1 basis-60 items-start gap-2.5">
              <RefreshCw aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <div className="min-w-0 wrap-anywhere">
                <p className="font-bold">{t('available')}</p>
                <p>{t('reloadHint')}</p>
                <p className="text-[13px] text-muted">{t('version', { version })}</p>
                {phase === 'failed' && (
                  <p className="mt-1 flex items-start gap-1.5 font-bold">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                    <span>{t('failed')}</span>
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={updating} onClick={accept}>
                {t('update')}
              </Button>
              <Button variant="secondary" disabled={updating} onClick={later}>
                {t('later')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UpdatePromptSlot() {
  return <UpdatePrompt />;
}

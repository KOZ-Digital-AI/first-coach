import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, CircleAlert, CircleUser, FileText, LoaderCircle, LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient, resetPlayerSession, useSession } from '../../lib/auth';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';
import { isAdminSession } from '../shell/Shell';
import { beginSignOut, clearDrafts, resetSessionExpired, SIGN_IN_PATH } from './session-expired';

/**
 * The account entry of the app shell's header slot (lib/slots.ts: this file default-exports ONE component).
 *
 * - An anonymous player (the silent session every visitor gets), or no session: a single discreet "Coach sign-in" link.
 * - A signed-in coach/admin: the display name on a disclosure button; the panel lists My contributions, Admin (admins only) and
 *   Sign out.
 * - Session still loading or being re-read (`isPending` / `isRefetching`): nothing at all, so a signed-in coach never sees the
 *   sign-in link flash first and the payload of the person who just left (Better Auth keeps it while it refetches) is never
 *   drawn: no name, no Admin item. Same rule as routes/admin/route.tsx.
 *
 * Sign out (`AccountDeps`), in this order (each step guarded, so a failing one can neither hide the next nor keep the coach on
 * the page):
 *  1. `beginSignOut()` BEFORE the request: holds the session-expired handler off and drops the drafts (see session-expired.ts),
 *     so a coach-area 401 that arrives meanwhile cannot redirect to sign-in half way through nor save a draft for the next person;
 *  2. the server request. If it does not confirm (an error or a network failure) the handler is re-armed
 *     (`resetSessionExpired`), nothing else is thrown away, the panel says so in words and the button works again;
 *  3. once confirmed: forget the remembered player session (the next ensurePlayerSession() reads the new cookie instead of
 *     returning the coach), clear the drafts again, empty the in-memory query cache;
 *  4. go home, wait for the navigation to land, and only then re-arm the handler, so 401s from refetches that the clearing
 *     provokes cannot redirect the leaving coach.
 *
 * Readings of the criteria (where they were open):
 * - "Menu shown only for a real session": only an explicit `isAnonymous === false` is an account, the same rule as
 *   `requireAdmin` (and `isAdminSession` in the shell, reused here for the Admin item). Missing flag, anonymous, or an
 *   unreadable payload: the sign-in link.
 * - Persisted per-player query cache: lib/query-persist.ts exports no helper that clears it (only the key builder and the
 *   store seam; the persister that owns `removeClient` is private), and it must not be modified, so only the in-memory cache is
 *   emptied. The persisted record is namespaced by player id (`fc:<playerId>:query-cache`), so the next person on the device
 *   never restores it. The anonymous player's own local data (outbox, language) is untouched: only `fc:draft:*` keys of
 *   sessionStorage are cleared.
 * - "Session hook still holds the previous user": Better Auth refetches after sign-out and KEEPS the old payload meanwhile.
 *   After a successful sign-out the controls of that user id stay hidden until the session hook reports something else.
 * - The panel is a disclosure (a button with aria-expanded and a list of links and a button), not `role="menu"`: the menu role
 *   promises arrow-key handling that a plain list does not need. Escape, a press outside or focus leaving close it.
 * - "My contributions" goes to /contribute: the contribute route bead owns the page and has not landed, so the exact
 *   destination for the list is unconfirmed (contract gap).
 * - Sign-out failure UI (an alert inside the panel, retry by pressing the button again) is not in the criteria; it was added
 *   because closing silently would leave a coach believing they had signed out on a shared device.
 */

// Typed `string` on purpose (as in the shell): a literal path for a route that has not landed does not typecheck.
const PATHS: Record<'home' | 'signIn' | 'contributions' | 'admin', string> = {
  home: '/',
  signIn: SIGN_IN_PATH,
  contributions: '/contribute',
  admin: '/admin',
};

/** The part of Better Auth's `useSession()` result that is read; the real result is assignable to it. */
export interface AccountSessionState {
  /** Validated here, not trusted: anything that is not a session with a user object is "no account". */
  data?: unknown;
  isPending?: boolean;
  /** Better Auth sets it while it re-reads the session and KEEPS the previous data: that data may be the previous person's. */
  isRefetching?: boolean;
}

/** What sign-out does besides the UI. Defaults are the real ones; tests inject stand-ins. */
export interface AccountDeps {
  /** Before the request: holds the expiry handler off and drops drafts (`beginSignOut` of session-expired.ts). */
  beginSignOut(): void;
  /** Resolves to Better Auth's `{ data, error }`; a non-null `error` or a rejection means the session was NOT ended. */
  signOut(): Promise<unknown>;
  resetPlayerSession(): void;
  clearDrafts(): void;
  resetSessionExpired(): void;
}

const DEFAULT_DEPS: AccountDeps = {
  beginSignOut: () => beginSignOut(),
  signOut: () => authClient.signOut(),
  resetPlayerSession,
  clearDrafts: () => clearDrafts(),
  resetSessionExpired,
};

type Reading = { kind: 'pending' } | { kind: 'visitor' } | { kind: 'account'; id: string; label: string | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

function readSession(session: AccountSessionState): Reading {
  if (session.isPending || session.isRefetching) return { kind: 'pending' };
  const user = isRecord(session.data) ? session.data.user : undefined;
  if (!isRecord(user) || user.isAnonymous !== false) return { kind: 'visitor' };
  return { kind: 'account', id: typeof user.id === 'string' ? user.id : '', label: text(user.name) ?? text(user.email) };
}

/** Better Auth answers `{ data, error }` and does not throw: a non-null `error` means the session is still there. */
const refused = (result: unknown): boolean => isRecord(result) && result.error !== null && result.error !== undefined;

// Every control is at least 44px tall (DESIGN.md tap targets); the focus ring is the global :focus-visible rule in app.css.
const TRIGGER =
  'inline-flex min-h-tap max-w-full cursor-pointer items-center gap-2 rounded-control border border-line bg-paper px-3 font-bold text-ink hover:bg-bg';
const ITEM =
  'flex min-h-tap w-full cursor-pointer items-center gap-2.5 rounded-control px-3 text-start font-bold text-ink hover:bg-bg aria-disabled:cursor-default aria-disabled:opacity-70';
// whitespace-nowrap (fc-zfg.9): the header row never wraps at >=900px (Shell.tsx), so this link must never squeeze
// "Coach sign-in" onto two lines either.
const VISITOR_LINK =
  'inline-flex min-h-tap items-center whitespace-nowrap rounded-control px-2 text-sm text-muted underline decoration-1 underline-offset-4 hover:text-ink';

export interface AccountControlsProps {
  session: AccountSessionState;
  deps?: Partial<AccountDeps>;
}

type Phase = 'idle' | 'signing-out' | 'failed';

export function AccountControls({ session, deps }: AccountControlsProps) {
  const { t } = useTranslation('account');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const signingOut = useRef(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [endedId, setEndedId] = useState<string | null>(null);

  const reading = readSession(session);
  const accountId = reading.kind === 'account' ? reading.id : null;

  // A user id that has signed out stays hidden until the session hook shows anyone else (or nobody).
  const settled = reading.kind !== 'pending';
  useEffect(() => {
    if (settled && endedId !== null && accountId !== endedId) setEndedId(null);
  }, [settled, accountId, endedId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onOutside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, [open]);

  if (reading.kind === 'pending') return null;

  if (reading.kind === 'visitor') {
    return (
      // Tighter side padding than the signed-in trigger below (fc-zfg.9: the header row must never wrap at >=900px;
      // this is the only header-extra state that has to share the row with the full desktop nav and the language
      // switch at once - the signed-in panel trigger keeps its own padding).
      <div className="px-0.5 py-2">
        <Link to={PATHS.signIn} className={VISITOR_LINK}>
          {t('coachSignIn')}
        </Link>
      </div>
    );
  }

  if (reading.id === endedId) return null;

  const isAdmin = isAdminSession(session.data);
  const label = reading.label ?? t('fallbackName');

  function toggle() {
    if (!open && phase === 'failed') setPhase('idle');
    setOpen(!open);
  }

  async function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    setPhase('signing-out');
    const use: AccountDeps = { ...DEFAULT_DEPS, ...deps };
    // A failing step must not hide the next one, nor keep the coach on the page.
    const guarded = (step: () => void) => {
      try {
        step();
      } catch {
        // deliberately quiet
      }
    };
    guarded(use.beginSignOut); // BEFORE the request: a 401 that comes back meanwhile must not redirect or save a draft
    let ended = false;
    try {
      ended = !refused(await use.signOut());
    } catch {
      ended = false;
    }
    signingOut.current = false;
    if (!ended) {
      guarded(use.resetSessionExpired); // the session is still there: its expiry redirect has to keep working
      setPhase('failed');
      return;
    }
    // The memo goes first so nothing re-reads the coach's session.
    guarded(use.resetPlayerSession);
    guarded(use.clearDrafts);
    guarded(() => queryClient.clear());
    setEndedId(reading.kind === 'account' ? reading.id : null);
    setPhase('idle');
    setOpen(false);
    try {
      await navigate({ to: PATHS.home });
    } catch {
      // the coach is signed out either way
    }
    guarded(use.resetSessionExpired); // only now: refetches provoked by the clearing have been left behind with the page
  }

  return (
    <div ref={rootRef} className="relative px-4 py-2">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
        className={TRIGGER}
      >
        <CircleUser aria-hidden="true" size={20} className="shrink-0" />
        <span className="max-w-40 truncate">{label}</span>
        <span className="sr-only">, {t('menuLabel')}</span>
        <ChevronDown aria-hidden="true" size={16} className="shrink-0" />
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute start-4 top-full z-30 w-[min(16rem,calc(100vw-2rem))] rounded-card border border-line bg-paper p-2 shadow-soft"
        >
          <ul className="flex flex-col gap-1">
            <li>
              <Link to={PATHS.contributions} onClick={() => setOpen(false)} className={ITEM}>
                <FileText aria-hidden="true" size={18} className="shrink-0" />
                {t('myContributions')}
              </Link>
            </li>
            {isAdmin && (
              <li>
                <Link to={PATHS.admin} onClick={() => setOpen(false)} className={ITEM}>
                  <ShieldCheck aria-hidden="true" size={18} className="shrink-0" />
                  {t('admin')}
                </Link>
              </li>
            )}
            <li>
              <button type="button" aria-disabled={phase === 'signing-out'} onClick={() => void signOut()} className={ITEM}>
                {phase === 'signing-out' ? (
                  <LoaderCircle aria-hidden="true" size={18} className="shrink-0 motion-safe:animate-spin" />
                ) : (
                  <LogOut aria-hidden="true" size={18} className="shrink-0" />
                )}
                {phase === 'signing-out' ? t('signingOut') : t('signOut')}
              </button>
            </li>
          </ul>
          {phase === 'failed' && (
            <p role="alert" className="mt-2 flex items-start gap-2 rounded-control bg-danger-tint px-3 py-2.5 text-sm text-ink">
              <CircleAlert aria-hidden="true" size={18} className="mt-px shrink-0 text-danger" />
              <span className="min-w-0 wrap-anywhere">{t('signOutFailed')}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AccountHeader() {
  return <AccountControls session={useSession()} />;
}

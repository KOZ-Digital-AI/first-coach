import { createFileRoute, Link, Outlet, useRouter } from '@tanstack/react-router';
import { Check, Lock } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { useSession } from '../../lib/auth';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';

/**
 * routes/admin/route.tsx: the layout for every /admin/* page. It decides only what a person SEES:
 *  - no session, or only the silent anonymous player session -> the sign-in page, with `redirect` set to this page;
 *  - signed in but not an admin (or banned)                    -> the unauthorized page, in place;
 *  - an admin                                                  -> the sub-navigation and the page.
 *
 * THIS GUARD IS COSMETIC (UX only). The API's `requireAdmin` (apps/api/src/auth/middleware.ts) is the real gate: it reads the
 * server session on every /api/admin request and answers 401/403 whatever this component shows. Nothing here protects data;
 * it only keeps a person from landing on screens that could not work for them. The rules below mirror requireAdmin (a
 * non-anonymous user whose comma-separated role list contains exactly "admin") so the two agree, but they may drift without
 * opening anything: the server never trusts this file.
 *
 * It nevertheless FAILS CLOSED, so a slow or broken session never flashes admin screens: admin content renders only when the
 * session is loaded, has no error, is a readable session object and passes every rule. Loading, an error and anything the
 * layout cannot read (an HTML page from a proxy, `{}`, `{ user: null }`) each render a state screen with no admin content.
 *
 * Known gap (backlog): there is no `beforeLoad` gate. The check runs at render time from the session hook, so a child route's
 * own `beforeLoad`/loader still starts for a signed-out visitor; such code must not depend on this layout and its API calls
 * are refused by requireAdmin anyway. A `beforeLoad` check would need an async session read outside React.
 *
 * Readings of the criteria (ambiguous in the bead):
 * - "signed-out" includes an anonymous player session: every visitor gets one silently (lib/auth.ts), so "has a session" is
 *   not "signed in"; an admin needs a real account, and the sign-in page is the only way to one. requireAdmin agrees
 *   (anonymous -> 403), and only an explicit `isAnonymous === false` counts as a real account.
 * - "the unauthorized page" is rendered by this layout in place (URL unchanged, no redirect): no separate route exists.
 * - "sign-in with redirect" is `/account/sign-in?redirect=<encoded path, query and hash of the requested page>`. The sign-in
 *   screen is routes/account/sign-in.tsx (bead 70i.7, not part of this bead); it must accept only same-origin paths in `redirect`.
 * - Sub-navigation targets are /admin/queue, /admin/drills, /admin/impact and /admin/settings (ADMIN_NAV below). The pages
 *   are other beads' routes and are not in the typed route tree yet, hence the `as never` on `to`.
 * - Pages under this layout render their own <main> (the convention of the existing pages); the layout adds the nav only.
 */

const SIGN_IN_PATH = '/account/sign-in';
const ROLE_ADMIN = 'admin';

const ADMIN_NAV = [
  { to: '/admin/queue', label: 'reviewQueue' },
  { to: '/admin/drills', label: 'drills' },
  { to: '/admin/impact', label: 'impact' },
  { to: '/admin/settings', label: 'settings' },
] as const;

/** The part of Better Auth's `useSession()` result that the layout reads; the real result is assignable to it. */
export interface AdminSessionState {
  /** Validated here, not trusted: anything that is not a session with a user object is an unreadable session. */
  data?: unknown;
  isPending: boolean;
  /**
   * Better Auth sets this while it re-reads the session (after a sign-in or sign-out on this tab, on refocus) and KEEPS the
   * previous data with isPending false. That data can belong to the previous person, so it is never acted on.
   */
  isRefetching?: boolean;
  error?: unknown;
  refetch: () => unknown;
}

type Access = 'loading' | 'error' | 'signed-out' | 'forbidden' | 'admin';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Exact match, no trimming and no case folding: the same rule as requireAdmin and the Better Auth admin plugin. */
const hasAdminRole = (role: unknown): boolean => typeof role === 'string' && role.split(',').includes(ROLE_ADMIN);

function resolveAccess(session: AdminSessionState): Access {
  // Loading in EVERY branch, before the data or the error is looked at: while a refetch is in flight, `data` may still be the
  // previous session (an admin who just signed out, an anonymous player who just signed in). No admin content, no redirect.
  if (session.isPending || session.isRefetching) return 'loading';
  if (session.error !== null && session.error !== undefined) return 'error';
  const { data } = session;
  if (data === null || data === undefined) return 'signed-out';
  if (!isRecord(data) || !isRecord(data.user)) return 'error';
  const { user } = data;
  if (user.isAnonymous !== false) return 'signed-out';
  // Any ban blocks the screens; the server also honours an expiry date, which is a detail the UI does not need.
  if (user.banned) return 'forbidden';
  return hasAdminRole(user.role) ? 'admin' : 'forbidden';
}

const EYEBROW = 'text-xs font-bold tracking-[.12em] text-accent uppercase';
const SCREEN = 'mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5';
// 44px tall, wrapping words, a check icon on the current section: state is never colour alone (aria-current is set by Link).
const NAV_LINK =
  'flex min-h-tap min-w-0 items-center justify-center gap-1.5 rounded-control border border-line bg-paper px-3 py-2 text-center text-base font-bold wrap-anywhere text-ink hover:bg-bg data-[status=active]:border-accent data-[status=active]:bg-accent-2 sm:px-4';
const HOME_LINK =
  'mt-6 inline-flex min-h-tap max-w-full items-center justify-center rounded-control border border-line bg-paper px-4.5 py-2.5 text-center font-bold wrap-anywhere text-ink hover:bg-bg';

function StateScreen({ busy = false, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <main aria-busy={busy || undefined} className={SCREEN}>
      {children}
    </main>
  );
}

function Loading({ message }: { message: string }) {
  return (
    <StateScreen busy>
      <p role="status" className="text-lg font-bold text-ink">
        {message}
      </p>
      <Skeleton className="mt-4 h-11 w-full max-w-64" />
      <Skeleton className="mt-2 h-11 w-full max-w-48" />
    </StateScreen>
  );
}

/** Sends a signed-out visitor to sign-in, then says so while the navigation happens. Renders nothing of the admin area. */
function SignedOut() {
  const { t } = useTranslation('admin-layout');
  const router = useRouter();
  // Read ONCE, when the visitor lands here. Following the live location would re-run the effect after the redirect itself
  // (this component is still mounted for a moment at /account/sign-in) and nest `redirect` inside `redirect` without end.
  const [requested] = useState(() => router.state.location.href);
  useEffect(() => {
    router.history.replace(`${SIGN_IN_PATH}?redirect=${encodeURIComponent(requested)}`);
  }, [router, requested]);
  return <Loading message={t('redirecting')} />;
}

function Unauthorized() {
  const { t } = useTranslation('admin-layout');
  return (
    <StateScreen>
      <p className={`${EYEBROW} flex items-center gap-1.5`}>
        <Lock aria-hidden="true" className="size-4 shrink-0" />
        {t('eyebrow')}
      </p>
      <h1 className="mt-3 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink">
        {t('unauthorized.title')}
      </h1>
      <p className="mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('unauthorized.hint')}</p>
      <Link to={'/' as never} className={HOME_LINK}>
        {t('unauthorized.home')}
      </Link>
    </StateScreen>
  );
}

function AdminNav() {
  const { t } = useTranslation('admin-layout');
  return (
    <nav aria-label={t('navLabel')} className="mx-auto w-full max-w-295 border-b border-line px-3 pt-6 pb-4 sm:px-5">
      <p className={EYEBROW}>{t('eyebrow')}</p>
      <ul className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {ADMIN_NAV.map(({ to, label }) => (
          <li key={to} className="min-w-0">
            <Link to={to as never} className={NAV_LINK}>
              {({ isActive }: { isActive: boolean }) => (
                <>
                  {isActive && <Check aria-hidden="true" className="size-4 shrink-0" />}
                  {t(label)}
                </>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The layout with the session handed in (the route below passes the real one; tests pass their own). */
export function AdminLayoutView({ session }: { session: AdminSessionState }) {
  const { t } = useTranslation('admin-layout');
  const access = resolveAccess(session);
  switch (access) {
    case 'admin':
      return (
        <>
          <AdminNav />
          <Outlet />
        </>
      );
    case 'signed-out':
      return <SignedOut />;
    case 'forbidden':
      return <Unauthorized />;
    case 'error':
      return (
        <StateScreen>
          <ErrorState
            title={t('error.title')}
            message={t('error.message')}
            retryLabel={t('error.retry')}
            onRetry={() => void session.refetch()}
          />
        </StateScreen>
      );
    case 'loading':
      return <Loading message={t('loading')} />;
    default: {
      // Exhaustive: a new Access value must be handled above. Anything unhandled at runtime shows nothing of the admin area.
      const unhandled: never = access;
      return unhandled;
    }
  }
}

function AdminLayout() {
  return <AdminLayoutView session={useSession()} />;
}

export const Route = createFileRoute('/admin')({ component: AdminLayout });

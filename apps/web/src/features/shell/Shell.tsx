import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CirclePlus, Footprints, Library, ShieldCheck, TrendingUp, Video, type LucideIcon } from 'lucide-react';
import type { ComponentType, MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ResponseSchema } from '../../lib/api';
import { useSession } from '../../lib/auth';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';
import { type HeaderSlotProps, type RootSlotProps, useSlot } from '../../lib/slots';

/**
 * The app shell: every page is wrapped in it by routes/__root.tsx. Layout follows the prototype (first-coach-demo.html) and
 * DESIGN.md (Navigation, Layout): a sticky blurred paper header, the primary navigation, a footer, and, under 900px, a
 * bottom tab bar in place of the top navigation. Light theme only: there is no theme switch.
 *
 * Extension points for later beads (nobody edits this file to add UI):
 * - `features/<name>/header-extra.tsx` (slot `header`): rendered in the header, in module-path order, inside
 *   `<div data-slot="header">`. The language switch (features/i18n) and the account menu use it. Components arrive with their
 *   own padding; the region adds none.
 * - `features/<name>/root-extra.tsx` (slot `root`): rendered in `<div data-slot="root">` directly below the header, in normal
 *   flow, above the page. A banner (e.g. "you are offline") can simply render its content; a component that draws nothing
 *   (a service-worker update prompt) or uses its own fixed position (a toast) works just as well. The bottom tab bar is
 *   `sticky`, not `fixed`, so it never covers anything below it.
 * Neither region is rendered when its slot is empty.
 *
 * Readings of the criteria (where they were open):
 * - The routed page goes inside `<div id="main-content" tabIndex={-1}>`, NOT a `<main>`: the merged pages (/legal/*) already
 *   render their own `<main>`, and nested `<main>` elements are invalid. The skip link targets this region.
 * - Admin: the link sits in the header at every width, because six tabs would not fit a 360px tab bar. The check is
 *   `isAdminSession`, the same rule as the API guard (`requireAdmin`); it only decides what to SHOW, the server still refuses.
 * - Build version: the web build carries no version of its own (the Dockerfile sets BUILD_VERSION for the API process), so
 *   `AppShell` asks `GET /health`, which reports it. Offline or unavailable: the version line is simply left out.
 * - Privacy settings (/settings/privacy, fc-mol-bjm.12): a footer link beside the legal ones, shown to every visitor (the shell
 *   knows no session kind, and a guest already has a player). A calm secondary entry: it is deliberately not a primary or tab-bar
 *   item, so it never competes with training. The label lives in nav-links.messages.ts. Video Coach · Beta (/video) was already
 *   the last item of both navigations (after Train), where the existing shell tests pin it.
 * - Nav destinations are plain strings, not literal route paths: the route beads that own /train, /commons, /contribute,
 *   /progress, /video and /admin have not all landed, and a literal `to` for a missing route does not typecheck. They are
 *   still real router links (client-side navigation, `aria-current`).
 */

const CONTENT_ID = 'main-content';

/** Typed `string` on purpose (see the last reading above): a literal for a route that does not exist yet does not typecheck. */
const PATHS: Record<'home' | 'admin' | 'privacy' | 'privacySettings' | 'terms' | 'recover', string> = {
  home: '/',
  admin: '/admin',
  privacy: '/legal/privacy',
  privacySettings: '/settings/privacy',
  terms: '/legal/terms',
  recover: '/recover',
};

/** Container from DESIGN.md Layout: min(1180px, 100% - 40px), 100% - 24px on phones. */
const CONTAINER = 'mx-auto w-[calc(100%-24px)] max-w-295 sm:w-[calc(100%-40px)]';

interface NavItem {
  key: 'train' | 'commons' | 'contribute' | 'progress' | 'video';
  to: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'train', to: '/train', icon: Footprints },
  { key: 'commons', to: '/commons', icon: Library },
  { key: 'contribute', to: '/contribute', icon: CirclePlus },
  { key: 'progress', to: '/progress', icon: TrendingUp },
  { key: 'video', to: '/video', icon: Video },
];

/**
 * True for a signed-in, non-anonymous account whose role list contains `admin`. Mirrors `requireAdmin` in
 * apps/api/src/auth/middleware.ts: only an explicit `isAnonymous: false` is an account, and roles are an exact
 * comma-separated match. `session` is a Better Auth session payload (`{ user }`) or nothing.
 */
export function isAdminSession(session: unknown): boolean {
  if (typeof session !== 'object' || session === null) return false;
  const user = (session as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) return false;
  const { role, isAnonymous } = user as { role?: unknown; isAnonymous?: unknown };
  return isAnonymous === false && typeof role === 'string' && role.split(',').includes('admin');
}

// --- the shell ---------------------------------------------------------------------------------

export interface ShellProps {
  /** The routed page (the router's `<Outlet />`). */
  children: ReactNode;
  /** Shows the Admin link. Default false. */
  isAdmin?: boolean;
  /** Build version for the footer. Left out of the footer when absent. */
  version?: string;
  /** Overrides the glob-collected slot components (tests). Default: `useSlot('header')` and `useSlot('root')`. */
  slots?: {
    header?: readonly ComponentType<HeaderSlotProps>[];
    root?: readonly ComponentType<RootSlotProps>[];
  };
}

// Every link is at least 44px tall (DESIGN.md tap targets). The focus ring is the global :focus-visible rule in app.css.
// whitespace-nowrap (fc-zfg.9): the top navigation must never squeeze a link's own text onto two lines ("Open Commons",
// "Video Coach · Beta"); the row it sits in has its own no-wrap rule below instead.
const TOP_LINK =
  'relative inline-flex min-h-tap items-center whitespace-nowrap rounded-control px-0.5 font-bold text-ink hover:bg-ink/5 motion-safe:transition-colors';
const TAB_LINK =
  'relative flex min-h-tap flex-col items-center justify-center gap-1 px-0.5 py-2 text-center text-xs leading-[1.15] font-bold text-ink wrap-anywhere aria-[current=page]:bg-accent-2';
const ACTION_LINK =
  'inline-flex min-h-tap items-center gap-1.5 rounded-control border border-line bg-paper px-3 font-bold text-ink hover:bg-bg';
const FOOTER_LINK =
  'inline-flex min-h-tap items-center rounded-control font-bold text-ink underline decoration-accent decoration-2 underline-offset-4';

/** The mark of the active item besides colour: a bar (top navigation: under the label; tab bar: above the icon). */
function ActiveIndicator({ placement }: { placement: 'under' | 'over' }) {
  return (
    <span
      data-active-indicator=""
      aria-hidden="true"
      className={
        placement === 'under'
          ? 'absolute inset-x-3 bottom-1 h-[3px] rounded-pill bg-accent'
          : 'absolute inset-x-3 top-0 h-[3px] rounded-b-pill bg-accent'
      }
    />
  );
}

function skipToContent(event: MouseEvent<HTMLAnchorElement>): void {
  const target = document.getElementById(CONTENT_ID);
  if (target === null) return; // fall back to the plain #main-content jump
  event.preventDefault();
  target.focus();
}

export function Shell({ children, isAdmin = false, version, slots }: ShellProps) {
  // `shell` first: it is the default namespace of the bare keys below. `nav-links` holds the Privacy settings label.
  const { t } = useTranslation(['shell', 'nav-links']);
  const globHeader = useSlot('header');
  const globRoot = useSlot('root');
  const headerExtras = slots?.header ?? globHeader;
  const rootExtras = slots?.root ?? globRoot;

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href={`#${CONTENT_ID}`}
        onClick={skipToContent}
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:inline-flex focus:min-h-tap focus:items-center focus:rounded-control focus:bg-ink focus:px-4 focus:font-bold focus:text-white"
      >
        {t('skip')}
      </a>

      {/* Translucent bench paper with a blur; the blur is progressive enhancement, the bar stays readable without it. */}
      <header className="sticky top-0 z-20 border-b border-ink/10 bg-bg/90 backdrop-blur-[18px]">
        {/*
         * min-[900px]:flex-nowrap (fc-zfg.9): below the 1220px desktop-nav breakpoint (see the nav element below) this
         * row only ever holds the brand mark and the header-extra slot (the primary nav is `hidden` until 1220px and
         * removed from flex layout, not merely squeezed) - comfortably narrow even at 900px width, so 900px is plenty
         * of margin for "never wrap this row"; it is not tied to the nav's own breakpoint. Two user screenshots showed
         * the header-extra slot (sign-in + language switch) dropping onto a second row in ru/kk, and the nav links
         * wrapping inside themselves in en; whitespace-nowrap on the links plus this rule fix both.
         */}
        <div className={`${CONTAINER} flex min-h-19 flex-wrap items-center gap-x-1 gap-y-1 py-1.5 min-[900px]:flex-nowrap`}>
          <Link to={PATHS.home} className="flex min-h-tap items-center gap-2.5 rounded-control text-ink">
            <span
              aria-hidden="true"
              className="grid size-9.5 shrink-0 place-items-center rounded-control bg-ink font-extrabold tracking-[-.04em] text-white"
            >
              FC
            </span>
            <span className="block leading-tight">
              <strong className="block text-[13px] tracking-[.08em]">FIRST COACH</strong>
              <span className="sr-only"> / </span>
              <small className="mt-0.5 block text-xs tracking-[.08em] text-muted">БІРІНШІ БАПКЕР</small>
            </span>
            <span className="sr-only">, {t('home')}</span>
          </Link>

          {/*
           * fc-zfg.9 - desktop-nav breakpoint raised from 900px to 1220px (below it the nav stays `hidden` and the
           * bottom tab bar carries navigation instead; keep this in lockstep with the tab bar's min-[1220px]:hidden
           * further down and the admin link's min-[1220px]:ms-0 beside it). Measured live (playwright, real browser,
           * apps/web dev server) with nowrap links, the compacted language switch and the tightened paddings/gaps
           * above and below: the header row's own natural (unconstrained) content width is 1030px (kk), 938px (en)
           * and 1160px (ru, the widest - longer Cyrillic nav labels), all under CONTAINER's 1180px cap (DESIGN.md
           * Layout: "min(1180px, 100% - 40px)"), so it's the RAMP-UP region that matters: CONTAINER equals
           * `100% - 40px` until the viewport reaches 1220px, so a viewport narrower than 1220px hands the row less
           * than the 1160px ru needs even though 1160 < 1180. 1220px is the smallest breakpoint at which CONTAINER
           * has already reached its 1180px cap in every locale, giving ru a 20px margin instead of landing exactly on
           * the edge. See shell.test.tsx and the report for the full 5-width x 3-locale measurement table.
           */}
          <nav aria-label={t('nav.primary')} className="hidden flex-1 justify-center gap-0.5 min-[1220px]:flex">
            {NAV_ITEMS.map(({ key, to }) => (
              <Link key={key} to={to} className={TOP_LINK}>
                {({ isActive }) => (
                  <>
                    {t(`nav.${key}`)}
                    {isActive && <ActiveIndicator placement="under" />}
                  </>
                )}
              </Link>
            ))}
          </nav>

          {isAdmin && (
            <Link to={PATHS.admin} className={`${ACTION_LINK} ms-auto min-[1220px]:ms-0`}>
              <ShieldCheck aria-hidden="true" size={16} />
              {t('admin')}
            </Link>
          )}

          {headerExtras.length > 0 && (
            <div
              data-slot="header"
              className="flex w-full flex-wrap items-center gap-2 sm:ms-auto sm:w-auto min-[900px]:flex-nowrap"
            >
              {headerExtras.map((Extra, index) => (
                <Extra key={index} />
              ))}
            </div>
          )}
        </div>
      </header>

      {rootExtras.length > 0 && (
        <div data-slot="root">
          {rootExtras.map((Extra, index) => (
            <Extra key={index} />
          ))}
        </div>
      )}

      {/* Programmatic focus target of the skip link: not interactive, so no ring of its own. */}
      <div id={CONTENT_ID} tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </div>

      <footer className="mt-16 border-t border-line text-sm text-muted">
        <div className={`${CONTAINER} flex flex-col gap-5 py-7 min-[900px]:flex-row min-[900px]:justify-between`}>
          <div className="flex flex-col gap-1">
            <strong className="text-ink">FIRST COACH</strong>
            <span>{t('footer.tagline')}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span>{t('footer.licences')}</span>
            <span>{t('footer.credit')}</span>
            {version !== undefined && <span>{t('footer.version', { version })}</span>}
          </div>
          <nav aria-label={t('footer.links')}>
            <ul className="flex flex-wrap gap-x-5 gap-y-0">
              <li>
                <Link to={PATHS.privacy} className={FOOTER_LINK}>
                  {t('footer.privacy')}
                </Link>
              </li>
              <li>
                <Link to={PATHS.terms} className={FOOTER_LINK}>
                  {t('footer.terms')}
                </Link>
              </li>
              <li>
                <Link to={PATHS.privacySettings} className={FOOTER_LINK}>
                  {t('nav-links:privacySettings')}
                </Link>
              </li>
              <li>
                <Link to={PATHS.recover} className={FOOTER_LINK}>
                  {t('footer.restore')}
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </footer>

      {/*
       * Replaces the top navigation under 1220px (fc-zfg.9: raised from 900px in lockstep with the nav's own
       * min-[1220px]:flex above - see that comment for the measured widths behind the number). Sticky (not fixed) at
       * the end of the page: it never hides content.
       */}
      <nav
        aria-label={t('nav.tabs')}
        className="sticky bottom-0 z-20 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] min-[1220px]:hidden"
      >
        <ul className="mx-auto grid max-w-lg grid-cols-5">
          {NAV_ITEMS.map(({ key, to, icon: Icon }) => (
            <li key={key} className="min-w-0">
              <Link to={to} className={TAB_LINK}>
                {({ isActive }) => (
                  <>
                    {isActive && <ActiveIndicator placement="over" />}
                    <Icon aria-hidden="true" size={20} />
                    {t(`nav.${key}`)}
                  </>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

// --- the wired shell ---------------------------------------------------------------------------

/** Only `version` is read from /health; a structural parser keeps zod (which the shared schema needs) out of the entry bundle. */
const HEALTH_VERSION: ResponseSchema<string> = {
  safeParse(input) {
    const version = typeof input === 'object' && input !== null ? (input as { version?: unknown }).version : undefined;
    if (typeof version === 'string' && version.trim() !== '') return { success: true, data: version.trim() };
    return { success: false, error: { issues: [{ message: 'the health response has no version' }] } };
  },
};

const TEN_MINUTES = 10 * 60 * 1000;

function useBuildVersion(): string | undefined {
  const { data } = useQuery({
    queryKey: ['build-version'],
    queryFn: ({ signal }) => api.get('/health', { schema: HEALTH_VERSION, signal }),
    staleTime: TEN_MINUTES,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return data;
}

/** The shell with real data: the admin flag from the Better Auth session and the build version from /health. */
export function AppShell({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const version = useBuildVersion();
  return (
    <Shell isAdmin={isAdminSession(session)} version={version}>
      {children}
    </Shell>
  );
}

import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { Compass, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { AppShell } from '../features/shell/Shell';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../lib/i18n';

// The header and root extension slots (lib/slots.ts) are rendered by the shell, so later beads still add UI
// without editing this file.
function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/*
 * The root's two fallback screens (words: features/shell/error-pages.messages.ts, namespace `error-pages`). Calm and short,
 * never scolding (PRODUCT.md): what happened, then one clear next step.
 *
 * - notFoundComponent renders where the routed page would, so an unknown URL keeps the shell (header, navigation, footer).
 *   The primary action is home, the second is training.
 * - errorComponent replaces the whole root match (a React error boundary wraps the shell too), so it is deliberately
 *   self-contained: it needs no session, no query client and no router state, and uses a plain `<a href="/">` so that "home"
 *   is a full page load, not a client navigation into whatever just broke. Any error a child route does not catch itself
 *   (no errorComponent of its own, no router-level default) lands here. The error object is never shown to the visitor.
 */

// Same page column and type scale as the other pages (DESIGN.md Layout, Typography); every link is at least 44px tall.
const PAGE = 'mx-auto w-[calc(100%-24px)] max-w-190 py-10 sm:w-[calc(100%-40px)] sm:py-16';
const EYEBROW = 'flex items-center gap-1.5 text-xs font-bold tracking-[.12em] text-accent uppercase';
const HEADING = 'mt-3 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';
const BODY = 'mt-5 max-w-[62ch] text-lg leading-[1.45] wrap-break-word text-ink';
const ACTIONS = 'mt-8 flex flex-col gap-3 sm:flex-row';
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const PRIMARY_LINK = `${LINK_BASE} border-ink bg-ink text-white`;
const SECONDARY_LINK = `${LINK_BASE} border-line bg-paper text-ink hover:bg-bg`;

/** 404: rendered inside the shell, in place of the routed page. */
export function NotFoundPage() {
  const { t } = useTranslation('error-pages');
  return (
    <main className={PAGE}>
      <p className={EYEBROW}>
        <Compass aria-hidden="true" className="size-4 shrink-0" />
        {t('notFound.eyebrow')}
      </p>
      <h1 className={HEADING}>{t('notFound.title')}</h1>
      <p className={BODY}>{t('notFound.body')}</p>
      <div className={ACTIONS}>
        <Link to="/" className={PRIMARY_LINK}>
          {t('notFound.home')}
        </Link>
        <Link to="/train" className={SECONDARY_LINK}>
          {t('notFound.train')}
        </Link>
      </div>
    </main>
  );
}

/** Something threw while rendering: a calm message and a reload, never a blank screen. Replaces the shell (see above). */
export function RootErrorPage() {
  const { t } = useTranslation('error-pages');
  return (
    <main className={PAGE}>
      <p className="text-[13px] font-bold tracking-[.08em] text-ink">FIRST COACH / БІРІНШІ БАПКЕР</p>
      <div role="alert" className="mt-10">
        <p className={EYEBROW}>
          <RotateCw aria-hidden="true" className="size-4 shrink-0" />
          {t('error.eyebrow')}
        </p>
        <h1 className={HEADING}>{t('error.title')}</h1>
        <p className={BODY}>{t('error.body')}</p>
      </div>
      <div className={ACTIONS}>
        <Button className="w-full sm:w-auto" onClick={() => window.location.reload()}>
          {t('error.reload')}
        </Button>
        <a href="/" className={SECONDARY_LINK}>
          {t('error.home')}
        </a>
      </div>
    </main>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: RootErrorPage,
});

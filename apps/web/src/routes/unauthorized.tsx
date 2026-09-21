import { createFileRoute, Link } from '@tanstack/react-router';
import { LockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../lib/i18n';

/**
 * /unauthorized: a calm explanation that the page a visitor asked for needs an admin or coach account, with sign-in as the
 * one clear next step (and home as the way out). Words: features/shell/error-pages.messages.ts (namespace `error-pages`).
 *
 * Reading of the criteria: this is a plain informational route inside the shell. It does not look at the session and does
 * not redirect: it is where a guard (or a link) can send a visitor, and the real gate is always the API (401/403).
 */

const PAGE = 'mx-auto w-[calc(100%-24px)] max-w-190 py-10 sm:w-[calc(100%-40px)] sm:py-16';
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';

export const Route = createFileRoute('/unauthorized')({ component: UnauthorizedPage });

export function UnauthorizedPage() {
  const { t } = useTranslation('error-pages');
  return (
    <main className={PAGE}>
      <p className="flex items-center gap-1.5 text-xs font-bold tracking-[.12em] text-accent uppercase">
        <LockKeyhole aria-hidden="true" className="size-4 shrink-0" />
        {t('unauthorized.eyebrow')}
      </p>
      <h1 className="mt-3 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink">
        {t('unauthorized.title')}
      </h1>
      <p className="mt-5 max-w-[62ch] text-lg leading-[1.45] wrap-break-word text-ink">{t('unauthorized.body')}</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link to="/account/sign-in" className={`${LINK_BASE} border-ink bg-ink text-white`}>
          {t('unauthorized.signIn')}
        </Link>
        <Link to="/" className={`${LINK_BASE} border-line bg-paper text-ink hover:bg-bg`}>
          {t('unauthorized.home')}
        </Link>
      </div>
    </main>
  );
}

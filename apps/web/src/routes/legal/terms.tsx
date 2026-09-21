import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../components/ui/notice';
import { GENESIS_DRAFT_SOURCE, TrustBadge } from '../../features/commons/TrustBadge';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';

/**
 * /legal/terms: the terms and the content licence, in kk, ru and en. A Read-mode page: one calm column, a contents list,
 * eight short sections. All words live in features/legal/terms.messages.ts (namespace `terms`).
 *
 * Readings of the criteria:
 * - "Safety notes" are the short list in the own-risk section (the same rules the seeded drills already give: warm up, a
 *   soft ball or gentle passes against a wall, away from roads, cars and streets) plus "read each drill's notes".
 * - The takedown section needs a way to reach someone. The repo has exactly one: the optional VITE_CONTACT_EMAIL build
 *   variable (apps/api/src/env.ts, .env.example). It is shown as a mailto link when it holds an address; otherwise the
 *   page says honestly that none is published. No address is invented here.
 * - The attribution line is copied from CONTENT-LICENSE.md and stays in English in every locale: re-users paste it as is.
 */

const CC_LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const COMMONS_EXPORT_PATH = '/api/commons/export.json';
const ATTRIBUTION_LINE =
  'Source: Open Sport Commons by FIRST COACH (KOZ AI) and contributors, licensed CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/';

type SectionSpec = {
  /** Message key under `sections.` and the anchor id. */
  id: 'free' | 'licences' | 'reuse' | 'contributing' | 'communityDraft' | 'ownRisk' | 'children' | 'takedown';
  /** Keys under `sections.<id>.points`, in reading order. */
  points?: readonly string[];
  /** The lead is a notice (icon + words) instead of a paragraph: the two things a reader must not miss. */
  callout?: 'warn' | 'info';
};

const SECTIONS: readonly SectionSpec[] = [
  { id: 'free' },
  { id: 'licences', points: ['software', 'knowledge'] },
  { id: 'reuse', points: ['attribution', 'shareAlike'] },
  { id: 'contributing', points: ['authorship', 'licence', 'rights', 'noCommercial'] },
  { id: 'communityDraft' },
  { id: 'ownRisk', points: ['read', 'warmUp', 'space', 'ball', 'stop'], callout: 'warn' },
  { id: 'children', callout: 'info' },
  { id: 'takedown', points: ['what', 'why', 'review'] },
];

/** The configured operator address, or null when unset or not shaped like an address (never a broken mailto). */
function contactEmail(): string | null {
  const raw: unknown = import.meta.env?.VITE_CONTACT_EMAIL;
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[^\s@]+@[^\s@]+$/.test(value) ? value : null;
}

// 44px tall (DESIGN.md tap target), underlined so a link is never colour alone, and the visible focus ring comes from
// the global :focus-visible rule in styles/app.css.
const LINK =
  'inline-flex min-h-tap items-center gap-1.5 rounded-control font-bold text-ink underline decoration-accent decoration-2 underline-offset-4 wrap-anywhere';

function ExternalAnchor({ href, children }: { href: string; children: string }) {
  const { t } = useTranslation('terms');
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
      {children}
      <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
      <span className="sr-only">, {t('newTab')}</span>
    </a>
  );
}

function SectionExtras({ id }: { id: SectionSpec['id'] }) {
  const { t } = useTranslation('terms');
  switch (id) {
    case 'licences':
      return <ExternalAnchor href={CC_LICENCE_URL}>{t('licenceLink')}</ExternalAnchor>;
    case 'reuse':
      return (
        <>
          <p className="mt-3 text-base font-bold">{t('attributionIntro')}</p>
          <div lang="en" className="mt-2 rounded-control border border-line bg-white px-3.5 py-3">
            <code className="block text-base leading-[1.45] wrap-anywhere select-all">{ATTRIBUTION_LINE}</code>
          </div>
          <div className="mt-3">
            <a href={COMMONS_EXPORT_PATH} className={LINK}>
              {t('exportLink')}
            </a>
          </div>
        </>
      );
    case 'communityDraft':
      return (
        <div className="mt-3">
          <TrustBadge status="COMMUNITY" source={GENESIS_DRAFT_SOURCE} />
        </div>
      );
    case 'takedown': {
      const email = contactEmail();
      return (
        <p className="mt-4 text-base leading-[1.45] wrap-anywhere">
          {email === null ? (
            t('noContact')
          ) : (
            <>
              {t('contactLabel')}{' '}
              <a href={`mailto:${email}`} className={LINK}>
                {email}
              </a>
            </>
          )}
        </p>
      );
    }
    default:
      return null;
  }
}

function TermsPage() {
  const { t } = useTranslation('terms');
  return (
    <main className="mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5">
      <p className="text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1 className="mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">
        {t('title')}
      </h1>
      <p className="mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>

      <nav aria-label={t('contentsLabel')} className="mt-8">
        <p className="text-[13px] font-bold text-ink">{t('contentsLabel')}</p>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {SECTIONS.map(({ id }) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="flex min-h-tap items-center rounded-control border border-line bg-paper px-3.5 py-2 text-base font-bold wrap-anywhere text-ink hover:bg-bg"
              >
                {t(`sections.${id}.title`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-10 grid gap-8">
        {SECTIONS.map(({ id, points, callout }, index) => (
          <section key={id} id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-4 border-t border-line pt-6">
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-pill bg-accent-2 text-base font-bold text-ink"
              >
                {index + 1}
              </span>
              <h2
                id={`${id}-heading`}
                className="min-w-0 pt-1 text-xl leading-[1.2] font-bold tracking-[-.025em] wrap-break-word text-ink"
              >
                {t(`sections.${id}.title`)}
              </h2>
            </div>
            <div className="mt-3">
              {callout === undefined ? (
                <p className="text-base leading-[1.45] wrap-break-word text-ink">{t(`sections.${id}.lead`)}</p>
              ) : (
                // Static text on a page load: a "note", not the assertive alert Notice would default to for warn.
                <Notice tone={callout} role="note">
                  {t(`sections.${id}.lead`)}
                </Notice>
              )}
            </div>
            {points !== undefined && (
              <ul className="mt-3 grid list-disc gap-2 pl-5 marker:text-accent">
                {points.map((point) => (
                  <li key={point} className="text-base leading-[1.45] wrap-break-word text-ink">
                    {t(`sections.${id}.points.${point}`)}
                  </li>
                ))}
              </ul>
            )}
            <SectionExtras id={id} />
          </section>
        ))}
      </div>
    </main>
  );
}

export const Route = createFileRoute('/legal/terms')({ component: TermsPage });

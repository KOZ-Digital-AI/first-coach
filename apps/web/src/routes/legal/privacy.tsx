/// <reference types="vite/client" />
import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Card } from '../../components/ui/card';
import { Notice } from '../../components/ui/notice';
import { PRIVACY_SECTIONS, type PrivacySection } from '../../features/legal/privacy.messages';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';

/**
 * /legal/privacy: the privacy policy in plain language (kk / ru / en). Static copy, no fetching: every string comes from
 * features/legal/privacy.messages.ts, and the page is marked as pending legal review.
 *
 * Readings of the criteria:
 * - The contact address is VITE_CONTACT_EMAIL, read at render time. Anything that is not a plain address (blank, spaces, two
 *   "@", characters that could add mailto parameters) counts as unset, and then the contact line is left out entirely.
 * - The takedown section names no address of its own: its contact line appears only when the address is set.
 */

// Deliberately plain ASCII addresses: this value goes into a mailto: href, so `?`, `&`, `#` and spaces are refused.
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function contactEmail(): string | undefined {
  const raw: unknown = import.meta.env.VITE_CONTACT_EMAIL;
  const email = typeof raw === 'string' ? raw.trim() : '';
  return EMAIL_PATTERN.test(email) ? email : undefined;
}

export const Route = createFileRoute('/legal/privacy')({ component: PrivacyPage });

function PrivacyPage() {
  const { t } = useTranslation('privacy');
  const email = contactEmail();
  return (
    <main className="mx-auto w-[calc(100%-24px)] max-w-190 py-8 sm:w-[calc(100%-40px)] sm:py-12">
      <header>
        <p className="text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
        {/* Longest word is "конфиденциальности" (18 letters): 8vw keeps it inside 336px at 360px, and it may still break. */}
        <h1 className="mt-3 text-[clamp(28px,8vw,48px)] leading-[1.05] font-bold tracking-[-.05em] wrap-break-word">
          {t('title')}
        </h1>
        <p className="mt-4 max-w-[65ch] text-lg leading-normal">{t('lead')}</p>
        <Notice tone="warn" role="note" className="mt-5">
          <strong>{t('status.label')}</strong> {t('status.note')}
        </Notice>
      </header>
      <div className="mt-8 flex flex-col gap-3">
        {PRIVACY_SECTIONS.map((section) => (
          <PolicySection key={section.id} section={section} email={email} />
        ))}
      </div>
    </main>
  );
}

function PolicySection({ section, email }: { section: PrivacySection; email: string | undefined }) {
  const { t } = useTranslation('privacy');
  const headingId = `privacy-${section.id}`;
  const text = (key: string) => t(`sections.${section.id}.${key}`);
  const paragraph = (key: string) => (
    <p key={key} className="mt-3 max-w-[65ch] leading-[1.45]">
      {text(key)}
    </p>
  );
  return (
    <section aria-labelledby={headingId}>
      <Card>
        <h2 id={headingId} className="text-xl leading-tight font-bold tracking-[-.025em]">
          {text('title')}
        </h2>
        {section.paragraphs.map(paragraph)}
        {section.items.length > 0 && (
          <ul className="mt-3 max-w-[65ch] list-disc space-y-2 pl-5 leading-[1.45]">
            {section.items.map((key) => (
              <li key={key}>{text(key)}</li>
            ))}
          </ul>
        )}
        {section.closing.map(paragraph)}
        {section.contact !== undefined && email !== undefined && (
          <p className="mt-3 flex flex-wrap items-center gap-x-2">
            <span>{t(`contact.${section.contact}`)}</span>
            <a
              href={`mailto:${email}`}
              className="inline-flex min-h-tap items-center font-bold underline underline-offset-4"
            >
              {email}
            </a>
          </p>
        )}
      </Card>
    </section>
  );
}

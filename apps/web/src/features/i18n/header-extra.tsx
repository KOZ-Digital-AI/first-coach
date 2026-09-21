import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_NAMES, LOCALES, toLocale } from '../../lib/i18n';

const BUTTON = 'inline-flex min-h-tap min-w-tap cursor-pointer items-center justify-center gap-1 rounded-control border px-3 text-base font-bold text-ink';
const SELECTED = `${BUTTON} border-accent bg-accent-2`;
const OTHER = `${BUTTON} border-line bg-paper hover:bg-bg`;

/**
 * Language switch for the header slot (default-exports ONE component, per lib/slots.ts).
 * The header slot is unpadded, so the group carries its own horizontal padding.
 */
export default function LanguageSwitch() {
  const { t, i18n } = useTranslation('i18n');
  const current = toLocale(i18n.language);
  return (
    <div role="group" aria-label={t('language')} className="flex flex-wrap items-center gap-2 px-4 py-2">
      {LOCALES.map((locale) => {
        const selected = locale === current;
        return (
          <button
            key={locale}
            type="button"
            lang={locale}
            aria-pressed={selected}
            onClick={() => void i18n.changeLanguage(locale)}
            className={selected ? SELECTED : OTHER}
          >
            {selected && <Check aria-hidden="true" size={16} />}
            {LANGUAGE_NAMES[locale]}
          </button>
        );
      })}
    </div>
  );
}

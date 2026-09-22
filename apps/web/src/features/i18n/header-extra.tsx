import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_NAMES, LOCALES, toLocale } from '../../lib/i18n';

// Tighter than a full 44px-tap button's usual 12px side padding (DESIGN.md button padding is 14px 18px): the visible
// text is now the 3-letter short label, not the full native name, so the box can be narrower while the 44px minimum
// tap target (min-h-tap / min-w-tap) is unchanged (fc-zfg.9 - the header must never wrap at >=900px, see Shell.tsx).
const BUTTON =
  'inline-flex min-h-tap min-w-tap cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-control border px-1.5 text-base font-bold text-ink';
const SELECTED = `${BUTTON} border-accent bg-accent-2`;
const OTHER = `${BUTTON} border-line bg-paper hover:bg-bg`;

/**
 * Language switch for the header slot (default-exports ONE component, per lib/slots.ts).
 * The header slot is unpadded, so the group carries its own horizontal padding.
 *
 * fc-zfg.9: each button shows a compact 3-letter label (Қаз / Рус / Eng, `i18n.messages.ts`'s `short`) so the switch
 * never forces the header onto a second row (DESIGN.md Navigation: "the language switch is always reachable" and must
 * never be hidden - so it shrinks instead of dropping an option). The full native name (LANGUAGE_NAMES, same source the
 * previous full-text label used) stays the button's accessible name via `aria-label`, and is repeated as `title` for a
 * mouse-hover tooltip; nothing is lost, only the visible glyph count.
 */
export default function LanguageSwitch() {
  const { t, i18n } = useTranslation('i18n');
  const current = toLocale(i18n.language);
  return (
    <div role="group" aria-label={t('language')} className="flex flex-wrap items-center gap-0.5 px-0.5 py-2 min-[900px]:flex-nowrap">
      {LOCALES.map((locale) => {
        const selected = locale === current;
        const fullName = LANGUAGE_NAMES[locale];
        return (
          <button
            key={locale}
            type="button"
            lang={locale}
            aria-pressed={selected}
            aria-label={fullName}
            title={fullName}
            onClick={() => void i18n.changeLanguage(locale)}
            className={selected ? SELECTED : OTHER}
          >
            {selected && <Check aria-hidden="true" size={16} />}
            {t(`short.${locale}`)}
          </button>
        );
      })}
    </div>
  );
}

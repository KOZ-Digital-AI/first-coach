import type { MessageBundle } from '../../lib/i18n';

// `short`: the compact visible label on each language-switch button (fc-zfg.9 - DESIGN.md Navigation: the switch must
// stay reachable at every width, so it becomes compact instead of wrapping the header). Like LANGUAGE_NAMES in
// lib/i18n.ts, these three letters are never translated: the same { kk, ru, en } trio is repeated identically under
// every locale block, so `t('short.kk')` reads 'Қаз' no matter which language is currently active.
const SHORT = { kk: 'Қаз', ru: 'Рус', en: 'Eng' };

export default {
  kk: { language: 'Тіл', short: SHORT },
  ru: { language: 'Язык', short: SHORT },
  en: { language: 'Language', short: SHORT },
} satisfies MessageBundle;

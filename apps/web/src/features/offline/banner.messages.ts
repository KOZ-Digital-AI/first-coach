import type { MessageBundle } from '../../lib/i18n';

// Connectivity banner copy (namespace `banner`, from the file name; registered by the eager glob in lib/i18n.ts).
// `offline` reassures (the deterministic training path needs no network); `restored` confirms the reconnect while the outbox
// is delivered. The Kazakh text is a first draft and still needs a native review.
export default {
  kk: {
    offline: 'Желіде емессіз — жаттығу жұмыс істей береді',
    restored: 'Желі қайта қосылды — синхрондалып жатыр',
  },
  ru: {
    offline: 'Вы не в сети — тренироваться можно',
    restored: 'Снова в сети — синхронизируем',
  },
  en: {
    offline: 'You are offline — training still works',
    restored: 'Back online — syncing',
  },
} satisfies MessageBundle;

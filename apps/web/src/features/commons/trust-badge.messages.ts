import type { MessageBundle } from '../../lib/i18n';

// Trust badge copy. Namespace `trust-badge` (from the file name); registered by the eager glob in lib/i18n.ts, so no
// central catalogue is edited. Short on purpose: the badge sits inline next to a drill title on a 360px screen.
// `verifiedBy` takes the organisation through {{org}} and uses a colon form ("Проверено: <org>", "Тексерген: <org>") so the
// organisation name never needs declining in ru or kk. Kazakh text still needs a native review.
export default {
  kk: {
    community: 'Қауымдастық',
    communityDraft: 'Қауымдастық жобасы',
    reviewed: 'Қаралған',
    expertVerified: 'Сарапшы тексерген',
    academyVerified: 'Академия тексерген',
    verifiedBy: 'Тексерген: {{org}}',
  },
  ru: {
    community: 'Сообщество',
    communityDraft: 'Черновик сообщества',
    reviewed: 'Рецензировано',
    expertVerified: 'Проверено экспертом',
    academyVerified: 'Проверено академией',
    verifiedBy: 'Проверено: {{org}}',
  },
  en: {
    community: 'Community',
    communityDraft: 'Community Draft',
    reviewed: 'Reviewed',
    expertVerified: 'Expert verified',
    academyVerified: 'Academy verified',
    verifiedBy: 'Verified by {{org}}',
  },
} satisfies MessageBundle;

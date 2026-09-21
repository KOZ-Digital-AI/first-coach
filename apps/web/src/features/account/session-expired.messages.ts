import type { MessageBundle } from '../../lib/i18n';

// Shown as a toast when a coach/admin session ends, just before the redirect to sign-in. Namespace `session-expired`.
// The English text is fixed by the bead. Kazakh text still needs a native review.
export default {
  kk: {
    message: 'Сессия аяқталды — қайта кіріңіз',
  },
  ru: {
    message: 'Сессия истекла — войдите снова',
  },
  en: {
    message: 'Your session expired — sign in again',
  },
} satisfies MessageBundle;

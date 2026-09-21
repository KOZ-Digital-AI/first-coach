import type { MessageBundle } from '../../lib/i18n';

// Strings of the extra shell links added by fc-mol-bjm.12. Namespace `nav-links` (from the file name), collected by the eager
// glob in lib/i18n.ts; the shell reads it next to `shell`. It is a separate file so the shell bundle stays untouched.
// The label names the page (/settings/privacy, "Your privacy") and must not read like the privacy POLICY link beside it
// (`shell` footer.privacy: "Privacy" / "Құпиялылық" / "Конфиденциальность"). The Russian uses "приватность", the word the
// settings page itself uses. The Kazakh text still needs a native review.
export default {
  kk: {
    privacySettings: 'Құпиялылық баптаулары',
  },
  ru: {
    privacySettings: 'Настройки приватности',
  },
  en: {
    privacySettings: 'Privacy settings',
  },
} satisfies MessageBundle;

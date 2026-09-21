import type { MessageBundle } from '../../lib/i18n';

// Account menu copy (features/account/header-extra.tsx). Namespace `account` (from the file name), registered by the eager glob
// in lib/i18n.ts. "Coach" is бапкер / тренер, the same word the brand and the navigation use. The Kazakh text still needs a
// native review (bead fc-cjh).
export default {
  kk: {
    coachSignIn: 'Бапкер ретінде кіру',
    menuLabel: 'Тіркелгі мәзірі',
    fallbackName: 'Тіркелгі',
    myContributions: 'Менің үлестерім',
    admin: 'Әкімші',
    signOut: 'Шығу',
    signingOut: 'Шығып жатырмыз…',
    signOutFailed: 'Шыға алмадық. Байланысты тексеріп, қайта көріңіз.',
  },
  ru: {
    coachSignIn: 'Вход для тренеров',
    menuLabel: 'Меню аккаунта',
    fallbackName: 'Аккаунт',
    myContributions: 'Мои вклады',
    admin: 'Админ',
    signOut: 'Выйти',
    signingOut: 'Выходим…',
    signOutFailed: 'Не удалось выйти. Проверьте соединение и попробуйте ещё раз.',
  },
  en: {
    coachSignIn: 'Coach sign-in',
    menuLabel: 'Account menu',
    fallbackName: 'Account',
    myContributions: 'My contributions',
    admin: 'Admin',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    signOutFailed: 'Could not sign out. Check your connection and try again.',
  },
} satisfies MessageBundle;

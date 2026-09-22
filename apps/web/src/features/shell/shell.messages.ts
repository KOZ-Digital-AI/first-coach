import type { MessageBundle } from '../../lib/i18n';

// App shell copy: skip link, navigation, admin link and footer. Namespace `shell` (from the file name), registered by the
// eager glob in lib/i18n.ts. The brand "FIRST COACH / БІРІНШІ БАПКЕР", "Open Commons" (a product name) and "Genesis"
// (a release name) are never translated. Nav labels stay short because five of them share a 360px tab bar (about 72px each).
// `nav.start` (auth-gate-spec.md §3.4): the visitor's one primary action ("Start training", shortened here the way the
// other tab labels are — it shares the same 360px tab bar). The longer sign-in-screen copy ("Start training", the full
// sentence) lives in features/account/sign-in.messages.ts (`start.button`), a separate bead's file.
// The Kazakh text still needs a native review.
export default {
  kk: {
    skip: 'Мазмұнға өту',
    home: 'басты бет',
    nav: {
      primary: 'Негізгі навигация',
      tabs: 'Төменгі навигация',
      train: 'Жаттығу',
      commons: 'Open Commons',
      contribute: 'Әдіс қосу',
      progress: 'Прогресс',
      video: 'Бейне бапкер · Бета',
      start: 'Бастау',
    },
    admin: 'Әкімші',
    footer: {
      links: 'Қосымша сілтемелер',
      tagline: 'Адам дағдыларын дамытуға арналған ашық инфрақұрылым.',
      licences: 'Бағдарлама: MIT · Білім: CC BY-SA 4.0',
      credit: 'KOZ AI жасаған · Genesis релизі',
      privacy: 'Құпиялылық',
      terms: 'Шарттар',
      restore: 'Прогресімді қалпына келтіру',
      version: 'Нұсқа {{version}}',
    },
  },
  ru: {
    skip: 'Перейти к содержимому',
    home: 'на главную',
    nav: {
      primary: 'Основная навигация',
      tabs: 'Нижняя навигация',
      train: 'Тренироваться',
      commons: 'Open Commons',
      contribute: 'Добавить методику',
      progress: 'Прогресс',
      video: 'Видео-тренер · Бета',
      start: 'Начать',
    },
    admin: 'Админ',
    footer: {
      links: 'Дополнительные ссылки',
      tagline: 'Открытая инфраструктура для развития навыков человека.',
      licences: 'Программа: MIT · Знания: CC BY-SA 4.0',
      credit: 'Создано KOZ AI · релиз Genesis',
      privacy: 'Конфиденциальность',
      terms: 'Условия',
      restore: 'Восстановить мой прогресс',
      version: 'Версия {{version}}',
    },
  },
  en: {
    skip: 'Skip to content',
    home: 'home',
    nav: {
      primary: 'Main navigation',
      tabs: 'Bottom navigation',
      train: 'Train',
      commons: 'Open Commons',
      contribute: 'Contribute',
      progress: 'Progress',
      video: 'Video Coach · Beta',
      start: 'Start',
    },
    admin: 'Admin',
    footer: {
      links: 'More links',
      tagline: 'Open human skill development infrastructure.',
      licences: 'Software: MIT · Knowledge: CC BY-SA 4.0',
      credit: 'Created by KOZ AI · Genesis release',
      privacy: 'Privacy',
      terms: 'Terms',
      restore: 'Restore my progress',
      version: 'Version {{version}}',
    },
  },
} satisfies MessageBundle;

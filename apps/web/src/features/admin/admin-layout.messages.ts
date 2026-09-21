import type { MessageBundle } from '../../lib/i18n';

// Admin layout copy (routes/admin/route.tsx). Namespace `admin-layout` (from the file name); registered by the eager glob in
// lib/i18n.ts, so no central catalogue is edited. The four nav labels are short on purpose: two per row at 360px.
// Kazakh text still needs a native review (bead fc-cjh).
export default {
  kk: {
    eyebrow: 'Әкімші',
    navLabel: 'Әкімші бөлімдері',
    reviewQueue: 'Тексеру кезегі',
    drills: 'Жаттығулар',
    impact: 'Әсер',
    settings: 'Баптаулар',
    loading: 'Қолжетімділік тексерілуде…',
    redirecting: 'Кіру бетіне өтудеміз…',
    unauthorized: {
      title: 'Бұл бөлім тек әкімшілерге арналған',
      hint: 'Тіркелгіңізде бұл бөлімге рұқсат жоқ. Рұқсат керек деп ойласаңыз, әкімшіден рөліңізді тексеруін сұраңыз.',
      home: 'Басты бетке өту',
    },
    error: {
      title: 'Рұқсатыңызды тексере алмадық',
      message: 'Интернетті тексеріп, қайталап көріңіз.',
      retry: 'Қайталау',
    },
  },
  ru: {
    eyebrow: 'Администратор',
    navLabel: 'Разделы администратора',
    reviewQueue: 'Очередь проверки',
    drills: 'Упражнения',
    impact: 'Влияние',
    settings: 'Настройки',
    loading: 'Проверяем доступ…',
    redirecting: 'Переходим на страницу входа…',
    unauthorized: {
      title: 'Этот раздел только для администраторов',
      hint: 'У вашей учётной записи нет доступа сюда. Если он должен быть, попросите администратора проверить вашу роль.',
      home: 'На главную',
    },
    error: {
      title: 'Не удалось проверить доступ',
      message: 'Проверьте интернет и попробуйте ещё раз.',
      retry: 'Повторить',
    },
  },
  en: {
    eyebrow: 'Admin',
    navLabel: 'Admin sections',
    reviewQueue: 'Review queue',
    drills: 'Drills',
    impact: 'Impact',
    settings: 'Settings',
    loading: 'Checking your access…',
    redirecting: 'Taking you to sign in…',
    unauthorized: {
      title: 'This area is for administrators',
      hint: 'Your account does not have access here. If it should, ask an administrator to check your role.',
      home: 'Go to the home page',
    },
    error: {
      title: 'We could not check your access',
      message: 'Check your connection and try again.',
      retry: 'Try again',
    },
  },
} satisfies MessageBundle;

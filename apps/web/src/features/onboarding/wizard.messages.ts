import type { MessageBundle } from '../../lib/i18n';

// Namespace `wizard` (from the file name): the shell around the three onboarding steps (page title, progress, loading, empty,
// error and success states, and the note shown when the server rejects an answer). The steps keep their own strings in
// profile-step / conditions-step / baseline-step; a failed request's generic sentence comes from the `problem` namespace.
// `step` is the "Step n / 4" label ({{n}} and {{total}} are locale-formatted numbers). `fields` labels the request fields a
// problem-details pointer can name, so a rejected answer is shown by name. Kazakh text still needs a native review.
export default {
  kk: {
    eyebrow: 'FIRST COACH / Футбол',
    title: 'Алғашқы жолыңызды бірге құрайық',
    progressLabel: 'Баптау барысы',
    step: 'Қадам {{n}} / {{total}}',
    loading: 'Сұрақтарды дайындап жатырмыз…',
    loadError: { title: 'Сұрақтарды жүктей алмадық' },
    empty: {
      title: 'Әзірге таңдайтын ештеңе жоқ',
      hint: 'Сұрақтар әлі дайын емес. Сәл кейін қайталап көріңіз.',
    },
    retry: 'Қайталау',
    submitting: 'Жоспарыңызды құрып жатырмыз…',
    success: 'Жоспар дайын. Ашып жатырмыз…',
    submitError: { title: 'Жоспарды құра алмадық' },
    issues: {
      title: 'Осы қадамды тексеріңіз',
      lead: 'Мына жауаптар қабылданбады:',
    },
    fields: {
      age: 'Жас',
      level: 'Қазіргі деңгей',
      goal: 'Басты мақсат',
      equipment: 'Құрал-жабдық',
      space: 'Жаттығу орны',
      partner: 'Жаттығу серігі',
      daysPerWeek: 'Аптасына неше күн',
      minutesPerSession: 'Бір жаттығу минуты',
      baseline: 'Сынақ нәтижелері',
    },
  },
  ru: {
    eyebrow: 'FIRST COACH / Футбол',
    title: 'Соберём ваш первый путь',
    progressLabel: 'Ход настройки',
    step: 'Шаг {{n}} / {{total}}',
    loading: 'Готовим вопросы…',
    loadError: { title: 'Не удалось загрузить вопросы' },
    empty: {
      title: 'Пока нечего выбирать',
      hint: 'Вопросы ещё не готовы. Попробуйте чуть позже.',
    },
    retry: 'Повторить',
    submitting: 'Строим ваш план…',
    success: 'План готов. Открываем…',
    submitError: { title: 'Не удалось построить план' },
    issues: {
      title: 'Проверьте этот шаг',
      lead: 'Эти ответы не приняты:',
    },
    fields: {
      age: 'Возраст',
      level: 'Текущий уровень',
      goal: 'Главная цель',
      equipment: 'Инвентарь',
      space: 'Место тренировок',
      partner: 'Партнёр по тренировкам',
      daysPerWeek: 'Дней в неделю',
      minutesPerSession: 'Минут за тренировку',
      baseline: 'Результаты тестов',
    },
  },
  en: {
    eyebrow: 'FIRST COACH / Football',
    title: 'Let’s build your first path',
    progressLabel: 'Setup progress',
    step: 'Step {{n}} / {{total}}',
    loading: 'Getting the questions ready…',
    loadError: { title: 'We could not load the questions' },
    empty: {
      title: 'There is nothing to choose from yet',
      hint: 'The questions are not ready. Try again in a little while.',
    },
    retry: 'Try again',
    submitting: 'Building your roadmap…',
    success: 'Your roadmap is ready. Opening it now…',
    submitError: { title: 'We could not build your roadmap' },
    issues: {
      title: 'Please check this step',
      lead: 'These answers were not accepted:',
    },
    fields: {
      age: 'Age',
      level: 'Current level',
      goal: 'Main goal',
      equipment: 'Equipment',
      space: 'Where you train',
      partner: 'Training partner',
      daysPerWeek: 'Days per week',
      minutesPerSession: 'Minutes per session',
      baseline: 'Skill test results',
    },
  },
} satisfies MessageBundle;

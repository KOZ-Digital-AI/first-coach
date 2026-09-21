import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the onboarding "training conditions" step. Namespace = file base name (`conditions-step`),
 * collected by the `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it.
 * Option labels are keyed by the payload value (`equipment.options.ball_wall`, `partner.options.true`).
 * The day count carries no unit of its own: the legend names it, which avoids Russian plural forms.
 */
export default {
  kk: {
    title: 'Жаттығу жағдайы',
    lead: 'Не бар екенін айт. Жоспарды соған қарай құрамыз.',
    back: 'Артқа',
    continue: 'Жалғастыру',
    incomplete: 'Жалғастыру үшін барлық сұраққа жауап бер.',
    equipment: {
      legend: 'Сенде не бар?',
      options: {
        nothing: 'Ештеңе жоқ',
        ball: 'Тек доп',
        ball_wall: 'Доп + қабырға',
        cones: 'Конустар',
        full_field: 'Толық алаң',
      },
    },
    space: {
      legend: 'Қайда жаттығасың?',
      options: {
        home_3x3: 'Үйде 3×3 м',
        yard: 'Аула',
        field: 'Алаң',
        gym: 'Жаттығу залы',
      },
    },
    partner: {
      legend: 'Бірге жаттығатын адам бар ма?',
      options: { true: 'Иә', false: 'Жоқ' },
    },
    daysPerWeek: { legend: 'Аптасына неше күн' },
    minutesPerSession: { legend: 'Бір жаттығу неше минут', value: '{{value}} мин' },
  },
  ru: {
    title: 'Условия тренировок',
    lead: 'Расскажи, что у тебя есть. Мы подберём план под это.',
    back: 'Назад',
    continue: 'Продолжить',
    incomplete: 'Ответь на все вопросы, чтобы продолжить.',
    equipment: {
      legend: 'Что у тебя есть?',
      options: {
        nothing: 'Ничего',
        ball: 'Только мяч',
        ball_wall: 'Мяч + стена',
        cones: 'Конусы',
        full_field: 'Полное поле',
      },
    },
    space: {
      legend: 'Где ты будешь тренироваться?',
      options: {
        home_3x3: 'Дома 3×3 м',
        yard: 'Двор',
        field: 'Поле',
        gym: 'Спортзал',
      },
    },
    partner: {
      legend: 'Есть с кем тренироваться?',
      options: { true: 'Да', false: 'Нет' },
    },
    daysPerWeek: { legend: 'Дней в неделю' },
    minutesPerSession: { legend: 'Минут за одну тренировку', value: '{{value}} мин' },
  },
  en: {
    title: 'Your training conditions',
    lead: 'Tell us what you have. We build your plan around it.',
    back: 'Back',
    continue: 'Continue',
    incomplete: 'Answer every question to continue.',
    equipment: {
      legend: 'What do you have?',
      options: {
        nothing: 'Nothing',
        ball: 'Ball only',
        ball_wall: 'Ball + wall',
        cones: 'Cones',
        full_field: 'Full field',
      },
    },
    space: {
      legend: 'Where will you train?',
      options: {
        home_3x3: 'Home 3×3 m',
        yard: 'Yard',
        field: 'Field',
        gym: 'Gym',
      },
    },
    partner: {
      legend: 'Is there someone to train with?',
      options: { true: 'Yes', false: 'No' },
    },
    daysPerWeek: { legend: 'Days per week' },
    minutesPerSession: { legend: 'Minutes per session', value: '{{value}} min' },
  },
} satisfies MessageBundle;

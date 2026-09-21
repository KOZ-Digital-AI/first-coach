import type { MessageBundle } from '../../lib/i18n';

// Namespace `profile-step` (from the file name). Level and goal labels are keyed by the contract's enum values
// (`levels.<level>`, `goals.<goal>`): the LIST of choices always comes from the onboarding options, these are only its labels.
// {{min}} and {{max}} are the contract's age bounds. Kazakh text still needs a native review.
export default {
  kk: {
    title: 'Бастау үшін бірнеше сұрақ',
    age: {
      label: 'Жас',
      hint: '{{min}}–{{max}} жас аралығында',
      error: 'Жасты {{min}} мен {{max}} аралығындағы бүтін сан ретінде жазыңыз.',
    },
    level: { legend: 'Қазіргі деңгей' },
    levels: {
      beginner: 'Жаңадан бастаушы',
      basic: 'Негізгі деңгей',
      intermediate: 'Орта деңгей',
    },
    goal: { legend: 'Басты мақсат' },
    goals: {
      control: 'Допты сенімді ұстау',
      dribbling: 'Дриблингті жақсарту',
      passing: 'Пас және допты алғаш қабылдау',
      weakfoot: 'Әлсіз аяқты жаттықтыру',
      coordination: 'Үйлесімділік',
    },
    continue: 'Жалғастыру',
    continueHint: 'Жасыңызды жазып, деңгей мен мақсатты таңдаңыз.',
  },
  ru: {
    title: 'Несколько вопросов, чтобы начать',
    age: {
      label: 'Возраст',
      hint: 'От {{min}} до {{max}} лет',
      error: 'Введите возраст целым числом от {{min}} до {{max}}.',
    },
    level: { legend: 'Текущий уровень' },
    levels: {
      beginner: 'Начинающий',
      basic: 'Базовый',
      intermediate: 'Средний',
    },
    goal: { legend: 'Главная цель' },
    goals: {
      control: 'Увереннее контролировать мяч',
      dribbling: 'Улучшить дриблинг',
      passing: 'Пас и первый приём',
      weakfoot: 'Подтянуть слабую ногу',
      coordination: 'Координация',
    },
    continue: 'Продолжить',
    continueHint: 'Укажите возраст и выберите уровень и цель.',
  },
  en: {
    title: 'A few questions to get started',
    age: {
      label: 'Age',
      hint: 'Between {{min}} and {{max}}',
      error: 'Enter your age as a whole number from {{min}} to {{max}}.',
    },
    level: { legend: 'Current level' },
    levels: {
      beginner: 'Beginner',
      basic: 'Basic',
      intermediate: 'Intermediate',
    },
    goal: { legend: 'Main goal' },
    goals: {
      control: 'Control the ball with confidence',
      dribbling: 'Improve dribbling',
      passing: 'Passing and first touch',
      weakfoot: 'Improve my weaker foot',
      coordination: 'Coordination',
    },
    continue: 'Continue',
    continueHint: 'Enter your age and choose a level and a goal.',
  },
} satisfies MessageBundle;

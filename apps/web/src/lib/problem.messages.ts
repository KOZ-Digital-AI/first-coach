import type { MessageBundle } from './i18n';

// Generic, blame-free copy for failures no screen wants to word itself. The server's own (English) title/detail is never shown.
// Namespace `problem` (from the file name); keys are named by MESSAGE_KEYS in problem.ts. Kazakh text still needs a native review.
export default {
  kk: {
    offline: 'Байланыс жоқ. Интернетті тексеріп, қайталап көріңіз.',
    unauthorized: 'Сессия аяқталды. Қайта кіріңіз.',
    forbidden: 'Бұған рұқсатыңыз жоқ.',
    notFound: 'Табылмады.',
    conflict: 'Деректер өзгерген. Бетті жаңартып, қайталаңыз.',
    tooLarge: 'Көлемі тым үлкен. Кішірек нұсқасын жіберіп көріңіз.',
    validation: 'Белгіленген өрістерді тексеріңіз.',
    rateLimited: 'Тым көп сұрау жіберілді. Біраз күтіп, қайталаңыз.',
    server: 'Бізде қате шықты. Аздан соң қайталап көріңіз.',
    schema: 'Сервер күтпеген жауап берді. Қайталап көріңіз.',
    unknown: 'Бірдеңе дұрыс болмады. Қайталап көріңіз.',
  },
  ru: {
    offline: 'Нет соединения. Проверьте интернет и попробуйте ещё раз.',
    unauthorized: 'Сессия истекла. Войдите снова.',
    forbidden: 'У вас нет доступа.',
    notFound: 'Ничего не найдено.',
    conflict: 'Данные изменились. Обновите страницу и повторите.',
    tooLarge: 'Слишком большой объём. Попробуйте меньше.',
    validation: 'Проверьте выделенные поля.',
    rateLimited: 'Слишком много запросов. Подождите немного и повторите.',
    server: 'Ошибка на нашей стороне. Попробуйте чуть позже.',
    schema: 'Сервер ответил неожиданно. Попробуйте ещё раз.',
    unknown: 'Что-то пошло не так. Попробуйте ещё раз.',
  },
  en: {
    offline: 'No connection. Check your internet and try again.',
    unauthorized: 'Your session has expired. Please sign in again.',
    forbidden: "You don't have access to this.",
    notFound: "We couldn't find that.",
    conflict: 'This changed elsewhere. Reload and try again.',
    tooLarge: 'That is too large to send. Try a smaller one.',
    validation: 'Check the highlighted fields.',
    rateLimited: 'Too many requests. Wait a moment and try again.',
    server: 'Something went wrong on our side. Try again in a moment.',
    schema: 'The server sent an unexpected answer. Try again.',
    unknown: 'Something went wrong. Try again.',
  },
} satisfies MessageBundle;

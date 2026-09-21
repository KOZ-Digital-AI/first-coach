import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the restore screen (routes/recover.tsx). The namespace is the file's base name: `restore`. Collected by the
 * `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it. Generic failures (offline, server, ...) live
 * in lib/problem.messages.ts and are shown through describeProblem, never worded here. Kazakh text still needs a native-speaker
 * review.
 *
 * Plain language on purpose: a 10-year-old and a parent should both follow it (short sentences, "you" is the child). It says
 * only what the product does (apps/api/src/shared/privacy.ts, PRODUCT.md): the code is 16 letters and numbers in 4 groups of 4,
 * upper or lower case, spaces and dashes do not matter, a wrong code is one plain answer (never which part was wrong), 5 tries
 * per 15 minutes, and replacing progress cannot be undone.
 *
 * - `empty`, `incomplete` and `wrong` belong to the code field. `incomplete` is said before anything is sent (the format is
 *   public); `wrong` is the ONE answer to every code the server refuses, so it never says whether a code exists or which part
 *   was off.
 * - `rateLimited` says 15 minutes, the server's window (RATE_LIMITS.recover: 5 attempts per 15 minutes).
 * - `account` is for a device that is signed in with an account: only an anonymous player session can receive progress.
 * - `confirmTitle`, `confirmBody`, `replace` and `keep` are the question shown when this device already has progress (409);
 *   `confirmBody` states the consequence and `replace` / `keep` are named for what they do to THIS device's progress.
 * - `submit` / `submitting` are the one button in its two moments; `replacing` is the replace button while it runs; `done` is
 *   the status line once the progress is back. `typed` is the live character count (`{{typed}}` is a number).
 */
export default {
  kk: {
    eyebrow: 'Нәтижелерді қайтару',
    title: 'Нәтижелеріңді қайтар',
    lead: 'Жазып қойған қалпына келтіру кодыңды енгіз. Жаттығуларың осы телефонға оралады.',
    label: 'Қалпына келтіру коды',
    hint: '4 топқа бөлінген 16 әріп пен сан. Кіші әріп, бос орын және сызықша болса да болады.',
    typed: '{{typed}} / 16 таңба',
    submit: 'Нәтижелерімді қайтару',
    submitting: 'Қайтарып жатырмыз',
    empty: 'Алдымен кодыңды енгіз.',
    incomplete: 'Кодта 16 әріп пен сан бар. Барлығын енгізгеніңді тексер.',
    wrong: 'Бұл код жұмыс істемеді. Әр әріп пен санды тексеріп, қайталап көр.',
    rateLimited: 'Тым көп әрекет жасалды. 15 минут күтіп, қайталап көр.',
    account: 'Бұл құрылғыға аккаунтпен кірілген. Нәтижелерді тек аккаунтсыз құрылғыда қайтаруға болады.',
    failedTitle: 'Нәтижелер қайтарылмады.',
    confirmTitle: 'Бұл телефонда нәтижелер бар',
    confirmBody:
      'Жалғастырсаң, осы телефондағы нәтижелер кодтағы нәтижелермен ауыстырылады. Ауыстырылған нәтижелерді қайтару мүмкін емес.',
    replace: 'Осы құрылғының нәтижелерін қайтарылғанмен ауыстыру',
    replacing: 'Ауыстырып жатырмыз',
    keep: 'Осы құрылғының нәтижелерін қалдыру',
    done: 'Дайын. Нәтижелерің қайтты. Жаттығуыңды ашып жатырмыз.',
    noCode: 'Кодың жоқ па? Оны жаттыққан телефоныңда жасауға болады: Құпиялылық баптаулары, Қалпына келтіру коды.',
  },
  ru: {
    eyebrow: 'Восстановление',
    title: 'Верни свой прогресс',
    lead: 'Введи код восстановления, который ты записал. Твои тренировки вернутся на этот телефон.',
    label: 'Код восстановления',
    hint: '16 букв и цифр, по 4 в группе. Можно писать маленькими буквами, с пробелами и дефисами.',
    typed: '{{typed}} из 16 символов',
    submit: 'Восстановить прогресс',
    submitting: 'Восстанавливаем прогресс',
    empty: 'Сначала введи код восстановления.',
    incomplete: 'В коде 16 букв и цифр. Проверь, что ты ввёл все.',
    wrong: 'Этот код не подошёл. Проверь каждую букву и цифру и попробуй ещё раз.',
    rateLimited: 'Слишком много попыток. Подожди 15 минут и попробуй снова.',
    account: 'На этом устройстве выполнен вход в аккаунт. Прогресс можно восстановить только на устройстве без аккаунта.',
    failedTitle: 'Прогресс не восстановлен.',
    confirmTitle: 'На этом телефоне уже есть прогресс',
    confirmBody:
      'Если продолжить, прогресс на этом телефоне будет заменён прогрессом из кода. Заменённый прогресс вернуть нельзя.',
    replace: 'Заменить прогресс этого устройства восстановленным',
    replacing: 'Заменяем прогресс',
    keep: 'Оставить прогресс этого устройства',
    done: 'Готово. Прогресс вернулся. Открываем тренировку.',
    noCode: 'Нет кода? Создай его на телефоне, где ты тренировался: Настройки конфиденциальности, Код восстановления.',
  },
  en: {
    eyebrow: 'Restore progress',
    title: 'Get your progress back',
    lead: 'Type the recovery code you wrote down. Your training comes back to this device.',
    label: 'Recovery code',
    hint: '16 letters and numbers in 4 groups of 4. Small letters, spaces and dashes are fine.',
    typed: '{{typed}} of 16 characters',
    submit: 'Restore my progress',
    submitting: 'Restoring your progress',
    empty: 'Type your recovery code first.',
    incomplete: 'The code has 16 letters and numbers. Check that you typed all of them.',
    wrong: 'This code did not work. Check every letter and number and try again.',
    rateLimited: 'Too many tries. Wait 15 minutes, then try again.',
    account: 'This device is signed in with an account. Progress can only be restored on a device without one.',
    failedTitle: 'Your progress was not restored.',
    confirmTitle: 'This device already has progress',
    confirmBody:
      'If you go on, the progress on this device is replaced with the progress from your code. Replaced progress cannot be brought back.',
    replace: "Replace this device's progress with the recovered one",
    replacing: 'Replacing your progress',
    keep: "Keep this device's progress",
    done: 'Your progress is back. Opening your training.',
    noCode: "Don't have a code? Make one on the device where you trained: Privacy settings, Recovery code.",
  },
} satisfies MessageBundle;

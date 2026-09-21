import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the recovery code panel (features/privacy/panels/recovery.panel.tsx). The namespace is the file's base name:
 * `recovery`. Collected by the `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it. Generic failures
 * (offline, server, ...) live in lib/problem.messages.ts and are shown through describeProblem, never worded here. Kazakh
 * text still needs a native-speaker review.
 *
 * Plain language on purpose: a 10-year-old and a parent should both follow it (short sentences, "you" is the child). It says
 * only what the product does (apps/api/src/shared/privacy.ts, PRODUCT.md): the code is 16 letters and numbers, it is shown
 * once, a new code replaces the old one, and whoever holds the code can get the progress back.
 *
 * - `replaceWarning` is on screen before the button is pressed; `replaces` is said again next to the code just made.
 * - `writeDown` and `hidden` both say "will not be shown again": the meaning is in the words, not in a colour or an icon.
 * - `make` / `making` / `makeAgain` are the one button in its three moments; `copy` / `copied` / `copyFailed` are the copy
 *   button and its status; `confirm` is the "I wrote it down" button; `failed` is the alert title and `needsPlan` its body when
 *   the server says there is no plan to recover yet (404).
 */
export default {
  kk: {
    title: 'Қалпына келтіру коды',
    lead: 'Телефонды ауыстырсаң немесе браузер деректерін тазаласаң, код нәтижелеріңді қайтарып береді. Онда 16 әріп пен сан бар. Оны қағазға жазып, сенімді жерге қой. Кодты білетін кез келген адам нәтижелеріңді аша алады, сондықтан оны басқаға көрсетпе.',
    replaceWarning: 'Жаңа код ескісін ауыстырады. Ескі код жұмыс істемей қалады.',
    make: 'Кодымды жасау',
    making: 'Кодты жасап жатырмыз',
    makeAgain: 'Жаңа код жасау',
    codeTitle: 'Сенің қалпына келтіру кодың',
    writeDown: 'Қазір қағазға жазып ал. Код қайта көрсетілмейді.',
    replaces: 'Бұл код бұрынғы кез келген кодты ауыстырады.',
    copy: 'Кодты көшіру',
    copied: 'Көшірілді',
    copyFailed: 'Көшіре алмадық. Кодты басып таңдап, өзің көшіріп ал.',
    confirm: 'Мен жазып алдым',
    hidden: 'Дайын. Код жасырылды және қайта көрсетілмейді. Жоғалтып алсаң, жаңасын жасай аласың.',
    failed: 'Код жасалмады.',
    needsPlan: 'Алдымен жаттығу жоспарыңды құр, содан кейін код жаса.',
  },
  ru: {
    title: 'Код восстановления',
    lead: 'Код вернёт твои результаты, если ты сменишь телефон или очистишь данные браузера. В нём 16 букв и цифр. Запиши его на бумаге и убери в надёжное место. Любой, кто знает код, может открыть твои результаты, поэтому никому его не показывай.',
    replaceWarning: 'Новый код заменяет старый. Старый код перестанет работать.',
    make: 'Получить код',
    making: 'Делаем код',
    makeAgain: 'Получить новый код',
    codeTitle: 'Твой код восстановления',
    writeDown: 'Запиши его на бумаге прямо сейчас. Больше он показан не будет.',
    replaces: 'Этот код заменяет любой прежний код.',
    copy: 'Скопировать код',
    copied: 'Скопировано',
    copyFailed: 'Не удалось скопировать. Нажми на код, выдели его и скопируй сам.',
    confirm: 'Я записал код',
    hidden: 'Готово. Код спрятан и больше показан не будет. Если потеряешь его, получи новый.',
    failed: 'Код не создан.',
    needsPlan: 'Сначала составь план тренировок, потом получи код.',
  },
  en: {
    title: 'Recovery code',
    lead: 'A code gets your results back if you change phone or clear your browser. It has 16 letters and numbers. Write it on paper and keep it somewhere safe. Anyone who knows the code can open your results, so do not show it to anyone.',
    replaceWarning: 'A new code replaces the old one. The old code stops working.',
    make: 'Make my recovery code',
    making: 'Making your code',
    makeAgain: 'Make a new code',
    codeTitle: 'Your recovery code',
    writeDown: 'Write it down now. It will not be shown again.',
    replaces: 'This code replaces any earlier code.',
    copy: 'Copy code',
    copied: 'Copied',
    copyFailed: 'Could not copy. Touch the code to select it and copy it yourself.',
    confirm: 'I wrote it down',
    hidden: 'Done. The code is hidden and will not be shown again. If you lose it, make a new one.',
    failed: 'We could not make a code.',
    needsPlan: 'Set up your training plan first, then make a code.',
  },
} satisfies MessageBundle;

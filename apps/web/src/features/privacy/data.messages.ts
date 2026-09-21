import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the data controls panel (features/privacy/panels/data.panel.tsx, mounted in the privacy-panel slot of
 * /settings/privacy). The namespace is the file's base name: `data`. Collected by the `*.messages.ts` glob in lib/i18n.ts, so
 * nothing outside this file registers it. Generic failures (offline, server, ...) live in lib/problem.messages.ts and are shown
 * through describeProblem, never worded here. Kazakh text still needs a native-speaker review.
 *
 * Plain language on purpose ("you" is the child), calm and blame-free: it says what will happen and that it cannot be undone,
 * and never scolds.
 *
 * - `dialog.word` is the word the player must type to confirm. It is LOCALIZED (en DELETE, ru УДАЛИТЬ, kk ЖОЮ), and
 *   `dialog.label` takes it as `{{word}}`, so the label names the exact word to type.
 * - `dialog.body` is the consequence sentence: the data and the account are erased and it cannot be undone.
 * - `download.saved` takes `{{name}}`, the file name that was saved.
 */
export default {
  kk: {
    title: 'Сенің деректерің',
    download: {
      title: 'Көшірмесін алу',
      hint: 'FIRST COACH сен туралы сақтайтын барлығы бір файлда. Ол сенікі: өзіңде сақта.',
      button: 'Деректерімді жүктеп алу',
      working: 'Файлды дайындап жатырмыз…',
      saved: '{{name}} файлы сақталды. Жүктемелер бумасынан қара.',
      failed: {
        title: 'Файлды дайындау мүмкін болмады',
        hint: 'Ештеңе өзгерген жоқ. Қайтадан байқап көр.',
      },
    },
    delete: {
      title: 'Бәрін өшіру',
      hint: 'Біз сен туралы сақтаған барлық деректі және аккаунтыңды өшіреміз. Оны қайтару мүмкін емес. Көшірмесін алғың келе ме? Алдымен жоғарыдағы деректерді жүктеп ал.',
      button: 'Деректерімді жою',
    },
    dialog: {
      title: 'Барлық деректерімді жою керек пе?',
      body: 'Бұл жаттығу деректеріңді және аккаунтыңды біржола өшіреді. Мұны қайтару мүмкін емес.',
      label: 'Растау үшін {{word}} деп жаз',
      word: 'ЖОЮ',
      wordHint: 'Сөз сәйкес келгенде төмендегі түйме қосылады.',
      cancel: 'Деректерімді қалдыру',
      confirm: 'Иә, деректерімді жою',
      deleting: 'Жойып жатырмыз…',
      done: 'Барлығы жойылды. Басты бетке қайтарып жатырмыз…',
      failed: {
        title: 'Деректер жойылмады',
        hint: 'Оларды жою мүмкін болмады, олар орнында тұр. Қайтадан байқап көр.',
      },
    },
  },
  ru: {
    title: 'Твои данные',
    download: {
      title: 'Получить копию',
      hint: 'Один файл со всем, что FIRST COACH хранит о тебе. Он твой: сохрани его себе.',
      button: 'Скачать мои данные',
      working: 'Готовим файл…',
      saved: 'Файл {{name}} сохранён. Загляни в загрузки.',
      failed: {
        title: 'Не удалось подготовить файл',
        hint: 'Ничего не изменилось. Попробуй ещё раз.',
      },
    },
    delete: {
      title: 'Стереть всё',
      hint: 'Мы удалим всё, что храним о тебе, и твой аккаунт. Вернуть это нельзя. Хочешь оставить копию? Сначала скачай данные выше.',
      button: 'Удалить мои данные',
    },
    dialog: {
      title: 'Удалить все мои данные?',
      body: 'Это навсегда сотрёт все твои данные о тренировках и твой аккаунт. Отменить это нельзя.',
      label: 'Введи {{word}}, чтобы подтвердить',
      word: 'УДАЛИТЬ',
      wordHint: 'Кнопка ниже заработает, когда слово совпадёт.',
      cancel: 'Оставить мои данные',
      confirm: 'Да, удалить мои данные',
      deleting: 'Удаляем…',
      done: 'Всё удалено. Возвращаем тебя на главную…',
      failed: {
        title: 'Данные не удалены',
        hint: 'Мы не смогли их удалить, они на месте. Попробуй ещё раз.',
      },
    },
  },
  en: {
    title: 'Your data',
    download: {
      title: 'Get a copy',
      hint: 'One file with everything FIRST COACH keeps about you. It is yours to keep.',
      button: 'Download my data',
      working: 'Preparing your file…',
      saved: 'Your file {{name}} was saved. Look in your downloads.',
      failed: {
        title: 'The file could not be made',
        hint: 'Nothing was changed. Try again.',
      },
    },
    delete: {
      title: 'Erase everything',
      hint: 'We will erase everything we keep about you, and your account. You cannot get it back. Want a copy first? Download your data above.',
      button: 'Delete my data',
    },
    dialog: {
      title: 'Delete all my data?',
      body: 'This erases all your training data and your account, and it cannot be undone.',
      label: 'Type {{word}} to confirm',
      word: 'DELETE',
      wordHint: 'The button below works when the word matches.',
      cancel: 'Keep my data',
      confirm: 'Yes, delete my data',
      deleting: 'Deleting…',
      done: 'Deleted. Taking you to the start page…',
      failed: {
        title: 'Your data was not deleted',
        hint: 'We could not delete it, so it is still here. Try again.',
      },
    },
  },
} satisfies MessageBundle;

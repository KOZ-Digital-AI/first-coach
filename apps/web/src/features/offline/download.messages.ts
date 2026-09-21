import type { MessageBundle } from '../../lib/i18n';

// Copy of the "download today's session" control in the `today` slot (namespace `download`, from the file name; registered by
// the eager glob in lib/i18n.ts). `{{time}}` arrives already formatted for the language and `{{waiting}}` is a formatted number.
// Wording avoids plural forms on purpose ("...will sync: 3"), so one phrase per language is enough. The tone is the app's: plain,
// calm, "you" in the singular informal (ты / сен) like the drill screens.
// The Kazakh text is a first draft and still needs a native review, in particular `lastSynced` ("синхрондау" is the loan word
// used across the app; a native speaker may prefer another) and the long `offlineHint`.
export default {
  kk: {
    title: 'Интернетсіз жаттығу',
    lead: 'Бүгінгі жаттығуды осы телефонға сақта. Сонда желі болмаса да ашылады.',
    download: 'Бүгінгі жаттығуды жүктеп алу',
    downloading: 'Бүгінгі жаттығу жүктелуде…',
    available: 'Интернетсіз қолжетімді',
    lastSynced: 'Соңғы синхрондау: {{time}}',
    pending: 'Осы құрылғыда сақталды — синхрондалады: {{waiting}}',
    checking: 'Осы құрылғы тексерілуде…',
    unknown: 'Осы құрылғыда не сақталғанын тексеру үшін интернетке бір рет қосыл.',
    offlineHint:
      'Қазір желі жоқ. Келесі жолы FIRST COACH-ты интернетпен ашып, «Бүгінгі жаттығуды жүктеп алу» түймесін бас — сонда жаттығу желісіз де жұмыс істейді.',
    error: {
      title: 'Бүгінгі жаттығуды жүктеп алу мүмкін болмады',
    },
    retry: 'Қайталау',
  },
  ru: {
    title: 'Тренировка без интернета',
    lead: 'Сохрани сегодняшнее занятие на этом телефоне. Тогда оно откроется, даже если сети нет.',
    download: 'Скачать занятие на сегодня',
    downloading: 'Скачиваем занятие на сегодня…',
    available: 'Доступно без интернета',
    lastSynced: 'Последняя синхронизация: {{time}}',
    pending: 'Сохранено на этом устройстве — синхронизируется: {{waiting}}',
    checking: 'Проверяем это устройство…',
    unknown: 'Подключись к интернету один раз, чтобы проверить, что сохранено на этом устройстве.',
    offlineHint:
      'Сейчас нет сети. В следующий раз открой FIRST COACH с интернетом и нажми «Скачать занятие на сегодня» — тогда занятие будет работать без сети.',
    error: {
      title: 'Не удалось скачать занятие на сегодня',
    },
    retry: 'Повторить',
  },
  en: {
    title: 'Train without internet',
    lead: "Save today's session on this phone. Then it opens even when there is no connection.",
    download: "Download today's session",
    downloading: "Downloading today's session…",
    available: 'Available offline',
    lastSynced: 'Last synced: {{time}}',
    pending: 'Saved on this device — will sync: {{waiting}}',
    checking: 'Checking this device…',
    unknown: 'Connect to the internet once to check what is saved on this device.',
    offlineHint:
      "You are offline. Next time, open FIRST COACH with internet and tap “Download today's session”. Then the session will work without a connection.",
    error: {
      title: "Could not download today's session",
    },
    retry: 'Try again',
  },
} satisfies MessageBundle;

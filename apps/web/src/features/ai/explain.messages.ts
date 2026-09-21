import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of "Explain more simply" in the drill player (namespace `explain`, from the file name; collected by the `*.messages.ts`
 * glob in lib/i18n.ts, so nothing outside this file registers it). Written for a child or a volunteer coach: plain words, calm, never
 * blaming the player. `panel.label` is the fixed provenance line above every AI text: it says that the text is AI-generated AND that
 * the coach's own text (instructions and safety note) is the one above, so a child knows which one to trust. `unavailable`, `off`,
 * `gone` and `offline` are quiet notes (never an alert): each says that the drill itself is fine. Kazakh text is a first draft and
 * still needs a native review.
 */
export default {
  kk: {
    title: 'Қарапайым түсіндіру',
    lead: 'Қадам түсініксіз бе? ЖИ-ден қарапайым сөздермен түсіндіруді сұраңыз. Жаттықтырушының жоғарыдағы мәтіні өзгеріссіз қалады.',
    action: 'Қарапайым түсіндіру',
    retryAction: 'Қайталап көру',
    running: 'ЖИ жаттығуды қарапайым сөздермен жазып жатыр…',
    runningHint: 'Күтіп тұрғанда жаттығуды қолдана бересіз.',
    panel: {
      label: 'ЖИ жасаған — жаттықтырушының түпнұсқа мәтіні жоғарыда',
    },
    offline: {
      title: 'Байланыс жоқ.',
      body: 'ЖИ түсіндіруі үшін интернет керек. Жоғарыдағы жаттығу интернетсіз де жұмыс істейді.',
    },
    unavailable: {
      title: 'ЖИ түсіндіруі қазір қолжетімсіз.',
      body: 'Жаттықтырушының жоғарыдағы мәтіні жеткілікті. Кейінірек қайталап көруге болады.',
    },
    off: {
      title: 'ЖИ түсіндіруі мұнда қосылмаған.',
      body: 'Жаттықтырушының жоғарыдағы мәтіні жеткілікті.',
    },
    gone: {
      title: 'Жаттығудың бұл нұсқасын түсіндіру мүмкін емес.',
      body: 'Жаттықтырушының жоғарыдағы мәтіні бұрынғыдай жұмыс істейді.',
    },
    error: {
      title: 'Түсініктеме алу мүмкін болмады',
      retry: 'Қайталап көру',
    },
  },
  ru: {
    title: 'Объяснить проще',
    lead: 'Непонятен шаг? Попросите ИИ объяснить простыми словами. Текст тренера выше остаётся без изменений.',
    action: 'Объяснить проще',
    retryAction: 'Повторить',
    running: 'ИИ переписывает упражнение простыми словами…',
    runningHint: 'Пока вы ждёте, упражнением можно пользоваться.',
    panel: {
      label: 'Создано ИИ — оригинальный текст тренера выше',
    },
    offline: {
      title: 'Нет соединения.',
      body: 'Для объяснения от ИИ нужен интернет. Упражнение выше работает и без него.',
    },
    unavailable: {
      title: 'Объяснение от ИИ сейчас недоступно.',
      body: 'Текста тренера выше достаточно. Можно попробовать позже.',
    },
    off: {
      title: 'Объяснение от ИИ здесь не включено.',
      body: 'Текста тренера выше достаточно.',
    },
    gone: {
      title: 'Эту версию упражнения объяснить нельзя.',
      body: 'Текст тренера выше по-прежнему работает.',
    },
    error: {
      title: 'Не удалось получить объяснение',
      retry: 'Повторить',
    },
  },
  en: {
    title: 'Explain more simply',
    lead: "Not sure what a step means? Ask AI to say it in simpler words. The coach's text above stays exactly as it is.",
    action: 'Explain more simply',
    retryAction: 'Try again',
    running: 'AI is rewriting this drill in simpler words…',
    runningHint: 'You can keep using the drill while you wait.',
    panel: {
      label: "AI-generated — the coach's original text is above",
    },
    offline: {
      title: 'You are offline.',
      body: 'AI explanations need a connection. The drill above still works.',
    },
    unavailable: {
      title: 'AI explanations are not available right now.',
      body: "The coach's text above is all you need. You can try again later.",
    },
    off: {
      title: 'AI explanations are not switched on here.',
      body: "The coach's text above is all you need.",
    },
    gone: {
      title: "We can't explain this version of the drill.",
      body: "The coach's text above still works.",
    },
    error: {
      title: 'Could not get an explanation',
      retry: 'Try again',
    },
  },
} satisfies MessageBundle;

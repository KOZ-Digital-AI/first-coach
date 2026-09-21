import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the "Personalise with AI" control on today's session (namespace `ai-plan`, from the file name; collected by the
 * `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it).
 * `fallback.reasons` has ONE sentence per fallback code of the contract (AI_FALLBACK_CODES: no_key | disabled | timeout |
 * invalid_output | provider_error), worded for a child or a volunteer coach: what happened, in plain words, never blaming the
 * player. They follow `fallback.standard` ("AI is unavailable — here is your standard plan.") in the same note, so the note says
 * both THAT it is the standard plan and WHY. `ai.tag` is the tag of an AI-planned session. Numbers ({{max}}, {{minutes}}) arrive
 * already formatted for the language. Kazakh text is a first draft and still needs a native review.
 */
export default {
  kk: {
    title: 'ЖИ арқылы жекелендіру',
    lead: 'ЖИ жаттықтырушыдан бүгінгі жаттығуды өзгертуді сұраңыз. Ол тек бекітілген жаттығулардан таңдайды.',
    noteLabel: 'Жаттықтырушы нені білуі керек? (міндетті емес)',
    noteHint: 'Мысалы: тобығым шаршады. {{max}} таңбаға дейін.',
    action: 'ЖИ арқылы жекелендіру',
    retryAction: 'ЖИ арқылы қайталау',
    running: 'ЖИ жаттықтырушы жаттығуыңызды құрастырып жатыр…',
    runningHint: 'Күтіп тұрғанда бүгінгі жаттығуды қолдана бересіз.',
    nothingLeft: 'Бүгінгі жаттығулардың бәрі орындалды, жекелендіретін ештеңе қалмады.',
    error: {
      title: 'ЖИ жаттықтырушымен байланысу мүмкін болмады',
      retry: 'Қайталау',
    },
    fallback: {
      standard: 'ЖИ қолжетімсіз — міне, әдеттегі жоспарыңыз.',
      reasons: {
        no_key: 'ЖИ жаттықтырушы бұл серверде қосылмаған.',
        disabled: 'ЖИ жаттықтырушы қазір өшірулі.',
        timeout: 'ЖИ жаттықтырушы тым ұзақ жауап берді.',
        invalid_output: 'ЖИ ұсынған жоспар тексеруден өтпеді, сондықтан қолданылмады.',
        provider_error: 'ЖИ қызметіне қосылу мүмкін болмады.',
      },
    },
    ai: {
      title: 'Бүгін неге осы жаттығулар',
      tag: 'ЖИ бекітілген жаттығулардан жекелендірді',
      done: 'Орындалды',
      minutes: '{{minutes}} мин',
    },
  },
  ru: {
    title: 'Персонализировать с ИИ',
    lead: 'Попросите ИИ-тренера перестроить сегодняшнюю тренировку. Он выбирает только из одобренных упражнений.',
    noteLabel: 'Что тренеру нужно знать? (по желанию)',
    noteHint: 'Например: у меня устала нога. До {{max}} символов.',
    action: 'Персонализировать с ИИ',
    retryAction: 'Повторить с ИИ',
    running: 'ИИ-тренер составляет вашу тренировку…',
    runningHint: 'Пока вы ждёте, сегодняшней тренировкой можно пользоваться.',
    nothingLeft: 'Все сегодняшние упражнения выполнены, персонализировать больше нечего.',
    error: {
      title: 'Не удалось связаться с ИИ-тренером',
      retry: 'Повторить',
    },
    fallback: {
      standard: 'ИИ недоступен — вот ваш обычный план.',
      reasons: {
        no_key: 'ИИ-тренер не настроен на этом сервере.',
        disabled: 'ИИ-тренер сейчас отключён.',
        timeout: 'ИИ-тренер слишком долго отвечал.',
        invalid_output: 'План от ИИ-тренера не прошёл нашу проверку, поэтому мы его не использовали.',
        provider_error: 'Сервис ИИ сейчас недоступен.',
      },
    },
    ai: {
      title: 'Почему сегодня эти упражнения',
      tag: 'Персонализировано ИИ из одобренных упражнений',
      done: 'Выполнено',
      minutes: '{{minutes}} мин',
    },
  },
  en: {
    title: 'Personalise with AI',
    lead: "Ask the AI coach to reshape today's session. It only picks from approved drills.",
    noteLabel: 'Anything the coach should know? (optional)',
    noteHint: 'For example: my ankle is tired. Up to {{max}} characters.',
    action: 'Personalise with AI',
    retryAction: 'Try AI again',
    running: 'The AI coach is planning your session…',
    runningHint: "You can keep using today's session while you wait.",
    nothingLeft: "All of today's drills are done, so there is nothing left to personalise.",
    error: {
      title: 'Could not reach the AI coach',
      retry: 'Try again',
    },
    fallback: {
      standard: 'AI is unavailable — here is your standard plan.',
      reasons: {
        no_key: 'The AI coach is not set up on this server.',
        disabled: 'The AI coach is switched off for now.',
        timeout: 'The AI coach took too long to answer.',
        invalid_output: 'The AI coach suggested a plan that did not pass our checks, so it was not used.',
        provider_error: 'The AI service could not be reached.',
      },
    },
    ai: {
      title: 'Why these drills today',
      tag: 'AI-personalised from approved drills',
      done: 'Done',
      minutes: '{{minutes}} min',
    },
  },
} satisfies MessageBundle;

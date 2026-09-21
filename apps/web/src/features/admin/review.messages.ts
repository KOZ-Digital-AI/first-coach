import type { MessageBundle } from '../../lib/i18n';

// Contribution review screen copy (routes/admin/contributions.$id.tsx). Namespace `review` (from the file name); registered by the
// eager glob in lib/i18n.ts, so no central catalogue is edited.
//
// Words shared with the queue are NOT repeated here: the screen reads them from the queue's own namespace (`queue:state.*`, `kind.*`,
// `level.*`, `goal.*`, `equipment.*`, `improvementKind.*`, `fileKind.*`, `fields.*`, `review.facts.*`) and the trust statuses from
// `trust-badge`, so an admin reads the same word for the same thing on both screens. Generic failures come from `problem`.
//
// KAZAKH (and Russian) TEXT STILL NEEDS A NATIVE-SPEAKER REVIEW (bead fc-cjh). No noun has to agree with a variable: a file name, a
// slug or a person's name is always placed after a colon or inside a fixed frame. The three server-facing error lines are the
// screen's own words: the server's English text is never shown.
export default {
  kk: {
    eyebrow: 'Тексеру',
    loading: 'Әдіс жүктелуде',
    back: 'Кезекке оралу',
    error: { title: 'Бұл әдісті жүктей алмадық', retry: 'Қайталау' },
    missing: {
      title: 'Бұл әдіс тексеруді күтіп тұрған жоқ',
      hint: 'Ол бойынша шешім қабылданып қойған болуы мүмкін, немесе сілтеме қате. Күтіп тұрғандарды көру үшін кезекті ашыңыз.',
    },
    noActions: {
      changes_requested: 'Жаттықтырушының жаңа нұсқаны жіберуін күтеміз. Сізге істейтін ештеңе жоқ.',
      approved: 'Бұл әдіс мақұлданған. Енді шешетін ештеңе жоқ.',
      rejected: 'Бұл әдіс қабылданбаған. Енді шешетін ештеңе жоқ.',
      withdrawn: 'Жаттықтырушы бұл әдісті қайтарып алды. Шешетін ештеңе жоқ.',
    },
    about: 'Кім жіберді',
    lockedNote: 'Авторын, тілін, түрін және ол жақсартатын жаттығуды жаттықтырушы белгілеген. Мұнда оларды өзгертуге болмайды.',
    media: {
      title: 'Бейне және файлдар',
      none: 'Бейне тіркелмеген.',
      videoLabel: 'Бейне: {{name}}',
      unsupported: 'Бұл браузер бейнені көрсете алмайды. Файлды сілтеме арқылы ашыңыз.',
    },
    checklist: {
      title: 'Мақұлдамас бұрын',
      hint: 'Әр тармақты тексергеннен кейін белгілеңіз.',
      original: 'Мазмұн түпнұсқа: FIFA, UEFA немесе басқа коммерциялық көзден көшірілмеген.',
      safe: 'Балалар мұны ересектің қадағалауынсыз қауіпсіз орындай алады.',
      minors: 'Фото мен бейнеде танылатын бала жоқ, немесе ата-анасы келісім берген.',
      required: 'Мақұлдамас бұрын үш тармақты да белгілеңіз.',
    },
    edit: {
      title: 'Мақұлдамас бұрын түзету',
      hint: 'Түзетулер мақұлдаумен бірге сақталады. Жаттықтырушының жазғанын қалдыру үшін өрісті қозғамаңыз.',
      improvementNote: 'Бұл бар жаттығуды жақсарту, сондықтан оның спорт түрі, дағдысы және мақсаты жаттығудағыдай қалады.',
      hints: {
        sport: 'Спорт түрінің коды, мысалы football.',
        skill: 'Дағды коды, мысалы dribbling-basics.',
        sourceUrl: 'Веб-мекенжай. Оны ауыстыруға болады, бірақ жоюға болмайды.',
      },
      errors: {
        required: 'Бұл өріс бос болмауы керек.',
        whole: 'Бүтін сан енгізіңіз, 0 немесе одан көп.',
        positive: '0-ден үлкен бүтін сан енгізіңіз.',
        ageOrder: 'Ең үлкен жас ең кіші жастан кіші болмауы керек.',
        url: 'http:// немесе https:// деп басталатын веб-мекенжай енгізіңіз.',
        server: 'Сервер бұл мәнді қабылдамады. Оны өзгертіп, қайталап көріңіз.',
        form: 'Сервер түзетулерді қабылдамады. Өрістерді тексеріп, қайталап көріңіз.',
      },
    },
    status: {
      legend: 'Жарияланғандағы сенім мәртебесі',
      hint: 'Әдетте «Қауымдастық» мәртебесінен бастайды. Тексерілген мәртебелерге жазба керек.',
      org: {
        label: 'Ұйым',
        hint: '«Академия тексерген» үшін міндетті, мысалы «FC Kairat Academy». «Сарапшы тексерген» үшін міндетті емес.',
        required: '«Академия тексерген» мәртебесі үшін ұйымның атауы керек.',
      },
    },
    decision: {
      title: 'Сіздің шешіміңіз',
      note: {
        label: 'Жаттықтырушыға жазба',
        hint: 'Қабылдамау, өзгеріс сұрау немесе тексерілген мәртебемен мақұлдау үшін міндетті. Басқа жағдайда міндетті емес.',
        required: 'Бұл шешім үшін жазба керек. Жаттықтырушыға себебін жазыңыз.',
      },
      approve: 'Мақұлдау',
      requestChanges: 'Өзгеріс сұрау',
      reject: 'Қабылдамау',
      failed: { title: 'Шешім сақталмады', hint: 'Ештеңе өзгерген жоқ. Қайталап көріңіз.' },
      conflict:
        'Бұл әдіспен басқа біреу бұрын айналысқан немесе жаттықтырушы оны қайтарып алған. Ештеңе сақталмады.',
      outcome: {
        approve: 'Мақұлданды. Әдіс енді ашық қорда.',
        request_changes: 'Қайтарылды. Жаттықтырушы әдісті түзетіп, қайта жібере алады.',
        reject: 'Қабылданбады. Жаттықтырушы сіздің жазбаңызды оқи алады.',
      },
      openDrill: 'Жарияланған жаттығуды ашу',
      reviewerNote: 'Тексерушінің жазбасы',
    },
  },
  ru: {
    eyebrow: 'Проверка',
    loading: 'Загружаем методику',
    back: 'Назад к очереди',
    error: { title: 'Не удалось загрузить методику', retry: 'Повторить' },
    missing: {
      title: 'Эта методика не ждёт проверки',
      hint: 'Возможно, по ней уже принято решение, или ссылка неверна. Откройте очередь, чтобы увидеть, что ждёт проверки.',
    },
    noActions: {
      changes_requested: 'Ждём, когда тренер пришлёт новую версию. Вам ничего делать не нужно.',
      approved: 'Эта методика одобрена. Решать больше нечего.',
      rejected: 'Эта методика отклонена. Решать больше нечего.',
      withdrawn: 'Тренер отозвал эту методику. Решать нечего.',
    },
    about: 'Кто прислал',
    lockedNote: 'Автора, язык, вид заявки и упражнение, которое она улучшает, задал тренер. Здесь их изменить нельзя.',
    media: {
      title: 'Видео и файлы',
      none: 'Видео не приложено.',
      videoLabel: 'Видео: {{name}}',
      unsupported: 'Этот браузер не может показать видео. Откройте файл по ссылке.',
    },
    checklist: {
      title: 'Перед одобрением',
      hint: 'Отметьте каждый пункт, когда проверите.',
      original: 'Материал оригинальный: не скопирован у FIFA, UEFA или из другого коммерческого источника.',
      safe: 'Детям безопасно выполнять это без присмотра взрослого.',
      minors: 'На фото и видео нет узнаваемых детей, либо родитель согласился.',
      required: 'Перед одобрением отметьте все три пункта.',
    },
    edit: {
      title: 'Правки перед одобрением',
      hint: 'Правки сохранятся вместе с одобрением. Не трогайте поле, чтобы оставить текст тренера.',
      improvementNote: 'Это улучшение существующего упражнения, поэтому его вид спорта, навык и цель остаются как в упражнении.',
      hints: {
        sport: 'Код вида спорта, например football.',
        skill: 'Код навыка, например dribbling-basics.',
        sourceUrl: 'Веб-адрес. Его можно заменить, но нельзя удалить.',
      },
      errors: {
        required: 'Это поле не может быть пустым.',
        whole: 'Введите целое число, 0 или больше.',
        positive: 'Введите целое число больше 0.',
        ageOrder: 'Наибольший возраст не может быть меньше наименьшего.',
        url: 'Введите веб-адрес, который начинается с http:// или https://.',
        server: 'Сервер не принял это значение. Измените его и попробуйте ещё раз.',
        form: 'Сервер не принял правки. Проверьте поля и попробуйте ещё раз.',
      },
    },
    status: {
      legend: 'Статус доверия при публикации',
      hint: 'Обычно начинают со статуса «Сообщество». Проверенные статусы требуют заметки.',
      org: {
        label: 'Организация',
        hint: 'Обязательна для статуса «Проверено академией», например «FC Kairat Academy». Для статуса «Проверено экспертом» не обязательна.',
        required: 'Для статуса «Проверено академией» нужно название организации.',
      },
    },
    decision: {
      title: 'Ваше решение',
      note: {
        label: 'Заметка тренеру',
        hint: 'Обязательна, чтобы отклонить, попросить правки или одобрить с проверенным статусом. В остальных случаях не обязательна.',
        required: 'Для этого решения нужна заметка. Объясните тренеру, почему.',
      },
      approve: 'Одобрить',
      requestChanges: 'Попросить правки',
      reject: 'Отклонить',
      failed: { title: 'Решение не сохранено', hint: 'Ничего не изменилось. Попробуйте ещё раз.' },
      conflict: 'Этой методикой уже занялся кто-то другой, или тренер её отозвал. Ничего не сохранено.',
      outcome: {
        approve: 'Одобрено. Методика теперь в открытой базе.',
        request_changes: 'Возвращено. Тренер может исправить методику и отправить её снова.',
        reject: 'Отклонено. Тренер сможет прочитать вашу заметку.',
      },
      openDrill: 'Открыть опубликованное упражнение',
      reviewerNote: 'Заметка проверяющего',
    },
  },
  en: {
    eyebrow: 'Review',
    loading: 'Loading the contribution',
    back: 'Back to the queue',
    error: { title: 'We could not load this contribution', retry: 'Try again' },
    missing: {
      title: 'This contribution is not waiting for review',
      hint: 'It may already be decided, or the link may be wrong. Open the queue to see what is waiting.',
    },
    noActions: {
      changes_requested: 'Waiting for the coach to send a new version. There is nothing for you to do.',
      approved: 'This method is approved. There is nothing more to decide.',
      rejected: 'This method was rejected. There is nothing more to decide.',
      withdrawn: 'The coach withdrew this method. There is nothing to decide.',
    },
    about: 'Who sent it',
    lockedNote: 'The author, language, kind and the drill it improves come from the coach and cannot be changed here.',
    media: {
      title: 'Video and files',
      none: 'No video was attached.',
      videoLabel: 'Video: {{name}}',
      unsupported: 'This browser cannot play the video. Open the file from the link instead.',
    },
    checklist: {
      title: 'Before you approve',
      hint: 'Tick each one after you have checked it.',
      original: 'The content is original: not copied from FIFA, UEFA or any commercial source.',
      safe: 'It is safe for children to do without an adult watching.',
      minors: 'No identifiable child is in the photos or video, or a parent agreed to it.',
      required: 'Tick all three checks before you approve.',
    },
    edit: {
      title: 'Edit before approving',
      hint: 'Changes are saved together with the approval. Leave a field alone to keep what the coach wrote.',
      improvementNote: 'This improves an existing drill, so its sport, skill and goal stay as the drill has them.',
      hints: {
        sport: 'The sport code, for example football.',
        skill: 'The skill code, for example dribbling-basics.',
        sourceUrl: 'A web address. It can be replaced here but not removed.',
      },
      errors: {
        required: 'This cannot be empty.',
        whole: 'Enter a whole number, 0 or more.',
        positive: 'Enter a whole number above 0.',
        ageOrder: 'The oldest age cannot be lower than the youngest.',
        url: 'Enter a web address that starts with http:// or https://.',
        server: 'The server did not accept this value. Change it and try again.',
        form: 'The server did not accept the edits. Check the fields and try again.',
      },
    },
    status: {
      legend: 'Trust status when published',
      hint: 'Community is the usual start. Verified statuses need a note.',
      org: {
        label: 'Organisation',
        hint: 'Required for Academy verified, for example “FC Kairat Academy”. Optional for Expert verified.',
        required: 'Academy verified needs the name of the organisation.',
      },
    },
    decision: {
      title: 'Your decision',
      note: {
        label: 'Note to the coach',
        hint: 'Required to reject, to ask for changes or to approve with a verified status. Otherwise optional.',
        required: 'A note is required for this decision. Tell the coach why.',
      },
      approve: 'Approve',
      requestChanges: 'Request changes',
      reject: 'Reject',
      failed: { title: 'The decision was not saved', hint: 'Nothing changed. Try again.' },
      conflict: 'Someone else has already dealt with this contribution, or the coach withdrew it. Nothing was saved.',
      outcome: {
        approve: 'Approved. The method is now in the commons.',
        request_changes: 'Sent back. The coach can now edit the method and send it again.',
        reject: 'Rejected. The coach can read your note.',
      },
      openDrill: 'Open the published drill',
      reviewerNote: "Reviewer's note",
    },
  },
} satisfies MessageBundle;

import type { MessageBundle } from '../../lib/i18n';

/*
 * Copy of the terms and content licence page (/legal/terms). Namespace = file base name (`terms`), collected by the
 * `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it.
 *
 * Shape: page-level strings at the top, then `sections.<id>` with a `title`, a `lead` and (for some) `points`, a list
 * rendered as bullets in the key order written here. The section ids are listed in routes/legal/terms.tsx.
 *
 * Every statement comes from the bead criteria, README.md, CONTENT-LICENSE.md and PRODUCT.md; no legal term is invented.
 * The safety notes repeat what the seeded drills already tell the child (warm up; soft ball or gentle passes against a
 * wall; away from roads, cars and streets). The attribution line itself is not translated: it is copied verbatim from
 * CONTENT-LICENSE.md in the route.
 *
 * KAZAKH NEEDS A NATIVE-SPEAKER REVIEW (bead fc-cjh) before this page is relied on. Voice is the app's informal singular
 * ("сен" / "ты"), like the onboarding steps.
 */
export default {
  kk: {
    eyebrow: 'Құқықтық ақпарат',
    title: 'Шарттар және мазмұн лицензиясы',
    lead: 'Мұнда FIRST COACH-ты қалай пайдалануға және оның білімін қайта қолдануға болатыны қарапайым тілмен жазылған. Қысқаша: қызмет тегін, бағдарлама мен білім ашық, жаттығуды өз жауапкершілігіңмен жасайсың.',
    contentsLabel: 'Осы беттегі бөлімдер',
    licenceLink: 'CC BY-SA 4.0 лицензиясының толық мәтіні',
    exportLink: 'Open Sport Commons деректер ретінде (JSON)',
    newTab: 'жаңа қойындыда ашылады',
    attributionIntro: 'Осы жолды көшіріп ал:',
    contactLabel: 'Сұрауды мына мекенжайға жібер:',
    noContact: 'Бұл қызметті іске қосқан адам байланыс мекенжайын әлі жарияламаған.',
    sections: {
      free: {
        title: 'FIRST COACH тегін',
        lead: 'FIRST COACH үшін ақы төлемейсің. Жазылым да, ақылы бөлімдер де жоқ.',
      },
      licences: {
        title: 'Екі ашық лицензия',
        lead: 'FIRST COACH екі бөлек жолмен ашық.',
        points: {
          software: 'Бағдарлама (қолданба, API және құралдар): MIT лицензиясы.',
          knowledge:
            'Білім (Open Sport Commons: жаттығулар, дағдылар, әдістеме және аудармалар): Creative Commons Attribution-ShareAlike 4.0 International, қысқаша CC BY-SA 4.0.',
        },
      },
      reuse: {
        title: 'Білімді қайта пайдалану',
        lead: 'Open Sport Commons-ты, соның ішінде коммерциялық мақсатта да, бөлісуге және өзгертуге болады. Тек екі ережені сақта.',
        points: {
          attribution:
            'Attribution (авторды көрсету): дереккөзді тиісінше көрсетіп, лицензияның атын ата. Төмендегі жолды қолдан.',
          shareAlike:
            'Share-alike (сол шартпен тарату): мазмұнды өзгертсең немесе оның негізінде жаңасын жасасаң, нәтижені сол лицензиямен, яғни CC BY-SA 4.0 бойынша тарат.',
        },
      },
      contributing: {
        title: 'Үлес қосқанда',
        lead: 'Әдістер, жаттығулар, дағдылар графтары мен аудармалар осы шартпен қабылданады.',
        points: {
          authorship: 'Авторлығың өзіңде қалады: атың үлесіңмен бірге сақталады.',
          licence: 'Үлесіңді CC BY-SA 4.0 лицензиясымен бересің.',
          rights:
            'Жіберген нәрсеңе құқығың бар екенін және оған лицензия бере алатыныңды растайсың: өз әдісің, өз бейнежазбаң, өз сөзің.',
          noCommercial:
            'FIFA, UEFA немесе басқа коммерциялық не авторлық құқықпен қорғалған материал жіберілмейді. Оған лицензия беруге құқығың болмаса, жіберме.',
        },
      },
      communityDraft: {
        title: 'Жасанды интеллект жазған мазмұн',
        lead: 'Кейбір жаттығуларды жасанды интеллекттің көмегімен жазған. Олар «Қауымдастық жобасы» (Community Draft) деп белгіленеді. Мұндай жоба әлі жаттықтырушылардың қарауынан өтпеген және академия әдістемесі емес. Белгі ешқашан жасырылмайды, сондықтан қаралған мазмұнды қаралмағаннан әрдайым ажырата аласың.',
      },
      ownRisk: {
        title: 'Жаттығу өз жауапкершілігіңде',
        lead: 'Жаттығуды өз жауапкершілігіңмен жасайсың. Футбол жаттығуында жарақат алу қаупі бар, сондықтан мына қауіпсіздік ескертпелерін орында.',
        points: {
          read: 'Бастамас бұрын әр жаттығудың қауіпсіздік ескертпелерін оқы.',
          warmUp: 'Алдымен жылын: орныңда жиырма қадам жүр.',
          space: 'Құрғақ, тегіс, бос жерде жаттығу жаса; жолдардан, көліктерден және көшелерден алыс бол.',
          ball: 'Қабырғаға немесе серігіңе соққанда жұмсақ допты пайдалан не пасты жайлап бер.',
          stop: 'Бір жерің ауырса немесе басың айналса, тоқта да ересек адамға айт.',
        },
      },
      children: {
        title: 'Балалар және қамқоршылар',
        lead: 'Балалар жаттығуды ата-анасының немесе қамқоршысының хабарымен жасағаны жөн. Бала болсаң, бастамас бұрын ата-анаңа немесе басқа ересек адамға айт.',
      },
      takedown: {
        title: 'Мазмұнды алып тастау сұраулары',
        lead: 'Open Sport Commons ішіндегі мазмұн құқықтарыңды бұзса немесе онда болмауы керек болса, оны алып тастауды сұрай аласың.',
        points: {
          what: 'Қандай мазмұн екенін және оны қайдан табуға болатынын жаз.',
          why: 'Неге алып тастау керегін және сенімен қалай байланысуға болатынын жаз.',
          review: 'Біз әр сұрауды қарап, ортақ базада болмауы керек мазмұнды алып тастаймыз.',
        },
      },
    },
  },
  ru: {
    eyebrow: 'Правовая информация',
    title: 'Условия и лицензия на контент',
    lead: 'Здесь простыми словами написано, как пользоваться FIRST COACH и как повторно использовать то, чему он учит. Коротко: сервис бесплатный, программа и знания открыты, а тренируешься ты на свой риск.',
    contentsLabel: 'Разделы страницы',
    licenceLink: 'Полный текст лицензии CC BY-SA 4.0',
    exportLink: 'Open Sport Commons как данные (JSON)',
    newTab: 'откроется в новой вкладке',
    attributionIntro: 'Скопируй эту строку:',
    contactLabel: 'Отправь запрос на адрес:',
    noContact: 'Тот, кто запустил этот сервис, пока не опубликовал контактный адрес.',
    sections: {
      free: {
        title: 'FIRST COACH бесплатный',
        lead: 'За FIRST COACH не нужно платить. Подписки и платных разделов нет.',
      },
      licences: {
        title: 'Две открытые лицензии',
        lead: 'FIRST COACH открыт двумя отдельными способами.',
        points: {
          software: 'Программа (приложение, API и инструменты): лицензия MIT.',
          knowledge:
            'Знания (Open Sport Commons: упражнения, навыки, методика и переводы): Creative Commons Attribution-ShareAlike 4.0 International, сокращённо CC BY-SA 4.0.',
        },
      },
      reuse: {
        title: 'Повторное использование знаний',
        lead: 'Open Sport Commons можно копировать и изменять, в том числе в коммерческих целях. Нужно соблюдать два правила.',
        points: {
          attribution:
            'Attribution (указание авторства): дай подобающую ссылку на источник и назови лицензию. Используй строку ниже.',
          shareAlike:
            'Share-alike (на тех же условиях): если ты меняешь материал или делаешь на его основе новый, распространяй результат под той же лицензией, CC BY-SA 4.0.',
        },
      },
      contributing: {
        title: 'Если ты вносишь вклад',
        lead: 'Методики, упражнения, графы навыков и переводы принимаются на этих условиях.',
        points: {
          authorship: 'Авторство остаётся за тобой: твоё имя сохраняется рядом с твоим вкладом.',
          licence: 'Свой вклад ты передаёшь под лицензией CC BY-SA 4.0.',
          rights:
            'Ты подтверждаешь, что у тебя есть права на то, что ты отправляешь, и ты вправе дать на это лицензию: твои собственные методики, видео и слова.',
          noCommercial:
            'Никаких материалов FIFA, UEFA и другого коммерческого или защищённого авторским правом контента. Если у тебя нет права дать на него лицензию, не отправляй его.',
        },
      },
      communityDraft: {
        title: 'Контент, написанный с помощью ИИ',
        lead: 'Некоторые упражнения написаны с помощью ИИ. Они помечены как «Черновик сообщества» (Community Draft). Такой черновик ещё не проверен тренерами и не является методикой академии. Метка никогда не скрывается, поэтому проверенный контент всегда можно отличить от непроверенного.',
      },
      ownRisk: {
        title: 'Тренировка на свой риск',
        lead: 'Ты тренируешься на свой риск. В футбольных упражнениях есть риск травмы, поэтому соблюдай эти правила безопасности.',
        points: {
          read: 'Перед началом прочитай указания по безопасности у каждого упражнения.',
          warmUp: 'Сначала разомнись: пройди на месте двадцать шагов.',
          space: 'Тренируйся на сухой, ровной и свободной площадке, подальше от дорог, машин и улиц.',
          ball: 'Когда играешь о стену или с партнёром, бери мягкий мяч или пасуй мягко.',
          stop: 'Если что-то болит или кружится голова, остановись и скажи взрослому.',
        },
      },
      children: {
        title: 'Дети и родители',
        lead: 'Детям лучше тренироваться с ведома родителей или опекунов. Если ты ребёнок, скажи родителям или другому взрослому, прежде чем начать.',
      },
      takedown: {
        title: 'Запросы на удаление',
        lead: 'Если контент в Open Sport Commons нарушает твои права или его не должно быть здесь, ты можешь попросить его удалить.',
        points: {
          what: 'Напиши, какой это контент и где его можно найти.',
          why: 'Напиши, почему его нужно удалить и как с тобой связаться.',
          review: 'Мы рассматриваем каждый запрос и удаляем контент, которого не должно быть в общей базе.',
        },
      },
    },
  },
  en: {
    eyebrow: 'Legal',
    title: 'Terms and content licence',
    lead: 'This page says in plain words how to use FIRST COACH and how to reuse what it teaches. In short: the service is free, the software and the knowledge are open, and you train at your own risk.',
    contentsLabel: 'Sections on this page',
    licenceLink: 'Full text of the CC BY-SA 4.0 licence',
    exportLink: 'Open Sport Commons as data (JSON)',
    newTab: 'opens in a new tab',
    attributionIntro: 'Copy this line:',
    contactLabel: 'Send your request to:',
    noContact: 'Whoever runs this service has not published a contact address yet.',
    sections: {
      free: {
        title: 'FIRST COACH is free',
        lead: 'You do not pay for FIRST COACH. There is no subscription and no paywall.',
      },
      licences: {
        title: 'Two open licences',
        lead: 'FIRST COACH is open in two separate ways.',
        points: {
          software: 'Software (the app, the API and the tooling): MIT licence.',
          knowledge:
            'Knowledge (Open Sport Commons: drills, skills, methodology and translations): Creative Commons Attribution-ShareAlike 4.0 International, CC BY-SA 4.0 for short.',
        },
      },
      reuse: {
        title: 'Reusing the knowledge',
        lead: 'You may share and adapt Open Sport Commons, including commercially, if you follow two rules.',
        points: {
          attribution:
            'Attribution: give appropriate credit to the source and name the licence. Use the line below.',
          shareAlike:
            'Share-alike: if you adapt this content or build on it, distribute your result under the same licence, CC BY-SA 4.0.',
        },
      },
      contributing: {
        title: 'If you contribute',
        lead: 'Methods, drills, skill graphs and translations are accepted on these terms.',
        points: {
          authorship: 'You keep authorship: your name stays attached to your contribution.',
          licence: 'You license your contribution under CC BY-SA 4.0.',
          rights:
            'You attest that you hold the rights to what you submit and may license it: your own methods, your own videos, your own words.',
          noCommercial:
            'No FIFA, UEFA or other commercial or copyrighted material. If you do not have the right to license it, do not submit it.',
        },
      },
      communityDraft: {
        title: 'AI-drafted content',
        lead: 'Some drills were drafted with the help of AI. They are labelled “Community Draft”. A Community Draft has not yet been reviewed by coaches and is not academy methodology. The label is never hidden, so you can always tell reviewed content from unreviewed content.',
      },
      ownRisk: {
        title: 'Training is at your own risk',
        lead: 'You train at your own risk. Football drills carry a risk of injury, so follow these safety notes.',
        points: {
          read: 'Read the safety notes on each drill before you start.',
          warmUp: 'Warm up first: march on the spot for twenty steps.',
          space: 'Train on a dry, flat, clear surface, away from roads, cars and streets.',
          ball: 'When you kick against a wall or with a partner, use a soft ball or gentle passes.',
          stop: 'If something hurts or you feel dizzy, stop and tell an adult.',
        },
      },
      children: {
        title: 'Children and guardians',
        lead: 'Children should train with a guardian’s knowledge. If you are a child, tell a parent or another adult before you start.',
      },
      takedown: {
        title: 'Takedown requests',
        lead: 'If content in Open Sport Commons infringes your rights or should not be here, you can ask us to take it down.',
        points: {
          what: 'Say which content it is and where it can be found.',
          why: 'Say why it should be removed and how we can reach you.',
          review: 'We review each request and remove content that should not be in the commons.',
        },
      },
    },
  },
} satisfies MessageBundle;

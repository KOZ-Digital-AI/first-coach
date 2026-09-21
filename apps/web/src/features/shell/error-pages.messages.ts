import type { MessageBundle } from '../../lib/i18n';

// Not-found, unauthorized and something-went-wrong pages. Namespace `error-pages` (from the file name), registered by the
// eager glob in lib/i18n.ts. Tone (PRODUCT.md): calm, plain, never scolding; it says what happened and the next small step,
// and never blames the visitor. The Kazakh text still needs a native review.
export default {
  kk: {
    notFound: {
      eyebrow: '404',
      title: 'Бұл бетті таба алмадық',
      body: 'Сілтеме ескірген немесе қате жазылған болуы мүмкін. Ештеңе жоғалған жоқ, басты бетке оралып, жалғастыра беріңіз.',
      home: 'Басты бетке өту',
      train: 'Жаттығуға өту',
    },
    unauthorized: {
      eyebrow: 'Бапкерлер мен әкімшілерге',
      title: 'Бұл бет бапкерлер мен әкімшілерге арналған',
      body: 'Оны ашу үшін әкімші немесе бапкер аккаунты қажет. Өз аккаунтыңызбен кіріңіз.',
      signIn: 'Кіру',
      home: 'Басты бетке оралу',
    },
    error: {
      eyebrow: 'Кішкене іркіліс',
      title: 'Бір нәрсе дұрыс болмады',
      body: 'Бұл біздің қателігіміз, сіздікі емес. Бетті қайта жүктеп көріңіз.',
      reload: 'Бетті қайта жүктеу',
      home: 'Басты бетке',
    },
  },
  ru: {
    notFound: {
      eyebrow: '404',
      title: 'Мы не нашли эту страницу',
      body: 'Ссылка могла устареть или в ней опечатка. Ничего не потеряно: вернитесь на главную и продолжайте.',
      home: 'На главную',
      train: 'К тренировкам',
    },
    unauthorized: {
      eyebrow: 'Для тренеров и админов',
      title: 'Эта страница для тренеров и администраторов',
      body: 'Чтобы открыть её, нужен аккаунт администратора или тренера. Войдите в свой аккаунт.',
      signIn: 'Войти',
      home: 'Вернуться на главную',
    },
    error: {
      eyebrow: 'Небольшая заминка',
      title: 'Что-то пошло не так',
      body: 'Это наша ошибка, а не ваша. Перезагрузите страницу и попробуйте ещё раз.',
      reload: 'Перезагрузить страницу',
      home: 'На главную',
    },
  },
  en: {
    notFound: {
      eyebrow: '404',
      title: "We can't find that page",
      body: 'The link may be old or mistyped. Nothing is lost: head back home and carry on.',
      home: 'Go to the home page',
      train: 'Go to training',
    },
    unauthorized: {
      eyebrow: 'For coaches and admins',
      title: 'This page is for coaches and admins',
      body: 'It needs an admin or coach account to open. Sign in with yours to continue.',
      signIn: 'Sign in',
      home: 'Back to the home page',
    },
    error: {
      eyebrow: 'A small hiccup',
      title: 'Something went wrong',
      body: 'That was our slip, not yours. Reload the page and try again.',
      reload: 'Reload the page',
      home: 'Go to the home page',
    },
  },
} satisfies MessageBundle;

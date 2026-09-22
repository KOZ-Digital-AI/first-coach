import type { MessageBundle } from '../../lib/i18n';

// Coach account screen copy (/account/sign-in). Namespace `sign-in` (from the file name); registered by the eager glob in
// lib/i18n.ts.
//
// Kazakh text still needs a native-speaker review (bead fc-cjh): it was written without one, so wording, register and word
// order may need changes. Russian and English are the reference texts. This includes the newer `start.*` keys (auth-gate
// spec P3): the child is addressed informally (kk сен / ru ты), the coach formally (kk сіз / ru вы), per PRODUCT.md.
//
// - `start.*` is the Start card (auth-gate spec §2.4): a signed-out visitor's one-tap way into training, no form, no
//   account. `start.button`'s English is "Start training" (not just "Start"), matching the landing page's CTA and the
//   kid-sized button the spec calls for. `start.coach` is the quiet secondary heading above the coach tabs, asking the
//   question the Start card itself cannot answer.
//
// - Players never need an account; the lead says so. A coach account is for people who add drills to Open Sport Commons.
// - There is no reset email (the server sends no mail), so the password hint says so; that is a fact, not a promise.
// - `errors.*` never repeat the server's English text: wrong password does not say WHICH of email / password is wrong, and
//   rate limited names the real limit (10 tries in 15 minutes, apps/api/src/auth/rate-limit.ts RATE_LIMITS).
// - `guest.note` is shown to a player who is training as a guest: making an account keeps that progress. DEPENDENCY: that
//   only holds once the API links the guest to the new account (onLinkAccount re-keys the player's data: bug bead
//   fc-mol-70i.12). Until then Better Auth deletes the guest user when the account is made. The client half (no sign-out,
//   the guest cookie stays for the sign-up / sign-in call) is done in routes/account/sign-in.tsx. Reword the note if 70i.12
//   is not going to land.
export default {
  kk: {
    eyebrow: 'Аккаунт',
    title: 'Бапкер аккаунты',
    lead: 'Ойыншыларға аккаунт ешқашан керек емес: жаттығу онсыз да жұмыс істейді. Бапкер аккаунты Open Sport Commons-қа жаттығу қосқысы келетіндерге арналған.',
    tabs: {
      label: 'Аккаунт әрекеттері',
      signUp: 'Бапкер аккаунтын ашу',
      signIn: 'Кіру',
    },
    guest: {
      checking: 'Сеанс тексерілуде…',
      note: 'Сен қазір қонақ ретінде жаттығып жүрсің. Аккаунт ашсаң, прогресің сенімен бірге қалады.',
    },
    signedIn: {
      title: 'Сен аккаунтқа кіріп қойғансың.',
      continue: 'Жалғастыру',
    },
    fields: {
      name: {
        label: 'Көрсетілетін аты',
        hint: 'Біз сені осылай атаймыз.',
      },
      email: {
        label: 'Электрондық пошта',
      },
      password: {
        label: 'Құпиясөз',
        hint: 'Кемінде 10 таңба. Құпиясөзді қалпына келтіру хатын жібере алмаймыз, сондықтан оны сақтап қой.',
      },
    },
    submit: {
      signUp: 'Бапкер аккаунтын ашу',
      signIn: 'Кіру',
      busySignUp: 'Аккаунт ашылуда…',
      busySignIn: 'Кіруде…',
    },
    success: 'Кірдің. Кері қайтарамыз…',
    validation: {
      name: 'Көрсетілетін атыңды жаз.',
      email: 'Электрондық поштаны жаз, мысалы name@example.com.',
      passwordShort: 'Кемінде 10 таңба қолдан.',
      passwordRequired: 'Құпиясөзді жаз.',
    },
    errors: {
      wrongPassword: 'Электрондық пошта мен құпиясөз сәйкес келмейді. Екеуін де тексеріп, қайта көр.',
      emailTaken: 'Бұл поштамен аккаунт бұрыннан бар.',
      emailTakenAction: 'Оның орнына кіру',
      passwordLong: 'Ең көбі 128 таңба қолдан.',
      rateLimited: 'Әрекет тым көп болды. 15 минутта 10 рет көруге болады. Біраз күтіп, қайта көр.',
      offline: 'Байланыс жоқ. Интернетті тексеріп, қайта көр.',
      server: 'Біздің жағымыздан қате шықты. Сәлден соң қайта көр.',
      generic: 'Аяқтай алмадық. Қайта көр.',
    },
    start: {
      title: 'Жаттығуды бастау',
      body: 'Аккаунт қажет емес. Прогресің осы телефонда сақталады.',
      button: 'Бастау',
      busy: 'Бастап жатырмыз…',
      error: 'Бастау мүмкін болмады. Байланысты тексеріп, қайта көр.',
      coach: 'Сіз бапкерсіз бе немесе жаттығу қосқыңыз келе ме?',
    },
  },
  ru: {
    eyebrow: 'Аккаунт',
    title: 'Аккаунт тренера',
    lead: 'Игрокам аккаунт не нужен: тренировки работают без него. Аккаунт тренера нужен тем, кто добавляет упражнения в Open Sport Commons.',
    tabs: {
      label: 'Действия с аккаунтом',
      signUp: 'Создать аккаунт тренера',
      signIn: 'Войти',
    },
    guest: {
      checking: 'Проверяем сессию…',
      note: 'Сейчас ты тренируешься как гость. Если создашь аккаунт, твой прогресс останется с тобой.',
    },
    signedIn: {
      title: 'Ты уже вошёл в аккаунт.',
      continue: 'Продолжить',
    },
    fields: {
      name: {
        label: 'Отображаемое имя',
        hint: 'Так мы будем к тебе обращаться.',
      },
      email: {
        label: 'Электронная почта',
      },
      password: {
        label: 'Пароль',
        hint: 'Не менее 10 символов. Мы не можем прислать письмо для сброса пароля, поэтому сохрани его.',
      },
    },
    submit: {
      signUp: 'Создать аккаунт тренера',
      signIn: 'Войти',
      busySignUp: 'Создаём аккаунт…',
      busySignIn: 'Входим…',
    },
    success: 'Готово, ты вошёл. Возвращаем тебя…',
    validation: {
      name: 'Введи отображаемое имя.',
      email: 'Введи адрес почты, например name@example.com.',
      passwordShort: 'Нужно не менее 10 символов.',
      passwordRequired: 'Введи пароль.',
    },
    errors: {
      wrongPassword: 'Почта и пароль не совпадают. Проверь оба поля и попробуй ещё раз.',
      emailTaken: 'У этой почты уже есть аккаунт.',
      emailTakenAction: 'Войти вместо этого',
      passwordLong: 'Не больше 128 символов.',
      rateLimited: 'Слишком много попыток. Можно пробовать 10 раз за 15 минут. Подожди немного и попробуй снова.',
      offline: 'Нет связи. Проверь интернет и попробуй ещё раз.',
      server: 'Что-то пошло не так на нашей стороне. Попробуй через минуту.',
      generic: 'Не получилось завершить. Попробуй ещё раз.',
    },
    start: {
      title: 'Начать тренировку',
      body: 'Аккаунт не нужен. Твой прогресс остаётся на этом телефоне.',
      button: 'Начать',
      busy: 'Запускаем…',
      error: 'Не получилось начать. Проверь связь и попробуй ещё раз.',
      coach: 'Вы тренер или хотите добавить упражнение?',
    },
  },
  en: {
    eyebrow: 'Account',
    title: 'Coach account',
    lead: 'Players never need an account: training works without one. A coach account is for people who add drills to Open Sport Commons.',
    tabs: {
      label: 'Account options',
      signUp: 'Create coach account',
      signIn: 'Sign in',
    },
    guest: {
      checking: 'Checking your session…',
      note: 'You are training as a guest right now. If you make an account, your progress stays with you.',
    },
    signedIn: {
      title: 'You are already signed in.',
      continue: 'Continue',
    },
    fields: {
      name: {
        label: 'Display name',
        hint: 'The name we use for you.',
      },
      email: {
        label: 'Email',
      },
      password: {
        label: 'Password',
        hint: 'At least 10 characters. We cannot send a password reset email, so keep it safe.',
      },
    },
    submit: {
      signUp: 'Create coach account',
      signIn: 'Sign in',
      busySignUp: 'Creating your account…',
      busySignIn: 'Signing in…',
    },
    success: 'Signed in. Taking you back…',
    validation: {
      name: 'Enter a display name.',
      email: 'Enter an email address, like name@example.com.',
      passwordShort: 'Use at least 10 characters.',
      passwordRequired: 'Enter your password.',
    },
    errors: {
      wrongPassword: 'That email and password do not match. Check both and try again.',
      emailTaken: 'This email already has an account.',
      emailTakenAction: 'Sign in instead',
      passwordLong: 'Use at most 128 characters.',
      rateLimited: 'Too many tries. You can try 10 times in 15 minutes. Wait a little, then try again.',
      offline: 'No connection. Check your internet and try again.',
      server: 'Something went wrong on our side. Try again in a moment.',
      generic: 'We could not finish that. Try again.',
    },
    start: {
      title: 'Start training',
      body: 'No account needed. Your progress stays with you on this phone.',
      button: 'Start training',
      busy: 'Starting…',
      error: 'Could not start. Check your connection and try again.',
      coach: 'Are you a coach, or want to add a drill?',
    },
  },
} satisfies MessageBundle;

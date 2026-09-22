# Как помочь проекту · Contributing

Спасибо, что хотите помочь! «Первый тренер» — открытый проект: каждый тренер, учитель физкультуры, спортсмен
или разработчик может сделать его лучше. *English version below.*

## Чем можно помочь

| Вы… | Что сделать |
|---|---|
| **Тренер или учитель физкультуры** | Добавьте своё упражнение через приложение (кнопка «Тренерам») — оно придёт на work@koz-ai.com. Или проверьте существующие упражнения и напишите, что поправить. |
| **Знаете казахский** | Вычитайте тексты интерфейса ([`lite/js/i18n.js`](lite/js/i18n.js), блок `kk`) и упражнений. Нам очень нужна проверка носителем языка. |
| **Разработчик** | Возьмите задачу из [Issues](../../issues), улучшите анимации, доступность или скорость на слабых телефонах. |
| **Родитель** | Попробуйте приложение с ребёнком и расскажите, что было непонятно. |

## Упражнения

Каждое упражнение живёт в [`config/commons/football/drills`](config/commons/football/drills) и описано одинаково:

| Поле | Что это |
|---|---|
| `slug` | Уникальный идентификатор: `навык-название`, латиницей через дефис |
| `title`, `goal`, `instructions` | Название, зачем это упражнение, шаги (`1. …\n2. …`) — на `kk`, `ru`, `en` |
| `mistakes`, `safety` | Частые ошибки и советы по безопасности — списки на трёх языках |
| `dose` | `reps`, `sets` или `durationSec` |
| `minutes`, `level` | Длительность и уровень 1–3 |
| `ageMin`, `ageMax` | Возраст |
| `equipment` | `nothing`, `ball`, `ball_wall` или `cones` |
| `space` | `home_3x3`, `yard` или `field` |
| `partner` | Нужен ли партнёр |
| `progressionSlugs`, `regressionSlugs` | Упражнения посложнее и попроще |
| `author`, `source`, `license` | Автор, источник, `CC-BY-SA-4.0` |

**Правила для текстов упражнений**

- Пишем для ребёнка, который тренируется один: на «ты», короткими фразами, одно действие в шаге.
- Безопасность — обязательна: где тренироваться, что убрать вокруг, когда остановиться.
- Никаких обещаний «станешь профессионалом» и сравнений детей между собой.
- Только своё: не копируйте упражнения и видео FIFA, UEFA, коммерческих приложений и книг.
- Если текст подготовлен с помощью ИИ, так и отметьте: такое упражнение остаётся черновиком, пока его не проверит тренер.

После изменения упражнений пересоберите данные приложения и проверьте его:

```bash
python3 lite/build_data.py
cd lite && python3 -m http.server 8080
```

Анимация упражнения задаётся в [`lite/js/anim.js`](lite/js/anim.js) (объект `SCENES`). Если своей сцены нет,
показывается общая анимация навыка.

## Код

- **`lite/`** — чистые HTML/CSS/JS без сборки. Держим его маленьким и быстрым: никаких тяжёлых библиотек,
  проверяем на ширине 375 px и на недорогом Android. Любой новый текст — сразу на трёх языках.
  После изменения файлов увеличьте `?v=` в `lite/index.html` и `CACHE` в `lite/sw.js`.
- **`apps/`** — Bun, Hono, React. Перед pull request: `bun run typecheck` и `bun test`.
- Сообщения коммитов — в стиле [Conventional Commits](https://www.conventionalcommits.org/): `feat(lite): …`, `fix(api): …`, `docs: …`.
- Один pull request — одна задача. Опишите, что изменилось и как вы это проверили; для интерфейса приложите скриншот с телефона.

## Безопасность детей

Мы не собираем данные детей: без почты, паролей, фамилий, публичных профилей, чатов и рекламы. Не добавляйте
аналитику, трекеры и сторонние скрипты, которые что-то отправляют с устройства ребёнка. О проблемах с безопасностью
пишите приватно — см. [SECURITY.md](SECURITY.md).

Участвуя в проекте, вы соглашаетесь с [Кодексом поведения](CODE_OF_CONDUCT.md).
Код публикуется по лицензии MIT, упражнения и методики — по CC BY-SA 4.0.

---

## English

Thank you for helping! Ways to contribute:

- **Coaches and PE teachers**: share a drill from the app (*For coaches* → *Send by email* to work@koz-ai.com),
  or review existing drills and tell us what to fix.
- **Kazakh speakers**: proofread the interface copy (`lite/js/i18n.js`, `kk`) and the drills. A native-speaker review is our biggest gap.
- **Developers**: pick an [issue](../../issues), improve the animations, accessibility or speed on low-end phones.

Drills live in `config/commons/football/drills` (fields are listed in the table above). Write for a child training alone,
keep safety notes mandatory, never copy FIFA, UEFA or commercial material, and mark AI-drafted text as a draft until a coach reviews it.
Rebuild the app data with `python3 lite/build_data.py`.

Code: `lite/` is dependency-free HTML/CSS/JS — keep it small, test at 375 px, add every new string in kk, ru and en,
and bump `?v=` in `lite/index.html` and `CACHE` in `lite/sw.js`. `apps/` uses Bun: run `bun run typecheck` and `bun test`.
Use Conventional Commits and keep one topic per pull request.

We do not collect children's data. Do not add analytics, trackers or third-party scripts. Report security or safety
problems privately (see [SECURITY.md](SECURITY.md)). By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Software is MIT; drills and methodology are CC BY-SA 4.0.

# Безопасность · Security

## Как сообщить о проблеме

Если вы нашли уязвимость или что-то, что может навредить ребёнку (опасный совет в упражнении, утечку данных,
способ обойти защиту), **не создавайте публичный issue**. Напишите на **work@koz-ai.com** с темой
«Безопасность» и опишите, что нашли и как это повторить. Мы ответим как можно скорее.

Опасные для здоровья советы в упражнениях считаются проблемой безопасности наравне с уязвимостями в коде.

## Что важно знать

- Приложение (`lite/`) хранит профили, прогресс и результаты тестов только в браузере (`localStorage`) и не отправляет
  данные игрока на сервер. ПИН-код профиля защищает от случайного входа брата или сестры, но не является защитой аккаунта.
- Видео для самопроверки не загружается.
- Полная платформа (`apps/`) хранит данные на сервере; порядок работы с ними описан в [docs/runbook.md](docs/runbook.md).

---

## English

If you find a vulnerability or anything that could harm a child (an unsafe instruction in a drill, a data leak,
a way around a safeguard), **do not open a public issue**. Email **work@koz-ai.com** with the subject "Security",
describe what you found and how to reproduce it. We will reply as soon as we can. Unsafe advice in a drill is treated
as a security issue.

The app in `lite/` keeps profiles, progress and test results in the browser only and never sends a player's data to a server;
the profile PIN keeps siblings out and is not account security. Self-check videos are never uploaded.
The full platform in `apps/` stores data on a server — see [docs/runbook.md](docs/runbook.md).

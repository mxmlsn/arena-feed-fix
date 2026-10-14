# arena-feed-fix

A Chrome extension that cleans up the Are.na following feed (`are.na/` and `are.na/feed`):

- hides your own saves, keeps only people you follow
- removes repeated blocks (one block connected to several channels shows once)
- no author/time headers: one continuous Explore-style grid with full rows
- bottom-left pill: scroll 10 / 20 rows (click again to queue), jump back to the furthest point you reached (remembered across reloads); right-click for options
- in the Connect popup (all pages), hides your own name next to your channels (set your name in `myNames` in `connect.js`)

Install: download/clone this repo, open `chrome://extensions`, enable Developer mode, click "Load unpacked", pick the folder, reload Are.na.

Unofficial, not affiliated with Are.na. It only rewrites data in your own browser.

---

Заметки (RU)

На https://www.are.na/ и /feed: только блоки от тех, на кого ты подписан, без твоих, без повторов (остаётся самый верхний), без шапок с авторами, сплошной сеткой как на Explore. Другие страницы не трогает. Масштаб обычный.

## Установка / обновление
`chrome://extensions`, Developer mode, Load unpacked (или круглая стрелка у расширения), потом обнови вкладку.
Старые файлы лежат в `old/` (не в репо).

## Как устроено
Сетку и карточки рисует сам сайт. `inject.js` перехватывает ответ запроса `FeedMeQuery` и меняет данные:
1. выкидывает твои группы;
2. выкидывает блоки, которые уже были выше;
3. все оставшиеся блоки страницы кладёт в первую чужую группу страницы (её поля не трогаются, меняется только список блоков), остальные группы убирает. Сайт рисует одну сетку.
Если страница после чистки пустая, сразу подтягивается следующая (до `maxSkipPages`), чтобы сайт не решил, что лента кончилась.
Число блоков в каждой группе кратно числу колонок (остаток переносится на следующую подгрузку), поэтому все ряды полные. Колонки считаются как на Explore (минимум 260px, зазор 15px) от ширины окна; чтобы зафиксировать, поставь `columns: 4` в `CFG`.
Шапку этой группы (ссылка на автора над сеткой) скрипт прячет вместе со временем, отступом и разделителем.

## Если сломается
`CFG` в начале `inject.js`. Логи в консоли с префиксом `[arena-feed-clean]`.
- Ничего не меняется: в DevTools → Network найди запрос ленты к `graphql`, его `operationName` впиши в `CFG.operation`.
- Видны шапки: смотри предупреждение «не нашёл шапку» в консоли, логика в `fixHeaders()`.

## Кнопки слева внизу (только / и /feed)
↓ на 10 рядов, ↓↓ на 20 рядов, булавка: к запомненному месту (самый дальний блок, до которого долистал; ищет по id, до 60 подгрузок; ещё раз = отмена).
Правый клик по кнопкам: Pin current position, Auto-save on/off, Reset memory. Ручная метка (Pin current position) одноразовая: после успешного перехода к ней снова включается автозапоминание с этого места; если блок не найден или поиск отменён, метка остаётся. Кольцо на кнопке показывает прогресс. Повторные клики по стрелкам ставят ещё циклы в очередь (точки в кнопке); правый клик по работающей стрелке или клик по булавке очищает очередь.

## Окно Connect
`connect.js` на всех страницах прячет твоё имя и кружок справа у каналов в окне Connect (окно ищется по полю «Type to search»). Имя в `myNames` в начале `connect.js`.

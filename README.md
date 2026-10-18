# MemePulse

Радар мемов, новостей и трендов в реальном времени для поиска идей под мем-коины (pump.fun).

## Запуск
    node server.js          # нужен Node 18+, зависимостей нет
    # открыть http://localhost:3000

`node server.js --selftest` показывает, как скоринг оценивает тестовые посты.

## Источники (работают без ключей)
Reddit (rising), Hacker News, Google Trends, pump.fun-токены через GeckoTerminal, новые профили токенов DexScreener.
Проверка «есть ли уже монета с таким тикером» идёт через DexScreener.

## TikTok и X (нужны платные ключи, у них нет бесплатного открытого API)
    X_BEARER=...  node server.js                       # X API, recent search
    APIFY_TOKEN=... APIFY_TIKTOK_ACTOR=user~actor APIFY_INPUT='{...}' node server.js   # TikTok через Apify
Поля актора TikTok сопоставляются в функции srcTikTok (server.js), под выбранный актор их, возможно, придётся поправить.

## Запуск онлайн
Нужен постоянно работающий сервер: Render, Railway, Fly.io или VPS. Статический хостинг не подойдёт, потому что лента строится на сервере.

## Настройки
PORT, SUBREDDITS (через запятую), TRENDS_GEO (по умолчанию US), X_QUERY.

Радар внимания, не финансовый совет.

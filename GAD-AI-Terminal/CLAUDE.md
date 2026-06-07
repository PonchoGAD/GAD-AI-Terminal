# GAD AI Terminal — CLAUDE.md

## Что это за проект

**GAD AI Terminal** — Solana memecoin-аналитика + торговая платформа с реальным временем.
Монорепозиторий (npm workspaces), 8 микросервисов, 17 shared-либ, PostgreSQL + Redis, Docker Compose.
Деплой: VPS Hetzner, Docker Compose, домен `gadai.shop`.

---

## Архитектура

```
services/
  api           — Express REST (port 4000): токены, подписки, tg-user linking
  scanner       — Сканер токенов с pump.fun / GMGN / Axiom / Helius каждые 30с
  telegram      — Telegram-бот (node-telegram-bot-api, polling)
  autobuy       — Авто-покупка через Jupiter DEX (jobs в БД)
  whale-tracker — Мониторинг крупных кошельков через Helius
  social-monitor— Мониторинг KOL/Twitter сигналов
  dashboard     — Next.js 14 фронтенд (port 3000)
  landing       — Next.js 16 лендинг + форма оплаты (port 3001) → gadai.shop

libs/
  db            — pg pool, query(), transaction()
  solana        — RPC, Helius, token metadata
  autobuy       — Jupiter swap: loadKeypair, executeSwap
  scoring       — AI-скор (6 факторов, веса 25/20/15/15/15/10)
  risk          — Риск-скор (5 факторов)
  rug           — Rug-pull вероятность (9 флагов)
  gad-score     — Единый рейтинг 0-100 (LEGENDARY/STRONG/GOOD/…)
  narrative     — Определение нарратива по regex (AI_AGENT, DOG, PEPE…)
  social        — Hype-скор из mention velocity + sentiment
  survival      — Вероятность выживания токена (1h/6h/24h/7d)
  dna           — Классификация кошелька (SNIPER/WHALE/INSIDER…)
  alerts        — Rule-based alert engine
  lifecycle     — Стадии токена: BIRTH→ACCUMULATION→BREAKOUT→HYPE→DISTRIBUTION→DEATH
  opportunity   — Нахождение токенов до движения (pre-breakout alpha)
  memory        — Сравнение нового токена с историческими 100x (cosine similarity)
  regime        — Детекция рыночного режима: BULL/BEAR/SIDEWAYS/EUPHORIA/PANIC
  reputation    — Классификация кошельков: LEGEND/SMART/AVERAGE/TOURIST/EXIT_LIQUIDITY
```

**БД:** 10 миграций → ~20 таблиц:
`tokens`, `token_metrics`, `subscriptions`, `subscription_plans`, `telegram_users`,
`autobuy_jobs`, `autosell_stages`, `whale_scores`, `score_history`, `alerts`

---

## Тарифные планы (АКТУАЛЬНО — июнь 2026)

| slug | Цена | Срок | Описание |
|---|---|---|---|
| `trial_1d` | **0.05 SOL** | 24 часа | Полный доступ, одноразовый на кошелёк |
| `trial_3d` | **0.1 SOL** | 72 часа | Полный доступ + Alpha Engine |
| `monthly` | **1.0 SOL** | 30 дней | Всё включено + Auto-buy |

---

## Telegram

| | |
|---|---|
| Бот | [@gadai_sol_bot](https://t.me/gadai_sol_bot) |
| Основной канал | [@gadfamilytg](https://t.me/gadfamilytg) |
| Сайт | [gadai.shop](https://gadai.shop) |
| Страница оплаты | [gadai.shop/pay](https://gadai.shop/pay) |

---

## Что СДЕЛАНО (готово и в продакшне)

- [x] Полная схема БД (10 SQL-миграций)
- [x] Все 17 shared-либ (scoring, risk, rug, narrative, social, survival, dna, gad-score, lifecycle, opportunity, memory, regime, reputation)
- [x] API сервер: токены, watchlist, alerts, portfolio, subscription, tg-user linking
- [x] Subscription routes: 3 плана (0.05/0.1/1.0 SOL), on-chain верификация tx, FREE_WALLETS bypass
- [x] Telegram-бот: все команды + Alpha Engine команды (/opportunity, /lifecycle, /regime, /reputation, /memory)
- [x] Scanner: circuit breaker (403/429/530 → disable 10min), collectors: GeckoTerminal, DexScreener, Helius (primary) + pump.fun, GMGN, Axiom (optional)
- [x] Autobuy: Jupiter swap, staged auto-sell (4x/7x/11x/16x/21x/31x), error handling
- [x] Whale tracker: Helius мониторинг, smart money классификация
- [x] Dashboard: все страницы (trending, new, highscore, highrisk, smartmoney, portfolio…)
- [x] Landing: мультилокаль (en/ru), pricing, payment form, API proxy (`/api/proxy`)
- [x] Docker Compose: все сервисы + postgres + redis + `restart: unless-stopped`
- [x] `/pay` роут исправлен (middleware больше не редиректит на `/en/pay`)
- [x] Proxy API route в лендинге (`app/api/proxy/[...path]/route.ts`) — браузер не ломится на localhost:4000
- [x] `SITE_URL=https://gadai.shop` в боте и env
- [x] Dashboard Dockerfile исправлен (context: services/dashboard → `COPY . .`)
- [x] social-monitor Dockerfile исправлен (workspace name)
- [x] Scanner tsconfig: пути для lifecycle/opportunity/memory/regime → `.ts` исходники

---

## Что НЕ СДЕЛАНО / требует доработки

### КРИТИЧНО
- [ ] **Metadata enrichment** — tokens.symbol/name остаются NULL (нужен fallback на DexScreener/GeckoTerminal/Helius в enrichment layer)
- [ ] **E2E тест payment flow** — нет автотеста on-chain верификации
- [ ] **Health checks** для scanner, telegram, autobuy, whale-tracker
- [ ] **Деплой-скрипт / Makefile** — нет единой точки запуска

### ВАЖНО
- [ ] **Unit-тесты** для rug, gad-score, narrative, survival, dna, social, lifecycle, regime
- [ ] **Rate limit на API** (express-rate-limit)
- [ ] **Zod-валидация** на POST endpoints
- [ ] **Структурированные логи** (pino/winston)
- [ ] **Redis кеширование** (trending/new на 30с, tg/status на 60с)
- [ ] **Dashboard WebSocket** — нет real-time обновлений
- [ ] **alpha.commands.ts SITE_URL** — ещё gadai.com в одном месте (нужен rebuild telegram)

---

## Как деплоить на сервер (VPS Hetzner)

```bash
# На сервере (/opt/gad-ai-terminal)
git pull origin main

# Применить новые миграции
docker compose exec -T postgres psql -U gad -d gad_ai < migrations/009_metadata_enrich.sql
docker compose exec -T postgres psql -U gad -d gad_ai < migrations/010_new_plans.sql

# Пересобрать и поднять
docker compose build --no-cache
docker compose up -d

# Проверить статус
docker compose ps
docker compose logs landing --tail=20
docker compose logs telegram --tail=20
```

---

## Важные фиксы (история для памяти)

### /pay → 404 (исправлено)
**Причина:** `middleware.ts` редиректил `/pay` → `/en/pay`, но `app/[locale]/pay/page.tsx` не существует.
**Фикс:** добавлено исключение `if (pathname.startsWith('/pay')) return;` в middleware.

### Dashboard Dockerfile (исправлено)
**Причина:** `docker-compose.yml` использует `context: services/dashboard`, но Dockerfile содержал пути вида `COPY services/dashboard/pages` (root-context пути).
**Фикс:** переписан на `COPY . .`, добавлен `.dockerignore`, добавлены `next`/`react`/`react-dom` в package.json.

### API proxy в landing (исправлено)
**Причина:** `pay/page.tsx` использовал `NEXT_PUBLIC_API_URL || 'http://localhost:4000'` — из браузера недоступно.
**Фикс:** создан `app/api/proxy/[...path]/route.ts`, pay page теперь использует `/api/proxy`.

### Scanner circuit breaker (добавлено)
После 3 ошибок 403/429/530 источник выключается на 10 минут. GeckoTerminal/DexScreener/Helius — основные (всегда). pump.fun/axiom — опциональные. GMGN — только при наличии `GMGN_API_KEY`.

### Новые тарифы (изменено)
Было: `trial_1d = 0.1 SOL`, `monthly = 1.0 SOL`.
Стало: `trial_1d = 0.05 SOL`, `trial_3d = 0.1 SOL`, `monthly = 1.0 SOL`.

---

## Env-переменные (критичные для prod)

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather |
| `HELIUS_API_KEY` | Helius RPC + webhooks |
| `TREASURY_WALLET_ADDRESS` | Кошелёк куда идут SOL-платежи |
| `WALLET_PRIVATE_KEY` | Приватный ключ для autobuy (JSON array) |
| `FREE_WALLETS` | Comma-separated список бесплатных кошельков (whitelist) |
| `SITE_URL` | `https://gadai.shop` — URL сайта для ссылок в боте |
| `SOLANA_RPC` | Платный RPC в prod (QuickNode/Alchemy/Helius) |
| `BACKEND_API_URL` | `http://api:4000` — для proxy в landing (docker service name) |
| `GMGN_API_KEY` | Опционально — без него GMGN коллектор отключён |
| `NEXT_PUBLIC_TREASURY_WALLET` | Адрес treasury для фронта (fallback если API недоступен) |

---

## Команды разработки

```bash
# Запуск всего стека
docker compose up -d

# Только базовые сервисы (БД + Redis)
docker compose up -d postgres redis

# Запуск API в dev-режиме
npm --workspace services/api run dev

# Запуск бота
npm --workspace services/telegram run dev

# Все тесты
npm test
```

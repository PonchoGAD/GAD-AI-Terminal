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
| `monthly` | **1.0 SOL** | 30 дней | Всё включено (без авто-покупки) |
| `autobuy_pro` | **5.0 SOL** | 30 дней | Всё включено + авто-покупка (ПЛАНИРУЕТСЯ) |

> Автопокупка планируется как отдельная премиум-функция: 5 SOL за 30 дней включает все функции + бот торгует автоматически.

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
- [x] Telegram-бот: все команды + Alpha Engine (/opportunity, /lifecycle, /regime, /reputation, /memory)
- [x] Trade Journal: `/journal` (история сделок + P&L) + `/riskpassport` (персональный риск-профиль) + CSV экспорт → `GET /journal`, `GET /riskpassport`
- [x] TokenScore: `/tokenscore <mint>` — прозрачность токена 0-100 (rug safety 40 + liquidity 25 + community 20 + transparency 15) → `GET /tokenscore/:mint`
- [x] HonestLauncher: `/launch` в боте — информация + ссылка на Dashboard launcher
- [x] Birdeye holder check: `checkHolderMomentum()` в `auto-signal.ts` перед покупкой — фильтр <50 holders (env: `BIRDEYE_MIN_HOLDERS`, `BIRDEYE_API_KEY`)
- [x] Scanner: circuit breaker (403/429/530 → disable 10min), collectors: GeckoTerminal, DexScreener, Helius (primary) + pump.fun, GMGN, Axiom (optional)
- [x] Autobuy: Jupiter swap + PumpPortal fallback, staged auto-sell (1.3x/2x/5x/10x/20x), error handling
- [x] PumpPortal Local TX API: `services/autobuy/src/pumpportal.ts` — fallback для токенов где Jupiter не может продать (pump.fun, pumpswap, fluxbeam, meteoradbc)
- [x] Two-track auto-signal: Jupiter ($20k liq, Raydium/Orca) + PumpPortal ($3k liq, pump.fun/pumpswap)
- [x] Intelligence.ts Math.round() fix: все поля opportunities table — INTEGER, вещественные числа вызывали `invalid input syntax for type integer` → Math.round() на всех 8 полях (lines 385-390)
- [x] Landing Helius RPC: NEXT_PUBLIC_SOLANA_RPC запекается через Docker ARG при сборке → платёж больше не даёт 403
- [x] Whale tracker: Helius мониторинг, smart money классификация
- [x] Dashboard: все страницы (trending, new, highscore, highrisk, smartmoney, portfolio…)
- [x] Landing: мультилокаль (en/ru), pricing, payment form, API proxy (`/api/proxy`)
- [x] Landing новые страницы (Sprint 14): `/trade-journal`, `/token-score`, `/launcher` + секция "NEW IN JUNE 2026" на главной
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

> **ВАЖНО:** Локальный git имеет два remote:
> - `gad` → `https://github.com/PonchoGAD/GAD-AI-Terminal.git` — **VPS тянет отсюда**
> - `origin` → `https://github.com/PonchoGAD/SaaS-Landing-Demo.git` — лендинг, VPS не использует
>
> Всегда пушить через: `git push gad main` (не `git push origin main`)

```bash
# На локальной машине — пушить в правильный remote:
git push gad main

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
Планируется: `autobuy_pro = 5.0 SOL` — авто-покупка как отдельная функция.

### Оплата 403 (исправлено — июнь 2026)
**Причина:** `SOLANA_RPC=https://api.mainnet-beta.solana.com` — публичный RPC блокирует VPS/браузер.
**Фикс:**
1. В `.env`: `SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=...`
2. В `docker-compose.yml`: `build.args.NEXT_PUBLIC_SOLANA_RPC` для landing service
3. В `services/landing/Dockerfile`: добавлены `ARG NEXT_PUBLIC_SOLANA_RPC` + `ENV NEXT_PUBLIC_SOLANA_RPC=$NEXT_PUBLIC_SOLANA_RPC`
4. Rebuild landing: URL запекается в статических чанках Next.js на этапе сборки

### STOP_LOSS_UNSELLABLE / TIME_LIMIT_UNSELLABLE (исправлено — июнь 2026)
**Причина:** Jupiter не может продавать pump.fun/pumpswap/fluxbeam/meteoradbc токены — нет маршрута.
Бот пытался 3 раза → сдавался → позиция теряется (активная но с 0 sold).
**Фикс:** PumpPortal Local TX API как fallback в `claimAndSell()`:
```typescript
// В scheduler.ts после провала Jupiter:
const ppResult = await sellViaPumpPortal(mint, sellPct, keypair, connection);
```
PumpPortal с `pool:"auto"` находит маршрут для любого DEX автоматически.
**Важно:** PumpPortal Local TX использует наш основной кошелёк (EL4m...) — отдельного фондирования не нужно.

### GMGN API (не работает с VPS)
GMGN защищён Cloudflare и блокирует VPS IP. Нет обходного пути без браузера/cookies.
API ключ `gmgn_78449f8f01b1775fdd1a0d149a91c406` с режимом "Trading Disabled" — сканирование тоже недоступно.
Коллектор включён в сборку, но всегда получает Cloudflare challenge (HTML вместо JSON).
**Решение для фиксаа:** Residential proxy (BrightData/Smartproxy ~$15/мес) или Puppeteer headless Chrome на VPS.

### Автобай два трека (добавлено — июнь 2026)
**Jupiter track:** Raydium/Orca/Meteora, $20k+ лик, 30+ мин, позиция 0.02 SOL
**PumpPortal track:** pumpfun/pumpswap/meteoradbc/fluxbeam, $3k+ лик, 20+ мин, позиция 0.02 SOL
Метка задания: `auto:new_high_score:score80:pumpportal` — шедулер видит суффикс и использует PumpPortal для покупки.

### processAutoSignals ОТКЛЮЧЁН (июнь 2026)
**Причина:** Score-80 pump.fun токены через `processAutoSignals()` давали 100% rate потерь.
Все позиции по этой стратегии закончились с total_sold_sol=0 (STOP_LOSS_UNSELLABLE, TIME_LIMIT_UNSELLABLE, silent fail).
Jupiter не может продавать pump.fun токены, PumpPortal иногда тоже.
**Фикс:** `processAutoSignals()` закомментирован в `startAutobuyScheduler()`. Только `processRaydiumOpportunities()` активен.
**НЕ ВКЛЮЧАТЬ** пока не будет надёжного механизма продажи pump.fun токенов.

### isJupiterOnly флаг в claimAndSell (июнь 2026)
**Причина:** Raydium токены при TIME_LIMIT_EXPIRED/STOP_LOSS падали в PumpPortal fallback → транзакция проходила но возвращала 0 SOL (неправильный DEX).
**Фикс:** `claimAndSell()` принимает `isJupiterOnly = !label.includes(':pumpportal')`. Raydium токены (auto:raydium_scan:*) имеют `isJupiterOnly=true` → PumpPortal fallback заблокирован.

### Raydium Scanner параметры (июнь 2026)
Лучшая стратегия: покупать fresh токены ДО памп.
- Для токенов < 6h: min 1h price change = 1%, max = 30%
- Для токенов ≥ 6h: min 1h price change = 5%, max = 150%
- Vol/liq ratio >= 15% (не застойный пул)
- Vol1h >= 8% от Vol24h (ускорение торговли)
- Max лик $300k (не large-cap, быстро двигается)
- Max возраст пары 48h

### Trading параметры (июнь 2026 — текущие)
- STOP_LOSS: 8% (было 12-15%)
- TRAIL_PCT: 15% (было 20%)
- TIME_LIMIT_SECONDS: 1800 (30min — без изменений)
- TIME_LIMIT_ACTIVITY_PCT: 3% (было 0.5% — слишком часто сбрасывал таймер)
- AUTOSELL_SLIPPAGE_BPS: 500 (было 150)
- AUTOSELL_SLIPPAGE_RETRY_BPS: 1000

### BXUSDT (CXkZuuconEnzL56dVhXW66Qks9DrrunyACUQYFN9YRqo) — мёртвая позиция
Бот купил 0.02 SOL на fluxbeam. Jupiter не мог продать → STOP_LOSS_UNSELLABLE.
PumpPortal тоже вернул "Bad Request" — fluxbeam не поддерживается PumpPortal Local TX.
DexScreener: $1077 ликвидности но Jupiter quote = 0.000004 SOL (price impact 99.99%).
**Вывод:** невозможно восстановить. Полная потеря 0.02 SOL.

### Env переменные добавлены
```
SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=39e37111-42e1-4e10-a5cd-001a5771cbfc
NEXT_PUBLIC_SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=39e37111-42e1-4e10-a5cd-001a5771cbfc
PUMP_PORTAL_ENABLED=true
PUMP_MIN_LIQUIDITY_USD=3000
PUMP_MIN_TOKEN_AGE_SEC=1200
```

### Sprint 14 — Trade Journal, RiskPassport, TokenScore, HonestLauncher, Birdeye (июнь 2026)

**Trade Journal** (`GET /journal`, `GET /journal/export`, `/journal` в боте):
- Берёт данные из `autobuy_jobs + autosell_stages` — без новых таблиц
- Показывает P&L на сделку, ROI%, стадию продажи, причину выхода
- CSV экспорт через `GET /journal/export`
- `/riskpassport` — личный профиль: DISCIPLINED/LEARNING/HIGH_RISK, разбивка по тирам T1/T2/T3

**TokenScore** (`GET /tokenscore/:mint`, `/tokenscore <mint>` в боте):
- Скор 0-100: rug safety (40) + liquidity (25) + community (20) + transparency (15)
- Метки: SAFE (85+) / MODERATE (70+) / RISKY (50+) / DANGEROUS (<50)
- Источники: `rug_scores` + `tokens` + `token_metrics` — без внешних API

**HonestLauncher** (`/launch` в боте):
- Команда информирует о принципах честного запуска + ссылка на Dashboard
- Принципы: бюджет = только ликвидность, без накрутки volume, без insider allocation
- Управление через `/mycoins` и `/exitcoin`

**Birdeye holder check** (`services/autobuy/src/auto-signal.ts`):
- `checkHolderMomentum(mint)` — проверяет `holder` из Birdeye API
- Пропускает токены с <50 holders (конфигурируется через `BIRDEYE_MIN_HOLDERS`)
- Fail-open: если `BIRDEYE_API_KEY` не задан или API недоступен → не блокирует

**Landing новые страницы:**
- `/trade-journal` — описание журнала сделок
- `/token-score` — описание TokenScore
- `/launcher` — описание Honest Launcher
- Главная: секция "NEW IN JUNE 2026" с карточками-ссылками на все три страницы

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
| `BIRDEYE_API_KEY` | Опционально — holder check перед покупкой (Birdeye public API) |
| `BIRDEYE_MIN_HOLDERS` | Минимум holders перед покупкой (default: 50, fail-open если API недоступен) |

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

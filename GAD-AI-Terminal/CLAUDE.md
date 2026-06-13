# GAD AI Terminal — CLAUDE.md
> Этот файл — главная память проекта. Claude читает его автоматически при каждом запуске.
> Обновляй его после каждого важного изменения.

---

## Что это за проект

**GAD AI Terminal** — Solana memecoin-аналитика + торговая платформа с реальным временем.
Монорепозиторий (npm workspaces), 8 микросервисов, 18 shared-либ, PostgreSQL + Redis, Docker Compose.
Деплой: VPS Hetzner (`root@65.21.159.255`), SSH key `~/.ssh/gad_deploy`, домен `gadai.shop`.

---

## SSH доступ к VPS

```bash
# Ключ находится локально:
ssh -i ~/.ssh/gad_deploy root@65.21.159.255

# Проект на сервере:
cd /opt/gad-ai-terminal/GAD-AI-Terminal

# Git remote на VPS (тянет отсюда):
# origin → https://github.com/PonchoGAD/GAD-AI-Terminal.git
```

> **Локальный git remotes:**
> - `gad` → `https://github.com/PonchoGAD/GAD-AI-Terminal.git` — **VPS тянет отсюда**
> - `origin` → `https://github.com/PonchoGAD/SaaS-Landing-Demo.git` — лендинг, VPS не использует
>
> Всегда пушить через: `git push gad main` (не `git push origin main`)

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
  trend-engine  — GDELT + Google News → кластеризация → AI генерация meme coin идей
```

**БД:** 11 миграций → ~23 таблицы:
`tokens`, `token_metrics`, `subscriptions`, `subscription_plans`, `telegram_users`,
`autobuy_jobs`, `autosell_stages`, `whale_scores`, `score_history`, `alerts`,
`trend_items`, `trend_clusters`, `coin_ideas`

---

## Соглашения по коду

```typescript
// Все модули возвращают единообразно:
{ ok: boolean; data?: T; error?: string }

// Async/await везде — никаких callbacks
// Логировать с префиксом сервиса:
console.info('[autobuy] ...')
console.debug('[raydium-scan] ...')
console.warn('[sell] ...')

// Env переменные: Number(process.env.X || 'default')
// Никогда не хардкодить адреса кошельков или ключи

// Entry price ВСЕГДА в SOL/readable-token (не SOL/base-unit)
// DexScreener priceNative = SOL/readable-token → эта же единица
// tokenAmount.uiAmount (из getParsedTokenAccountsByOwner) — human-readable
```

---

## Тарифные планы (АКТУАЛЬНО — июнь 2026)

| slug | Цена | Срок | Описание |
|---|---|---|---|
| `trial_1d` | **0.05 SOL** | 24 часа | Полный доступ, одноразовый на кошелёк |
| `trial_3d` | **0.1 SOL** | 72 часа | Полный доступ + Alpha Engine |
| `monthly` | **1.0 SOL** | 30 дней | Всё включено (без авто-покупки) |
| `autobuy_pro` | **5.0 SOL** | 30 дней | Всё включено + авто-покупка (ПЛАНИРУЕТСЯ) |

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

- [x] Полная схема БД (11 SQL-миграций)
- [x] Все 18 shared-либ + trend-engine (GDELT + Google News + AI идеи)
- [x] API сервер: токены, watchlist, alerts, portfolio, subscription, tg-user linking
- [x] Subscription routes: 3 плана (0.05/0.1/1.0 SOL), on-chain верификация tx, FREE_WALLETS bypass
- [x] Telegram-бот: все команды + Alpha Engine + Trend Engine (/trends, /ideas, /approve_idea)
- [x] Trade Journal: `/journal` + `/riskpassport` + CSV экспорт
- [x] TokenScore: `/tokenscore <mint>` — скор 0-100
- [x] HonestLauncher: `/launch` в боте
- [x] Birdeye holder check + trending (Source 5)
- [x] Scanner: circuit breaker, collectors: GeckoTerminal, DexScreener, Helius
- [x] Autobuy: Jupiter + PumpPortal fallback, single-shot sell (1.25x/1.35x/1.45x по тиру)
- [x] Fast sell loop: setInterval(1000ms) независимо от 5-секундного poll
- [x] Graduation scanner: WebSocket → PumpPortal — sub-second latency на pump.fun graduates
- [x] **CRITICAL FIX (июнь 2026):** Entry price unit mismatch — был SOL/base-unit, стал SOL/readable-token
- [x] Raydium DexScreener multi-source (5 источников: profiles, boosts, top-boosts, 8 queries, Birdeye)
- [x] Filter calibration из 72h анализа pump.fun winners: min_liq 22k, max B/S ratio 3.5x, vol/liq 8%
- [x] Trend-to-MemeCoin Engine: migration 011, libs/trend-engine, telegram /trends commands
- [x] Landing: мультилокаль (en/ru), pricing, payment form, API proxy
- [x] Docker Compose: все сервисы + postgres + redis + `restart: unless-stopped`
- [x] **Futures Trading Module (июнь 2026):** migration 012, services/futures, port 4003
  - MacroMonitor: BTC/Fear&Greed/SP500/CryptoPanic → composite score 0-100
  - EntryStrategy: EMA21/EMA50/RSI14/Volume on Binance 15m candles
  - DriftTrader: paper mode (default) + live Drift Protocol (FUTURES_LIVE_MODE=true, uses Phantom keypair)
  - CapitalManager: 2% risk/trade, x2 leverage ($5-20), 6% daily stop
  - RiskManager: 3s TP/SL/Trail poll, BE trigger at +3%
  - Telegram: /futures /macro /signal /position /capital /ftrades /fclose

---

## Что НЕ СДЕЛАНО / требует доработки

### КРИТИЧНО
- [ ] **Metadata enrichment** — tokens.symbol/name остаются NULL
- [ ] **ANTHROPIC_API_KEY** в VPS .env — нужен для trend-engine AI генерации идей
- [ ] **Migration 011** применить на VPS: `docker compose exec -T postgres psql -U gad -d gad_ai < migrations/011_trend_engine.sql`
- [ ] **Migration 012** применить на VPS (futures): `docker compose exec -T postgres psql -U gad -d gad_ai < migrations/012_futures.sql` ← уже применена!
- [ ] **Health checks** для scanner, telegram, autobuy, whale-tracker
- [ ] **Futures LIVE MODE:** отключён по умолчанию (FUTURES_LIVE_MODE=false → paper trading). Для real Drift Protocol включить через .env + депозит USDC на Drift аккаунт

### ВАЖНО
- [ ] **Unit-тесты** для rug, gad-score, narrative, survival, dna, social, lifecycle, regime
- [ ] **Rate limit на API** (express-rate-limit)
- [ ] **Redis кеширование** (trending/new на 30с, tg/status на 60с)
- [ ] **Dashboard WebSocket** — нет real-time обновлений
- [ ] **GMGN** недоступен с VPS (Cloudflare) — нужен residential proxy ($15/мес)

---

## Decisions Log (почему так сделано)

### 2026-06 — Entry price: SOL/readable-token, не SOL/base-unit
**Решение:** `entry_price_sol` хранится в SOL per human-readable token (совпадает с DexScreener `priceNative`).
**Почему:** Jupiter возвращает `outAmount` в base units (BigInt). Делить SOL на base-units давало ~10^9× меньшее число чем `priceNative`. TP-цели срабатывали мгновенно (current >> target), бот продавал сразу после покупки, теряя на slippage+fees каждую сделку.
**Фикс:** `tokenAmount.uiAmount` из `getParsedTokenAccountsByOwner` — уже в human-readable единицах.
**Не менять:** entry_price_sol = `amountSol / uiAmount`.

### 2026-06 — Sell targets: single-shot 100%
**Решение:** Один TP target на всю позицию (не 50%+50%).
**Почему:** Мемкоины делают быстрый памп и откатываются. Продавать 50% и удерживать остаток = часто держать пока не упадёт под stop-loss. Single-shot гарантирует фиксацию прибыли на пике.
**Текущие цели:** T1 ($8-80k liq) = 1.25x, T2 ($80-250k) = 1.35x, T3 ($250k+) = 1.45x.

### 2026-06 — processAutoSignals ОТКЛЮЧЁН
**Решение:** Только `processRaydiumOpportunities()` активен. `processAutoSignals()` закомментирован.
**Почему:** Score-80 pump.fun токены давали 100% rate потерь. Jupiter не может продавать pump.fun токены, PumpPortal тоже ненадёжен для этой стратегии.
**Не включать** пока нет надёжного механизма продажи pump.fun токенов.

### 2026-06 — GeckoTerminal убран из autobuy
**Решение:** Autobuy не использует GeckoTerminal. Scanner использует.
**Почему:** Оба сервиса на одном VPS IP → совместные запросы вызывают persistent 429. DexScreener + Birdeye закрывают потребность в discovery.

### 2026-06 — Min liquidity 22k (было 8k)
**Решение:** `RAYDIUM_MIN_LIQUIDITY_USD=22000` по умолчанию.
**Почему:** Анализ 20 pump.fun токенов > $50k mcap за 72ч показал: liq < $20k = dev buy < 0.3 SOL = высокий rug риск. Liq $22k+ = dev вложил ≥ 0.8 SOL (реальный commitment).
**Данные:** Победители (>200% за 24ч) имели avg liq $35.8k при листинге.

### 2026-06 — Max B/S ratio 3.5x (новый фильтр)
**Решение:** `RAYDIUM_MAX_BUY_SELL_RATIO=3.5` — отклонять токены с аномально высоким соотношением.
**Почему:** Gaejuki: B/S 5.82x при цене -76% = pump&dump (накачка объёма, дамп дева). RESERVE: 5.7x (24ч) → 0.58x (1ч) = большой памп уже прошёл. Здоровое накопление = 1.2-1.8x.
**Данные:** Все 10 победителей имели B/S 1.1-1.6x в здоровой фазе.

### 2026-06 — isJupiterOnly флаг в claimAndSell
**Решение:** Raydium токены (`auto:raydium_scan:*`) имеют `isJupiterOnly=true` → PumpPortal fallback заблокирован.
**Почему:** При TIME_LIMIT_EXPIRED Raydium токены падали в PumpPortal → транзакция проходила но 0 SOL возвращалось (неправильный DEX).

---

## Как деплоить на сервер

```bash
# Локально:
git push gad main

# На VPS:
ssh -i ~/.ssh/gad_deploy root@65.21.159.255
cd /opt/gad-ai-terminal/GAD-AI-Terminal
git pull origin main

# Применить новые миграции (если есть):
docker compose exec -T postgres psql -U gad -d gad_ai < migrations/011_trend_engine.sql

# Пересобрать нужные сервисы:
docker compose build autobuy
docker compose up -d autobuy

# Проверить:
docker compose ps
docker logs gad-ai-autobuy --tail=20
```

---

## Текущие параметры бота (VPS .env — июнь 2026)

```bash
AUTO_BUY_ENABLED=true
AUTO_BUY_SOL=0.02               # позиция 0.02 SOL
MAX_AUTO_POSITIONS=10
DAILY_MAX_SOL=1.0               # max 1 SOL в день

# Фильтры Raydium scanner:
RAYDIUM_MIN_LIQUIDITY_USD=22000  # min liq = dev buy ≥ 0.8 SOL
RAYDIUM_MAX_LIQUIDITY_USD=300000
RAYDIUM_MIN_PC1H=1              # 1% momentum за 1ч
RAYDIUM_MAX_PC1H=80
RAYDIUM_MIN_PC5M=1
RAYDIUM_MIN_VOL_LIQ_RATIO=0.08  # 8% hourly vol/liq (код дефолт)
RAYDIUM_MAX_BUY_SELL_RATIO=3.5  # wash trading filter

# Sell параметры:
STOP_LOSS_PCT=8                 # глобальный стоп (per-tier = 5%)
TRAIL_PCT=12
EARLY_TRAIL_PCT=4

# Slippage:
# AUTOSELL_SLIPPAGE_BPS=500
# AUTOSELL_SLIPPAGE_RETRY_BPS=1000

# Birdeye:
BIRDEYE_MIN_HOLDERS=70
BIRDEYE_API_KEY=b027655dffa446308f5073d48653c5d2

# PumpPortal:
PUMP_PORTAL_ENABLED=true
PUMP_MIN_LIQUIDITY_USD=9000
PUMP_MIN_TOKEN_AGE_SEC=1200
```

---

## Профиль winning pump.fun токена (данные из 72ч анализа)

| Метрика | Диапазон |
|---|---|
| Возраст при входе | 15-25ч после листинга |
| Liq при листинге | $25-65k |
| Buy/sell ratio 24ч | 1.2-1.8x |
| Vol/mcap ratio | >2.0x за 24ч |
| Ранняя активность | >60% объёма в первые 18ч |
| Dev buy (оценка) | 0.8-5 SOL |

**Жизненный цикл:**
- 0-5 мин: Dev создаёт + покупает
- 5-20 мин: Снайперы/боты
- 20-30 мин: Листинг на Raydium/pumpswap — **НАШЕ ОКНО**
- 30-120 мин: Основной памп (200-900% у победителей)
- 2-6 ч: Дистрибуция
- 6+ ч: Стабилизация или смерть

---

## Важные фиксы (история для памяти)

### Entry price unit mismatch — КРИТИЧЕСКИЙ БАГ (исправлено — июнь 2026)
**Причина:** `entry_price_sol` = `amountSol / baseUnitTokens` (SOL/base-unit).
DexScreener `priceNative` = SOL/readable-token. Разница = 10^decimals (до 10^9).
Все TP-цели срабатывали мгновенно → бот продавал сразу после покупки → потеря slippage+fees на каждой сделке.
**Фикс:** `entry_price_sol` = `amountSol / uiAmount` где `uiAmount` = `tokenAmount.uiAmount` из `getParsedTokenAccountsByOwner` (human-readable).

### /pay → 404 (исправлено)
`middleware.ts` редиректил `/pay` → `/en/pay` но страница не существовала. Добавлено исключение.

### Dashboard Dockerfile (исправлено)
`docker-compose.yml` использует `context: services/dashboard` → Dockerfile переписан на `COPY . .`.

### API proxy в landing (исправлено)
`pay/page.tsx` обращался к `localhost:4000` из браузера. Создан `app/api/proxy/[...path]/route.ts`.

### GeckoTerminal 429 (исправлено)
Autobuy больше не использует GeckoTerminal — scanner и autobuy делят IP, оба вызывали 429. Autobuy переключён на DexScreener.

### Новые тарифы (изменено)
`trial_1d = 0.05 SOL`, `trial_3d = 0.1 SOL` (было: `trial_1d = 0.1 SOL`).

### STOP_LOSS_UNSELLABLE / TIME_LIMIT_UNSELLABLE (исправлено)
Jupiter не продаёт pump.fun/pumpswap/fluxbeam/meteoradbc. Добавлен PumpPortal fallback в `claimAndSell()`.

### BXUSDT — мёртвая позиция
Fluxbeam не поддерживается ни Jupiter ни PumpPortal. Полная потеря 0.02 SOL. Fluxbeam токены теперь исключены из стратегии.

### GMGN API — недоступен с VPS
Cloudflare блокирует VPS IP. Нет обходного пути без браузера/cookies. Нужен residential proxy ($15/мес).

### Оплата 403 (исправлено)
Публичный RPC блокирует VPS. `SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=...`. `NEXT_PUBLIC_SOLANA_RPC` запекается при Docker build через ARG.

---

## Env-переменные (критичные для prod)

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather |
| `HELIUS_API_KEY` | Helius RPC + webhooks |
| `TREASURY_WALLET_ADDRESS` | Кошелёк куда идут SOL-платежи |
| `WALLET_PRIVATE_KEY` | Приватный ключ для autobuy (JSON array) |
| `FREE_WALLETS` | Comma-separated список бесплатных кошельков (whitelist) |
| `SITE_URL` | `https://gadai.shop` |
| `SOLANA_RPC` | Платный RPC в prod (Helius) |
| `BACKEND_API_URL` | `http://api:4000` — для proxy в landing |
| `BIRDEYE_API_KEY` | Holder check + trending source |
| `ANTHROPIC_API_KEY` | Нужен для trend-engine AI генерации идей |

---

## Команды разработки

```bash
# Запуск всего стека
docker compose up -d

# Только базовые сервисы
docker compose up -d postgres redis

# Dev режим
npm --workspace services/api run dev
npm --workspace services/telegram run dev

# Проверка типов
npx tsc -p services/autobuy/tsconfig.json --noEmit
npx tsc -p services/telegram/tsconfig.json --noEmit

# Анализ pump.fun токенов (запускать на VPS):
npx ts-node -p tsconfig.launch.json scripts/analyze-pumpfun-winners.ts
```

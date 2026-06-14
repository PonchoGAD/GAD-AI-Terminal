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
- [x] **Bonding Scanner MOVERS poller (14.06.2026, обновлено):** DexScreener-based (pump.fun API недоступен с VPS)
  - Стратегия переименована: HOT (15min-4h) → **MOVERS** (90s-8min): ловим на старте движения
  - Wallet W3 (DJ8Tq8vi): DexScreener polling каждые **20с** (было 60с)
  - mcap range: **$500-$6k** (было $3k-$8k) — pre-pump stage
  - Фильтры: buys5m≥5 (было 15), vol5m≥$300 (было $1500), **pc5m 5-30%** (было 2-6%), bsRatio≥1.5
  - Добавлен vol momentum check: vol5m/vol1h ≥ 25% для токенов старше 5min
  - TP levels: [1.5x/60%, 2.5x/30%, 5x/10%] (было [1.25x/30%, 1.7/25%, 2.5/20%, 4/15%, 7/10%])
  - Stop-loss: 10% (было 12%), Trail stop: 15% (было 20%), Time limit: 120s (было 300s)
  - WebSocket теперь ВСЕГДА подключён (даже в HOT-only mode) для real-time продаж
  - DB: накапливает total_sold_sol на КАЖДОЙ продаже (TP + final), не только на 100% продаже
  - Position poll: 10s (было 30s) — быстрее реагирует на цену
  - Label в DB: `auto:bonding:mover:SYMBOL:pool:mcapXsol`
- [x] **3-wallet launch scripts (рабочий паттерн — июнь 2026):**
  - Рабочий подход: **Pinata IPFS** (не pump.fun/pumpportal IPFS!) + **pumpdotfun-sdk** createAndBuy + PumpPortal trade-local для buy
  - PumpPortal `action:'create'` в trade-local **НЕ РАБОТАЕТ** (400 Bad Request). Только SDK!
  - pump.fun `/api/ipfs` возвращает 403 при публичном доступе. Только Pinata!
  - Запуск локально: compile with tsc → `node dist_launch/launch-gadai.js`
    (ts-node не выводит ничего в Git Bash Windows — нужно компилировать вручную)
  - `scripts/launch-gadai.ts` — $GADAI, 3 кошелька, staggered timing
  - `scripts/launch-usmnt.ts` — образец рабочего скрипта (использовался для USMNT)
  - `scripts/launch-elonwon.ts` — образец (ELONWON токен)
  - Компиляция: `npx tsc --target ES2020 --module CommonJS --esModuleInterop true --skipLibCheck true --allowSyntheticDefaultImports true --outDir dist_launch --strict false scripts/launch-gadai.ts`
- [x] **$GADAI токен ЗАПУЩЕН (14.06.2026):**
  - CA: `DfaPx6oj5gHcEbBa8N2JSmdLgdQX4Tq7EcJPbTGya4Yx`
  - pump.fun: https://pump.fun/coin/DfaPx6oj5gHcEbBa8N2JSmdLgdQX4Tq7EcJPbTGya4Yx
  - Create TX: 3DHbJxDSvemThUGCvcH2D7eRc22VdJ8WYNe3t1VYfTRnzvzyDBQR1BoBsup6y1jD5opVQ5VeKTpWvyYb5UFMFHkW
  - Dev buy (W1, 0.15 SOL): jnsXvYdbgTuZLnZ7XjHcGS18KA52KheUAs7zbNDRL1onFREtZj7wX5BvF5REtewZJdCqdDrSVUtMLeqdzBaBanP
  - W2 buy: +12 min (0.08 SOL) | W3 buy: +28 min (0.04 SOL)
  - Логотип: `scripts/gadai_logo.png` (147KB, Pepe в GAD Terminal худи)
  - Image IPFS: https://ipfs.io/ipfs/QmU8g8rbgZo1T2aY8b9ixadJCZH8i1waPXFi71uyNx47fG
  - Metadata: https://gateway.pinata.cloud/ipfs/QmcQ8DxhLD2vaF6T8vviLWdVpxD2DutwLTpGRZTzXB3Xyy
- [x] **Bonding scanner TX fix (14.06.2026):**
  - `sendPumpTx()` — всегда `VersionedTransaction.deserialize(bytes)` — обрабатывает ОБА типа TX (legacy + v0)
  - **НЕ** проверять byte[0] для определения типа — byte[0] = compact-u16 count подписей (всегда 0x01), не version prefix!
  - `skipPreflight: true` для buy и sell
  - HOT filter ужесточён: buys5m≥10, vol5m≥$800, pc5m 1-8%, B/S ratio≥1.5, max mcap $8k, stop 12%, time limit 300s
- [x] **HOT-only mode (14.06.2026):**
  - `BONDING_SCANNER_ENABLED=false` + `BONDING_HOT_ENABLED=true` → запускает только HOT poller без WebSocket
  - W2 (CFmHWpmQ) выключен. W3 (DJ8Tq8vi) = единственный кошелёк HOT поллера
- [x] **Base Network EVM Integration (14.06.2026):** migration 015, libs/base, services/base-scanner, port 4005
  - libs/base: ethers v6, Uniswap V3 + Aerodrome, DexScreener price, Basescan safety
  - base-scanner: token discovery (DexScreener + GeckoTerminal every 30s), position monitor (10s poll)
  - 5 TP levels: 1.3/1.8/2.5/4.0/7.0x, trailing stop 8%, time limit 1h, stop-loss 10%
  - Telegram: /basestatus /basepositions /basetrades /basetokens (PRO/STARTER+)
  - API: /base/* routes proxied from api service to base-scanner:4005
  - Docker: `BASE_AUTO_BUY=false` by default (dry-run) — set to true + add BASE_WALLET_PRIVATE_KEY to activate
- [x] **Market Regime Gating для Raydium autobuy (14.06.2026):**
  - `getFearGreed()` — Fear&Greed API (alternative.me), кеш 30мин
  - `getMarketRegime()` → EXTREME_FEAR/FEAR/NEUTRAL/BULL/EUPHORIA (или overrideMARKET_REGIME=AUTO)
  - **EXTREME_FEAR (F&G < 13):** все новые покупки заморожены — только реальная капитуляция (было: < 25)
  - **FEAR (F&G 13-45):** контрарная зона покупок — мин pc1h 15%, TP снижен (1.18x/1.15x/1.12x)
  - Стратегия: покупать на страхе (buy the fear) — изменено с 14.06.2026 по решению владельца
  - NEUTRAL: 1.30x/1.28x/1.25x; BULL/EUPHORIA: 1.55x/1.45x/1.38x
  - HOT poller: buys5m снижен с 20 до 15 (более мягкий рынок)
  - `.env`: `MARKET_REGIME=AUTO`, `STOP_LOSS_PCT=10`, `BONDING_STOP_PCT=0.12`
- [x] **X (Twitter) Trend Pipeline (14.06.2026):** migration 016, social-monitor/x-trends + coin-hunter
  - `x-trends.ts`: Twitter Bearer API поиск каждые 15мин, определение нарратива (AI_AGENT/DOG/CAT/PEPE/TRUMP/ELON/ANIME/SPORTS/FOOD/MEME)
  - `coin-hunter.ts`: DexScreener поиск монеты под нарратив (liq $15k+, vol24h $30k+, pc5m 1%+, pc1h 5-100%)
  - `monitor.ts`: `runXTrendCycle()` каждые 15мин — находит тренд + монету → Telegram алерт в ADMIN_CHAT_ID
  - Telegram: `/xtrends` (последние 10 сигналов), `/xsignal` (последний с монетой) — PRO
  - DB: `x_trend_signals` таблица с theme/coin_mint/engagement/action
- [x] **Token Launcher на gadai.shop (14.06.2026):** migration 017, /launcher/submit API, Telegram /auto_launch
  - Форма на сайте: submit-to-queue (без Phantom wallet) → VPS API → coin_ideas → TG бот /auto_launch
  - `/auto_launch` в боте: список pending идей, запуск по UUID или ручной ввод, загрузка фото
  - `services/telegram/src/launcher.ts`: Pinata upload + pumpdotfun-sdk + staggered PumpPortal buys
  - API: `POST /launcher/submit` в `services/api/src/launcher.routes.ts`
  - Сайт (`gadai.shop`): Vercel → `PonchoGAD/gadai.git` → `C:\Users\gafit\saas-landing-demo`
  - Деплой сайта: `cd C:\Users\gafit\saas-landing-demo && git push gadai main`
- [x] **EXTREME_FEAR порог снижен до 13 (14.06.2026):** бот покупает при F&G 13-45 (FEAR = contrarian buy zone)

---

## Кошельки (июнь 2026)

| Кошелёк | Адрес | Роль | Баланс |
|---|---|---|---|
| W1 WALLET_PRIVATE_KEY | EL4mS7Xg | Главный/казна/dev launch/Raydium autobuy | ~0.29 SOL (14.06.26) |
| W2 PUMPFUN_WALLET_PRIVATE_KEY | CFmHWpmQ | **ОТКЛЮЧЁН** (WebSocket scanner off) | 0.244 SOL (14.06.26) |
| W3 PUMPFUN_WALLET_PRIVATE_KEY_2 | DJ8Tq8vi | HOT poller (активен) | **0.13 SOL ✅ (14.06.26 — пополнен)** |

> **W3 пополнен (14.06.2026):** DJ8Tq8vi теперь 0.13 SOL — достаточно для HOT trades (BONDING_BUY_SOL=0.015).
> **Адреса:** W1=EL4mS7XgNPWRLca38vHu8JHPhpZcupLKuMipPNJeNwqt | W3=DJ8Tq8viRtMPb3HsK9NwoM2yhVgUdcwuxxePuQ1zPF6e | W2=CFmHWpmQki6dDhV9G82JWCq68x2axTwdnKDQvu7dPTcL

---

## VPS — Что работает 24/7 (все сервисы Docker)

| Сервис | Порт | Статус | Описание |
|---|---|---|---|
| postgres | 5432 | ✅ 24/7 | База данных |
| redis | 6379 | ✅ 24/7 | Кеш |
| api | 4000 | ✅ 24/7 | REST API |
| scanner | — | ✅ 24/7 | DexScreener + GeckoTerminal сканер |
| telegram | — | ✅ 24/7 | Telegram бот @gadai_sol_bot |
| autobuy | — | ✅ 24/7 | Raydium/HOT autobuy + sell |
| whale-tracker | — | ✅ 24/7 | Мониторинг китов |
| social-monitor | — | ✅ 24/7 | KOL Twitter + X тренды (каждые 15мин) |
| dashboard | 3000 | ✅ 24/7 | Next.js фронтенд |
| landing | 3001 | ✅ 24/7 | gadai.shop |
| futures | 4003 | ✅ 24/7 | BTC futures анализ (paper mode) |
| base-scanner | 4005 | ✅ 24/7 | Base Network EVM (dry-run) |

**Только локально (НЕ на VPS):**
- `scripts/launch-*.ts` — запуск токенов на pump.fun (нужен ключ + pumpdotfun-sdk локально)
- `scripts/twitter-post.ts` — постинг в X после запуска (OAuth 2.0 refresh-token хранится локально)
- `scripts/launch-fte.ts` — FTE launch скрипт

**Что нужно для полной 24/7 автоматизации:**
- [ ] Telegram команда `/auto_launch` на VPS — берёт coin_idea из тренд-движка, запускает через pumpdotfun-sdk + PINATA_JWT (уже в .env VPS)
- [ ] Автопостинг в X после запуска — перенести twitter-post.ts логику в social-monitor

---

## Что НЕ СДЕЛАНО / требует доработки

### КРИТИЧНО
- [x] ~~W3 нужна пополнение SOL~~ — DJ8Tq8vi теперь 0.13 SOL ✅ (пополнен 14.06.2026)
- [ ] **Metadata enrichment** — tokens.symbol/name остаются NULL
- [ ] **ANTHROPIC_API_KEY** в VPS .env — нужен для trend-engine AI генерации идей
- [ ] **Migration 011** применить на VPS: `docker compose exec -T postgres psql -U gad -d gad_ai < migrations/011_trend_engine.sql`
- [ ] **Health checks** для scanner, telegram, autobuy, whale-tracker
- [ ] **Futures LIVE MODE:** отключён по умолчанию (FUTURES_LIVE_MODE=false → paper trading). Для real Drift Protocol включить через .env + депозит USDC на Drift аккаунт
- [ ] **PumpSwap graduated token sells** — HOT токены > $8k mcap нужно продавать через Jupiter, не PumpPortal. Сейчас ограничено max $8k в HOT poller.
- [ ] **Периодический pruning Docker cache** — `docker builder prune -af` на VPS раз в 1-2 недели (диск был 100% 14.06.2026, PostgreSQL упал)
- [ ] **Auto-launch на VPS** — токены сейчас запускаются только локально через scripts/. Нужна Telegram /auto_launch команда.

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

### 2026-06 — Bonding HOT poller: pump.fun API → DexScreener + dexPool routing
**Решение:** HOT poller переключён с `frontend-api.pump.fun/coins` на DexScreener поиск (`dexId='pumpfun'|'pumpswap'`).
**Почему:** pump.fun API возвращает Cloudflare 530 с VPS IP. DexScreener доступен. Плюс добавлен `dexPool` в BondingPosition — при продаже используется тот же pool что при покупке.
**Ключевое:** HOT mcap ограничен $3k-$12k. Всё что выше $12k уже graduated к PumpSwap — для таких нужен Jupiter (не реализовано). `buyOnBondingCurve`/`sellOnBondingCurve` принимают `pool: string` — передаётся из `coin.dexPool`.

### 2026-06 — $GADAI 3-wallet launch strategy
**Решение:** Последовательная покупка тремя кошельками с задержкой, разные суммы.
**Почему:** Параллельные покупки одинаковыми суммами выглядят скоординировано → детектируются как wash trading, токен могут заблокировать в трекерах.
**Правило:** W1 (dev) держит 2-4ч minimum; W2 выходит на 5-6x; W3 выходит на 3-4x. Dev sells last = доверие комьюнити.

### 2026-06 — Bonding scanner TX deserialization (финальный фикс — 14.06.2026)
**Проблема:** `sellOnBondingCurve` падал с "Versioned messages must be deserialized with VersionedMessage.deserialize()". Причина: `VersionedTransaction.deserialize()` OK → `sendTransaction()` fail → catch пробовал `Transaction.from(versioned_bytes)` → error. Все sells падали → бот покупал и терял при TIME_LIMIT.
**Первый фикс (неправильный):** Проверка `txBytes[0] >= 0x80` — но byte[0] = compact-u16 count подписей (всегда 0x01), НЕ version prefix. Фикс был неверный.
**Правильный фикс:** `VersionedTransaction.deserialize(bytes)` обрабатывает ОБА типа TX (legacy и v0) нативно. НЕ нужна проверка байтов, НЕ нужен fallback на `Transaction.from()`. `skipPreflight: true`.
**Ключевое правило:** Никогда не делать fallback `Transaction.from()` после `VersionedTransaction.deserialize()`. PumpPortal возвращает только versioned TX.

### 2026-06 — HOT-only mode (14.06.2026)
**Решение:** `BONDING_SCANNER_ENABLED=false` + `BONDING_HOT_ENABLED=true` → запускает только поллер без WebSocket scanner.
**Почему W2 выключен:** WebSocket scanner покупал агрессивно новые токены без ликвидности. Фокус на поллере с фильтрами.
**Важно:** WebSocket теперь ВСЕГДА подключён (`connectBondingWS()` вызывается независимо от wsEnabled) — нужен для real-time продаж позиций по TP/стоп. `wsNewTokenEnabled` флаг управляет subscribeNewToken отдельно от соединения.

### 2026-06 — MOVERS стратегия (14.06.2026, финальная версия)
**Проблема HOT стратегии:** Токены 15min-4h = уже пампанули. DexScreener лаг 30-60с означал покупку после пика.
**Решение — MOVERS:** Ловить токены на СТАРТЕ движения (90с-8min), не после.
**Фильтры MOVERS:**
- Возраст: 90с-8min (ловим начало движения, не хвост)
- mcap: $500-$6k (pre-pump stage, на кривой)
- pc5m: **5-30%** — резкое ценовое движение СЕЙЧАС (не 2-6% "тепловатый")
- buys5m: 5+ (ранний сигнал), vol5m: $300+ (реальные деньги)
- B/S ratio: 1.5+ (покупатели доминируют)
- vol momentum: vol5m/vol1h ≥ 25% для токенов >5min (активность сейчас, не старый объём)
**TP стратегия:**
- 1.5x → продать 60% (lock profit на spike)
- 2.5x → продать 30% (если продолжает расти)
- 5x → продать 10% (moon bag)
- Trail stop 15% от ATH, stop-loss 10%, time limit 120s
**Почему агрессивные TP:** Bonding curve movers делают spike за 60-120 секунд и откатываются.

### 2026-06 — Паттерн запуска токенов на pump.fun (рабочий)
**Решение:** Pinata IPFS для метадаты + `pumpdotfun-sdk.createAndBuy()` для создания + PumpPortal `trade-local action:'buy'` для покупок.
**Почему PumpPortal create не работает:** `POST https://pumpportal.fun/api/trade-local { action: 'create' }` возвращает 400 Bad Request. PumpPortal IPFS `POST https://pumpportal.fun/api/ipfs` возвращает 404. pump.fun IPFS `POST https://pump.fun/api/ipfs` работает для upload но файлы возвращают 403 при публичном доступе → PumpPortal отказывает.
**Рабочий паттерн:** `pinataUploadFile() + pinataUploadJson()` → Pinata URI (публично доступен) → `sdk.createAndBuy(w1, mintKp, {...}, BigInt(0), 500n)` → buy через PumpPortal.
**Пакеты:** `pumpdotfun-sdk` + `@coral-xyz/anchor` установлены в root package.json.
**Запуск локально:** `tsc --skipLibCheck --outDir dist_launch` → `node dist_launch/launch-gadai.js`

### 2026-06 — isJupiterOnly флаг в claimAndSell
**Решение:** Raydium токены (`auto:raydium_scan:*`) имеют `isJupiterOnly=true` → PumpPortal fallback заблокирован.
**Почему:** При TIME_LIMIT_EXPIRED Raydium токены падали в PumpPortal → транзакция проходила но 0 SOL возвращалось (неправильный DEX).

### 2026-06 — EXTREME_FEAR порог снижен с 25 до 13 (14.06.2026)
**Решение:** `getMarketRegime()` теперь возвращает EXTREME_FEAR только при F&G < 13 (было < 25).
**Почему:** F&G=18 → EXTREME_FEAR → все покупки заморожены. Но стратегия владельца: "покупать на страхе" (contrarian). Снижение порога до 13 означает: бот покупает в FEAR-режиме (F&G 13-45) но с жёсткими фильтрами (мин pc1h 15%, сниженные TP). EXTREME_FEAR = только реальная капитуляция/чёрный лебедь (< 13), не обычный коррекционный страх.
**Не менять** порог назад без явного решения владельца.

### 2026-06 — gadai.shop — Vercel, не VPS (14.06.2026)
**Факт:** `gadai.shop` хостится на Vercel, подключён к `https://github.com/PonchoGAD/gadai.git`.
**Локальная папка:** `C:\Users\gafit\saas-landing-demo` — отдельный git-репо с `gadai` remote → `PonchoGAD/gadai.git`.
**Деплой сайта:** `cd C:\Users\gafit\saas-landing-demo && git push gadai main` (НЕ `git push gad main`!).
**Launcher форма** на сайте: submit-to-queue (без Phantom wallet) → `/api/proxy/launcher/submit` → VPS:4000 → coin_ideas → `/auto_launch` в TG боте.
**Если Vercel не деплоит автоматически:** Зайти на vercel.com, найти проект `gadai`, нажать "Redeploy" вручную.

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

## Текущие параметры бота (VPS .env — 14.06.2026)

```bash
AUTO_BUY_ENABLED=true
AUTO_BUY_SOL=0.02               # позиция 0.02 SOL
MAX_AUTO_POSITIONS=10
DAILY_MAX_SOL=1.0               # max 1 SOL в день

# Фильтры Raydium scanner (обновлено 14.06.2026):
RAYDIUM_MIN_LIQUIDITY_USD=12000  # снижено с 22k → больше сигналов
RAYDIUM_MAX_LIQUIDITY_USD=300000
RAYDIUM_MIN_PC1H=5              # 5% momentum за 1ч (было 1%)
RAYDIUM_MAX_PC1H=80
RAYDIUM_MIN_PC5M=1
RAYDIUM_MIN_VOL_LIQ_RATIO=0.15  # 15% hourly vol/liq (было 8%)
RAYDIUM_MAX_BUY_SELL_RATIO=3.5  # wash trading filter
RAYDIUM_MAX_AGE_SEC=172800      # 48 часов max

# Sell параметры (Raydium scheduler):
STOP_LOSS_PCT=8                 # глобальный стоп
TRAIL_PCT=12
EARLY_TRAIL_PCT=4

# Bonding Scanner (обновлено 14.06.2026):
BONDING_SCANNER_ENABLED=false   # W2 WebSocket выключен!
BONDING_HOT_ENABLED=true        # HOT poller через DexScreener (W3 только)
BONDING_BUY_SOL=0.02            # 0.02 SOL позиция
BONDING_MAX_SOL_DAILY=0.3
BONDING_MIN_BUYERS=50           # мин уникальных покупателей
BONDING_MIN_DEV_BUY=0.5         # мин SOL dev купил
BONDING_HOT_INTERVAL_SEC=60     # каждые 60 секунд
BONDING_STOP_PCT=0.12           # 12% stop-loss (было 17%)
BONDING_TIME_LIMIT_SEC=300      # 5 мин time limit (было 10 мин)
BONDING_HOT_MAX_MCAP_USD=8000   # max mcap при покупке $8k (было $12k)

# HOT filter параметры (в коде, не в .env):
# buys5m >= 10, vol5m >= $800, pc5m 1-8%, B/S ratio >= 1.5

# Кошельки:
# PUMPFUN_WALLET_ADDRESS=CFmHWpmQ...   (wallet 1 — ОТКЛЮЧЁН)
# PUMPFUN_WALLET_PRIVATE_KEY=...
# PUMPFUN_WALLET_ADDRESS_2=DJ8Tq8vi... (wallet 2 — HOT poller, нужна пополнение!)
# PUMPFUN_WALLET_PRIVATE_KEY_2=...     (добавлен 13.06.2026)

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

### Bonding scanner: все sells падали "Versioned messages" (исправлено — 14.06.2026)
Баг: try VersionedTx → sendTx fails → catch пробует Transaction.from(versioned_bytes) → ошибка.
DRILL достиг 58x но все TP sells упали. Потеря 50% при TIME_LIMIT.
**Правильный фикс:** `VersionedTransaction.deserialize(bytes)` без fallback. Byte[0] = signature count (0x01), НЕ version prefix. skipPreflight: true.

### Docker builder cache заполнил диск (14.06.2026)
Docker build cache вырос до 8.7GB → диск 100% → PostgreSQL упал с "No space left on device".
Фикс: `docker builder prune -af` → 7.5GB freed → `docker restart gad-ai-postgres`.
**Профилактика:** Запускать `docker builder prune -af` на VPS раз в 1-2 недели.

### W3 GADAI продажа не прошла (14.06.2026)
W3 (DJ8Tq8vi) держит 1,407,117 $GADAI (~$2.75 при mcap $1,955). SOL баланс 0.0027.
Bonding curve почти пустая → sell TXs не подтверждаются (недостаточно ликвидности).
Можно считать 0.04 SOL потерей. W3 нужна пополнение SOL для торговли.

### Запуск токенов на pump.fun (паттерн)
USMNT (12.06.2026), ELONWON (12.06.2026), GADAI (14.06.2026) — все через Pinata+pumpdotfun-sdk.
PumpPortal create action и PumpPortal IPFS не работают. Только pump.fun SDK для создания.
PINATA_JWT есть на VPS и в локальном .env (взят с VPS 14.06.2026).

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

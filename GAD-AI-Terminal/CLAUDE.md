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

## Тарифные планы (АКТУАЛЬНО — 20.06.2026)

**Оплата: USDT на BSC (MetaMask/Trust Wallet) ИЛИ Telegram Stars**
**EVM кошелёк казначейства:** `0x4C0B07Ad19D47994639D18ac2Af2FF82A0F95F37` (BSC_WALLET_PUBLIC_KEY)
**Stars rate:** $2.29 за 100 звёзд → $5=219⭐ | $10=437⭐ | $100=4367⭐

| slug | Цена USD | Stars | Срок | Описание |
|---|---|---|---|---|
| `trial_1d` | **$5** | 219 ⭐ | 24 часа | Полный доступ, одноразовый на аккаунт |
| `trial_3d` | **$10** | 437 ⭐ | 72 часа | Полный доступ + Alpha Engine |
| `monthly` | **$100** | 4367 ⭐ | 30 дней | Всё включено |

**Способы оплаты:**
1. **USDT на BSC** — gadai.shop/pay → MetaMask → USDT transfer → API верификация через BSC RPC
2. **Telegram Stars** — /subscribe в боте → кнопка ⭐ → invoice → `pre_checkout_query` → `successful_payment`

**Идентификация:** `tg_<user_id>` как virtual wallet_address для Stars/USDT подписок (не нужен Solana wallet)
**Статус /tg/status/:id** — проверяет ОБА: linked wallet AND `tg_<id>` — находит любую подписку

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

- [x] **Раунд 4: Калибровка 4 ботов + X-trend Source 9 (03-04.07.2026):**
  - **TX Velocity filter (W3 Sniper):** на PumpPortal create → очередь `pendingWatch` → через 10s читаем Helius getAccountInfo(bondingCurvePDA) → парсим bytes 16-23 (vSol в lamport) → если delta ≥ 0.30 SOL → вход; иначе `DEAD_LAUNCH` skip. Epsilon FP fix: `delta >= TX_VEL_SOL - 0.001` (lamport/1e9 = 0.2999... out of FP).
  - **Dynamic stagnation stage 1 (W3 Sniper):** `dev_buy_sol >= 1.5` → 90s окно; иначе 45s. IIFE внутри else-if: `(() => { const s = pos.dev_buy_sol >= 1.5 ? 90 : 45; return ageSec >= s && ageSec < s+15; })()`.
  - **TON Break-even после TP1:** После частичной продажи на TP1 (+35%) → `be_active=true` → если цена опускается ниже entry (mult < 1.0) → `BE_STOP` вместо ожидания -10% SL. Защита locked profit.
  - **TON startup cleanup:** `cleanupStaleTonPositions()` при старте — закрывает позиции старше TIME_LIMIT_SEC с reason `EXPIRED_ON_RESTART`. Без этого postgres-recovery оставлял зависшие open-позиции.
  - **Raydium max liq $60k → $95k + vol1h guard:** `RAYDIUM_MAX_LIQUIDITY_USD=95000` default. Для пула > $60k liq требуем `vol1h/liq ≥ 1.5x` (активный пул, не мёртвый). Убийца: T2 ($80-300k) давал 0% WR — теперь допускаем $60-95k только при высоком vol.
  - **Raydium relaxed-shadow:** параллельный paper-pass с `strategy='raydium_relaxed'` — записывает кандидатов с мягкими фильтрами (vaccel 0.30, без vol1h guard) для сравнения WR strict vs relaxed. Решение о порогах — через 5 дней данных.
  - **vaccel 0.40 → 0.30:** `RAYDIUM_VACCEL_MIN` снижен для большего потока при F&G<30.
  - **X-trend Source 9 (ПЕРВЫЙ РАЗ ПОДКЛЮЧЁН):** autobuy раньше НИКОГДА не читал `x_trend_signals`. Добавлен: `SELECT coin_mint FROM x_trend_signals WHERE created_at > NOW()-'30m' AND coin_mint IS NOT NULL` → mint-ы инжектируются в список кандидатов Raydium с `_xtrend=true` в pair-объекте. До этого X-тренды существовали только в Telegram-алёртах и Polymarket стратегии.
  - **Adaptive ADX threshold (Futures):** `calcBollinger(closes.slice(0,-1))` → если BB width расширяется >5% → `effectiveMinAdx = 19` вместо MIN_ADX=22. Ловит начало движения когда ADX ещё не разогнался.
  - **Все патчи на VPS деплойнуты** через `/opt/gad-patches/` bind-mounts.
- [x] **Деплой Раунд 3 + Futures macro-monitor fix (03.07.2026):**
  - **Futures `ok=false` при F&G=19 ИСПРАВЛЕН:** compiled `macro-monitor.js` имел `fg >= 20`. TS-патч с `fg >= 10` не был пересобран. Фикс: `score >= 40 && btcChange1h > -1.5 && fg >= 10`. Бот теперь торгует при F&G 10+.
  - **W3 Sniper zombie-WS heartbeat:** если >3 мин без PumpPortal сообщений → `conn.terminate()` + reconnect 5s.
  - **W3 Sniper State Recovery:** рестарт не вайпает open-позиции с `outcome_pct=0` — пишет `stopped_restart` / `stopped_timeout`. Исключены из WR.
  - **W3 Sniper Rapid Dump Guard:** `-5% с 5-20s` (было -3% с 0s — ловил слипидж при покупке).
  - **F&G тег в shadow_trades:** w3-sniper и bonding-smart пишут `fg:N` в filter_params при каждом входе.
  - **Все патчи на VPS деплойнуты** через `/opt/gad-patches/` bind-mounts. Все контейнеры запущены.
  - **Статистика 03.07.2026:** W3 Sniper 297 shadow (0% WR — рынок F&G=19, нет покупателей в 45s), Base Scanner 8 shadow (**37.5% WR**, avg win +52.6%), Raydium 124 live (30.6% WR, net -0.04 SOL), Polymarket 62 DRY-RUN сигнала (avg EV 18.8%).
- [x] **PumpSwap Graduate Movers — shadow-сборщик (03.07.2026):** `services/autobuy/src/pumpswap-movers.ts`
  - Раздел Movers pump.fun (30мин-4ч, mcap $80k-$1.5M) структурно невидим Raydium-сканеру: pumpswap не в JUPITER_DEX_IDS + mcap выше лимитов
  - Shadow-сборщик пишет каждого мувера в shadow_trades (strategy='pumpswap_movers') с полными входными метриками; runShadowCheck проставляет исходы 30м/1ч/4ч/8ч
  - vps-stats.sh: профиль победителей (mcap/liq/age/pc5m/bs1h/volLiq по статусам) — Шаг 2
  - Шаг 3 (покупки через W1) — ТОЛЬКО если профиль покажет +EV; W2/W3 не участвуют никогда
  - Env: PUMPSWAP_MOVERS_SHADOW=false — выключить
- [x] **Fear-market фиксы: X-trend wiring + relaxed-shadow (03.07.2026):**
  - **X-тренд сигналы подключены к торговле:** autobuy НИКОГДА не читал `x_trend_signals` (сигналы шли только в TG и polymarket). Source 9 в fetchRaydiumPairs: coin_mint из x_trend_signals (<3ч) → кандидаты в общий пайплайн, метка `_xtrend` в shadow filter_params
  - **Relaxed-shadow калибровка:** после ужесточений 01.07 бот в FEAR = 0 покупок/сутки. Второй paper-проход по тем же кандидатам с июньскими порогами (liq≥12k, pc1h≥5, buys 20/10, vol/liq≥12%) → `shadow_trades strategy='raydium_relaxed'`. Через 3-5 дней сравнение WR strict vs relaxed решит, что ослаблять. `RAYDIUM_RELAX_SHADOW=false` — выключить
  - **Пороги в env:** `RAYDIUM_VACCEL_MIN` (дефолт 0.30, было hardcoded 0.40 — неаудированное ужесточение), `RAYDIUM_FEAR_MIN_PC1H` (10), `RAYDIUM_DEEP_FEAR_MIN_PC1H` (8) — тюнинг без пересборки
  - vps-stats.sh: сравнение strict vs relaxed + судьба X-trend кандидатов
- [x] **Polymarket ARB-сканер "YES+NO < $1" (02.07.2026, ночь):** `arb-scanner.ts`, migration 028
  - PAPER-ONLY детектор негативного спреда на коротких крипто Up/Down рынках (<6ч до конца)
  - POST /books батч-опрос стаканов каждые 5с, edge = 1 − (bestAskYES + bestAskNO) − fees
  - Пишет возможности в `polymarket_arb_ops` (дедуп 60с), эндпоинт `/arb`, часовой лог `[poly-arb] hourly`
  - НЕ размещает ордера. Решение о live — только если неделя данных покажет регулярные исполнимые гэпы
  - Источник идеи — вирусные посты о Polymarket-арбитраже; их цифры ($570k и т.п.) непроверяемы, реф-ссылки = маркетинг. Математика ядра верна, но гэпы выедаются HFT — поэтому сначала измерение
- [x] **Раунд 2 доработок по статистике (02.07.2026, вечер):**
  - **TON unit-баг исправлен:** entry_price был в смешанных единицах (GT=TON, DexScreener=quote-токен) → аномалии +622536%. Теперь весь shadow-контур в USD (`price_usd` в TonToken, priceUsd в мониторе), legacy-строки без `price_unit:'usd'` авто-закрываются как `status='invalid'`, гард mult>20x
  - **Polymarket impulse-TP баг:** буфер истории 10×30с=5мин, а окно импульса 20мин → IMPULSE_TP никогда не срабатывал. Буфер → 45 чтений
  - **Polymarket воронка:** счётчики отказов по каждому гарду (max_open/dup/validator по причинам), эндпоинт `/funnel` + часовой лог `[poly-funnel]` — покажет, почему 62 сигнала дали 0 позиций (подозрение: EXCESSIVE_DURATION в validator)
  - **Polymarket LIVE-gate:** реальные ордера жёстко заблокированы в trader.ts пока dry-run не покажет ≥30 сделок И WR≥65% (`POLY_GATE_MIN_TRADES/POLY_GATE_MIN_WR`, аварийный `POLY_GATE_OVERRIDE=true`). Даже с POLYMARKET_DRY_RUN=false бот пишет paper-позиции до открытия гейта
  - **F&G-теги в shadow_trades:** w3-sniper и bonding-smart теперь пишут `fg` в filter_params — для анализа WR по режимам рынка ("W3 работает при F&G>35" станет проверяемо)
  - Деплой: polymarket = scp 3 .ts в /opt/gad-patches/polymarket-src + restart; autobuy = build + scp dist; ton = rebuild (нужен свободный диск) или hot-patch libs/ton
- [x] **Аудит всех ботов + 3 бага исправлено (02.07.2026):** см. `ОТЧЁТ_АУДИТ_БОТОВ_02.07.2026.md`
  - scheduler.ts: `deep_fear` отсутствовал в regex getTierFromLabel → DEEP_FEAR позиции получали NEUTRAL TP (1.12x вместо 1.10x) и NEUTRAL trail (18% вместо 10%)
  - scheduler.ts: эндпоинт цен `lite.jup.ag/v1/prices` МЁРТВ (пустое тело) → замена на `lite-api.jup.ag/price/v3?ids=<mint>,<SOL>` (цена = tokUsd/solUsd)
  - scheduler.ts: DexScreener price fallback теперь приоритизирует SOL-котируемые пары (priceNative номинирован в quote-токене — USDC-пара давала цену ~150x)
  - Хот-патч без сборки: `scripts/patch-autobuy-scheduler.js` (правит /opt/gad-patches/autobuy-dist/scheduler.js, делает .bak)
  - ⚠️ copy-trader включён по умолчанию (`COPY_TRADE_ENABLED !== 'false'`) — прописать `COPY_TRADE_ENABLED=false` в VPS .env, если не используется
- [x] Полная схема БД (11 SQL-миграций)
- [x] Все 18 shared-либ + trend-engine (GDELT + Google News + AI идеи)
- [x] API сервер: токены, watchlist, alerts, portfolio, subscription, tg-user linking
- [x] Subscription routes: 3 плана, FREE_WALLETS bypass
- [x] **Payment system USDT+Stars (20.06.2026):** migration 022, BSC USDT верификация, Telegram Stars invoice
  - `POST /subscription/verify-usdt` — BSC RPC verification (eth_getTransactionReceipt + Transfer event decode)
  - `POST /subscription/activate-stars` — Stars payment activation (tg_user_id + telegram_charge_id)
  - `/tg/status/:id` — теперь проверяет tg_<id> wallet fallback (no Solana wallet needed)
  - Stars: $2.29/100⭐ → trial_1d=219⭐, trial_3d=437⭐, monthly=4367⭐
  - Pay page: MetaMask USDT on BSC (encodeUsdtTransfer ABI, wallet_switchEthereumChain)
  - Bot Stars flow: `stars_plan:` callback → `sendInvoice(XTR)` → `pre_checkout_query` → `successful_payment`
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
- [x] **Rug filters tightened (16.06.2026):** buys1h 25→40 for fresh tokens (<6h), + min 1h age for liq≥$40k fresh tokens
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
  - **БАГ ИСПРАВЛЕН (29.06.2026):** `total_sold_eth=0` после TP — был balance diff с RPC race. Фикс: `result.amount_out` из WETH Withdrawal event в receipt
  - Telegram: /basestatus /basepositions /basetrades /basetokens (PRO/STARTER+)
  - API: /base/* routes proxied from api service to base-scanner:4005
  - Docker: `BASE_AUTO_BUY=false` by default (dry-run) — set to true + add BASE_WALLET_PRIVATE_KEY to activate
- [x] **TON Network Integration (17.06.2026):** migration 020, libs/ton, services/ton-scanner, port 4007
  - libs/ton: TonClient + WalletContractV4, STON.fi v1 router (buy/sell Jettons), tonapi.io safety, GeckoTerminal + DexScreener discovery
  - ton-scanner: token discovery (GeckoTerminal + DexScreener every 60s), 5-stage TP (1.2/1.5/2.0/3.0/5.0x), trail stop 10%, SL 8%, time limit 10min
  - Telegram: /tonstatus /tonpositions /tontrades /tonpnl (PRO)
  - API: /ton/* routes proxied from api service to ton-scanner:4007
  - Docker: `TON_AUTO_BUY=false` by default (dry-run) — requires TON_WALLET_MNEMONIC + TON_API_KEY to activate
  - **Config для активации:** добавить в VPS .env: `TON_WALLET_MNEMONIC=word1...word24`, `TON_API_KEY=<toncenter key>`, `TON_AUTO_BUY=true`
  - Deps: `@ton/ton@^15`, `@ton/crypto@^3`, `@ton/core@^0.62`, `@ston-fi/sdk@^2.2`, `@ston-fi/api@*`
- [x] **Market Regime Gating для Raydium autobuy (14.06.2026):**
  - `getFearGreed()` — Fear&Greed API (alternative.me), кеш 30мин
  - `getMarketRegime()` → EXTREME_FEAR/FEAR/NEUTRAL/BULL/EUPHORIA (или overrideMARKET_REGIME=AUTO)
  - **EXTREME_FEAR (F&G < 10):** все новые покупки заморожены — только реальная капитуляция (было: < 13 → снижено 29.06.2026)
  - **FEAR (F&G 10-45):** контрарная зона покупок — мин pc1h 15%, TP снижен (1.18x/1.15x/1.12x)
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
- [x] **EXTREME_FEAR порог снижен до 10 (29.06.2026, было 13):** бот покупает при F&G 10-45 (FEAR = contrarian buy zone). F&G=12 теперь разрешён.
- [x] **Raydium T2 заблокирован + HIGH_LIQ_RUG guard (29.06.2026):**
  - `RAYDIUM_MAX_LIQUIDITY_USD=80000` на VPS (было 120k) — T2 ($80k+) имел 0% win rate, исключён
  - `HIGH_LIQ_RUG` guard в `auto-signal.js`: liq > $100k AND rug_risk ≥ 25 → skip (whale trap)
  - Патч: `/opt/gad-patches/autobuy-dist/auto-signal.js`
- [x] **Futures Guard 6: EMA200 на 1H (29.06.2026):**
  - Добавлен `fetchCandles1H(210)` → EMA200 на 1H таймфрейме
  - LONG заблокирован если price < EMA200(1H) (макро-даунтренд)
  - SHORT заблокирован если price > EMA200(1H) (макро-аптренд)
  - Патч: `/opt/gad-patches/futures-src/entry-strategy.ts`
- [x] **W3 Sniper F&G guard (29.06.2026):**
  - `checkFGHistorySafe()` — проверяет F&G > 45 за последние 5 дней
  - AUTO-ENABLE заблокирован пока не 5 дней подряд BULL (F&G > 45)
  - Патч: `/opt/gad-patches/autobuy-dist/w3-sniper.js`
- [x] **Polymarket улучшения (29.06.2026):**
  - Liquidity gate: рынки с `liquidityUsd < $1000` отфильтровываются перед FAST PATH
  - Dead market filter в `keyword-matcher.ts`: `entryPrice < 0.05 OR > 0.95` → skip
  - `aiProb` hard cap: `Math.min(rawAiProb, 0.95)` — предотвращает EV>0 при entry=1.0
  - Sentiment required для MEDIUM confidence: `(bull + bear) >= 1`, иначе → LOW → filtered
  - Патчи: `/opt/gad-patches/polymarket-src/keyword-matcher.ts`, `scorer.ts`, `markets.ts`
- [x] **GRAD/Score80/Whale стратегии отключены (17.06.2026):** 100% loss rate
  - `graduation-scanner.ts`: добавлен `GRAD_HUNTER_ENABLED` чек перед покупкой — при false логирует и пропускает
  - `scheduler.ts`: явный лог `✅ GRAD scanner disabled` при старте; `SCORE80_SIGNAL_ENABLED=false`, `WHALE_SIGNAL_ENABLED=false` — hardcoded
  - GRAD WebSocket остаётся подключён для pre-graduation exit guard
- [x] **SOL Velocity Tracker v2 (17.06.2026):** АКТИВЕН на VPS
  - Реальный PumpPortal WebSocket сигнал вместо DexScreener polling (0 lag)
  - Зона входа: 25-80 SOL в кривой (7-14% от graduation threshold 588 SOL)
  - Velocity: сумма `solAmount` за 60s ≥ 3 SOL (реальный поток денег)
  - Anti-whale: пропуск если одна покупка > 5 SOL (manipulation guard)
  - Unique buyers ≥ 8, последний трейд < 30s назад (momentum alive)
  - Pre-graduation exit: если vSol > 488 (588-100) и есть позиция → PRE_GRAD_EXIT немедленно
  - Time limit: 90s, TP: 100% на 1.5x, Stop: 12%
  - Env: `SOL_VELOCITY_ENABLED=true`, `SOL_VELOCITY_BUY_SOL=0.012`
- [x] **VPS RAM увеличена (17.06.2026):** пользователь изменил тип сервера в Hetzner (RAM увеличилась)
  - ВНИМАНИЕ: RAM ≠ Disk. Диск остался 38GB, заполнен на 100%
  - Фикс диска: `tune2fs -m 2 /dev/sda1` → снизили reserved блоки с 5% до 2%, освободили 291MB
  - PostgreSQL падал с "could not write lock file postmaster.pid: No space left on device"
  - Hot-patch метод деплоя: `scp .ts → docker cp → docker exec build → docker restart` (без пересборки образа)
  - КРИТИЧНО: нужно добавить Hetzner Volume или перейти на тип с большим диском
- [x] **W2/W3 PumpFun кошельки: ТОЛЬКО запуск монет, НЕ трейдинг (19.06.2026):**
  - `BONDING_HOT_ENABLED=false`, `SOL_VELOCITY_ENABLED=false` — навсегда отключены в VPS .env
  - W2 (CFmHWpmQ) и W3 (DJ8Tq8vi) = ТОЛЬКО для triple-launch новых токенов
  - Trейдинг на pump.fun кошельках слил все SOL в 0 — запрет абсолютный
  - **Правило:** W2/W3 участвуют только как создатели монет в `launchTriple()`, никаких buy/sell токенов
- [x] **Polymarket Prediction Market Bot (20.06.2026):** migration 021, services/polymarket-bot, port 4009
  - Gamma API: 94 активных рынка, обновление каждые 15 мин
  - **FAST PATH (29.06.2026):** `keyword-matcher.ts` — zero cost (<1ms), без LLM. Named entities + word overlap + sentiment + naive Bayesian EV
  - **SLOW PATH:** LLM (Claude Haiku, $0.001/сигнал) — только при LOW keyword confidence
  - 3 стратегии: X Trends, GDELT clusters, Volume Spikes
  - **БАГ (29.06.2026 — ИСПРАВЛЕН):** Docker IMAGE содержал `CMD: sleep 600` → бот не запускался 9 дней (0 сигналов)
  - Fix: `docker-compose.override.yml` с `entrypoint: ['node']` + `command: ['-r', 'ts-node/register'...]` override
  - DRY-RUN → LIVE после WR≥65% на 30+ сделках. Документация: `!полимаркет настройка.md`
  - Telegram: /polystatus /polypositions /polytrades /polymarkets (Admin only)
- [x] **Payment system USDT/Stars (20.06.2026):** migration 022
  - USDT на BSC: treasury `0x4C0B07Ad19D47994639D18ac2Af2FF82A0F95F37`, BSC USDT 18 decimals
  - Stars: trial_1d=219⭐ | trial_3d=437⭐ | monthly=4367⭐ (rate $2.29/100)
  - Pay page: MetaMask + USDT ABI encoding + BSC RPC confirmation polling
  - Subscription status: fallback на `tg_<id>` wallet (без Solana кошелька)
  - Stars flow: stars_plan: callback → sendInvoice(XTR) → pre_checkout_query → successful_payment
- [x] **Triple-launch (3-wallet simultaneous token creation, 19.06.2026):**
  - `services/telegram/src/launcher.ts`: `launchTriple(cfg)` — все 3 кошелька создают ОДНУ И ТУ ЖЕ монету одновременно
  - Pinata image+metadata загружаются ОДИН РАЗ → `Promise.all()` для 3 независимых createAndBuy
  - Каждый кошелёк получает СВОЙ mintKp → свой уникальный CA на pump.fun
  - `createSingleToken(wallet, alias, ...)` — создаёт одну монету для одного кошелька
  - `coin_launches` таблица: добавлены `wallet_alias` (W1/W2/W3) и `wallet_address` колонки
  - `coin_ideas` таблица: добавлены `image_url` и `auto_launch_at` колонки (миграция на VPS ✅)
- [x] **24h holder check + auto-sell (19.06.2026):**
  - `runLaunchedCoinMaintenance()` — раз в час проверяет монеты возрастом 22-30ч
  - `checkHolderCount(mint)` — Birdeye → Helius → DexScreener fallback
  - Если holders < 10 (MIN_HOLDERS_24H) → `pumpSellAll()` — полная продажа позиции
  - Scheduler в index.ts: `setInterval(runLaunchedCoinMaintenance, 60*60*1000)` 
- [x] **Auto-launch scheduler (19.06.2026):**
  - `runAutoLaunchCycle()` — каждые 3 часа, лимит 5 монет в день (DAILY_LAUNCH_LIMIT=5)
  - Ищет в coin_ideas: `status='approved'` AND `image_url IS NOT NULL`
  - Загружает изображение → вызывает `launchTriple()` → записывает wallet_alias в coin_launches
  - `setTimeout(runAutoLaunchCycle, 10*60*1000)` — первый запуск через 10 мин после старта бота
- [x] **trend-launcher.ts обновлён (19.06.2026):**
  - Теперь сохраняет `image_url` в coin_ideas (Pinata CID)
  - Идеи из X трендов теперь включают URL изображения → auto-launch cycle может их использовать
- [x] **Raydium filters tightened (19.06.2026):**
  - `RAYDIUM_MIN_LIQUIDITY_USD=22000` (было 12k)
  - `RAYDIUM_MAX_PC1H=25` (было 80%) — не покупаем уже пампанувшие
  - `RAYDIUM_MIN_PC1H=10` (было 5%) — минимальный momentum
  - `RAYDIUM_MIN_PC5M=3` (было 1%)
  - `RAYDIUM_MIN_VOL_LIQ_RATIO=0.20` (было 0.15)
- [x] **Raydium FRESH-ONLY стратегия (19.06.2026):** анализ 79 pump.fun + Raydium трейдов
  - Данные: FRESH (<6h) win rate 41.4% (+0.012 SOL net), AGED (>6h) win rate 21.9% (-0.049 SOL net)
  - VPS .env: `RAYDIUM_MAX_AGE_SEC=21600` (было 172800=48h) — только токены до 6ч
  - VPS .env: `RAYDIUM_MIN_PC5M=5` (было 1%) — тighter momentum filter
  - Файл с полным аудитом: `PUMPFUN_TRADING_AUDIT.md` (79 сделок, 3 победы, -1.077 SOL)
- [x] **X Trends multi-source fix (19.06.2026):**
  - `services/social-monitor/src/x-trends.ts` — переписан: Nitter RSS + DexScreener + CoinGecko (нет xml2js)
  - Исправлено: Nitter RSS НЕ содержит лайки/ретвиты → synthetic tier engagement (Tier1=50k, Tier2=5k, Tier3=2k)
  - Исправлено: cutoff расширен с 6h → 24h для Tier1 (elonmusk посты старше 6h не появлялись)
  - Twitter API viral thresholds: min_retweets:500, min_faves:5000 (реально массовые, Basic план нужен)
  - `services/social-monitor/src/twitter.ts` — добавлен BROWSER_UA + 4 Nitter instances, fallback 402/403
  - Подтверждено на VPS: "Nitter influencers: 2 signals from 3 accounts" (было 0)

---

## Кошельки (июнь 2026)

| Кошелёк | Адрес | Роль | Баланс |
|---|---|---|---|
| W1 WALLET_PRIVATE_KEY | EL4mS7Xg | Главный/казна/dev launch/Raydium autobuy | ~0.29 SOL (14.06.26) |
| W2 PUMPFUN_WALLET_PRIVATE_KEY | CFmHWpmQ | **ТОЛЬКО ЗАПУСК МОНЕТ** (трейдинг ОТКЛЮЧЁН навсегда) | ~0.244 SOL (14.06.26) |
| W3 PUMPFUN_WALLET_PRIVATE_KEY_2 | DJ8Tq8vi | **ТОЛЬКО ЗАПУСК МОНЕТ** (трейдинг ОТКЛЮЧЁН навсегда) | ~0.13 SOL (19.06.26) |

> **ВАЖНО (19.06.2026):** W2 и W3 = ТОЛЬКО для `launchTriple()`. Трейдинг (BONDING_HOT, SOL_VELOCITY) на них слил все SOL в 0 несколько раз. Hardcoded: `BONDING_HOT_ENABLED=false`, `SOL_VELOCITY_ENABLED=false` в VPS .env.
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
| ton-scanner | 4007 | ✅ 24/7 | TON Network / STON.fi (dry-run, shadow stats only — экосистема не подходит для стратегии, см. `!ТОН настройка.md`) |
| polymarket-bot | 4009 | ✅ 24/7 | Polymarket (DRY-RUN, keyword+LLM, target WR≥65% on 30 trades) |

**Только локально (НЕ на VPS):**
- `scripts/launch-*.ts` — запуск токенов на pump.fun (нужен ключ + pumpdotfun-sdk локально)
- `scripts/twitter-post.ts` — постинг в X после запуска (OAuth 2.0 refresh-token хранится локально)
- `scripts/launch-fte.ts` — FTE launch скрипт

**Что нужно для полной 24/7 автоматизации:**
- [x] ~~Telegram команда `/auto_launch` на VPS~~ — реализовано (19.06.2026): тройной запуск + авто-цикл 5/день ✅
- [ ] Автопостинг в X после запуска — перенести twitter-post.ts логику в social-monitor

---

## Что НЕ СДЕЛАНО / требует доработки

### КРИТИЧНО
- [x] ~~W3 нужна пополнение SOL~~ — DJ8Tq8vi теперь 0.13 SOL ✅ (пополнен 14.06.2026)
- [ ] **⚠️ ДИСК VPS КРИТИЧЕСКИ ЗАПОЛНЕН (17.06.2026):** 38GB, 0 байт свободно
  - Временный фикс: `tune2fs -m 2 /dev/sda1` — reserved blocks 5%→2%, дало 291MB
  - Решение: добавить Hetzner Volume (20GB = ~5€/мес) ИЛИ перейти на тип сервера с бо́льшим диском
  - RAM ≠ Disk: увеличение RAM не добавляет диск. Нужно отдельно: Hetzner → Server → Volumes → Create Volume
  - `docker builder prune -af` теперь даёт 0B (build cache пуст). Диск занят ОБРАЗАМИ запущенных контейнеров
  - До расширения диска: деплой через hot-patch (scp + docker exec build), НЕ docker compose build
- [ ] **Metadata enrichment** — tokens.symbol/name остаются NULL
- [x] ~~**ANTHROPIC_API_KEY** в VPS .env~~ — SET ✅ (проверено 20.06.2026)
- [ ] **Migration 011** применить на VPS: `docker compose exec -T postgres psql -U gad -d gad_ai < migrations/011_trend_engine.sql`
- [ ] **Health checks** для scanner, telegram, autobuy, whale-tracker
- [ ] **Futures LIVE MODE:** отключён по умолчанию (FUTURES_LIVE_MODE=false → paper trading). Для real Drift Protocol включить через .env + депозит USDC на Drift аккаунт
- [ ] **PumpSwap graduated token sells** — HOT токены > $8k mcap нужно продавать через Jupiter, не PumpPortal. Сейчас ограничено max $8k в HOT poller.
- [x] ~~Auto-launch на VPS~~ — реализовано (19.06.2026): `/auto_launch` в TG боте + `launchTriple()` + авто-цикл 5/день ✅
- [x] ~~Velocity Tracker~~ — ОТКЛЮЧЁН навсегда (19.06.2026). `SOL_VELOCITY_ENABLED=false`. W2/W3 только для запуска монет.

### СЛЕДУЮЩИЕ ПРИОРИТЕТЫ (структурированный план)

#### P1 — Raydium прибыльность (главная задача)
- [ ] **Остановить T2 покупки:** `RAYDIUM_MAX_LIQUIDITY_USD=80000` — T2 ($80k+) 0% win rate
- [ ] **Поднять FEAR TP:** FEAR режим TP1=1.10x слишком мало (avg win=1.19x) → поднять до 1.20-1.25x в `auto-signal.ts`
- [ ] **NULL bought_at phantom позиции:** 15 трейдов с `bought_at=NULL, active=false, received=0` — inflate loss count; добавить cleanup при старте autobuy
- [ ] **Backtesting pipeline:** собрать 200+ DexScreener сигналов без покупки → симулировать → доказать прибыльность фильтров перед изменением

#### P2 — Инфраструктура (КРИТИЧНО)
- [ ] **⚠️ ДИСК VPS 100% (17.06.2026):** добавить Hetzner Volume 20GB ($5/мес) ИЛИ перейти на CPX41 (160GB). Текущий фикс (tune2fs) даёт 291MB — не хватит надолго
- [x] ~~ANTHROPIC_API_KEY~~ — SET на VPS ✅
- [ ] **Миграции на VPS:** проверить что все (011-022) применены: `docker compose exec postgres psql -U gad -d gad_ai -c "\dt"` (022 применена 20.06.2026 ✅)
- [ ] **Polymarket LIVE:** включить после WR≥65% на 30+ dry-run сделках (см. `!аналитика бота полимаркет.md`)

#### P3 — X/Twitter Trends
- [ ] **Twitter Basic план ($100/мес)** — для реальных engagement metrics (сейчас Nitter = synthetic данные без лайков/ретвитов)
- [ ] **Автопостинг в X** — перенести `scripts/twitter-post.ts` в `social-monitor` → постить при каждом `/auto_launch`
- [ ] **Verify coin-hunter→DexScreener:** убедиться что `coin-hunter.ts` получает токены с liq $15k+, vol24h $30k+, pc5m 1%+

#### P4 — Качество кода
- [ ] **Health checks** для scanner, telegram, autobuy, whale-tracker в docker-compose.yml
- [ ] **Rate limit на API** (express-rate-limit) — защита от DDoS
- [ ] **Unit-тесты** для rug, gad-score, narrative, survival, dna, lifecycle
- [ ] **Redis кеширование** (trending/new на 30с, tg/status на 60с)
- [ ] **Dashboard WebSocket** — real-time обновления позиций

### ВАЖНО (вторичные)
- [ ] **GMGN** недоступен с VPS (Cloudflare) — нужен residential proxy ($15/мес)
- [ ] **Metadata enrichment** — tokens.symbol/name остаются NULL в scanner
- [ ] **Futures LIVE MODE:** `FUTURES_LIVE_MODE=false` → paper trading. Для Drift Protocol: USDC депозит + env флаг

---

## Decisions Log (почему так сделано)

### 2026-07 — TX Velocity filter FP epsilon (04.07.2026)
**Решение:** `delta >= TX_VEL_SOL - 0.001` вместо `delta >= TX_VEL_SOL`.
**Почему:** vSol читается как `BigInt / 1e9` (lamport → SOL). Деление создаёт floating point drift: `0.300 SOL` представляется как `0.29999999...`. Лог показывал `only +0.300 SOL < 0.3 — skip (dead launch)` — токены точно на пороге отбрасывались. Epsilon 0.001 = 1 lamport погрешности — безопасно, ложных пропусков не будет.
**Не менять** delta на ints/BigInt — порог TX_VEL_SOL может быть дробным и конфигурируется через env.

### 2026-07 — X-trend Source 9 подключён к autobuy (03.07.2026)
**Решение:** `auto-signal.ts` теперь читает `x_trend_signals` (последние 30 минут) и добавляет `coin_mint` в список кандидатов Raydium scannera с тегом `_xtrend=true`.
**Почему был отключён:** Никогда не был реализован в autobuy. X-тренды создавались в `social-monitor` → шли только в Telegram-алёрт и в Polymarket стратегию. Физического провода от `x_trend_signals` к autobuy не существовало.
**Как работает теперь:** Mint из x_trend_signals инжектируется как отдельный "pair" в список DexScreener candidates. Если DexScreener возвращает данные по этому mint → проходит через все Raydium фильтры как обычный токен, но в filter_params пишется `_xtrend: true`.
**Ограничение:** X-trend scan работает раз в 15 мин, autobuy цикл раз в 30с → window = только если токен появился в последние 30 мин. Если тренд старше 30 мин — mint не будет в кандидатах.

### 2026-07 — Raydium relaxed-shadow для калибровки (03.07.2026)
**Решение:** Каждый Raydium кандидат, проходящий базовые Gate-1/2 проверки, пишется в `shadow_trades` с `strategy='raydium_relaxed'` — с мягкими порогами (vaccel 0.30, без vol1h/liq guard). Строгий проход (`strategy='raydium_scan'`) пишется только если токен прошёл все фильтры.
**Почему:** При F&G<30 strict фильтры дают 0 сделок за 48ч — нет данных для решения. Relaxed-shadow накапливает что было бы куплено при более мягких условиях. Через 5 дней сравнение WR strict vs relaxed покажет: (a) relaxed дал больше WR → можно смягчить, (b) WR одинаковый → фильтры правильные, просто плохой рынок.
**Таблица сравнения:** `vps-stats.sh` раздел `═══ КАЛИБРОВКА: strict vs relaxed ═══` → принять решение через 5 дней.
**Не путать:** `raydium_relaxed` = только paper, никаких реальных покупок. Реальные покупки только через `raydium_scan` (strict).

### 2026-07 — Adaptive ADX в Futures (03.07.2026)
**Решение:** В Guard 5 перед `adx < MIN_ADX`: вычислить prevBb (Bollinger на closes без последней свечи), если `bb.width > prevBb.width * 1.05` (расширение >5%) → `effectiveMinAdx = 19` вместо 22.
**Почему:** BB expansion = волатильность растёт прямо сейчас. ADX подтверждает тренд с лагом (~3 свечи). В начале движения BB уже расширяется, ADX ещё 20-21. Снижение порога с 22 до 19 позволяет войти раньше. Условие: expansion >5% — фильтрует шум (небольшие колебания BB ширины не считаются expansion).
**Не снижать** ниже 19 — ADX < 19 = рынок без тренда, любое направление случайно.

### 2026-07 — Futures macro-monitor threshold (03.07.2026)
**Решение:** `const ok = score >= 40 && btcChange1h > -1.5 && fg >= 10`
**Почему:** Скомпилированный `macro-monitor.js` содержал `fg >= 20`. TS-патч с `fg >= 10` был сделан ранее но JS так и не пересобирался. F&G=19 → `ok=false` → бот пропустил SOL +$10 движение. Порог score снижен с 45 до 40 (нет смысла требовать 45/100 макро-скора для LONG когда рынок в легкой коррекции). btcChange1h смягчен с -1 до -1.5 (коррекция до -1.5% за час = нормально для Long).
**Не менять** назад на `fg >= 20` — это слишком жёсткий порог, блокирует торговлю в FEAR-зоне.

### 2026-07 — Источник цен: Jupiter Lite Price v3 (02.07.2026)
**Решение:** `getPriceSolViaDS` использует `https://lite-api.jup.ag/price/v3?ids=<mint>,<SOL_MINT>` (usdPrice ratio), затем DexScreener fallback с приоритетом SOL-котируемых пар.
**Почему:** Старый эндпоинт `lite.jup.ag/v1/prices` мёртв — быстрый источник цен НИКОГДА не работал, каждая проверка цены шла через DexScreener (лаг 15-45с) → стоп-лоссы исполнялись с проскальзыванием. v3 не поддерживает vsToken — только USD, поэтому цена в SOL = tokUsd/solUsd из одного запроса.
**Не менять** на `price.jup.ag/v4` или `lite.jup.ag` — оба мертвы.

### 2026-07 — deep_fear в getTierFromLabel regex (02.07.2026)
**Решение:** regex `/:(deep_fear|extreme_fear|fear|neutral|bull|euphoria)$/i` — длинные альтернативы первыми.
**Почему:** `:deep_fear` не матчился старым regex (перед `fear` стоял `_`, а не `:`) → все DEEP_FEAR покупки получали NEUTRAL TP/trail. При добавлении нового режима в getMarketRegime ОБЯЗАТЕЛЬНО добавлять его и в этот regex.

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

### 2026-06 — Payment system: SOL → USDT/Stars (20.06.2026)
**Решение:** Полный переход с SOL на USDT (BSC) + Telegram Stars. SOL payment routes оставлены для обратной совместимости.
**Почему:** Система выросла на Solana→Base→BSC→TON. Платить только SOL неудобно для новых юзеров. USDT более привычен. Stars удобен для Telegram-native платежей.
**Детали:**
- USDT treasury: `0x4C0B07Ad19D47994639D18ac2Af2FF82A0F95F37` (BSC_WALLET_PUBLIC_KEY на VPS)
- BSC USDT: `0x55d398326f99059fF775485246999027B3197955` (18 decimals — НЕ 6 как Ethereum!)
- Verification: `eth_getTransactionReceipt` + Transfer event decode через BSC public RPC (без API ключа)
- Stars: TG Bot API `sendInvoice(currency:'XTR')` → `answerPreCheckoutQuery` → `successful_payment`
- Идентификатор: `tg_<user_id>` как virtual wallet (не нужен Solana кошелёк для новых методов)
**Не менять** BSC USDT decimals на 6 — это будет неправильно для BSC (18 decimals).
**Stars admin TG ID:** 1304225865 — звёзды приходят автоматически на бот (владелец бота = этот TG аккаунт)

### 2026-06 — Polymarket Bot (20.06.2026)
**Решение:** Prediction market trading bot в DRY-RUN. Нельзя переключить на LIVE без WR≥65% на 30+ сделках.
**Стратегии:** X тренды (плохой матч с политикой), GDELT clusters (лучший матч), Volume spikes.
**Критические детали:**
- `clobTokenIds` в Gamma API приходят как JSON-encoded STRING, не массив — нужен JSON.parse()
- `source_signal_id` в polymarket_signals = TEXT (UUID x_trend_signals.id нужно кастовать `s.id::text`)
- trend_clusters.summary содержит HTML (RSS) — использовать только `main_title`
- CLOB Auth для live: HMAC-SHA256, private key из MetaMask Polygon wallet + API key с polymarket.com
- Файлы: `!аналитика бота полимаркет.md` — полная документация + LIVE setup guide

### 2026-06 — gadai.shop — Vercel, не VPS (14.06.2026)
**Факт:** `gadai.shop` хостится на Vercel, подключён к `https://github.com/PonchoGAD/gadai.git`.
**Локальная папка:** `C:\Users\gafit\saas-landing-demo` — отдельный git-репо с `gadai` remote → `PonchoGAD/gadai.git`.
**Деплой сайта:** `cd C:\Users\gafit\saas-landing-demo && git push gadai main` (НЕ `git push gad main`!).
**Launcher форма** на сайте: submit-to-queue (без Phantom wallet) → `/api/proxy/launcher/submit` → VPS:4000 → coin_ideas → `/auto_launch` в TG боте.
**Если Vercel не деплоит автоматически:** Зайти на vercel.com, найти проект `gadai`, нажать "Redeploy" вручную.

---

### 2026-06 — W2/W3 только для запуска монет (19.06.2026)
**Решение:** W2 и W3 кошельки ПОЛНОСТЬЮ отключены от любого трейдинга. `BONDING_HOT_ENABLED=false`, `SOL_VELOCITY_ENABLED=false` — hardcoded в VPS .env.
**Почему:** W2/W3 несколько раз полностью слили SOL до 0 через bonding scanner и velocity trader. Ни одна из этих стратегий не была прибыльной — 100% потерь. Единственное применение W2/W3 — создавать монеты через `launchTriple()`.
**Не включать** трейдинг на pump.fun кошельках до создания полноценного backtesting pipeline.

### 2026-06 — Triple-launch: все 3 кошелька создают одну монету (19.06.2026)
**Решение:** `launchTriple()` загружает image+metadata в Pinata ОДИН РАЗ, затем 3 кошелька одновременно (Promise.all) создают ОДНУ И ТУ ЖЕ монету (одинаковое имя/тикер/описание/изображение) — но каждый получает СВОЙ уникальный CA.
**Почему:** Pump.fun — это создание нового токена при каждом вызове createAndBuy. Нельзя "купить" в уже созданный токен другого кошелька через SDK (нужен PumpPortal buy). Поэтому каждый кошелёк = отдельный листинг на pump.fun.
**Auto-cycle:** `runAutoLaunchCycle()` запускается каждые 3 часа, максимум 5 раз в день (DAILY_LAUNCH_LIMIT). Ищет `coin_ideas` с `status='approved'` AND `image_url IS NOT NULL`.
**24h check:** `runLaunchedCoinMaintenance()` раз в час смотрит монеты 22-30ч возраста. Если holders < 10 → продать.

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

## Текущие параметры бота (VPS .env — 19.06.2026)

```bash
AUTO_BUY_ENABLED=true
AUTO_BUY_SOL=0.02               # позиция 0.02 SOL
MAX_AUTO_POSITIONS=10
DAILY_MAX_SOL=1.0               # max 1 SOL в день

# Фильтры Raydium scanner (обновлено 19.06.2026 — FRESH ONLY стратегия):
RAYDIUM_MIN_LIQUIDITY_USD=12000  # мин лик (22k=кодовый default, 12k на VPS для большего потока)
RAYDIUM_MAX_LIQUIDITY_USD=300000 # T3 исключён, T2 ($80-250k) убыточен — рассмотреть MAX=80000
RAYDIUM_MIN_PC1H=5              # 5% momentum за 1ч
RAYDIUM_MAX_PC1H=80
RAYDIUM_MIN_PC5M=5              # ↑ с 1% → 5% (19.06.2026) — тighter momentum
RAYDIUM_MIN_VOL_LIQ_RATIO=0.15  # 15% hourly vol/liq
RAYDIUM_MAX_BUY_SELL_RATIO=3.5  # wash trading filter
RAYDIUM_MAX_AGE_SEC=21600       # ↓ с 172800 (48h) → 21600 (6h) — FRESH ONLY (19.06.2026)
                                 # Данные: FRESH 41.4% win rate vs AGED 21.9% win rate

# Sell параметры (Raydium scheduler):
STOP_LOSS_PCT=8                 # глобальный стоп
TRAIL_PCT=12
EARLY_TRAIL_PCT=4

# Bonding Scanner (19.06.2026 — ВСЁ ОТКЛЮЧЕНО):
BONDING_SCANNER_ENABLED=false   # W2 WebSocket навсегда выключен
BONDING_HOT_ENABLED=false       # ↓ с true → false (19.06.2026) — W3 только для запуска монет
BONDING_BUY_SOL=0.02
BONDING_MAX_SOL_DAILY=0.3

# Кошельки W2/W3 — ТОЛЬКО ЗАПУСК МОНЕТ (трейдинг слил SOL в 0):
# PUMPFUN_WALLET_ADDRESS=CFmHWpmQ...   (W2 — только launchTriple)
# PUMPFUN_WALLET_PRIVATE_KEY=...
# PUMPFUN_WALLET_ADDRESS_2=DJ8Tq8vi... (W3 — только launchTriple)
# PUMPFUN_WALLET_PRIVATE_KEY_2=...

# Birdeye:
BIRDEYE_MIN_HOLDERS=70
BIRDEYE_API_KEY=<rotated — see VPS .env>

# PumpPortal:
PUMP_PORTAL_ENABLED=true
PUMP_MIN_LIQUIDITY_USD=9000
PUMP_MIN_TOKEN_AGE_SEC=1200

# SOL Velocity Tracker — ОТКЛЮЧЁН НАВСЕГДА (19.06.2026):
SOL_VELOCITY_ENABLED=false      # ↓ с true → false. 26 трейдов, 1 победа (3.8%), -0.455 SOL
                                 # НЕ ВКЛЮЧАТЬ до backtesting на симуляции

# Token Launcher:
DAILY_LAUNCH_LIMIT=5            # max 5 монет в день через auto-launch цикл
MIN_HOLDERS_24H=10              # min holders через 24ч — иначе продать
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

### 2026-06 — GRAD/Score80/Whale стратегии принудительно отключены
**Решение:** Три стратегии с историческим P&L -54% до -100% заблокированы на уровне кода.
**Почему GRAD упускался при GRAD_HUNTER_ENABLED=false:** `graduation-scanner.ts` не читал этот флаг — WebSocket подключался и покупки делались. Фикс: добавлен явный чек внутри файла.
**Правило:** GRAD WebSocket остаётся подключён — нужен для pre-graduation exit (если наша velocity-позиция приближается к 588 SOL). Это не баг.

### 2026-06 — SOL Velocity Tracker vs DexScreener HOT poller
**Решение:** Velocity Tracker через PumpPortal WebSocket (реальное время) вместо DexScreener polling.
**Почему HOT/MOVER терял деньги:** DexScreener лаг 30-60с. Спайк происходил → через 60с DexScreener обновлялся → мы покупали ТОП спайка, откат = стоп-лосс.
**Velocity:** сумма solAmount за 60с, не delta marketCapSol — это реальный поток денег в кривую.
**Anti-whale:** пропуск если 1 покупка > 5 SOL — whale spike виден как искусственный памп, не органическое накопление.

### 2026-06 — Raydium FRESH-ONLY: только токены <6ч (19.06.2026)
**Решение:** `RAYDIUM_MAX_AGE_SEC=21600` (6ч) на VPS. До этого было 172800 (48ч).
**Данные из 79-трейд аудита:**
- FRESH (<6ч): 41.4% win rate, avg ROI 1.23x, net +0.012 SOL → ПРИБЫЛЬНО
- AGED (>6ч): 21.9% win rate, avg ROI 0.87x, net -0.049 SOL → УБЫТОЧНО
- T1 liq ($12-80k) FEAR режим: 46.2% win rate, avg ROI 1.25x → лучшее окно
**Почему aged проигрывает:** Meme токен делает главный памп в первые 2-4ч. После 6ч — либо уже 2-5x и на распределении, либо умер. Mы входим в момент, когда holders начинают фиксировать прибыль.
**Не менять** обратно на 48h без данных доказывающих прибыльность aged токенов.

### 2026-06 — X Viral Thresholds (19.06.2026)
**Решение:** Twitter API (Basic, $100/мес) запросы требуют min_retweets:500 / min_faves:5000.
**Почему:** "Популярный пост" = реально массовый. Ниже 500 RT / 5000 лайков = нишевый контент, не вирусный. Nitter RSS не возвращает engagement метрики вообще — only tweet text + pubDate. Synthetic engagement: Tier1=50k, Tier2=5k, Tier3=2k как прокси.
**До Basic плана:** Nitter RSS = информация о контенте без engagement. Фильтровать по narrative detection (AI_AGENT/DOG/PEPE/MEME и т.д.) — единственный доступный сигнал.
**Cutoff:** Tier1 = 24ч (elonmusk твитит редко), Tier2/3 = 12ч.

### 2026-06 — Hot-patch деплой при заполненном диске (17.06.2026)
**Проблема:** Docker build требует ~500MB+ временного пространства (node_modules содержит Next.js ~300MB). Диск 38GB = 100%.
**Фикс:** `tune2fs -m 2 /dev/sda1` → reserved 5%→2% → 291MB свободно (только для postgres, не для docker build).
**Hot-patch протокол:**
1. `scp -i ~/.ssh/gad_deploy file.ts root@VPS:/tmp/`
2. `docker cp /tmp/file.ts container:/usr/src/app/services/autobuy/src/`
3. `docker exec container sh -c 'cd /usr/src/app && npm --workspace services/autobuy run build'`
4. `docker restart container`
**ВАЖНО (29.06.2026 — РЕШЕНО):** при `docker compose up -d --no-deps` контейнер пересоздаётся из IMAGE → patch теряется. Решение: `docker-compose.override.yml` с bind mounts (см. ниже).

### 2026-06 — Patch persistence через docker-compose.override.yml (29.06.2026)
**Решение:** Все hot-patches хранятся в `/opt/gad-patches/` на хосте VPS. Bind mounts в `docker-compose.override.yml` монтируют эти директории поверх container dist/.
**Файл:** `/opt/gad-ai-terminal/GAD-AI-Terminal/docker-compose.override.yml`
```yaml
services:
  autobuy:      volumes: [/opt/gad-patches/autobuy-dist:/usr/src/app/services/autobuy/dist]
  base-scanner: volumes: [/opt/gad-patches/base-scanner-dist:/usr/src/app/services/base-scanner/dist]
  ton-scanner:  volumes: [/opt/gad-patches/ton-scanner-dist:/usr/src/app/services/ton-scanner/dist]
  polymarket-bot:
    entrypoint: ['node']
    command: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', 'services/polymarket-bot/src/index.ts']
    volumes: [/opt/gad-patches/polymarket-src:/usr/src/app/services/polymarket-bot/src]
```
**Patching process (теперь):**
1. Отредактировать файл на хосте: `/opt/gad-patches/<service>-dist/file.js` (или `/opt/gad-patches/polymarket-src/file.ts`)
2. `docker restart gad-ai-<service>` — готово. Recreate тоже не потеряет patch.
**Текущие патчи в patch dirs:**
- `autobuy-dist/auto-signal.js` → F&G < 10 (было < 13), `raydium-price-fetcher.js` → stub
- `base-scanner-dist/monitor.js` → использует `result.amount_out` вместо balance diff
- `ton-scanner-dist/scanner.js` → shadow_trades INSERT при dry-run
- `polymarket-src/keyword-matcher.ts` → новый файл (zero-cost matcher) + dead market filter + aiProb cap (29.06.2026)
- `polymarket-src/scorer.ts` → FAST PATH перед LLM + liquidity gate
- `polymarket-src/markets.ts` → liquidityUsd field added
- `futures-src/entry-strategy.ts` → Guard 6: EMA200 on 1H timeframe (29.06.2026)

### 2026-06 — EXTREME_FEAR порог снижен до 10 (29.06.2026, было 13)
**Решение:** `getMarketRegime()` возвращает EXTREME_FEAR только при F&G < 10 (было < 13).
**Почему:** F&G=12 → режим EXTREME_FEAR → все Raydium покупки заморожены. Но F&G=12-13 = обычный коррекционный страх, не чёрный лебедь. Настоящая капитуляция = F&G < 10 (исторически: COVID (15), FTX collapse (6)).
**Текущий F&G:** 12 → теперь попадает в FEAR zone → buys разрешены.
**Не менять** без явного решения владельца.

### 2026-06 — Raydium T2 заблокирован + HIGH_LIQ_RUG (29.06.2026)
**Решение:** `RAYDIUM_MAX_LIQUIDITY_USD=80000` на VPS. T2 ($80k-$300k liq) — 0% win rate в аудите 79 сделок.
**HIGH_LIQ_RUG guard:** Если `liq > $100k AND rug_risk >= 25` → skip. Правило: крупные пулы без сильного liqHealth score = whale trap (накопили ликвидность, готовятся к дампу).
**Данные:** T1 ($12-80k) FEAR режим 46.2% win rate. T2: ни одной прибыльной сделки за всю историю трейдинга.
**Не менять** обратно пока нет минимум 20 прибыльных T2 сделок.

### 2026-06 — Futures Guard 6: EMA200 на 1H (29.06.2026)
**Решение:** Дополнительный гвард в `entry-strategy.ts`: `fetchCandles1H(210)` → EMA200 на часовом графике.
**Почему:** LONG в макро-даунтренде (price < EMA200/1H) → контртрендовые позиции. Исторически 70%+ убыточных фьючерс-трейдов — контртрендовые. Это "Guard 6" = последний фильтр перед сигналом.
**Логика:** SHORT заблокирован если price > EMA200 (рынок в аптренде, шортить опасно). LONG заблокирован если price < EMA200 (рынок в даунтренде, лонговать опасно). Non-fatal: если 1H fetch упал → ошибка логируется, Guard 6 пропускается.
**Не убирать** этот гвард — он защищает от худшего класса сделок.

### 2026-06 — W3 Sniper F&G guard (29.06.2026)
**Решение:** `startW3Sniper()` проверяет `checkFGHistorySafe()` перед любой активностью.
**Почему:** W2/W3 кошельки несколько раз слили SOL до 0. Trейдинг на pump.fun разрешён только в устойчивом бычьем рынке (F&G > 45 × 5 дней подряд). Одиночный BULL день может быть dead cat bounce.
**Параметры:** alternative.me API `/fng/?limit=5` → проверяет все 5 значений > 45. Если хоть один < 45 → BLOCKED.
**Не включать** без явного подтверждения пользователя даже при F&G=50+.

### 2026-06 — Polymarket dead market filter + aiProb cap (29.06.2026)
**Проблема:** `entry_price=1.000` появлялся для рынков с priceYes≈0 (уже resolved). `aiProb` формула: `entryPrice*(1-strength*0.4) + strength*(0.55+strength*0.3)` при entryPrice=1.0 может давать aiProb=1.45 → EV=0.45 (математически > 0 но физически невозможно).
**Фикс 1 (dead market):** `if (entryPrice < 0.05 || entryPrice > 0.95) continue;` перед EV-расчётом.
**Фикс 2 (aiProb cap):** `Math.min(rawAiProb, 0.95)` — вероятность не может быть > 95%. При entryPrice > 0.95 → dead market filter поймает раньше.
**Фикс 3 (sentiment gate):** `(bull + bear) >= 1` для MEDIUM confidence — направление без sentiment слов = случайный выбор YES/NO.
**Не убирать** dead market filter — маркеты с priceYes < 5% или > 95% = нет ликвидности, нет смысла.

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

### Диск 100% — образами, не кешем (17.06.2026)
Диск 38GB заполнен 14 запущенными контейнерами (~25GB rootfs) + другие проекты (auto-search: 7GB, shopify-bot: 4GB).
`docker builder prune -af` = 0B (кеш уже пуст). Docker прун не помогает когда образы используются контейнерами.
Временный фикс: `tune2fs -m 2 /dev/sda1` — снизить reserved blocks с 5% до 2% (+291MB для non-root).
PostgreSQL падает с "could not write lock file postmaster.pid: No space left on device" — postgres user не root, нет reserved blocks.
**Решение:** добавить Hetzner Volume 20GB (Volumes → Create, mount to /mnt/data, docker data-root на /mnt/data) ИЛИ перейти на CPX41 (160GB диск).
**RAM увеличение ≠ диск увеличение** — это разные ресурсы в Hetzner. Изменить RAM в настройках сервера не изменяет размер диска /dev/sda1.

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

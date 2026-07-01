# Base Network Scanner — Настройка и Состояние

> Документ описывает текущую конфигурацию Base network автоботa.
> Обновлено: **01.07.2026** — Price-unit fix, Clanker API, tax 15→10%, GoPlus JS fix

---

## Кошелёк B1

| Параметр | Значение |
|---|---|
| Alias | B1 |
| Публичный ключ | `0x88704Df21Ac8bFb017ef37b42FC3BA7Ce80F61Bd` |
| Env-переменная | `BASE_WALLET_PUBLIC_KEY / BASE_WALLET_PRIVATE_KEY` |
| Текущий баланс | **Проверить через Basescan** (пополнить до 0.02+ ETH для 10+ трейдов) |
| Минимум для торговли | **0.003 ETH** (0.0015 трейд + 0.0004 gas reserve × 2) |
| Рекомендуется | **0.03-0.05 ETH** (15-25 трейдов в запасе) |

> **ВАЖНО:** B1 = ТОЛЬКО Base scanner. Сеть Base (не Ethereum mainnet!). Никакого Solana трейдинга.

---

## Текущий Режим

| Параметр | Значение |
|---|---|
| `BASE_AUTO_BUY` | **`true`** — LIVE торговля включена |
| `BASE_BUY_ETH` | `0.0015 ETH` (~$4.10 за трейд, с 01.07.2026) |
| `BASE_MAX_POSITIONS` | `2` (было 3) |
| Сервис | `gad-ai-base-scanner`, port 4005 |
| Статус | Работает 24/7, сканирует каждые 30с |
| Gas reserve | `0.0004 ETH` (~$1.10) — фиксированный резерв на 2 TX |

---

## Текущие Фильтры (VPS .env — обновлено 01.07.2026)

```bash
# Размер позиции — ИЗМЕНЕНО 01.07
BASE_BUY_ETH=0.0015          # ↑ с 0.001 → 0.0015 ETH (~$4.10) за трейд
BASE_MAX_POSITIONS=2          # ↓ с 3 → 2 (меньше exposure при тестировании)
BASE_MAX_ETH_DAILY=0.1        # max 0.1 ETH в день

# Возраст токена
BASE_MIN_AGE_SEC=120          # минимум 2 мин (новее = honeypot риск)
BASE_MAX_AGE_SEC=172800       # максимум 48 часов

# Ликвидность — ИЗМЕНЕНО 01.07
BASE_MIN_LIQUIDITY_USD=8000   # ↑ с 5000 → 8000 (меньше slippage на мелкой ликвидности)
BASE_MAX_LIQUIDITY_USD=500000 # максимум $500k

# Mcap — КРИТИЧЕСКИЙ ФИЛЬТР — ИЗМЕНЕНО 01.07
BASE_MIN_MCAP_USD=5000        # выше $5k (не мёртвый токен)
BASE_MAX_MCAP_USD=350000      # ↓ с 2000000 → 350000 — только pre-pump фаза

# Momentum
BASE_MIN_PC1H=3               # минимум +3% за 1ч
BASE_MAX_PC1H=200             # максимум +200% за 1ч
BASE_MAX_PC1H_FRESH=1000      # для токенов < 1h — без ограничения сверху
BASE_MIN_PC5M=2               # минимум +2% за 5мин
BASE_MIN_VOL_LIQ_RATIO=10    # vol/liq ratio ≥ 10%
BASE_MAX_BUY_SELL_RATIO=4.0  # B/S ratio ≤ 4x

# Активность
BASE_MIN_BUYS_H1=2            # минимум 2 покупки за час

# Sell параметры — ИЗМЕНЕНО 01.07
BASE_STOP_LOSS_PCT=7          # ↓ с 8 → 7% стоп-лосс
BASE_TRAIL_PCT=10             # ↓ с 12 → 10% trail stop
BASE_EARLY_TRAIL_PCT=3        # early trail активируется при +3%
BASE_TIME_LIMIT_SEC=7200      # ↓ с 43200 (12h) → 7200 (2h) — форс-продажа через 2ч

# Moonbag настройки
BASE_MOONBAG_MULT=2.5         # при 2.5x — снять time limit, расширить trail
BASE_MOONBAG_TRAIL_PCT=15     # trail 15% после достижения 2.5x

# Safety
BASE_MIN_SAFE_SCORE=30        # минимум 30/100 по Basescan safety
BASE_GOPLUS_MIN_AGE_SEC=1200  # GoPlus block для токенов < 20 мин без данных

# Scan interval
BASE_SCAN_INTERVAL_SEC=30     # сканирование каждые 30 секунд
BASE_POLL_INTERVAL_MS=3000    # мониторинг позиций каждые 3 секунды
```

---

## TP Уровни (F&G Динамические — 01.07.2026)

```
F&G < 10  (EXTREME_FEAR):  TP1=1.08x→90% | TP2=1.20x→10%   → микро-скальп, быстрый выход
F&G 10-20 (DEEP_FEAR):     TP1=1.10x→85% | TP2=1.30x→15%   → тайтовые TPs
F&G 20-45 (FEAR):          TP1=1.25x→80% | TP2=2.00x→20%   → консервативный выход
F&G > 45  (NEUTRAL/BULL):  TP1=1.40x→70% | TP2=2.50x→30%   → дать расти
```

> TP пересчитываются при каждом поллинге из F&G API (alternative.me, кеш 30 мин).
> Начиная с 2.5x: moonbag режим — time limit снимается, trail расширяется до 15%.

---

## GoPlus Safety Check

**Поведение (28.06 — JS-баг исправлен 01.07.2026):**

```
Возраст    → Поведение
< 20 мин   → BLOCK (GoPlus no data = слишком рано, honeypot risk)
20 мин+    → PASS к swap simulator (GoPlus no data после 20 мин = нормально)
Любой      → GoPlus данные есть → полный check (honeypot/tax/modifiable)
```

**Баг (исправлен 01.07):** Compiled `security-shield.js` имел старый порог `< 3600` (1h).
TS файл имел `< 1200` (20 мин), но JS не пересобирался. Все токены 20мин-1ч блокировались без причины.
Фикс: JS вручную обновлён и задеплоен в `/opt/gad-patches/evm-src/security-shield.js`.

---

## Слои Защиты от Honeypot

```
Layer 1: Contract verification (Basescan) — пропускается если нет BASESCAN_API_KEY
Layer 2: GoPlus Labs API — honeypot, sell-block, tax check
         Блок только для < 20 мин старых токенов без GoPlus данных
Layer 3: Virtual Swap Simulator — РЕАЛЬНАЯ СИМУЛЯЦИЯ buy→sell
         Порог: 10% (был 15%) — ловит hidden 10-15% tax ДО GoPlus индексации
         Fail-OPEN для V3-only пулов (Clanker, нет V2 path) — не блокируем
         BLOCK только: HIGH_TAX_DETECTED, SELL_REVERT_DETECTED
         PASS-THROUGH: SIMULATION_ERROR, ZERO_BUY_SIMULATION (V2 router не поддерживает V3)
Layer 4: Post-buy balance check — если 0 токенов после buy → HONEYPOT зафиксирован
```

---

## Источники Токенов (Discovery)

| Источник | Частота | Что возвращает |
|---|---|---|
| DexScreener token-profiles/latest | каждые 30с | Последние листинги Base |
| DexScreener search "base meme new" | каждые 30с | Мем-токены по поиску |
| DexScreener search "clanker" | каждые 30с | Clanker/Farcaster токены |
| DexScreener search "virtual base agent" | каждые 30с | AI agent токены |
| **Clanker API** (добавлено 01.07.2026) | **каждые 2 мин** | Свежие Clanker монеты с CA (limit=20, parallel DexScreener enrichment) |
| **fetchDexScreenerFresh()** 5 запросов | 1 раз в 5 мин | "base launch today", "believe.app base", "clanker launch" и др. |
| GeckoTerminal new_pools + Uniswap V3 + Aerodrome | 1 раз в 5 мин | Свежие пулы (rate limited) |

**Clanker API детали:**
- URL: `https://www.clanker.world/api/tokens?sort=desc&page=1&limit=20`
- Cooldown: 2 мин между запросами (не каждый 30с цикл)
- Обогащение: если есть `pool_address` → DexScreener `/pairs/base/{pool}`, иначе `/tokens/{ca}`
- Параллельно: `Promise.allSettled()` для 10 токенов (~5с max, было 50с последовательно)
- Cutoff: токены старше 48ч игнорируются

---

## Как Работает Бот (Полный Флоу)

### Сканирование (каждые 30 секунд)

```
fetchDexScreener()      — DexScreener profiles + 3 поиска
fetchGeckoTerminal()    — GeckoTerminal new pools (1 раз в 5 мин)
fetchDexScreenerFresh() — 5 targeted DexScreener поисков (1 раз в 5 мин)
fetchClankerApi()       — Clanker.world API (1 раз в 2 мин, параллельный enrich)
    ↓
Дедупликация по contract_address
    ↓
passesFilter() — проверяет все параметры:
  1. Mcap: $5k - $350k  (блокирует крупные и мёртвые токены)
  2. Age: 2мин - 48h
  3. Liq: $8k - $500k
  4. Tradeable DEX: Uniswap V2/V3/V4, Aerodrome
  5. PC1h: 3% - 200% для токенов >1h (3% - 1000% для <1h fresh)
  6. PC5m ≥ 2%
  7. Vol/Liq ratio ≥ 10%
  8. Buy/Sell ratio ≤ 4.0x
  9. Buys in H1 ≥ 2
  10. isChainImpersonator() — SOL/cbXRP/cbADA/... → SKIP
    ↓
checkTokenSafety() через Basescan — safe_score ≥ 30
    ↓
isTokenSafeToTrade() — EVM Shield (GoPlus)
  → BLOCK если < 20 мин И GoPlus нет данных
  → BLOCK если honeypot / modifiable-tax / excessive-tax (>12% Base)
    ↓
simulateEvmSwap() — Virtual swap simulation (V2 router, 10% max loss)
  → BLOCK если HIGH_TAX_DETECTED или SELL_REVERT_DETECTED
  → PASS если SIMULATION_ERROR / ZERO_BUY (V3-only pool, Clanker)
    ↓
BASE_AUTO_BUY=true → buyToken() через Uniswap V3 / Aerodrome
  → Записывается в base_positions
    ↓
Post-buy: balance check (3с после buy)
  → HONEYPOT если 0 токенов получено
```

### Мониторинг Позиций (каждые 3 секунды)

```
getOpenPositions() из базы
    ↓
getCurrentPriceEth() через DexScreener
  → ТОЛЬКО ETH/WETH-quoted пары (не USDC!)
  → Fallback на любую пару если нет ETH-пары
    ↓
Moonbag check: trail_high ≥ 2.5x entry → moonbag mode
Time limit (пропускается для moonbag): age > 2h → TIME_LIMIT sell 100%
Stop loss: price ≤ entry * (1 - 7%) → STOP_LOSS sell 100%
Trail stop: trail_stop = trail_high * (1 - 10%) → TRAIL_STOP sell 100%
  early trail: активен при mult > 1.03 (даже до TP1)
  moonbag trail: trail_stop = trail_high * (1 - 15%)
TP check (динамический по F&G):
  mult ≥ TP1 → продать TP1_PCT%, slippage 3%
  mult ≥ TP2 (последний) → продать 100% остатка, slippage 3%
    ↓
Sell result: amount_out из WETH Withdrawal event в TX receipt (НЕ balance diff)
```

---

## Impersonator Guard (в коде — не env)

Токены в чёрном списке (блокируются ВСЕГДА):
```
SOL, BNB, ADA, XRP, AVAX, MATIC, DOT, TRX, NEAR, SUI, ATOM, FTM, ETH, BTC, WBTC...
CB* префикс (cbXRP, cbADA, cbBTC, cbDOGE...) — ВСЕ заблокированы
W* префикс для L1 токенов (WBTC, WXRP, WADA...)
```

---

## Исторические Результаты (до 29.06.2026)

| Токен | Вложено | Получено | P&L | Причина |
|---|---|---|---|---|
| VIBES | 0.002 ETH | 0.001972 ETH | -$0.10 | TRAIL_STOP ✅ |
| SOL (скам) | 0.002 ETH | 0 | -$6.80 | NO_TOKENS (honeypot) |
| SOL (скам) ×2 | 0.003 ETH | 0 | -$10.20 | total_sold_eth=0 баг |
| cbXRP (honeypot) | 0.001 ETH | 0 | -$3.40 | MANUAL_CLEANUP |
| cbADA, cbXRP | 0.002 ETH | 0 | -$6.80 | TIME_LIMIT (wrong token) |

**Итого:** -0.008028 ETH (-80.3%) — **все убытки от неправильных токенов + баги, теперь исправлено**

> **ЧИСТЫЕ ДАННЫЕ только с 01.07.2026** — price unit bug, GoPlus JS, Clanker блок — всё исправлено

---

## Текущее Состояние (01.07.2026)

| Параметр | Значение |
|---|---|
| Статус | LIVE (BASE_AUTO_BUY=true) |
| Открытых позиций | 0 |
| Основные баги | ✅ Все 5 исправлены (01.07.2026) |
| Источники | DexScreener + GeckoTerminal + Clanker API (новый) |
| Следующий шаг | Накопить 20+ чистых трейдов с 01.07 → оценить WR |

---

## Что Нужно Сделать

### Срочно
- [ ] **Пополнить B1 кошелёк** — `0x88704Df21Ac8bFb017ef37b42FC3BA7Ce80F61Bd`
  - Нужно: 0.03+ ETH на сети **Base** (не Ethereum mainnet!)
  - При 0.0015/трейд × 2 позиции = 0.003 активных + gas

### Следующие шаги
- [ ] Накопить 20+ чистых трейдов с 01.07.2026 → оценить win rate
- [ ] Если WR ≥ 40% → поднять `BASE_BUY_ETH=0.003`
- [ ] Если WR < 30% → ужесточить фильтры (поднять MIN_SAFE_SCORE, MIN_LIQ)
- [ ] Возможно: `BASESCAN_API_KEY` для Layer 1 contract verification (сейчас пропускается)

---

## Команды для Проверки

```bash
# Текущие открытые позиции
curl http://65.21.159.255:4005/base/positions

# Статистика P&L
curl http://65.21.159.255:4005/base/trades

# Логи сканера (последние 50 строк)
ssh -i ~/.ssh/gad_deploy root@65.21.159.255 "docker logs gad-ai-base-scanner --tail=50"

# Проверить баланс кошелька B1
# (в браузере) https://basescan.org/address/0x88704Df21Ac8bFb017ef37b42FC3BA7Ce80F61Bd

# Патч-файлы на VPS
ssh -i ~/.ssh/gad_deploy root@65.21.159.255 "ls /opt/gad-patches/evm-src/ && ls /opt/gad-patches/base-scanner-dist/"
```

---

## История Фиксов

| Дата | Фикс | Проблема |
|---|---|---|
| ~21.06 | `isChainImpersonator()` guard | SOL/cbXRP/cbADA попадали в покупки |
| ~21.06 | `BASE_MAX_MCAP_USD=2000000` | Крупные токены проходили фильтр |
| ~22.06 | `BASE_MIN_LIQUIDITY_USD=5000` (был 15000) | Слишком мало кандидатов |
| ~22.06 | `BASE_MIN_BUYS_H1=2` (был 5) | Слишком строгий фильтр |
| ~23.06 | `BASE_MAX_PC1H=200` (был 30%) | SKIBIDI +677% блокировался после 1ч |
| **28.06** | `BASE_MAX_AGE_SEC=172800` (был 86400) | Мало кандидатов в discovery |
| **28.06** | `BASE_MIN_PC5M=2` (был 5%) | Слишком строгий фильтр |
| **28.06** | GoPlus block: < 1h → < 20 мин | SKIBIDI/LARP (12-16 мин) вечно блокировались |
| **28.06** | Добавлен `fetchDexScreenerFresh()` | 5 targeted поисков "base launch today" и др. |
| **29.06** | **БАГ: `total_sold_eth=0` после TP** | balance diff с RPC race. Фикс: `result.amount_out` из WETH Withdrawal event в receipt |
| **01.07** | **БАГ КРИТИЧНО: Price unit confusion** | `getCurrentPriceEth()` брал USDC пару (самую ликвидную). priceNative в USDC паре = USD цена (~$69), не ETH (~0.001). 63000x ложный множитель → TP2@2x за 0 секунд → sell возвращал 0 ETH. Фикс: фильтрация ETH/WETH-quoted пар в monitor.ts и scanner.ts |
| **01.07** | **Clanker API прямая интеграция** | Clanker токены появляются в DexScreener с задержкой 5-15 мин. Прямой API даёт CA сразу. Параллельный enrichment: `Promise.allSettled()` 10 токенов одновременно (было 50с → ~5с) |
| **01.07** | **Tax threshold: 15%→10%** | `MAX_TOTAL_TAX_PCT` в swap-simulator.ts/js. Ловит hidden 10-15% tax ДО GoPlus индексации |
| **01.07** | **Swap-sim fail-open для V3-only** | Clanker = V3-only пулы → V2 router → SIMULATION_ERROR → все Clanker блокировались 2ч. Фикс: fail-open для SIMULATION_ERROR/ZERO_BUY, block только HIGH_TAX + SELL_REVERT |
| **01.07** | **БАГ: security-shield.js старый порог** | Compiled JS имел `< 3600` (1h). TS был `< 1200` (20 мин). JS не пересобирался. Все токены 20мин-1ч блокировались без причины. Фикс: JS обновлён вручную → /opt/gad-patches/evm-src/ |
| **01.07** | **Параметры .env обновлены** | BUY_ETH 0.001→0.0015, MAX_POSITIONS 3→2, MIN_LIQ 5k→8k, MAX_MCAP 2M→350k, TIME_LIMIT 12h→2h, STOP 8→7%, TRAIL 12→10% |

---

## Критические Правила

1. **B1 = ТОЛЬКО Base scanner** — никогда не переводить с него ETH вручную
2. **BASE_AUTO_BUY=true** — УЖЕ В LIVE РЕЖИМЕ
3. **SOL/cbXRP/cbADA** — ЗАБЛОКИРОВАНЫ impersonator guard в коде (не env)
4. **Mcap ≤ $350k** — pre-pump фаза только (с 01.07.2026)
5. **Price в ETH** — всегда ETH/WETH-quoted пары. USDC пара = USD цена = 63000x ложный TP
6. **Clanker токены** — V3-only, swap-sim fail-open, проходят GoPlus + post-buy check
7. **Не увеличивать BASE_BUY_ETH** до 10+ чистых profitable трейдов с 01.07.2026
8. **GoPlus block = 20 мин** — JS и TS должны СОВПАДАТЬ. Если компилируешь снова — проверить threshold
9. **Hot-patch:** файлы в `/opt/gad-patches/evm-src/` и `/opt/gad-patches/base-scanner-dist/` override container через bind mount. После изменения: `scp file → /opt/gad-patches/... → docker restart gad-ai-base-scanner`

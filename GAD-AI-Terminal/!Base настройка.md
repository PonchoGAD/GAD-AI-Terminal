# Base Network Scanner — Настройка и Состояние

> Документ описывает текущую конфигурацию Base network автоботa.
> Обновлено: 28.06.2026

---

## Кошелёк B1

| Параметр | Значение |
|---|---|
| Alias | B1 |
| Публичный ключ | `0x88704Df21Ac8bFb017ef37b42FC3BA7Ce80F61Bd` |
| Env-переменная | `BASE_WALLET_PUBLIC_KEY / BASE_WALLET_PRIVATE_KEY` |
| Текущий баланс | **0.00277 ETH (~$9.40)** ⚠️ |
| Минимум для торговли | **0.003 ETH** (1 трейд + gas fees) |
| Рекомендуется | **Пополнить до 0.02-0.05 ETH** для нормальной работы |

> **ВАЖНО:** Кошелёк B1 используется ТОЛЬКО Base scanner — никакого Solana трейдинга на этот адрес.

---

## Текущий Режим

| Параметр | Значение |
|---|---|
| `BASE_AUTO_BUY` | **`true`** — LIVE торговля уже включена |
| `BASE_BUY_ETH` | `0.001 ETH` (~$3.40 за трейд) |
| Сервис | `gad-ai-base-scanner`, port 4005 |
| Статус | Работает 24/7, сканирует каждые 30с |

> **Бот уже в реальной торговле!** `BASE_AUTO_BUY=true` был выставлен ранее. Не нужно "запускать" — он уже работает.

---

## Исторические Результаты (до 28.06.2026)

### Все закрытые позиции (7 trades)

| Токен | Вложено | Получено | P&L | Причина | Дата |
|---|---|---|---|---|---|
| VIBES | 0.002 ETH | 0.001972 ETH | -$0.10 | TRAIL_STOP ✅ | 19.06 |
| SOL (скам) | 0.002 ETH | 0 | -$6.80 | NO_TOKENS ❌ | 19.06 |
| SOL (скам) | 0.002 ETH | 0 | -$6.80 | TP2@2x (sell fail) ❌ | 20.06 |
| SOL (скам) | 0.001 ETH | 0 | -$3.40 | TP2@2x (sell fail) ❌ | 21.06 |
| cbXRP (honeypot) | 0.001 ETH | 0 | -$3.40 | MANUAL_CLEANUP ❌ | 21.06 |
| cbADA (wrong token) | 0.001 ETH | 0 | -$3.40 | TIME_LIMIT ❌ | 22.06 |
| cbXRP (wrong token) | 0.001 ETH | 0 | -$3.40 | TIME_LIMIT ❌ | 23.06 |

**Итого:** Вложено 0.010 ETH → Возвращено 0.001972 ETH → **Убыток: -0.008028 ETH (-80.3%)**

### Почему такие результаты?

**ВСЕ убытки от неправильных токенов**, которые теперь ЗАБЛОКИРОВАНЫ:
- `SOL` на Base = honeypot-скам, который имитирует Solana SOL. При покупке токены не поступали (NO_TOKENS) или продажа возвращала 0 ETH из-за hidden sell-block.
- `cbXRP`, `cbADA` = Coinbase-wrapped assets на $94-100M mcap. Это не meme coins — неправильная стратегия.

Эти токены попали в портфель до того, как был добавлен `isChainImpersonator()` guard и тайтед mcap фильтр.

**Единственный "честный" трейд — VIBES** (-0.000028 ETH = -1.4%). Почти breakeven — стратегия TP/trail stop работала правильно.

### Shadow Mode результаты (dry-run период, 22-24 июня)

| Токен | Mcap | Liq | PC1H | Вывод |
|---|---|---|---|---|
| KRN | - | $65k | +486% | ✅ Правильный тип — мем-монета на Base |
| B20 | $150-250k | $90-120k | 36-55% | ✅ Правильный тип |
| WENDEEZ | $52k | - | - | ✅ Мем-монета на Base |
| BASIS | $77k | - | - | ✅ Мем-монета на Base |
| TOM LEE | $38k | - | - | ✅ Мем-монета на Base |
| Buildr | $100k | - | - | ✅ Мем-монета на Base |

Shadow режим нашёл правильные типы токенов! **Фильтры работают.**

---

## Текущие Фильтры (VPS .env)

```bash
# Размер позиции
BASE_BUY_ETH=0.001           # 0.001 ETH (~$3.40) за трейд
BASE_MAX_POSITIONS=3          # максимум 3 одновременных позиции

# Возраст токена
BASE_MIN_AGE_SEC=120          # минимум 2 мин (новее = honeypot риск)
BASE_MAX_AGE_SEC=172800       # максимум 48 часов

# Ликвидность
BASE_MIN_LIQUIDITY_USD=5000   # минимум $5k
BASE_MAX_LIQUIDITY_USD=500000 # максимум $500k

# Mcap — КЛЮЧЕВОЙ ФИЛЬТР (блокирует ВСЕ установленные токены)
BASE_MIN_MCAP_USD=1000        # выше $1k (не мёртвый токен)
BASE_MAX_MCAP_USD=2000000     # НЕ БОЛЬШЕ $2M — только мем-монеты на старте

# Momentum
BASE_MIN_PC1H=5               # минимум +5% за 1ч
BASE_MAX_PC1H=30              # максимум +30% за 1ч (не покупаем уже пампанувший)
BASE_MIN_PC5M=1               # минимум +1% за 5мин

# Качество трейда
BASE_MIN_BUYS_H1=2            # минимум 2 покупки за час
BASE_MIN_SAFE_SCORE=30        # минимум 30/100 по Basescan safety check
BASE_STOP_LOSS_PCT=8          # стоп-лосс 8%
BASE_TRAIL_PCT=12             # trail stop 12%
BASE_TIME_LIMIT_SEC=43200     # форс-продажа через 12 часов
```

### Impersonator Guard (в коде — не env)

Токены в чёрном списке (блокируются ВСЕГДА):
```
SOL, BNB, ADA, XRP, AVAX, MATIC, DOT, TRX, NEAR, SUI, ATOM, FTM, ETH, BTC, WBTC...
CB* префикс (cbXRP, cbADA, cbBTC, cbDOGE...) — ВСЕ заблокированы
W* префикс для L1 токенов (WBTC, WXRP, WADA...)
```

---

## Как работает бот (полный флоу)

### Сканирование (каждые 30 секунд)

```
fetchDexScreener() + fetchGeckoTerminal()
    ↓
Дедупликация по contract_address (берём с наибольшей ликвидностью)
    ↓
passesFilter() — проверяет все параметры:
  1. Mcap: $1k - $2M  (блокирует ВСЕ крупные токены)
  2. Age: 2мин - 48h
  3. Liq: $5k - $500k
  4. Tradeable DEX: Uniswap V2/V3/V4, Aerodrome
  5. PC1h: 5% - 30% (7-10% для свежих < 1h)
  6. Vol/Liq ratio ≥ 10%
  7. Buy/Sell ratio ≤ 4.0x
  8. Buys in H1 ≥ 2
    ↓
checkTokenSafety() через Basescan API
  → safe_score ≥ 30 (honeypot check, налоги, LP lock)
    ↓
BASE_AUTO_BUY=true → buyToken() через Uniswap V3 / Aerodrome
  → Записывается в base_positions
```

### Мониторинг позиций (каждые 3 секунды)

```
getOpenPositions() из базы
    ↓
getCurrentPriceEth() через DexScreener
    ↓
Вычисляем мультипликатор = current_price / entry_price
    ↓
Решение:
  mult ≥ 1.25x → TP1: продать 80% (TRAIL_STOP→pos only 20% остаётся)
  mult ≥ 2.0x  → TP2: продать оставшееся 20%
  mult ≤ -8%   → STOP_LOSS: продать 100%
  trail_high * (1 - 12%) → TRAIL_STOP: продать 100%
  age ≥ 12h    → TIME_LIMIT: продать 100%
    ↓
sellToken() через Uniswap V3 (с V2 fallback если tick empty)
```

### TP Стратегия (BASE_TPS)

```
TP1: цена достигла 1.25x → продать 80% позиции
TP2: цена достигла 2.0x  → продать оставшиеся 20%

Moonbag режим: если цена достигла 2.5x → trail widened до 15%
               → снимается time limit (дать вырасти дальше)
```

---

## Источники токенов (Discovery)

| Источник | Статус | Что возвращает |
|---|---|---|
| DexScreener token-profiles/latest | ✅ Работает | Последние листинги Base |
| DexScreener search "base meme new" | ✅ Работает | Мем-токены по поиску |
| DexScreener search "clanker" | ✅ Работает | Clanker/Farcaster токены |
| DexScreener search "virtual base agent" | ✅ Работает | AI agent токены |
| GeckoTerminal new_pools | ⚠️ Rate limited | 0 результатов (429 rate limit) |
| GeckoTerminal Uniswap V3 pools | ⚠️ Rate limited | 0 результатов |

**Текущая проблема:** GeckoTerminal возвращает 0 токенов из-за rate limiting (VPS IP). Все 64 кандидата от DexScreener — это старые/крупные токены.

**Причина отсутствия трейдов последних 5 дней:** Не баг, а просто тихий период для новых Base meme launches. DexScreener показывает одни и те же старые токены.

---

## Текущее Состояние (28.06.2026)

| Параметр | Значение |
|---|---|
| Статус | LIVE (BASE_AUTO_BUY=true) |
| Открытых позиций | 0 |
| Закрытых позиций | 7 (все — неправильные токены до фиксов) |
| Net P&L | -0.008028 ETH (-$27.30) |
| Win Rate | 0/7 = 0% (но все 7 трейдов — заблокированные типы токенов) |
| Последний трейд | 23.06.2026 |
| Активность сейчас | Низкая — нет новых Base meme launches < 48h |

---

## Что нужно сделать

### Срочно
- [ ] **Пополнить B1 кошелёк** — `0x88704Df21Ac8bFb017ef37b42FC3BA7Ce80F61Bd`
  - Текущий баланс: 0.00277 ETH (~$9.40) — хватит на 2-3 трейда
  - Рекомендуется: пополнить до **0.02-0.05 ETH** (5-15 трейдов)
  - Это ETH на сети Base (не Ethereum mainnet!)

### Для улучшения discovery
- [ ] Добавить Clanker API как источник (`https://clanker.world/api/...`) — основной launchpad мем-монет на Base через Farcaster
- [ ] Добавить резервный GeckoTerminal с другим IP / прокси для `new_pools`

### Для увеличения размера позиции
> Не рекомендуется увеличивать с 0.001 ETH до получения **5+ чистых прибыльных трейдов** через новые фильтры.
> Shadow trades показывают правильный тип токенов (WENDEEZ, BASIS, KRN) — ждём их появления в live режиме.

---

## Параметры для Увеличения Размера (когда придёт время)

| Сценарий | BASE_BUY_ETH | Требования |
|---|---|---|
| Текущий (консервативный) | 0.001 ETH ($3.40) | Базовый уровень |
| Умеренный | 0.003 ETH ($10.20) | После 5 прибыльных чистых трейдов |
| Активный | 0.005 ETH ($17.00) | После 10 прибыльных, win rate ≥ 40% |
| Агрессивный | 0.010 ETH ($34.00) | После 20 трейдов, win rate ≥ 50% |

---

## Команды для проверки

```bash
# Текущие открытые позиции
curl http://65.21.159.255:4005/base/positions

# Статистика P&L
curl http://65.21.159.255:4005/base/trades

# Логи сканера (последние 50 строк)
ssh -i ~/.ssh/gad_deploy root@65.21.159.255 "docker logs gad-ai-base-scanner --tail=50"

# Проверить баланс кошелька B1
# (в браузере) https://basescan.org/address/0x88704Df21Ac8bFb017ef37b42FC3BA7Ce80F61Bd
```

---

## История фиксов

| Дата | Фикс | Проблема |
|---|---|---|
| ~21.06 | Добавлен `isChainImpersonator()` guard | SOL/cbXRP/cbADA попадали в покупки |
| ~21.06 | Снижен `BASE_MAX_MCAP_USD=2000000` | Крупные токены проходили фильтр |
| ~22.06 | `BASE_MIN_LIQUIDITY_USD=5000` (был 15000) | Слишком мало кандидатов |
| ~22.06 | `BASE_MIN_BUYS_H1=2` (был 5) | Слишком строгий фильтр активности |
| ~23.06 | `BASE_MAX_PC1H=30` (был 100%) | B20 +55% → -47% после покупки |

---

## Критические правила

1. **B1 используется ТОЛЬКО для Base scanner** — никогда не переводить с него ETH вручную
2. **BASE_AUTO_BUY=true** — УЖЕ В LIVE РЕЖИМЕ, не нужно "включать"
3. **SOL/cbXRP/cbADA** — ЗАБЛОКИРОВАНЫ impersonator guard в коде (не env)
4. **Mcap ≤ $2M** — абсолютный барьер против всех крупных/неправильных токенов
5. **Не увеличивать BASE_BUY_ETH** до получения 5+ чистых profitable трейдов

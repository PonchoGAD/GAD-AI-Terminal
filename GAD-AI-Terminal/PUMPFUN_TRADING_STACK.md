# PumpFun Trading Stack — GAD AI Terminal
> Полная архитектура + стратегия торговли на bonding curve pump.fun.
> Статус: **СКОНФИГУРИРОВАНО, ТОРГОВЛЯ ОТКЛЮЧЕНА** (`BONDING_SMART_ENABLED=false`)
> Дата: 19.06.2026 | Основано на анализе 79 сделок + spec от владельца

---

## Итог 79 сделок (до внедрения нового стека)

| Причина убытка | Сделок | Потери |
|---|---|---|
| TX failures (VersionedTx bug, до 14.06) | ~54 | -0.54 SOL |
| DexScreener lag 30-60s (покупка на пике) | ~20 | -0.37 SOL |
| GRAD стратегия (покупка перед дампом листинга) | 9 | -0.112 SOL |
| **Итого** | **79** | **-1.077 SOL (-79%)** |

**Корневые причины:**
1. Технически неверный fallback в VersionedTransaction.deserialize() → sell TX не проходили
2. DexScreener обновляется с задержкой 30-60с → покупаем на вершине спайка
3. GRAD = покупка В МОМЕНТ листинга на Raydium = покупка перед техническим дампом 40-70%

---

## Новый стек: `bonding-smart.ts`

### Архитектура

```
PumpPortal WebSocket (0ms задержка)
        │
        ├── txType: 'create' → TokenState: devWallet, socials, bundleDetected
        │                     fetchMetadataSocials() → hasTwitter/hasTelegram
        │
        ├── txType: 'buy'/'sell' → TradeEvent в rolling window
        │                          updateVelocity() ← sum(solAmount, 60s)
        │                          updateUniqueBuyers() ← Set(buyers, 5min)
        │
        └── handleTrade() → shouldBuy() → 8 фильтров → doBuy() → PumpPortal
                 │
                 └── monitorPositions() (1s poll)
                           ├── Dynamic TP: +50%→sell50%, +100%→sell50%
                           ├── Trailing stop: -20% от пика
                           ├── Stop-loss: -10% от входа
                           ├── Time exit: 120s + vol < 1 SOL/60s
                           └── Dump guard: sellVol > buyVol×3 → exit 15% slip
```

### Почему WebSocket, а не DexScreener

| | DexScreener API | PumpPortal WebSocket |
|---|---|---|
| Задержка | 30-60 секунд | 0 мс (реальное время) |
| Источник | Агрегированные данные | Прямые TX из блокчейна |
| Уникальные покупатели | Нет | Да (traderPublicKey) |
| Объём в реальном времени | Нет (кешированный) | Да (каждый TX) |
| Dev wallet | Нет | Да (из create event) |
| Metadata URI | Нет | Да (из create event) |

**Ключевой инсайт**: при DexScreener polling `pc5m=15%` — этот памп уже закончился 30-60 секунд назад. При WebSocket мы видим каждый buy в момент подтверждения.

---

## 8 фильтров входа (shouldBuy)

### 1. Возраст токена
```
MAX_TOKEN_AGE_SEC = 1800 (30 минут)
```
- Старше 30 минут = первичное окно движения закрылось
- Держатели с первых минут уже фиксируют прибыль

### 2. Bundle Detection — без снайпинга дева
```
bundleDetected = devSolBuy > GRADUATION_SOL × 10% = 58.8 SOL
```
- Дев купил > 10% bonding curve в транзакции создания = bundle
- Такие токены обычно дампятся в первые 5 минут
- `bundleDetected: true` → полный пропуск

### 3. Социальные сети (из метадаты)
```
ТРЕБУЕТСЯ: hasTwitter OR hasTelegram
```
- Токены без Twitter/Telegram в 99% умирают в первые 3 минуты
- Метадата URI из `txType: 'create'` события → `fetchMetadataSocials()`
- Website дополнительный балл, но не обязательное условие

### 4. Прогресс bonding curve (золотое сечение)
```
MIN_CURVE_PROGRESS = 20%  (vSol / 588 × 100)
MAX_CURVE_PROGRESS = 60%
```
- < 20%: слишком ранняя стадия — 95-98% токенов умирает до $20k
- 20-60%: оптимальная зона — подтверждённый интерес + есть пространство для роста
- > 60%: близко к graduation ($69k) → массовая фиксация прибыли ранних покупателей

| vSol | Прогресс | Рекомендация |
|---|---|---|
| < 118 SOL | < 20% | Skip — слишком рискованно |
| 118-353 SOL | 20-60% | ✅ ENTRY ZONE |
| 353-488 SOL | 60-83% | Skip — продаём если позиция есть |
| > 488 SOL | > 83% | PRE_GRAD_EXIT если есть позиция |

### 5. Volume Velocity (реальный поток денег)
```
MIN_VELOCITY_SOL_60S = 5.0 SOL
```
- Сумма всех buy `solAmount` за последние 60 секунд из WebSocket событий
- < 5 SOL/мин = интерес угасает → пропуск
- ≥ 5 SOL/мин = реальный приток капитала СЕЙЧАС

**Vs старый DexScreener подход:**
- Старый: `vol5m > $300` — агрегированный, 30-60s задержка
- Новый: sum(solAmount, 60s) — каждый байт, 0 задержки

### 6. Уникальные покупатели (5 минут)
```
MIN_UNIQUE_BUYERS_5M = 30
```
- Набор уникальных `traderPublicKey` за последние 5 минут
- < 30 уникальных = объём накручивается 2-3 кошельками дева (wash trading)
- ≥ 30 = органический интерес реальных участников

### 7. Anti-whale guard
```
max single buy in 60s < 5 SOL
```
- Кит покупает > 5 SOL = искусственный памп, не органика
- После whale buy — манипуляция → откат → стоп-лосс

### 8. Dev Holding
```
MAX_DEV_HOLDING_PCT = 5%
```
- Получить баланс дева через Helius RPC
- Dev держит > 5% = может сдампить в любой момент
- Идеальный случай: Dev = 0% (полностью продал → CTO стадия)

---

## Управление позицией

### Размер позиции
```
BUY_SOL = 0.02 SOL (настраивается через BONDING_SMART_BUY_SOL)
```
- Оптимальный размер для мемкоинов: 0.02-0.05 SOL
- Больше = трудно выйти без проскальзывания
- MAX_POSITIONS = 2 одновременно

### Dynamic Take-Profit (сетка фиксации)

```
ENTRY → +50% → SELL 50% (фиксируем break-even)
              → +100% → SELL 50% оставшихся (= 25% от начальной позиции)
                       → FREE RIDE остаток (25%) с trailing stop -20%
```

Пример с 0.02 SOL входом:
- Вход: 0.02 SOL
- +50%: продаём 50% → получаем ~0.015 SOL (break-even)
- +100%: продаём ещё 25% → +0.01 SOL бонус
- Остаток: 25% свободная езда до trailing stop

### Временной стоп (Time-based Exit)
```
VOLUME_WATCH_SEC = 120 (секунд)
MIN_VOLUME_TO_STAY = 1.0 SOL/60s
```
- Если через 120 секунд после покупки: объём за 60с < 1 SOL → принудительный выход
- Логика: отсутствие новой ликвидности в мемкоине = смерть токена
- Используется `DUMP_SLIPPAGE_BPS = 1500` (15%) для гарантии выхода

### Защита от проскальзывания при продаже
```
Нормальные продажи: BASE_SLIPPAGE_BPS = 500 (5%)
Dump-mode: DUMP_SLIPPAGE_BPS = 1500 (15%)
```
Dump mode активируется при:
- Stop-loss срабатывании
- Time-based exit
- Dump detection: sellVol/buyVol > 3 за 30 секунд
- Pre-graduation exit (vSol > 488)

### Stop-Loss
```
STOP_PCT = 10% ниже цены входа
```
- Только до TP1 (если TP1 уже сработал → trailing stop)
- Подтверждение: срабатывает при следующем trade событии подтверждающем цену

### Trailing Stop (после TP1)
```
-20% от пика (peak price)
```
- Активируется после TP1 (stage1Done = true)
- Обновляется на каждом новом максимуме цены
- Продаём 100% остатка при срабатывании

### Pre-graduation Exit Guard
```
vSol > 488 (= 100 SOL до graduation threshold 588)
```
- Если у нас есть позиция И vSol > 488 → немедленный выход
- Причина: при graduation закрывается bonding curve → PumpPortal не может продавать
- Используется DUMP_SLIPPAGE_BPS = 15%

### Dump Detection
```
sellVol > buyVol × 3 за последние 30 секунд
```
- Отслеживается из WebSocket событий в реальном времени
- Ratio > 3 И sellVol > 2 SOL = koordinированный дамп
- Реакция: немедленная продажа 100% с 15% slippage

---

## Переменные окружения (.env)

```bash
# Статус (НЕ включать без backtesting на 500+ сигналов!)
BONDING_SMART_ENABLED=false

# Параметры позиции
BONDING_SMART_BUY_SOL=0.02
BONDING_SMART_MAX_POSITIONS=2
BONDING_SMART_DAILY_SOL=0.2

# Фильтры bonding curve
BONDING_SMART_MIN_CURVE_PCT=20    # мин прогресс (по умолчанию: 20%)
BONDING_SMART_MAX_CURVE_PCT=60    # макс прогресс (по умолчанию: 60%)

# Velocity
BONDING_SMART_MIN_VEL_SOL=5.0    # мин SOL/60s (по умолчанию: 5 SOL)
BONDING_SMART_MIN_BUYERS=30      # мин уникальных покупателей за 5min

# Dev check
BONDING_SMART_MAX_DEV_PCT=5      # макс % токенов у дева

# Возраст токена
BONDING_SMART_MAX_AGE_SEC=1800   # макс 30 минут

# Exit параметры
BONDING_SMART_STOP_PCT=10        # стоп-лосс 10%
BONDING_SMART_VOL_WATCH_SEC=120  # ждать 120s перед time exit
BONDING_SMART_MIN_VOL_STAY=1.0   # мин SOL/60s чтобы оставаться
```

---

## Чек-лист перед включением

- [ ] **Backtesting**: 500+ WebSocket событий собраны и симулированы
- [ ] **Win rate ≥ 35%** подтверждена на симуляции при avg ROI ≥ 1.5x
- [ ] **Break-even формула**: `win_rate × avg_roi > 1 + loss_rate × (1 - win_rate)`
- [ ] **W1 SOL баланс**: минимум 0.5 SOL перед включением
- [ ] **PumpPortal stабильность**: проверить что trade-local API отвечает
- [ ] **Запустить с BUY_SOL=0.005**: 10 тестовых сделок с мин размером
- [ ] **Анализ 10 сделок**: если win rate ≥ 30% — масштабировать до 0.02 SOL

---

## Почему сейчас DISABLED

1. **TX bug period (до 14.06)**: 68% сделок давали 0 возврата из-за VersionedTx fallback
2. **DexScreener lag**: HOT/MOVER стратегии потеряли деньги из-за 30-60с задержки данных
3. **No backtesting**: нет доказанной прибыльности на исторических данных WebSocket
4. **Capital at risk**: W2/W3 уже слили SOL до 0 несколько раз

**Break-even**: нужен win rate ≥ 35% при avg ROI ≥ 1.5x. Исторически бот показывал 3.8% (3/79). Реалистичный целевой win rate с новыми фильтрами: 25-40% (на основе профиля успешных монет).

---

## Профиль успешной pump.fun монеты

| Параметр | Значение |
|---|---|
| Возраст при входе | 3-15 минут |
| Bonding curve progress | 20-50% (118-295 SOL) |
| Dev holding | < 2% (или 0%) |
| Volume velocity (60s) | > 8 SOL |
| Unique buyers (5m) | > 40 |
| Social media | Twitter + Telegram оба |
| Bundle detection | Нет |
| Top 10 holders | < 20% суммарно |

---

## Сравнение стратегий

| Стратегия | Win Rate | Net P&L | Статус |
|---|---|---|---|
| bonding:hot (DexScreener) | 5.9% | -0.311 SOL | ❌ DISABLED (lag) |
| bonding:mover (DexScreener) | 4.0% | -0.180 SOL | ❌ DISABLED (lag) |
| bonding:grad | 0.0% | -0.112 SOL | ❌ DISABLED (buy-at-top) |
| sol:velocity (WebSocket) | 3.8% | -0.455 SOL | ❌ DISABLED (bad filters) |
| **bonding:smart (NEW)** | **TBD** | **TBD** | ⏳ BACKTESTING NEEDED |
| raydium_scan (FRESH <6h) | 41.4% | +0.012 SOL | ✅ ACTIVE |

---

## Roadmap

1. **Сейчас**: пассивный режим — WebSocket подключён, собирает данные, pre-graduation guard работает
2. **После 500 событий**: анализ — какой % прошёл бы все 8 фильтров и стал бы прибыльным
3. **Включение**: только при Win Rate ≥ 35% на backtesting + W1 баланс ≥ 0.5 SOL
4. **Масштабирование**: если 10 реальных сделок прибыльны → увеличить до 0.05 SOL позиции

---

*Создан: 19.06.2026 | Файл: `services/autobuy/src/bonding-smart.ts`*

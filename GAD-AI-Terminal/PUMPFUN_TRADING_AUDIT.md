# PumpFun Trading Audit — GAD AI Terminal
> Полный анализ всех сделок на pump.fun / bonding curve. Дата: June 19, 2026.

---

## Итого по всем стратегиям

| Стратегия | Сделок | Побед | Win% | Потрачено SOL | Получено SOL | Net P&L | Нулевых возвратов |
|---|---|---|---|---|---|---|---|
| **bonding:hot** | 17 | 1 | 5.9% | 0.385 | 0.0736 | **-0.311 SOL** | 12/17 (71%) |
| **bonding:mover** | 25 | 1 | 4.0% | 0.300 | 0.1205 | **-0.180 SOL** | 12/25 (48%) |
| **bonding:grad** | 9 | 0 | 0.0% | 0.135 | 0.0230 | **-0.112 SOL** | 7/9 (78%) |
| **bonding:new** | 2 | 0 | 0.0% | 0.020 | 0.0000 | **-0.020 SOL** | 2/2 (100%) |
| **other (velocity/early)** | 26 | 1 | 3.8% | 0.520 | 0.0651 | **-0.455 SOL** | 21/26 (81%) |
| **ИТОГО** | **79** | **3** | **3.8%** | **1.36 SOL** | **0.283 SOL** | **-1.077 SOL (-79%)** | **54/79 (68%)** |

---

## Все прибыльные сделки (3 из 79)

| Токен | Стратегия | Потрачено | Получено | ROI | Дата | Примечание |
|---|---|---|---|---|---|---|
| **Dash** | early (other) | 0.02 SOL | 0.0376 SOL | **1.88x** | 12 июня | Лучший результат |
| **SHIB** | bonding:mover | 0.01 SOL | 0.0140 SOL | **1.39x** | 15 июня | Post TX-fix |
| **YMAMA** | bonding:hot | 0.02 SOL | 0.0215 SOL | **1.07x** | 13 июня | Почти break-even |

**Суммарная прибыль с победителей: +0.0291 SOL**
**Суммарные потери: -1.106 SOL**
**Break-even требует win rate ≈ 35-40% при среднем ROI 1.5x**

---

## Анализ по причинам потерь

### 1. TX failures — нулевой возврат (68% сделок, -0.54 SOL)

**Период:** июнь 12-14 (до hotfix)
**Причина:** `VersionedTransaction.deserialize()` → `sendTransaction()` fail → fallback `Transaction.from(versioned_bytes)` → ошибка. Бот покупал SOL успешно, но sell TX падали все до одной.

```
DRILL — HOT поллер купил, достиг +5800% (58x!) за 2 часа
Все 4 TP sell TX упали: "Versioned messages must be deserialized with VersionedMessage"
TIME_LIMIT_EXPIRED → попытка emergency sell → тоже упала
Потеря: 0.02 SOL (получено 0)
```

**Другие нулевые возвраты в этот период:**
- MOTION, ANSEM, MANLETS, DOGEIFY — куплены, sells не прошли, time_limit = 0 received
- KNICKS, NEWYORK — bonding:new, TX failures

**Фикс (14.06.2026):** `VersionedTransaction.deserialize(bytes)` без fallback. `skipPreflight: true`.
После фикса нулевых возвратов стало меньше (12/25 в mover vs 12/17 в hot period).

---

### 2. DexScreener lag — покупка на пике (оставшиеся потери)

**Период:** июнь 14-19 (после TX fix)
**Причина:** DexScreener обновляет данные с задержкой 30-60 секунд. Когда мы видим `pc5m=15%` — этот памп УЖЕ произошёл 30-60 секунд назад. Мы покупаем на самом верху.

```
Типичный сценарий:
T+0s:   Токен начинает движение (organic)
T+30s:  DexScreener обновляется → pc5m=15%
T+31s:  Наш MOVER поллер видит сигнал → покупаем
T+32s:  Мы на вершине памп-спайка
T+40s:  Естественный откат -10%
T+50s:  Stop-loss срабатывает → продаём с убытком
```

**Подтверждение данными:**
- 12/25 mover сделок: received = 0 (проданы по stop-loss с минимальным возвратом или TX fail)  
- Средний hold time mover: 1-2 минуты (в рамках 120s time limit)
- SHIB (единственная mover-победа): купили при НАЧАЛЕ движения, а не на пике. mcap 199 SOL.

---

### 3. bonding:grad стратегия — 100% loss rate

| Токен | Потрачено | Получено | Примечание |
|---|---|---|---|
| SCHEMING | 0.015 | 0.000 | TX fail |
| BULL | 0.015 | 0.000 | TX fail |
| BOBO | 0.015 | 0.0122 | Partial sell |
| BTC | 0.015 | 0.000 | 17 min hold, time_limit |
| AURA | 0.015 | 0.000 | TX fail |
| LIGHT | 0.015 | 0.0108 | Partial |
| OPENFABLE | 0.015 | 0.000 | TX fail |
| STURMER | 0.015 | 0.000 | TX fail |
| MINIMI | 0.015 | 0.000 | TX fail |

**Стратегия:** Покупать токены на bonding curve вблизи graduation (~350-400 SOL mcap).
**Почему не работает:** Pre-graduation токены уже прошли основной памп. Большинство who хотел войти — уже вошли. После graduation на Raydium — резкий дамп.
**ОТКЛЮЧЕНО навсегда (17.06.2026):** `GRAD_HUNTER_ENABLED=false` в коде.

---

### 4. bonding:hot стратегия (первая версия)

**Параметры (июнь 12-13):** mcap $3k-$8k, buys5m≥15, vol5m≥$1500, pc5m 2-6%, позиция 0.02 SOL
**Проблема:** Токены в диапазоне $3k-$8k уже в 15-60 минут от создания → памп прошёл, мы в хвосте.

```
HOT трейды июнь 13:
OMG (mcap 140 SOL): 0.03 SOL → 0.00 (TX fail)
KINSBANK (mcap 147 SOL): 0.03 SOL → 0.00 (TX fail)  
DRILL (mcap 149 SOL): ПОТЕНЦИАЛЬНАЯ 58x победа → TX fails → потеря
SOL (mcap 83 SOL): 0.02 SOL → 0.0173 (-13.5%)
```

**Переход на MOVER стратегию (14.06.2026):** Уменьшен mcap ($500-$6k), возраст 90s-8min, pc5m 5-30%.

---

### 5. bonding:mover (текущая, июнь 14-19)

**Параметры:** mcap $500-$6k, возраст 90s-8min, pc5m 5-30%, buys5m≥5, позиция 0.01 SOL
**Win rate: 4% (1/25)**

```
Победы: SHIB (1.4x, +0.004 SOL)
Близко к breakeven: SOL (0.96x), TACTICS (0.91x), COOKED (0.79x)
Полные потери (нулевые TX): CZ, SLOOMI, THONG, AGAIN, BOTCAPTCHA, RICO
```

**Проблема:** DexScreener lag = покупаем на пике pc5m.
Даже mcap $500-$6k с 90s возрастом — если мы их ВИДИМ, они уже прошли движение.

---

## Временная линия стратегий

```
Jun 12: bonding:other/early (Dash +88% — единственная крупная победа)
Jun 13: bonding:hot (0.02-0.03 SOL/сделка, TX failures = 0 returns)
Jun 14: TX bugfix → bonding:mover запущен (0.015→0.01 SOL)
Jun 14: bonding:grad (0.015 SOL, 100% loss rate)
Jun 15: GRAD отключён, mover продолжается с 0.01 SOL
Jun 17: BONDING_HOT_ENABLED=false (W3 баланс = 0)
Jun 17: SOL_VELOCITY_ENABLED=false (W3 снова 0)  
Jun 19: Все pump.fun trading = ОТКЛЮЧЕНО (W2+W3 только для запуска монет)
```

---

## Ключевые выводы

### Что работало (3 сделки)
1. **Ранняя покупка (Dash, 1.88x):** Вошли в начале движения, не в хвосте.
2. **SHIB (1.4x):** Быстрая продажа в 10 минут, токен только начал движение.
3. **YMAMA (1.08x):** Случайная победа в HOT период.

### Почему 100% стратегий проиграли:
1. **TX bug (до 14.06):** 68% сделок получили received=0 несмотря на потраченный SOL.
2. **DexScreener lag (30-60с):** Делаем из нас ПОСЛЕДНИХ в очереди, не первых.
3. **Bonding curve nature:** Спайки длятся 30-120 секунд. При polling каждые 20-60с мы всегда опаздываем.
4. **Неправильная зона входа:** HOT покупал mcap $3-8k = уже 15-60 мин = памп сделан другими.
5. **GRAD = дамп:** Pre-graduation = sell wall после листинга.

### Что НЕ работает (запрещено навсегда)
- **bonding:new** — покупка токенов в первые минуты: TX fails + extreme volatility
- **bonding:hot** — mcap $3-12k уже пампанут до нашего входа
- **bonding:grad** — pre-graduation токены дампятся после листинга на Raydium
- **bonding:mover** — DexScreener lag убивает всю логику "ловить начало движения"
- **SOL velocity** — WebSocket реальный поток, но сами покупки проигрывают на slip + время TX

---

## Возможные решения (для анализа)

### Вариант A: Полный отказ от pump.fun trading
- W1 только Raydium (работает, win rate ~31%, нужны лучшие фильтры)
- W2/W3 только для создания монет
- **Статус:** Принято (19.06.2026)

### Вариант B: WebSocket real-time (если вернуться)
- PumpPortal WebSocket `newCoin` event → покупка в первые СЕКУНДЫ (не минуты)
- Требует: надёжный sell TX (уже исправлено) + позиция ≤ 0.005 SOL (extreme volatility)
- Win rate нужен ≥20% при avg ROI ≥2.0x для прибыльности
- **Риск:** снова слить W2/W3 до 0

### Вариант C: Backtesting перед реальными сделками
- Собрать 500+ PumpPortal WebSocket событий
- Симулировать стратегию на исторических данных
- Только после доказательства прибыльности — real money
- **Требует:** 2-4 недели passive data collection

### Вариант D: Copy-trading смарт-кошельков
- Мониторить кошельки которые стабильно profit (через Birdeye/Helius)
- Копировать их сделки с задержкой 1-2 секунды
- Использует уже работающий whale-tracker сервис

---

## Рекомендация

**Текущее решение (принято):** W2/W3 = только запуск монет. Никакого pump.fun trading.

**Следующий шаг если возвращаться:** Начать с Варианта C (backtesting) или D (copy-trading). 
Ни при каких условиях не перезапускать HOT/MOVER/GRAD/velocity без доказанной прибыльности на симуляции.

**Break-even формула:**
```
Нужен win_rate × avg_roi_x > 1 + (avg_loss_rate × (1 - win_rate))
При потере 10% на стоп: нужно win_rate ≥ 35% при avg_roi ≥ 1.5x
При потере 100% (TX fail): нужно win_rate ≥ 50% при avg_roi ≥ 2.0x
```

---

*Создан: 19.06.2026 | Данные: 79 сделок из БД autobuy_jobs, июнь 12-19, 2026*

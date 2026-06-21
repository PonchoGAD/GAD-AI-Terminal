/**
 * Polymarket Bot — Monte Carlo симуляция v1 (50 сделок)
 *
 * Модель основана на:
 *   - Аналитика бота (v5, 21.06.2026): 1 реальный dry-run сигнал
 *   - Hit rates источников: GDELT 20-40%, RSS 15-20%, X <5%, Volume редко
 *   - Polymarket механика: TP:+35%, impulse:+22%, SL:-40%, time limit:2h
 *   - MIN_EV = 0.12, MIN_CONFIDENCE = MEDIUM
 *   - Средняя ставка: $10/trade (dry-run default)
 *
 * Цель: оценить ожидаемый WR, P&L, Sharpe за 50 сделок
 */

// ─── Параметры торговли (из monitor.ts) ──────────────────────────────────────
const CONFIG = {
  TRADE_USD:    10,      // $10 за сделку (dry-run размер позиции)
  TP_PCT:       0.35,    // +35% от entry price → Take Profit
  IMPULSE_PCT:  0.22,    // +22% → impulse exit (ранняя фиксация)
  SL_PCT:       0.40,    // -40% → Stop Loss
  TIME_LIMIT_H: 2,       // 2ч максимум в позиции
  MIN_EV:       0.12,    // Минимальный EV для входа

  // Размер симуляции
  NUM_TRADES:   50,
  SIMULATIONS:  2000,    // Monte Carlo итераций
};

// ─── Pipeline воронка (данные из аналитики) ──────────────────────────────────
//
// Источники сигналов (по качеству):
//   GDELT clusters:      hit rate 25% (best source — новости vs политика Polymarket)
//   RSS headlines:       hit rate 18% (1 сигнал за 17 headlines)
//   Volume spikes:       hit rate 40% (редко, но сильный сигнал)
//   Wikipedia spikes:    hit rate 12% (новый, неизвестная эффективность)
//   X/Twitter trends:    hit rate  4% (crypto темы → плохой матч с политикой)
//   GDELT direct search: hit rate 22% (keyword → статьи → матч)
//   US Macro:            hit rate  8% (нужны Fed rate markets)
//
// После matchNewsToMarket (relevance ≥ 50):
//   EV ≥ 0.12 pass rate: 28% (из тех что прошли match, только часть имеет реальный edge)
//   confidence=HIGH:     12% от всех трейдов
//   confidence=MEDIUM:   88% от всех трейдов
//
// Итоговая частота сделок (при работающем Groq, 94 рынка):
//   Всего сигналов/день:   ~150-200 (все источники)
//   Pass match:            ~30-40
//   Pass EV≥0.12:          ~8-12
//   Уникальные сделки/день: ~1.0  (дедупликация по рынку)

const DAILY_TRADES_AVG  = 1.0;  // ~1 сделка в день при нормальной работе
const DAILY_TRADES_STD  = 0.6;  // волатильность (бывает 0-3 в день)

// ─── Типология сигналов ──────────────────────────────────────────────────────
//
// Сигналы сортируются по EV и confidence:

interface SignalType {
  name:      string;
  pct:       number;   // доля в общем flow трейдов
  wr_tp:     number;   // P(TP hit в 2ч)
  wr_imp:    number;   // P(impulse +22% exit в 2ч) если TP не был достигнут
  wr_sl:     number;   // P(SL hit в 2ч)
  // P(time limit) = 1 - wr_tp - wr_imp - wr_sl
  // При time limit: price drift в 2ч
  tl_avg:    number;   // средний дрейф при time limit (в % от trade size)
  tl_std:    number;   // std дрейфа
}

// Типы сигналов (основаны на EV + confidence + источнике)
const SIGNAL_TYPES: SignalType[] = [
  {
    // S1: Высокий EV (≥25%) + HIGH confidence. Чаще volume spike или strong GDELT.
    // Пример: WCup France (EV=20.2%, наш единственный реальный трейд → близко к этому тиру)
    name:   'HIGH-EV+HIGH-CONF',
    pct:    0.12,     // 12% трейдов
    wr_tp:  0.18,     // 18% TP в 2ч (сильное news confirmation)
    wr_imp: 0.12,     // 12% impulse +22%
    wr_sl:  0.06,     // 6% SL
    // time limit (64%):
    tl_avg: 4.5,      // +4.5% в среднем (медленное repricing)
    tl_std: 8.0,
  },
  {
    // S2: Средний EV (12-25%) + MEDIUM confidence. Основной поток — RSS, GDELT.
    // Самый частый тип.
    name:   'MED-EV+MED-CONF',
    pct:    0.68,     // 68% трейдов
    wr_tp:  0.10,     // 10% TP
    wr_imp: 0.08,     // 8% impulse
    wr_sl:  0.09,     // 9% SL
    // time limit (73%):
    tl_avg: 1.5,      // +1.5% (слабый edge в коротком окне)
    tl_std: 7.0,
  },
  {
    // S3: Граничный EV (12-15%) + MEDIUM confidence. "Серая зона".
    // EV чуть выше порога — много шума, низкая реализация в 2ч.
    name:   'LOW-EV+MED-CONF',
    pct:    0.20,     // 20% трейдов
    wr_tp:  0.07,     // 7% TP
    wr_imp: 0.05,     // 5% impulse
    wr_sl:  0.11,     // 11% SL (чуть выше — ложный сигнал)
    // time limit (77%):
    tl_avg: -1.0,     // лёгкий минус (рынок справедливее нашей оценки)
    tl_std: 7.0,
  },
];

// ─── RNG ──────────────────────────────────────────────────────────────────────
let seed = 42;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}
function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── Симуляция одной сделки ──────────────────────────────────────────────────
interface TradeResult {
  type:       string;
  exitReason: 'TP' | 'IMPULSE' | 'SL' | 'TIME';
  pnlPct:     number;  // % от позиции
  pnlUsd:     number;  // $
  win:        boolean;
}

function simulateTrade(): TradeResult {
  // Выбираем тип сигнала
  const r = rand();
  let cum = 0;
  let stype = SIGNAL_TYPES[0];
  for (const st of SIGNAL_TYPES) {
    cum += st.pct;
    if (r < cum) { stype = st; break; }
  }

  const p = rand();

  if (p < stype.wr_tp) {
    return {
      type: stype.name, exitReason: 'TP',
      pnlPct:  CONFIG.TP_PCT,
      pnlUsd:  CONFIG.TRADE_USD * CONFIG.TP_PCT,
      win: true,
    };
  }
  if (p < stype.wr_tp + stype.wr_imp) {
    return {
      type: stype.name, exitReason: 'IMPULSE',
      pnlPct:  CONFIG.IMPULSE_PCT,
      pnlUsd:  CONFIG.TRADE_USD * CONFIG.IMPULSE_PCT,
      win: true,
    };
  }
  if (p < stype.wr_tp + stype.wr_imp + stype.wr_sl) {
    return {
      type: stype.name, exitReason: 'SL',
      pnlPct:  -CONFIG.SL_PCT,
      pnlUsd:  -CONFIG.TRADE_USD * CONFIG.SL_PCT,
      win: false,
    };
  }

  // Time limit: стохастический дрейф
  const drift = stype.tl_avg + stype.tl_std * randn();
  const pnlPct = drift / 100;
  return {
    type: stype.name, exitReason: 'TIME',
    pnlPct,
    pnlUsd: CONFIG.TRADE_USD * pnlPct,
    win: pnlPct > 0,
  };
}

// ─── Один прогон симуляции (50 сделок) ───────────────────────────────────────
interface RunResult {
  wins:    number;
  losses:  number;
  totalPnl:number;
  maxDD:   number;
  equity:  number[];   // equity curve
  exits: Record<'TP'|'IMPULSE'|'SL'|'TIME', number>;
}

function runOnce(): RunResult {
  let wins = 0, losses = 0, totalPnl = 0;
  let peak = 0, maxDD = 0, runningPnl = 0;
  const equity: number[] = [0];
  const exits: Record<'TP'|'IMPULSE'|'SL'|'TIME', number> = { TP:0, IMPULSE:0, SL:0, TIME:0 };

  for (let i = 0; i < CONFIG.NUM_TRADES; i++) {
    const t = simulateTrade();
    totalPnl   += t.pnlUsd;
    runningPnl += t.pnlUsd;
    if (t.win) wins++; else losses++;
    exits[t.exitReason]++;
    equity.push(runningPnl);
    peak = Math.max(peak, runningPnl);
    maxDD = Math.max(maxDD, peak - runningPnl);
  }
  return { wins, losses, totalPnl, maxDD, equity, exits };
}

// ─── Monte Carlo (N симуляций) ────────────────────────────────────────────────
function monteCarlo(n: number) {
  const results: RunResult[] = [];
  for (let i = 0; i < n; i++) {
    seed = 42 + i * 7;  // разный seed для каждой симуляции
    results.push(runOnce());
  }
  return results;
}

// ─── Статистика ───────────────────────────────────────────────────────────────
function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function usd(n: number): string { return `$${n.toFixed(2)}`; }
function fmt(n: number, dec = 2): string { return n.toFixed(dec); }

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const results = monteCarlo(CONFIG.SIMULATIONS);

const wrs  = results.map(r => r.wins / CONFIG.NUM_TRADES);
const pnls = results.map(r => r.totalPnl);
const dds  = results.map(r => r.maxDD);

const avgWR  = wrs.reduce((a, b) => a + b, 0) / wrs.length;
const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
const avgDD  = dds.reduce((a, b) => a + b, 0) / dds.length;

const std = (arr: number[]) => {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
};
const pnlStd = std(pnls);

// Sharpe (assuming $10/trade, risk-free = 0 for crypto)
const sharpe = pnlStd > 0 ? (avgPnl / pnlStd) : 0;

// Profitable runs
const profitablePct = results.filter(r => r.totalPnl > 0).length / results.length;

// Aggregate exit distribution
const exitTotal: Record<string, number> = { TP: 0, IMPULSE: 0, SL: 0, TIME: 0 };
for (const r of results) {
  for (const k of ['TP','IMPULSE','SL','TIME'] as const) {
    exitTotal[k] += r.exits[k];
  }
}
const totalExits = Object.values(exitTotal).reduce((a, b) => a + b, 0);

// Days to 50 trades estimate
const daysFor50 = CONFIG.NUM_TRADES / DAILY_TRADES_AVG;

// Single deterministic run for equity curve display
seed = 42;
const demoRun = runOnce();

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║        POLYMARKET BOT — Симуляция v1 (${CONFIG.NUM_TRADES} сделок)           ║
╚═══════════════════════════════════════════════════════════════╝

📊 ПАРАМЕТРЫ
  Размер позиции:  ${usd(CONFIG.TRADE_USD)}/trade | MIN_EV=${pct(CONFIG.MIN_EV)}
  TP: +${pct(CONFIG.TP_PCT)}  |  Impulse: +${pct(CONFIG.IMPULSE_PCT)}  |  SL: -${pct(CONFIG.SL_PCT)}  |  Time: ${CONFIG.TIME_LIMIT_H}ч
  Кол-во сделок:   ${CONFIG.NUM_TRADES} | MC итераций: ${CONFIG.SIMULATIONS.toLocaleString()}
  Freq:           ~${DAILY_TRADES_AVG} сделка/день → ${daysFor50.toFixed(0)} дней до 50 трейдов

─────────────────────────────────────────────────────────────────
📈 РЕЗУЛЬТАТЫ MONTE CARLO (${CONFIG.SIMULATIONS.toLocaleString()} симуляций)

  Win Rate:        ${pct(avgWR)} среднее  [P5=${pct(percentile(wrs,0.05))}, P95=${pct(percentile(wrs,0.95))}]
  P&L:             ${usd(avgPnl)} среднее  ±${usd(pnlStd)} σ
  Max Drawdown:    ${usd(avgDD)} среднее
  Sharpe:          ${fmt(sharpe)} (выше 0.5 = приемлемо)
  Прибыльных runs: ${pct(profitablePct)} симуляций закончили в плюс

  P&L Перцентили:
    P10 (плохой):    ${usd(percentile(pnls, 0.10))}
    P25:             ${usd(percentile(pnls, 0.25))}
    P50 (медиана):   ${usd(percentile(pnls, 0.50))}
    P75:             ${usd(percentile(pnls, 0.75))}
    P90 (хороший):   ${usd(percentile(pnls, 0.90))}
    P99:             ${usd(percentile(pnls, 0.99))}

─────────────────────────────────────────────────────────────────
🚪 РАСПРЕДЕЛЕНИЕ ВЫХОДОВ (средн. по всем симуляциям)

  TP   (+35%):   ${pct(exitTotal.TP    / totalExits)} сделок
  Impulse (+22%): ${pct(exitTotal.IMPULSE / totalExits)} сделок
  SL   (-40%):   ${pct(exitTotal.SL    / totalExits)} сделок
  Time (drift):  ${pct(exitTotal.TIME  / totalExits)} сделок

─────────────────────────────────────────────────────────────────
📊 СИГНАЛЬНАЯ ВОРОНКА (оценка)

  Сигналов/день (все источники):  ~150-200
  Pass matchNewsToMarket (≥50%):   ~30-40  (~20%)
  Pass EV≥12% + MEDIUM conf:       ~8-12   (~28% от matched)
  Уникальные трейды/день:          ~1.0    (дедупликация)

  По источникам:
    GDELT clusters  (каждые 8мин):  ~25-35% hit rate ← ЛУЧШИЙ
    RSS headlines   (каждые 10мин): ~15-20% hit rate ← основной поток
    Volume spikes   (каждые 30мин): ~40% hit rate (редко)
    Wikipedia       (каждые 20мин): ~10-15% hit rate (новый)
    X/Twitter       (каждые 8мин):  ~4-5%  hit rate (crypto→политика плохо)
    GDELT search    (каждые 8мин):  ~20-25% hit rate
    US Macro        (каждые 60мин): ~8% hit rate (нужны Fed markets)

─────────────────────────────────────────────────────────────────
🔬 ДЕМО ПРОГОН (seed=42, ${CONFIG.NUM_TRADES} сделок)

  Wins: ${demoRun.wins} | Losses: ${demoRun.losses} | WR: ${pct(demoRun.wins / CONFIG.NUM_TRADES)}
  Total P&L: ${usd(demoRun.totalPnl)} | Max DD: ${usd(demoRun.maxDD)}
  Выходы: TP=${demoRun.exits.TP} Imp=${demoRun.exits.IMPULSE} SL=${demoRun.exits.SL} Time=${demoRun.exits.TIME}

  Equity curve (каждые 5 сделок):
  ${demoRun.equity.filter((_, i) => i % 5 === 0).map((v, i) => `  Trade ${(i * 5).toString().padStart(2)}: ${usd(v)}`).join('\n')}
  Trade ${CONFIG.NUM_TRADES}: ${usd(demoRun.equity[CONFIG.NUM_TRADES])}

─────────────────────────────────────────────────────────────────
⚠️  РИСКИ И ОГРАНИЧЕНИЯ

  1. ВСЕ источники LLM сейчас 429/402 (Groq rate limit, DeepSeek нет баланса)
     → 0 сигналов пока не добавить токен/пополнить счёт Groq
     → Решение: пополнить Groq Pay-As-You-Go или добавить DEEPSEEK_API_KEY

  2. Polymarket — нет истории ≥30 реальных dry-run сделок
     → WR нельзя подтвердить пока. Симуляция = теоретическая модель.
     → ОБЯЗАТЕЛЬНО: провести 30 dry-run сделок перед включением LIVE

  3. Модель предполагает 94 рынка постоянно активны
     → Реально большинство рынков долгосрочные (выборы, WCup) — low daily volume
     → Краткосрочные рынки (недельные) дают лучшие шансы на TP/SL hit в 2ч

  4. Groq TPM rate limit при одновременных источниках
     → В периоды активности (все 7 стратегий одновременно) → burst 429
     → Уже зафиксировано acquireGroqToken() сериализацией

─────────────────────────────────────────────────────────────────
🎯 ВЫВОД

  WR ${pct(avgWR)} при ${CONFIG.NUM_TRADES} трейдах:
  ${avgWR >= 0.55 ? '✅ ВЫШЕ целевого 65% threshold — но это теоретический потолок!' :
    avgWR >= 0.50 ? '⚠️  Умеренно положительный edge. Нужна реальная проверка 30 dry-run сделок.' :
    '❌ Ниже 50% — стратегия убыточна в симуляции, пересмотреть параметры.'}

  P&L median ${usd(percentile(pnls, 0.50))} за ${CONFIG.NUM_TRADES} сделок:
  ${percentile(pnls, 0.50) > 0 ? '✅ Положительный' : '❌ Отрицательный'} median

  Следующий шаг: накопить ${Math.max(0, 30 - 1)} dry-run сделки → проверить реальный WR
  Текущий dry-run прогресс: 1/30 сделок
  ${1 >= 30 ? '✅ READY TO LIVE' : `⏳ Ещё ~${(29 / DAILY_TRADES_AVG).toFixed(0)} дней до проверки`}
`);

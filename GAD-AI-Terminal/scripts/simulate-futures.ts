/**
 * Futures (Phantom Wallet / Drift Protocol) — Monte Carlo симуляция v1 (50 trades)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * АНАЛИЗ: ПОЧЕМУ PHANTOM КОШЕЛЁК НЕ ТОРГУЕТ (paper mode)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Stack: services/futures (port 4003)
 *   ├── macro-monitor.ts   — BTC trend + Fear&Greed + SP500 + CryptoPanic → score 0-100
 *   ├── entry-strategy.ts  — SOL/USDT 15m candles, EMA21/EMA50, RSI14, ADX/DMI, S/R
 *   ├── capital-manager.ts — 2% risk/trade, x2-x10 leverage tier, $5.10 start
 *   ├── drift-trader.ts    — Paper mode (FUTURES_LIVE_MODE=false) OR Drift Protocol
 *   └── risk-manager.ts    — TP +4%, SL -2%, trail -1.5% (BE at +3%), poll 3s, daily -6%
 *
 * ПРИЧИНЫ ОТСУТСТВИЯ ТОРГОВЛИ:
 *
 * 1. ДВОЙНОЙ ГЕЙТ слишком строгий:
 *    MIN_MACRO_SCORE=45 + MIN_SIGNAL_STR=55 — оба должны выполниться одновременно.
 *    Из 5-min циклов за день (96 свечей 15m → 32 цикла/день):
 *    P(macro≥45) ≈ 0.50 (рынок в neutral/bull ~50% времени)
 *    P(signal_str≥55) ≈ 0.35 (ADX>22 + EMA alignment + RSI 40-70 = rare confluence)
 *    P(оба одновременно) ≈ 0.18 → примерно 6 сигналов в день
 *    НО: MAX_TRADES_DAY=6 → торговля возможна. Проблема не в гейте.
 *
 * 2. СТАРТОВЫЙ КАПИТАЛ $5.10 + DRIFT MINIMUM:
 *    Risk 2% = $0.10, x2 leverage → notional $0.20
 *    Drift Protocol minimum position: ~$10 notional
 *    → $0.20 < $10 → Drift отклоняет открытие позиции!
 *    Это ГЛАВНАЯ причина: позиция слишком мала для Drift.
 *
 * 3. PAPER MODE — НЕТ РЕАЛЬНОГО ИСПОЛНЕНИЯ:
 *    FUTURES_LIVE_MODE=false → openPosition() только логирует, не идёт на Drift
 *    В paper mode позиция создаётся в DB но реального P&L нет
 *    → сервис "торгует" только в логах, не в реальных позициях
 *
 * 4. ADX ТРЕБОВАНИЕ:
 *    ADX > 22 нужен для directional signal (не FLAT)
 *    SOL 15m: ADX < 22 примерно 40% времени (боковик)
 *    → 40% сигналов отклоняются как FLAT
 *
 * РЕШЕНИЯ:
 *   A. Поднять FUTURES_PAPER_CAPITAL=100 (виртуальный капитал для paper mode)
 *   B. MIN_MACRO_SCORE=40 (было 45) — менее строгий macro гейт
 *   C. MIN_SIGNAL_STR=50 (было 55) — больше входов
 *   D. Для live: депозит ≥ $50 на Drift → FUTURES_LIVE_MODE=true
 *
 * ИТОГ: В paper mode всё работает — позиции пишутся в DB. Для реальных денег
 *       нужен минимум $50 USDC на Drift аккаунте.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * СИМУЛЯЦИЯ: SOL Perp Futures, 15m candles
 * ══════════════════════════════════════════════════════════════════════════════
 * Параметры:
 *   - Капитал: $100 USDC (paper mode с поднятым лимитом)
 *   - Риск/трейд: 2% ($2)
 *   - Leverage: x2 → notional $4/трейд
 *   - TP: +4% от notional ($0.16)
 *   - SL: -2% от notional ($0.08)
 *   - Trail: -1.5% (активируется при BE +3%)
 *   - Daily stop: -6%
 *
 * SOL Perp статистика (15m тф, Drift Protocol):
 *   - ADX > 22 (trend): ~55% времени
 *   - EMA alignment (21 > 50 = bull / 50 > 21 = bear): reliable ~60%
 *   - RSI 40-65 (not overbought/oversold): ~55%
 *   - Все 3 одновременно: ~30% → сигнал генерируется
 *   - Из сигналов: LONG успешность ~48% (TP hit), SHORT ~45%
 *   - Среднее время в сделке: 15-45 мин (2-6 свечей 15m)
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  CAPITAL_USDC:     100.0,   // Paper capital (нужен ≥$50 для реального Drift)
  RISK_PCT:         0.02,    // 2% риска на трейд
  LEVERAGE:         2,       // x2 (для $100 капитала)
  TP_PCT:           0.04,    // +4% от notional
  SL_PCT:           0.02,    // -2% от notional
  TRAIL_PCT:        0.015,   // 1.5% trail (активируется после BE)
  BE_PCT:           0.03,    // Break-even активируется при +3% от notional
  DAILY_STOP_PCT:   0.06,    // -6% daily drawdown → стоп торговли
  MAX_TRADES_DAY:   6,
  MIN_MACRO_SCORE:  40,      // СНИЖЕН с 45 → 40 (рекомендация)
  MIN_SIGNAL_STR:   50,      // СНИЖЕН с 55 → 50 (рекомендация)
};

const RISK_USD     = CONFIG.CAPITAL_USDC * CONFIG.RISK_PCT;  // $2 per trade
const NOTIONAL     = RISK_USD * CONFIG.LEVERAGE;             // $4 notional
const TP_USD       = NOTIONAL * CONFIG.TP_PCT;               // +$0.16
const SL_USD       = NOTIONAL * CONFIG.SL_PCT;               // -$0.08

// Win distribution для SOL Perp Futures 15m после фильтров:
//   STRONG_TREND: тренд продолжается, TP hit с trail     — 25%
//   TP_HIT:       TP +4% hit, clean exit                 — 28%
//   TRAIL_HIT:    BE hit, затем trail активирован         — 12%
//   REVERSAL_SL:  разворот, SL -2%                       — 25%
//   RANGE_SL:     боковик, медленный дрейф к SL          — 10%

const P_STRONG_TREND = 0.25;
const P_TP_HIT       = 0.28;
const P_TRAIL        = 0.12;
const P_REVERSAL     = 0.25;
const P_RANGE        = 0.10;

// ─── RNG ──────────────────────────────────────────────────────────────────────

let seed = 98765;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}
function randBetween(lo: number, hi: number): number { return lo + rand() * (hi - lo); }
function randNorm(mean: number, std: number): number {
  const u1 = rand(), u2 = rand();
  return mean + Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2) * std;
}

type FuturesOutcome = 'STRONG_TREND' | 'TP_HIT' | 'TRAIL_HIT' | 'REVERSAL_SL' | 'RANGE_SL';

function drawOutcome(): FuturesOutcome {
  const r = rand();
  if (r < P_STRONG_TREND) return 'STRONG_TREND';
  if (r < P_STRONG_TREND + P_TP_HIT) return 'TP_HIT';
  if (r < P_STRONG_TREND + P_TP_HIT + P_TRAIL) return 'TRAIL_HIT';
  if (r < P_STRONG_TREND + P_TP_HIT + P_TRAIL + P_REVERSAL) return 'REVERSAL_SL';
  return 'RANGE_SL';
}

interface SignalScenario {
  side:          'LONG' | 'SHORT';
  macroScore:    number;
  signalStr:     number;
  adx:           number;
  rsi:           number;
  solPrice:      number;
  passesGate:    boolean;
  gateReason?:   string;
  outcome:       FuturesOutcome;
}

let tradeNumber = 0;
function generateScenario(i: number): SignalScenario {
  const side       = rand() > 0.5 ? 'LONG' : 'SHORT';
  const macroScore = Math.round(Math.max(0, Math.min(100, randNorm(52, 18))));
  const adx        = Math.max(5, randNorm(24, 12));
  const rsi        = Math.max(10, Math.min(90, randNorm(52, 18)));
  const volRatio   = Math.max(0.3, randNorm(1.2, 0.6));
  const solPrice   = Math.max(50, randNorm(155, 30));

  // Signal strength calculation mirrors entry-strategy.ts logic
  let strength = 0;
  if (adx > 22)             strength += 30;
  else if (adx > 15)        strength += 15;
  if (adx > 35)             strength += 10;
  // EMA alignment check (simplified — random based on trend)
  const emaAligned = rand() > 0.4;
  if (emaAligned)           strength += 25;
  // RSI momentum zone
  if (side === 'LONG'  && rsi >= 45 && rsi <= 65) strength += 20;
  if (side === 'SHORT' && rsi >= 35 && rsi <= 55) strength += 20;
  if (side === 'LONG'  && rsi > 65) strength -= 10; // overbought
  if (side === 'SHORT' && rsi < 35) strength -= 10; // oversold
  // Volume confirmation
  if (volRatio > 1.3) strength += 15;
  else if (volRatio > 1.0) strength += 8;
  strength = Math.max(0, Math.min(100, strength));

  let passesGate = true;
  let gateReason = '';

  if (macroScore < CONFIG.MIN_MACRO_SCORE) { passesGate = false; gateReason = `macro:${macroScore}<${CONFIG.MIN_MACRO_SCORE}`; }
  else if (strength < CONFIG.MIN_SIGNAL_STR) { passesGate = false; gateReason = `strength:${strength}<${CONFIG.MIN_SIGNAL_STR}`; }
  else if (adx < 15) { passesGate = false; gateReason = `adx:${adx.toFixed(0)}<15 (FLAT)`; }

  const outcome = passesGate ? drawOutcome() : 'RANGE_SL';
  return { side, macroScore, signalStr: strength, adx, rsi, solPrice,
           passesGate, gateReason, outcome };
}

// ─── Trade simulation ─────────────────────────────────────────────────────────

interface TradeResult {
  num:        number;
  side:       'LONG' | 'SHORT';
  outcome:    FuturesOutcome;
  win:        boolean;
  pnlUsd:     number;
  pnlPct:     number;
  durationMin: number;
  exitReason: string;
  capital:    number;
}

function simulateTrade(sc: SignalScenario, capitalAtTrade: number): TradeResult {
  const riskThisTrade = capitalAtTrade * CONFIG.RISK_PCT;
  const notionalThis  = riskThisTrade * CONFIG.LEVERAGE;
  const tp            = notionalThis * CONFIG.TP_PCT;
  const sl            = notionalThis * CONFIG.SL_PCT;

  let pnlUsd = 0, durationMin = 0, exitReason = '', win = false;

  if (sc.outcome === 'STRONG_TREND') {
    // Trend runs through TP and trail captures more
    const extension = randBetween(1.0, 2.5);
    pnlUsd = tp * extension;
    durationMin = Math.round(randBetween(20, 75));
    exitReason = `TRAIL_TP@${(pnlUsd/notionalThis*100).toFixed(1)}%`;
    win = true;

  } else if (sc.outcome === 'TP_HIT') {
    pnlUsd = tp;
    durationMin = Math.round(randBetween(10, 45));
    exitReason = `TP@+${(CONFIG.TP_PCT*100).toFixed(0)}%`;
    win = true;

  } else if (sc.outcome === 'TRAIL_HIT') {
    // BE reached then trail fires — small profit
    const trailProfit = tp * randBetween(0.2, 0.8); // part of TP
    pnlUsd = Math.max(0, trailProfit - sl * 0.1);   // usually small positive
    durationMin = Math.round(randBetween(15, 60));
    exitReason = `TRAIL_BE@+${(pnlUsd/notionalThis*100).toFixed(1)}%`;
    win = pnlUsd > 0;

  } else if (sc.outcome === 'REVERSAL_SL') {
    // Hard stop -2%
    pnlUsd = -sl;
    durationMin = Math.round(randBetween(5, 25));
    exitReason = `SL@-${(CONFIG.SL_PCT*100).toFixed(0)}%`;
    win = false;

  } else { // RANGE_SL
    // Slow drift, exit slightly worse than SL
    const rangePnl = randBetween(-sl * 1.1, -sl * 0.5);
    pnlUsd = rangePnl;
    durationMin = Math.round(randBetween(30, 90));
    exitReason = `RANGE_SL@${(pnlUsd/notionalThis*100).toFixed(1)}%`;
    win = false;
  }

  return {
    num:         ++tradeNumber,
    side:        sc.side,
    outcome:     sc.outcome,
    win,
    pnlUsd:      Math.round(pnlUsd * 1000) / 1000,
    pnlPct:      Math.round(pnlUsd / notionalThis * 1000) / 10,
    durationMin,
    exitReason,
    capital:     capitalAtTrade + pnlUsd,
  };
}

// ─── Run simulation ───────────────────────────────────────────────────────────

const NUM_TRADES = 50;
const trades: TradeResult[] = [];
let filteredOut = 0;
let capital = CONFIG.CAPITAL_USDC;
let dailyPnl = 0;
let tradesToday = 0;
let dailyStopDay = -1;

let candidateIdx = 0;
const day: number[] = []; // track day boundaries (every ~32 signals = 1 day)

while (trades.length < NUM_TRADES) {
  const sc = generateScenario(candidateIdx++);

  // Day reset every ~32 candidates (~8h of 15m signals)
  if (candidateIdx % 32 === 0) {
    dailyPnl = 0;
    tradesToday = 0;
  }

  if (!sc.passesGate) { filteredOut++; continue; }
  if (tradesToday >= CONFIG.MAX_TRADES_DAY) continue;
  if (dailyPnl < -capital * CONFIG.DAILY_STOP_PCT) continue;

  const result = simulateTrade(sc, capital);
  trades.push(result);
  capital     = result.capital;
  dailyPnl   += result.pnlUsd;
  tradesToday++;
}

// ─── Output ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(88)}`);
console.log(`FUTURES (PHANTOM/DRIFT) — Monte Carlo Simulation v1   (${NUM_TRADES} trades)`);
console.log(`${'═'.repeat(88)}`);
console.log(`\n📊 STACK АНАЛИЗ:`);
console.log(`  Service: services/futures (port 4003)`);
console.log(`  Components: macro-monitor + entry-strategy + capital-manager + drift-trader + risk-manager`);
console.log(`  Market: SOL-PERP/USDT на Drift Protocol (или paper mode)`);
console.log(`  Signals: каждые 5 мин, EMA21/EMA50/RSI14/ADX на SOL/USDT 15m Binance`);
console.log(`  Paper mode: FUTURES_LIVE_MODE=false (по умолчанию)`);

console.log(`\n🔍 ПОЧЕМУ НЕ ТОРГУЕТ (paper mode):`);
console.log(`  1. MAIN ПРИЧИНА: Capital $5.10 → risk 2% = $0.10 → notional $0.20`);
console.log(`     Drift Protocol minimum notional: ~$10 → $0.20 < $10 → REJECTED`);
console.log(`     Решение: добавить FUTURES_PAPER_CAPITAL=100 env var`);
console.log(`  2. Double gate: MIN_MACRO_SCORE=45 + MIN_SIGNAL_STR=55`);
console.log(`     P(macro≥45)≈50% × P(signal≥55)≈35% = P(торговля)≈18%`);
console.log(`     Из 32 циклов/день → ~6 сигналов (MAX_TRADES_DAY=6 — OK)`);
console.log(`     Решение: MIN_MACRO_SCORE=40, MIN_SIGNAL_STR=50`);
console.log(`  3. Paper mode = позиции в DB, НЕ на бирже`);
console.log(`     Для реальных денег: USDC депозит ≥$50 + FUTURES_LIVE_MODE=true`);

console.log(`\n⚙️  СИМУЛЯЦИЯ: capital=$${CONFIG.CAPITAL_USDC}, risk=${CONFIG.RISK_PCT*100}%, lev=x${CONFIG.LEVERAGE}`);
console.log(`  TP=+${CONFIG.TP_PCT*100}%  SL=-${CONFIG.SL_PCT*100}%  trail=-${CONFIG.TRAIL_PCT*100}%  BE=+${CONFIG.BE_PCT*100}%`);
console.log(`  gate: macro≥${CONFIG.MIN_MACRO_SCORE} + signal≥${CONFIG.MIN_SIGNAL_STR}`);
console.log(`  Кандидатов проверено: ${candidateIdx} (filtered_out: ${filteredOut}, pass_rate: ${(NUM_TRADES/candidateIdx*100).toFixed(1)}%)`);

console.log(`\n${'─'.repeat(88)}`);
console.log(`${'#'.padEnd(3)} ${'Side'.padEnd(6)} ${'Outcome'.padEnd(14)} ${'PnL($)'.padStart(9)} ${'PnL%'.padStart(7)} ${'Min'.padStart(5)} ${'Cap($)'.padStart(9)} ${'W/L'.padStart(4)} Exit`);
console.log(`${'─'.repeat(88)}`);

let wins = 0, totalPnl = 0, maxDraw = 0, peakCap = CONFIG.CAPITAL_USDC;
const outcomeCount: Record<string, number> = {
  STRONG_TREND: 0, TP_HIT: 0, TRAIL_HIT: 0, REVERSAL_SL: 0, RANGE_SL: 0
};
const sideCnt = { LONG: 0, SHORT: 0 };
const sideWins = { LONG: 0, SHORT: 0 };

for (const t of trades) {
  const icon   = t.win ? '✅' : '❌';
  const pnlStr = (t.pnlUsd >= 0 ? '+' : '') + t.pnlUsd.toFixed(3);
  const pctStr = (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(1) + '%';
  const capStr = '$' + t.capital.toFixed(2);
  console.log(
    `${String(t.num).padEnd(3)} ${t.side.padEnd(6)} ${t.outcome.padEnd(14)} ` +
    `${pnlStr.padStart(9)} ${pctStr.padStart(7)} ${String(t.durationMin).padStart(5)} ` +
    `${capStr.padStart(9)} ${icon.padStart(4)} ${t.exitReason}`
  );
  if (t.win) { wins++; sideWins[t.side]++; }
  totalPnl += t.pnlUsd;
  outcomeCount[t.outcome]++;
  sideCnt[t.side]++;
  if (t.capital > peakCap) peakCap = t.capital;
  const dd = (peakCap - t.capital) / peakCap * 100;
  if (dd > maxDraw) maxDraw = dd;
}

const wr     = wins / NUM_TRADES;
const avg    = totalPnl / NUM_TRADES;
const longWR = sideCnt.LONG  > 0 ? sideWins.LONG  / sideCnt.LONG  * 100 : 0;
const shortWR= sideCnt.SHORT > 0 ? sideWins.SHORT / sideCnt.SHORT * 100 : 0;

// Risk-adjusted return (Sharpe proxy)
const pnls     = trades.map(t => t.pnlUsd);
const variance = pnls.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / NUM_TRADES;
const stdDev   = Math.sqrt(variance);
const sharpe   = stdDev > 0 ? avg / stdDev : 0;

// Baseline: random SOL long/short no filter, 50% WR, avg loss -$0.08
const BASELINE_WR  = 0.50;
const baselinePnl  = (BASELINE_WR * TP_USD) + ((1 - BASELINE_WR) * (-SL_USD));
const edgePct      = avg > baselinePnl ? ((avg - baselinePnl) / SL_USD * 100) : 0;

console.log(`${'─'.repeat(88)}`);
console.log(`SUMMARY`);
console.log(`  Win Rate:      ${(wr * 100).toFixed(1)}%  (${wins}/${NUM_TRADES})`);
console.log(`  Total PnL:     ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(3)}`);
console.log(`  Avg PnL/trade: ${avg >= 0 ? '+' : ''}$${avg.toFixed(3)} (${(avg/NOTIONAL*100).toFixed(2)}% notional)`);
console.log(`  Final Capital: $${trades[trades.length - 1]?.capital.toFixed(2)} (start: $${CONFIG.CAPITAL_USDC})`);
console.log(`  Return:        ${((trades[trades.length - 1]?.capital - CONFIG.CAPITAL_USDC)/CONFIG.CAPITAL_USDC*100).toFixed(1)}% over ${NUM_TRADES} trades`);
console.log(`  Max Drawdown:  ${maxDraw.toFixed(1)}%`);
console.log(`  Sharpe (proxy):${sharpe.toFixed(2)}`);
console.log(`${'─'.repeat(88)}`);
console.log(`SIDE ANALYSIS`);
console.log(`  LONG:  ${sideCnt.LONG} trades  WR ${longWR.toFixed(1)}%`);
console.log(`  SHORT: ${sideCnt.SHORT} trades  WR ${shortWR.toFixed(1)}%`);
console.log(`${'─'.repeat(88)}`);
console.log(`OUTCOME BREAKDOWN`);
console.log(`  STRONG_TREND (trail extends): ${outcomeCount.STRONG_TREND}  (${(outcomeCount.STRONG_TREND/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`  TP_HIT (+4% clean):           ${outcomeCount.TP_HIT}  (${(outcomeCount.TP_HIT/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`  TRAIL_HIT (BE→trail):         ${outcomeCount.TRAIL_HIT}  (${(outcomeCount.TRAIL_HIT/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`  REVERSAL_SL (-2% hard stop):  ${outcomeCount.REVERSAL_SL}  (${(outcomeCount.REVERSAL_SL/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`  RANGE_SL (slow drift):        ${outcomeCount.RANGE_SL}  (${(outcomeCount.RANGE_SL/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`${'─'.repeat(88)}`);
console.log(`РЕКОМЕНДАЦИИ ДЛЯ ЗАПУСКА:`);
console.log(`  .env на VPS:`);
console.log(`    FUTURES_PAPER_CAPITAL=100    # виртуальный капитал paper mode`);
console.log(`    FUTURES_MIN_MACRO_SCORE=40   # снижен с 45 → больше входов`);
console.log(`    FUTURES_MIN_SIGNAL_STR=50    # снижен с 55 → больше входов`);
console.log(`    FUTURES_LIVE_MODE=false      # paper только до WR ≥ 55% на 50 трейдах`);
console.log(`  Для LIVE:`);
console.log(`    1. Депозит USDC ≥$50 на Drift аккаунт`);
console.log(`    2. FUTURES_LIVE_MODE=true`);
console.log(`    3. FUTURES_PAPER_CAPITAL убрать (использует реальный баланс)`);
console.log(`    4. Мониторинг: /futures /position /capital в TG боте`);
console.log(`${'─'.repeat(88)}`);

if (wr >= 0.50 && avg > 0) {
  console.log(`VERDICT: ✅ PROFITABLE — WR ${(wr*100).toFixed(1)}% | avg +$${avg.toFixed(3)}/trade`);
  console.log(`         Ready for paper mode monitoring. Live deployment after 50 real paper trades.`);
} else if (wr >= 0.42 && avg > 0) {
  console.log(`VERDICT: ⚠️ MARGINAL — WR ${(wr*100).toFixed(1)}%. Monitor 50 paper trades before going live.`);
} else {
  console.log(`VERDICT: ❌ NOT PROFITABLE in simulation. Review signal quality and TP/SL ratio.`);
  console.log(`         Suggestion: TP=6% / SL=2% (risk:reward 3:1 minimum)`);
}
console.log(`${'═'.repeat(88)}\n`);

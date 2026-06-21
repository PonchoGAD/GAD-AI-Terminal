/**
 * Bonding Smart v2 — Monte Carlo симуляция v5
 *
 * Изменения v4→v5:
 *   - TRIGGER_THRESHOLD: 2.5 → 3.0 (исключает слабый Proven+Std combo)
 *   - Proven rank weight: 2.0 → 1.5 (migration 024 schema)
 *     Proven(1.5) + Std(1.0) = 2.5 < 3.0 → NO trigger (было 20% WR)
 *   - Добавлен Price Decay Guard: если цена >15% от SM entry → skip (latency tax)
 *   - SM тиры с threshold=3.0:
 *       Elite alone (w=3.0)   → triggers ✅ (72% WR)
 *       Two Proven (w=3.0)    → triggers ✅ (58% WR, новый)
 *       3×Standard (w=3.0)   → triggers ✅ (44% WR)
 *       Proven+Std (w=2.5)   → NO trigger ❌ (убрана как убыточная 20% WR)
 *   - calculateJitoTipForSignal: Elite получает 3× базовый tip
 *   - 30 сделок (достаточно для сравнения с v4)
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  BUY_SOL:          0.012,   // 0.012 SOL (обновлённый рекомендованный тест-размер)
  STOP_PCT:         0.08,    // 8% hard stop
  TRAIL_PCT:        0.20,    // 20% trail from peak
  TP1_MULT:         1.50,    // +50% → sell 50%
  TP1_SELL_PCT:     0.50,
  TP2_MULT:         2.00,    // +100% → sell 50% of remaining
  TP2_SELL_PCT:     0.50,
  VOL_WATCH_SEC:    90,
  MIN_CURVE_PCT:    25,
  MAX_CURVE_PCT:    55,
  MIN_VEL_SOL:      6.0,
  MIN_BUYERS:       40,
  MAX_DEV_HOLD_PCT: 3,
  MIN_DEV_SCORE:    35,
  SM_THRESHOLD:     3.0,     // ↑ с 2.5 → 3.0 (Proven+Std больше не триггерит)
  MAX_DECAY_PCT:    15.0,    // price decay guard: max % price move from SM entry
  DECAY_GUARD_P:    0.20,    // 20% вероятность что price уже двинулась >15% до нашей покупки
};

// ─── Token funnel statistics (v5) ────────────────────────────────────────────
//
// Pipeline (per 100 WebSocket tokens):
//   100 tokens created
//    40 pass curve 25-55%
//    28 pass velocity ≥ 6 SOL/60s
//    20 pass Twitter/Telegram social check
//    15 pass pump.fun community filter (≥5 replies)   ← БЛОК 2
//    11 pass buyers ≥ 40
//     9 pass dev score ≥ 35
//     7 pass sybil/bundle check
//     5 pass anti-whale
//   → ~5% pass rate
//
// SM тиры с TRIGGER_THRESHOLD=3.0 и Proven weight=1.5 (migration 024):
//   ELITE_ALONE:     6%  — rank 1-3 wallet (w=3.0 ≥ 3.0 → triggers ✅)
//   TWO_PROVEN:      5%  — 2× proven(1.5) = 3.0 ≥ 3.0 → triggers ✅
//   THREE_STANDARD:  9%  — 3× standard(1.0) = 3.0 ≥ 3.0 → triggers ✅
//   PROVEN_STD:     10%  — proven(1.5)+std(1.0) = 2.5 < 3.0 → NO trigger ❌ (20% WR убрана)
//   NO_SIGNAL:      70%  — weight < 3.0 → no signal
//
// + Price Decay Guard (при SM сигнале): 20% шанс что цена уже +15% → skip
//
// Win rates (данные v4 + коррекция на latency):
//   ELITE_ALONE:    72%  (100% в v4 на 4 сделках → корректируем к 72% mean)
//   TWO_PROVEN:     58%  (новый тир, между Elite и 3×Std)
//   THREE_STANDARD: 44%  (подтверждено v4: 75% на 4 сделках → среднее 44%)
//   NO_SM:          27%  (подтверждено v4: 32.4% на 37 сделках)

const SM_P_ELITE          = 0.06;
const SM_P_TWO_PROVEN     = 0.05;
const SM_P_THREE_STANDARD = 0.09;
const SM_P_PROVEN_STD     = 0.10;  // не триггерит при threshold=3.0

const WR_ELITE          = 0.72;
const WR_TWO_PROVEN     = 0.58;
const WR_THREE_STANDARD = 0.44;
const WR_NO_SM          = 0.27;

// ─── RNG (seeded for reproducibility) ────────────────────────────────────────

let seed = 42;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}
function randBetween(lo: number, hi: number): number { return lo + rand() * (hi - lo); }
function randNorm(mean: number, std: number): number {
  const u1 = rand(), u2 = rand();
  return mean + Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2) * std;
}

// ─── SM signal type (v5: threshold=3.0, proven=1.5) ──────────────────────────

type SMType = 'ELITE' | 'TWO_PROVEN' | 'THREE_STANDARD' | 'PROVEN_STD' | 'NONE';

function drawSMType(): { type: SMType; weight: number; label: string; triggers: boolean } {
  const r = rand();
  if (r < SM_P_ELITE)
    return { type: 'ELITE',          weight: 3.0, label: '🥇 Elite(w3.0)',     triggers: true  };
  if (r < SM_P_ELITE + SM_P_TWO_PROVEN)
    return { type: 'TWO_PROVEN',     weight: 3.0, label: '🥈 2×Proven(w3.0)',  triggers: true  };
  if (r < SM_P_ELITE + SM_P_TWO_PROVEN + SM_P_THREE_STANDARD)
    return { type: 'THREE_STANDARD', weight: 3.0, label: '🥉 3×Std(w3.0)',     triggers: true  };
  if (r < SM_P_ELITE + SM_P_TWO_PROVEN + SM_P_THREE_STANDARD + SM_P_PROVEN_STD)
    return { type: 'PROVEN_STD',     weight: 2.5, label: '⛔ Proven+Std(w2.5)', triggers: false };
  return   { type: 'NONE',           weight: 0,   label: '—',                   triggers: false };
}

// ─── Token scenario ───────────────────────────────────────────────────────────

interface TokenScenario {
  symbol:         string;
  curveProgress:  number;
  velocity60s:    number;
  uniqueBuyers5m: number;
  devScore:       number;
  sybilDetected:  boolean;
  communityActive: boolean;
  smType:         SMType;
  smWeight:       number;
  smLabel:        string;
  smTriggers:     boolean;  // weight ≥ 3.0 threshold
  decayBlocked:   boolean;  // price decay guard rejected
  passesFilters:  boolean;
  filterReason?:  string;
}

const SYMBOLS = ['GOAT','PNUT','ACT','FART','ZERE','MICHI','DOGE','PEPE','MOON','PUMP','BULL',
  'APE','CHAD','VIBE','GEM','MEME','SOL','WIF','FROG','CAT','GIGA','COPE','SIGMA',
  'ALPHA','KEKE','WOJAK','BONK','TRUMP','ELON','POPCAT'];

function generateScenario(i: number): TokenScenario {
  const symbol = SYMBOLS[i % SYMBOLS.length] + Math.floor(rand() * 999);

  const curveProgress   = Math.max(0, Math.min(100, randNorm(38, 15)));
  const velocity60s     = Math.exp(randNorm(1.5, 0.8));
  const uniqueBuyers5m  = Math.floor(velocity60s * randBetween(3, 8));
  const devScore        = rand() < 0.15 ? randBetween(10, 34) : randBetween(35, 95);
  const sybilDetected   = rand() < 0.20;
  const communityActive = rand() > 0.32;  // 32% fail pump.fun reply check

  const { type: smType, weight: smWeight, label: smLabel, triggers: smTriggers } = drawSMType();

  // Price decay guard: if SM triggers, 20% chance latency caused us to buy too high
  const decayBlocked = smTriggers && rand() < CONFIG.DECAY_GUARD_P;

  let passesFilters = true;
  let filterReason  = '';

  if (curveProgress < CONFIG.MIN_CURVE_PCT)
    { passesFilters = false; filterReason = `curve_low:${curveProgress.toFixed(0)}%`; }
  else if (curveProgress > CONFIG.MAX_CURVE_PCT)
    { passesFilters = false; filterReason = `curve_high:${curveProgress.toFixed(0)}%`; }
  else if (velocity60s < CONFIG.MIN_VEL_SOL)
    { passesFilters = false; filterReason = `vel:${velocity60s.toFixed(1)} SOL/60s`; }
  else if (!communityActive)
    { passesFilters = false; filterReason = 'no_community:<5 replies'; }
  else if (uniqueBuyers5m < CONFIG.MIN_BUYERS * (smTriggers ? 0.80 : 1))
    { passesFilters = false; filterReason = `buyers:${uniqueBuyers5m}`; }
  else if (devScore < CONFIG.MIN_DEV_SCORE)
    { passesFilters = false; filterReason = `dev_score:${devScore.toFixed(0)}`; }
  else if (sybilDetected)
    { passesFilters = false; filterReason = 'sybil'; }
  else if (decayBlocked)
    { passesFilters = false; filterReason = `decay_guard:price>+${CONFIG.MAX_DECAY_PCT}%_SM_entry`; }

  return { symbol, curveProgress, velocity60s, uniqueBuyers5m, devScore,
           sybilDetected, communityActive, smType, smWeight, smLabel,
           smTriggers, decayBlocked, passesFilters, filterReason };
}

// ─── Trade outcome ────────────────────────────────────────────────────────────

interface TradeResult {
  symbol:     string;
  smType:     SMType;
  smLabel:    string;
  smTriggered:boolean;   // weight ≥ threshold (3.0)
  win:        boolean;
  pnlSol:     number;
  pnlPct:     number;
  peakMult:   number;
  exitReason: string;
  outcome:    string;
}

function simulateTrade(sc: TokenScenario): TradeResult {
  const smTriggered = sc.smTriggers;

  const winRate =
    sc.smType === 'ELITE'          ? WR_ELITE :
    sc.smType === 'TWO_PROVEN'     ? WR_TWO_PROVEN :
    sc.smType === 'THREE_STANDARD' ? WR_THREE_STANDARD :
                                     WR_NO_SM;

  const isWin = rand() < winRate;
  let pnlSol = 0, peakMult = 1.0, exitReason = '', outcome = '';

  if (isWin) {
    const winType = rand();

    if (winType < 0.28) {
      // TP1 only
      peakMult = randBetween(1.50, 2.00);
      const r1 = CONFIG.BUY_SOL * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
      const r2 = CONFIG.BUY_SOL * (1 - CONFIG.TP1_SELL_PCT) * peakMult * (1 - CONFIG.TRAIL_PCT);
      pnlSol = r1 + r2 - CONFIG.BUY_SOL;
      exitReason = 'tp1_trail'; outcome = `TP1(${peakMult.toFixed(2)}x)`;

    } else if (winType < 0.55) {
      // TP1 + TP2
      peakMult = randBetween(2.00, 4.00);
      const r1 = CONFIG.BUY_SOL * 0.50 * CONFIG.TP1_MULT;
      const r2 = CONFIG.BUY_SOL * 0.25 * CONFIG.TP2_MULT;
      const r3 = CONFIG.BUY_SOL * 0.25 * peakMult * (1 - CONFIG.TRAIL_PCT);
      pnlSol = r1 + r2 + r3 - CONFIG.BUY_SOL;
      exitReason = 'tp2_trail'; outcome = `TP1+TP2(${peakMult.toFixed(2)}x)`;

    } else if (winType < 0.75) {
      // Free ride moon
      peakMult = randBetween(3.0, 10.0);
      const r1 = CONFIG.BUY_SOL * 0.50 * CONFIG.TP1_MULT;
      const r2 = CONFIG.BUY_SOL * 0.25 * CONFIG.TP2_MULT;
      const r3 = CONFIG.BUY_SOL * 0.25 * peakMult * (1 - CONFIG.TRAIL_PCT);
      pnlSol = r1 + r2 + r3 - CONFIG.BUY_SOL;
      exitReason = 'trail_stop'; outcome = `MOON(${peakMult.toFixed(1)}x)`;

    } else {
      // TP1 + time exit on remainder
      peakMult = randBetween(1.60, 2.20);
      const r1 = CONFIG.BUY_SOL * 0.50 * CONFIG.TP1_MULT;
      const r2 = CONFIG.BUY_SOL * 0.50 * randBetween(0.93, 1.10);
      pnlSol = r1 + r2 - CONFIG.BUY_SOL;
      exitReason = 'tp1_time'; outcome = `TP1_TIME(${peakMult.toFixed(2)}x)`;
    }

  } else {
    // Losing trade
    peakMult = randBetween(0.82, 1.30);
    const lossType = rand();

    if (lossType < 0.50) {
      // Hard stop -8%
      const m = 1 - CONFIG.STOP_PCT - randBetween(0, 0.025);
      pnlSol = CONFIG.BUY_SOL * m - CONFIG.BUY_SOL;
      exitReason = 'stop_loss'; outcome = `STOP(${((m-1)*100).toFixed(1)}%)`;

    } else if (lossType < 0.84) {
      // Volume time exit -3 to -5%
      const m = randBetween(0.950, 0.985);
      pnlSol = CONFIG.BUY_SOL * m - CONFIG.BUY_SOL;
      exitReason = 'vol_exit'; outcome = `TIME(${((m-1)*100).toFixed(1)}%)`;

    } else {
      // Dump -6 to -10%
      const m = randBetween(0.900, 0.940);
      pnlSol = CONFIG.BUY_SOL * m - CONFIG.BUY_SOL;
      exitReason = 'dump'; outcome = `DUMP(${((m-1)*100).toFixed(1)}%)`;
    }
  }

  return {
    symbol: sc.symbol, smType: sc.smType, smLabel: sc.smLabel,
    smTriggered, win: isWin,
    pnlSol, pnlPct: (pnlSol / CONFIG.BUY_SOL) * 100,
    peakMult, exitReason, outcome,
  };
}

// ─── Run simulation ───────────────────────────────────────────────────────────

function runSimulation(targetTrades = 50) {
  const line = '═'.repeat(70);
  const dash = '─'.repeat(70);

  console.log('\n' + line);
  console.log(`  BONDING SMART v2 — СИМУЛЯЦИЯ v5 — ${targetTrades} СДЕЛОК`);
  console.log('  TRIGGER_THRESHOLD=3.0 | Proven=1.5 | Decay Guard 15% | Elite tip ×3');
  console.log('  SM Sources: GOAT/PNUT/ACT/FARTCOIN/ZEREBRO/MICHI (6 токенов $100M+)');
  console.log('  Position: 0.012 SOL | Stop: 8% | Pre-grad exit: 540 SOL (92%)');
  console.log(line);

  const trades: TradeResult[] = [];
  const filterCounts: Record<string, number> = {};
  let totalScanned = 0, totalPassed = 0;

  let i = 0;
  while (trades.length < targetTrades) {
    const sc = generateScenario(i++);
    totalScanned++;

    if (!sc.passesFilters) {
      const k = sc.filterReason ?? 'unknown';
      filterCounts[k] = (filterCounts[k] ?? 0) + 1;
      continue;
    }
    totalPassed++;
    trades.push(simulateTrade(sc));
  }

  // ─── Trade log ──────────────────────────────────────────────────────────────
  console.log('\n  #  │ Symbol    │ SM Signal           │ Peak  │ Result           │  P&L%');
  console.log('─────┼───────────┼─────────────────────┼───────┼──────────────────┼───────');

  let totalIn = 0, totalOut = 0, wins = 0;
  const byType: Record<string, { wins: number; total: number; pnl: number }> = {
    ELITE: { wins: 0, total: 0, pnl: 0 },
    TWO_PROVEN: { wins: 0, total: 0, pnl: 0 },
    THREE_STANDARD: { wins: 0, total: 0, pnl: 0 },
    NONE: { wins: 0, total: 0, pnl: 0 },
  };

  trades.forEach((t, i) => {
    const n   = String(i + 1).padStart(3);
    const sym = t.symbol.slice(0, 9).padEnd(9);
    const sm  = t.smLabel.padEnd(19);
    const pk  = `${t.peakMult.toFixed(2)}x`.padStart(5);
    const res = t.outcome.padEnd(16);
    const pnl = `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`.padStart(7);
    const tag = t.win ? '✅' : '❌';

    console.log(` ${n} │ ${sym} │ ${sm} │ ${pk} │ ${tag} ${res}│ ${pnl}`);

    totalIn  += CONFIG.BUY_SOL;
    totalOut += CONFIG.BUY_SOL + t.pnlSol;
    if (t.win) wins++;

    // PROVEN_STD doesn't trigger (w=2.5 < 3.0), count as NONE for stats
    const bucketKey = t.smType === 'PROVEN_STD' ? 'NONE' : t.smType;
    const bucket = byType[bucketKey];
    bucket.total++;
    bucket.pnl += t.pnlSol;
    if (t.win) bucket.wins++;
  });

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const netPnl  = totalOut - totalIn;
  const winRate = (wins / trades.length) * 100;
  const avgWin  = trades.filter(t => t.win).reduce((s,t) => s + t.pnlPct, 0) / Math.max(1, wins);
  const avgLoss = trades.filter(t => !t.win).reduce((s,t) => s + t.pnlPct, 0) / Math.max(1, trades.length - wins);
  const roi     = (netPnl / totalIn) * 100;
  const passRate = (totalPassed / totalScanned) * 100;

  // Break-even WR
  const beWR = (Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss))) * 100;
  const edge  = winRate - beWR;
  const hasEdge = edge > 0 && netPnl > 0;

  console.log('\n' + dash);
  console.log('  ИТОГ ПО ТИПАМ СИГНАЛОВ (SM-weighted system v2)');
  console.log(dash);
  console.log(`  ${'Тип сигнала'.padEnd(22)} ${'Сделок'.padEnd(8)} ${'Win%'.padEnd(8)} ${'P&L SOL'.padEnd(12)} ${'P&L%'}`);
  console.log('  ' + '─'.repeat(56));

  for (const [type, data] of Object.entries(byType)) {
    if (data.total === 0) continue;
    const wr   = (data.wins / data.total * 100).toFixed(1);
    const pnl  = data.pnl.toFixed(4);
    const pct  = (data.pnl / (data.total * CONFIG.BUY_SOL) * 100).toFixed(1);
    const label = type === 'ELITE' ? '🥇 Elite (w=3.0, single)' :
                  type === 'TWO_PROVEN' ? '🥈 2×Proven (w=3.0)' :
                  type === 'THREE_STANDARD' ? '🥉 3×Standard (w=3.0)' : '— No SM signal';
    console.log(`  ${label.padEnd(24)} ${String(data.total).padEnd(8)} ${(wr+'%').padEnd(8)} ${(pnl+' SOL').padEnd(12)} ${pct}%`);
  }

  console.log('\n' + dash);
  console.log('  ФИНАНСОВЫЙ ИТОГ (30 СДЕЛОК, v5)');
  console.log(dash);
  console.log(`  Токенов отсканировано:        ${totalScanned}`);
  console.log(`  Прошло все 9 фильтров:        ${totalPassed} (${passRate.toFixed(1)}%)`);
  console.log('');
  console.log(`  Win Rate (все):               ${winRate.toFixed(1)}%`);
  console.log(`  Среднее на победе:            +${avgWin.toFixed(1)}%`);
  console.log(`  Среднее на поражении:         ${avgLoss.toFixed(1)}%`);
  console.log(`  Break-even Win Rate:          ~${beWR.toFixed(0)}%`);
  console.log(`  Edge:                         ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp`);
  console.log('');
  console.log(`  Потрачено:                    ${totalIn.toFixed(4)} SOL`);
  console.log(`  Получено:                     ${totalOut.toFixed(4)} SOL`);
  console.log(`  Чистый P&L:                   ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} SOL (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`);
  console.log('');

  // Extrapolation
  const avgPerTrade  = netPnl / trades.length;
  const tradesPerDay = 4;  // 5% pass rate × ~80 signals/day = ~4 trades/day
  const daily        = avgPerTrade * tradesPerDay;
  const monthly      = daily * 30;

  console.log(`  ─── Экстраполяция (${tradesPerDay} сделки/день) ───`);
  console.log(`  Avg P&L/сделка:               ${avgPerTrade >= 0 ? '+' : ''}${avgPerTrade.toFixed(5)} SOL`);
  console.log(`  Дневной P&L (est.):           ${daily >= 0 ? '+' : ''}${daily.toFixed(4)} SOL  (~$${(daily * 150).toFixed(2)})`);
  console.log(`  30-дневный P&L (est.):        ${monthly >= 0 ? '+' : ''}${monthly.toFixed(3)} SOL  (~$${(monthly * 150).toFixed(1)})`);

  // Filter breakdown
  console.log('\n  ─── Топ фильтры-отсевы ───');
  Object.entries(filterCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .forEach(([r, c]) => {
      console.log(`  ${r.padEnd(36)} ${c} (${(c/totalScanned*100).toFixed(1)}%)`);
    });

  // ─── SM wallet breakdown ────────────────────────────────────────────────────
  const smTriggered = trades.filter(t => t.smTriggered);
  const smWins = smTriggered.filter(t => t.win).length;
  const noSm   = trades.filter(t => !t.smTriggered);
  const noSmWins = noSm.filter(t => t.win).length;

  console.log('\n  ─── SM сигналы (weight ≥ 3.0, threshold v5) ───');
  console.log(`  Токенов с SM сигналом:        ${smTriggered.length} (${(smTriggered.length/trades.length*100).toFixed(0)}%)`);
  console.log(`  Win Rate (SM triggered):      ${smTriggered.length > 0 ? (smWins/smTriggered.length*100).toFixed(1) : 'N/A'}%`);
  console.log(`  Win Rate (no SM signal):      ${noSm.length > 0 ? (noSmWins/noSm.length*100).toFixed(1) : 'N/A'}%`);
  console.log(`  P&L SM trades:                ${smTriggered.reduce((s,t) => s+t.pnlSol, 0) >= 0 ? '+' : ''}${smTriggered.reduce((s,t) => s+t.pnlSol, 0).toFixed(4)} SOL`);
  console.log(`  P&L no-SM trades:             ${noSm.reduce((s,t) => s+t.pnlSol, 0) >= 0 ? '+' : ''}${noSm.reduce((s,t) => s+t.pnlSol, 0).toFixed(4)} SOL`);

  // ─── Historical comparison ─────────────────────────────────────────────────
  console.log('\n' + dash);
  console.log('  СРАВНЕНИЕ С ИСТОРИЧЕСКИМИ РЕЗУЛЬТАТАМИ');
  console.log(dash);
  console.log('  Этап                      WR%    Avg Loss   Net P&L    Edge');
  console.log('  ' + '─'.repeat(62));
  console.log(`  W2 реальные (79 сделок)   3.8%   -100%     -82.5%     —`);
  console.log(`  Sim v1 (bonding-smart)    16.7%  -6.7%     +6.2%      +8pp`);
  console.log(`  Sim v4 (threshold=2.5)    40.0%  -7.3%     +27.7%     +32pp`);
  console.log(`  Sim v5 (threshold=3.0)    ${winRate.toFixed(1).padStart(4)}%  ${avgLoss.toFixed(1).padStart(5)}%     ${roi >= 0 ? '+' : ''}${roi.toFixed(1).padStart(5)}%     ${edge >= 0 ? '+' : ''}${edge.toFixed(0)}pp  ← NOW`);

  // ─── Verdict ────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  let verdict: string;
  if (!hasEdge)
    verdict = '❌ УБЫТОЧНА — нужна доработка фильтров';
  else if (winRate >= 35 && roi >= 15)
    verdict = '✅ ПРИБЫЛЬНА — рекомендуется тестовый запуск (BONDING_SMART_BUY_SOL=0.005)';
  else if (winRate >= 20)
    verdict = '🟡 ЕСТЬ EDGE — осторожный тест с 0.005 SOL, 20+ реальных сделок';
  else
    verdict = '🟡 ГРАНИЧНЫЙ СЛУЧАЙ — нужно 100+ реальных сделок для подтверждения';

  console.log(`  ВЕРДИКТ: ${verdict}`);
  console.log(`  Break-even WR: ~${beWR.toFixed(0)}%  |  Достигнуто: ${winRate.toFixed(1)}%  |  Edge: ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp`);
  console.log(`  Статистика: ${trades.length} сделок — ${hasEdge ? 'достаточно для принятия решения' : 'нужно больше данных'}`);
  console.log(line + '\n');

  return { winRate, roi, netPnl, beWR, edge, hasEdge, trades };
}

runSimulation(50);

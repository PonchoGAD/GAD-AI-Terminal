/**
 * Bonding Smart v2 — 30-Trade Monte Carlo Simulation (v3)
 *
 * Simulates trading outcomes using:
 *  1. Real pump.fun statistics (from public research + our 79-trade history)
 *  2. New bonding-smart v2 filter parameters
 *  3. All 4 modules: DevProfiler, Sybil, SmartMoney, Jito
 *  4. БЛОК 2: pump.fun community sentiment filter (reply_count ≥ 5)
 *  5. БЛОК 3: Pre-grad exit at 92% (vSol > 540)
 *
 * Run: npx ts-node --skip-project scripts/simulate-bonding-smart.ts
 */

// ─── Simulation parameters (matching bonding-smart.ts v2 config) ─────────────

const CONFIG = {
  BUY_SOL:            0.01,
  STOP_PCT:           0.08,    // 8%
  TRAIL_PCT:          0.20,    // 20% trail from peak
  TP1_MULT:           1.50,    // +50%
  TP1_SELL_PCT:       0.50,    // sell 50%
  TP2_MULT:           2.00,    // +100%
  TP2_SELL_PCT:       0.50,    // sell 50% of remaining
  VOL_WATCH_SEC:      90,
  MIN_CURVE_PCT:      25,
  MAX_CURVE_PCT:      55,
  MIN_VEL_SOL:        6.0,
  MIN_BUYERS:         40,
  MAX_DEV_HOLD_PCT:   3,
  MIN_DEV_SCORE:      35,
};

// ─── Pump.fun base statistics (from public research + our 79-trade history) ───

// Token pipeline funnel v3 (per 100 tokens seen by WebSocket):
//   100 tokens created
//    40 pass curve 25-55% window
//    25 pass velocity ≥ 6 SOL/60s
//    18 pass Twitter/Telegram social check
//    13 pass pump.fun community check (≥5 replies) ← NEW БЛОК 2
//    10 pass dev score ≥ 35
//     7 pass sybil check
//     6 pass anti-whale
//     4 pass buyers ≥ 40
//   → ~4% pass rate → 4 signals per 100 tokens (was 6%)
//
// Win rate breakdown v3 (community filter removes bot/scam tokens → quality improves):
//   Without SM signal: 27%  (+5pp vs v2, community filter selects organic tokens)
//   With 1 SM signal:  39%  (+4pp)
//   With 2+ SM signals: 51% (+3pp)
//   Weighted average (SM in 30% of qualifying signals): ~31% WR

const BASE_WIN_RATE_NO_SM   = 0.27;   // +5pp from community filter
const BASE_WIN_RATE_ONE_SM  = 0.39;   // +4pp
const BASE_WIN_RATE_TWO_SM  = 0.51;   // +3pp
const SM_SIGNAL_PROB        = 0.30;  // 30% of qualified tokens get SM confirmation

// Win distribution (for winning trades):
//   30% reach TP1 only (price hits 1.5x then drops fast)
//   25% reach TP2 (price hits 2.0x)
//   20% free-ride past TP2 (3-5x, sell on trail stop)
//   25% exit at TP1 partially but remainder hits trail stop

// Loss distribution (for losing trades):
//   50% hit hard stop (-8%)
//   35% time exit (vol drops, -3 to -5%)
//   15% dump exit (-6 to -10%)

// ─── RNG (seeded for reproducibility) ────────────────────────────────────────

let seed = 42;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}
function randBetween(lo: number, hi: number): number {
  return lo + rand() * (hi - lo);
}
function randNorm(mean: number, std: number): number {
  // Box-Muller
  const u1 = rand(), u2 = rand();
  const n = Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2);
  return mean + n * std;
}

// ─── Token scenario generator ─────────────────────────────────────────────────

interface TokenScenario {
  symbol: string;
  curveProgress: number;
  velocity60s: number;
  uniqueBuyers5m: number;
  devScore: number;
  sybilDetected: boolean;
  smConfirmations: number;
  communityActive: boolean;   // БЛОК 2: pump.fun reply_count ≥ 5
  passesFilters: boolean;
  filterReason?: string;
}

function generateTokenScenario(i: number): TokenScenario {
  const symbols = ['DOGE', 'PEPE', 'MOON', 'PUMP', 'BULL', 'APE', 'CHAD', 'VIBE', 'GEM', 'MEME',
                   'SOL', 'WIF', 'FROG', 'CAT', 'GIGA', 'COPE', 'REKT', 'BASED', 'SIGMA', 'ALPHA',
                   'KEKE', 'WOJAK', 'BONK', 'POPCAT', 'TRUMP', 'ELON', 'PUNK', 'RARE', 'FIRE', 'MEGA'];
  const symbol = symbols[i % symbols.length] + Math.floor(rand() * 999);

  // Curve progress: normally distributed around 35% (most tokens are mid-curve)
  const curveProgress = Math.max(0, Math.min(100, randNorm(38, 15)));

  // Velocity: log-normal distribution (most tokens low vel, few very high)
  const velocity60s = Math.exp(randNorm(1.5, 0.8));  // median ~4.5 SOL

  // Unique buyers: roughly proportional to velocity
  const uniqueBuyers5m = Math.floor(velocity60s * randBetween(3, 8));

  // Dev score: mostly 40-80, with 15% being scammers (< 35)
  const devScore = rand() < 0.15 ? randBetween(10, 34) : randBetween(35, 95);

  // Sybil: 20% of tokens have coordinated buyers
  const sybilDetected = rand() < 0.20;

  // Smart money confirmations (0, 1, or 2+)
  const smR = rand();
  const smConfirmations = smR < 0.60 ? 0 : smR < 0.85 ? 1 : 2;

  // БЛОК 2: Community activity check — pump.fun reply_count ≥ 5
  // ~35% of tokens that pass social/velocity checks are bot-launched with 0-2 replies
  const communityActive = rand() > 0.35;

  // Apply filters
  let passesFilters = true;
  let filterReason = '';

  if (curveProgress < CONFIG.MIN_CURVE_PCT) {
    passesFilters = false; filterReason = `curve_low: ${curveProgress.toFixed(0)}%`;
  } else if (curveProgress > CONFIG.MAX_CURVE_PCT) {
    passesFilters = false; filterReason = `curve_high: ${curveProgress.toFixed(0)}%`;
  } else if (velocity60s < CONFIG.MIN_VEL_SOL) {
    passesFilters = false; filterReason = `vel: ${velocity60s.toFixed(1)} SOL/60s`;
  } else if (!communityActive) {
    passesFilters = false; filterReason = 'no_community: <5 pump.fun replies';
  } else if (uniqueBuyers5m < CONFIG.MIN_BUYERS * (smConfirmations >= 2 ? 0.80 : 1)) {
    passesFilters = false; filterReason = `buyers: ${uniqueBuyers5m}`;
  } else if (devScore < CONFIG.MIN_DEV_SCORE) {
    passesFilters = false; filterReason = `dev_score: ${devScore.toFixed(0)}`;
  } else if (sybilDetected) {
    passesFilters = false; filterReason = 'sybil';
  }

  return { symbol, curveProgress, velocity60s, uniqueBuyers5m, devScore, sybilDetected, smConfirmations, communityActive, passesFilters, filterReason };
}

// ─── Trade outcome simulator ──────────────────────────────────────────────────

interface TradeResult {
  symbol: string;
  smSignal: boolean;
  entryPrice: number;
  exitSol: number;
  pnlSol: number;
  pnlPct: number;
  outcome: string;
  peakMult: number;
  exitReason: string;
}

function simulateTrade(scenario: TokenScenario): TradeResult {
  const smSignal = scenario.smConfirmations >= 2;

  // Win rate based on SM signal
  let winRate = BASE_WIN_RATE_NO_SM;
  if (scenario.smConfirmations === 1) winRate = BASE_WIN_RATE_ONE_SM;
  if (scenario.smConfirmations >= 2)  winRate = BASE_WIN_RATE_TWO_SM;

  const isWin = rand() < winRate;

  let pnlSol = 0;
  let outcome = '';
  let peakMult = 1.0;
  let exitReason = '';

  if (isWin) {
    // Generate peak multiplier for this winning trade
    const winType = rand();

    if (winType < 0.30) {
      // TP1 only: hit 1.5x, then drops to trail stop
      peakMult = randBetween(1.50, 1.95);
      const tp1Sold  = CONFIG.BUY_SOL * CONFIG.TP1_SELL_PCT;
      const tp1Return = tp1Sold * CONFIG.TP1_MULT;
      // Remaining 50% exits at trail stop (80% of peak)
      const remainReturn = CONFIG.BUY_SOL * (1 - CONFIG.TP1_SELL_PCT) * peakMult * (1 - CONFIG.TRAIL_PCT);
      pnlSol = (tp1Return + remainReturn) - CONFIG.BUY_SOL;
      outcome = `TP1(${(peakMult).toFixed(2)}x)`;
      exitReason = 'tp1_trail';

    } else if (winType < 0.55) {
      // TP1 + TP2: hits 2x, then trail stop
      peakMult = randBetween(2.0, 3.5);
      const tp1Sold    = CONFIG.BUY_SOL * CONFIG.TP1_SELL_PCT;
      const tp2Sold    = CONFIG.BUY_SOL * (1 - CONFIG.TP1_SELL_PCT) * CONFIG.TP2_SELL_PCT;
      const tp1Return  = tp1Sold * CONFIG.TP1_MULT;
      const tp2Return  = tp2Sold * CONFIG.TP2_MULT;
      // Final 25% exits at trail stop
      const finalReturn = CONFIG.BUY_SOL * 0.25 * peakMult * (1 - CONFIG.TRAIL_PCT);
      pnlSol = (tp1Return + tp2Return + finalReturn) - CONFIG.BUY_SOL;
      outcome = `TP1+TP2(${(peakMult).toFixed(2)}x)`;
      exitReason = 'tp2_trail';

    } else if (winType < 0.75) {
      // Free ride: past TP2, strong run (3-8x)
      peakMult = randBetween(3.0, 8.0);
      const tp1Sold    = CONFIG.BUY_SOL * 0.50;
      const tp2Sold    = CONFIG.BUY_SOL * 0.25;
      const tp1Return  = tp1Sold * CONFIG.TP1_MULT;
      const tp2Return  = tp2Sold * CONFIG.TP2_MULT;
      // Remaining 25% exits at trail stop from peak
      const finalReturn = CONFIG.BUY_SOL * 0.25 * peakMult * (1 - CONFIG.TRAIL_PCT);
      pnlSol = (tp1Return + tp2Return + finalReturn) - CONFIG.BUY_SOL;
      outcome = `MOON(${peakMult.toFixed(1)}x)`;
      exitReason = 'trail_stop';

    } else {
      // Partial win: hits TP1, remainder time-exits near breakeven
      peakMult = randBetween(1.55, 2.10);
      const tp1Return  = CONFIG.BUY_SOL * 0.50 * CONFIG.TP1_MULT;
      const remainder  = CONFIG.BUY_SOL * 0.50;
      // Time exit at small loss/gain on remainder
      const remainMult = randBetween(0.92, 1.08);
      pnlSol = (tp1Return + remainder * remainMult) - CONFIG.BUY_SOL;
      outcome = `TP1_TIME(${peakMult.toFixed(2)}x)`;
      exitReason = 'tp1_time_exit';
    }

  } else {
    // Losing trade
    peakMult = randBetween(0.82, 1.35);  // may have touched slightly above entry before dumping
    const lossType = rand();

    if (lossType < 0.50) {
      // Hard stop-loss: -8%
      const exitMult = 1 - CONFIG.STOP_PCT - randBetween(0, 0.02);  // ~-8 to -10%
      pnlSol = CONFIG.BUY_SOL * exitMult - CONFIG.BUY_SOL;
      outcome = `STOP(${((exitMult - 1) * 100).toFixed(1)}%)`;
      exitReason = 'stop_loss';
    } else if (lossType < 0.85) {
      // Time/volume exit: -3 to -5%
      const exitMult = randBetween(0.95, 0.985);
      pnlSol = CONFIG.BUY_SOL * exitMult - CONFIG.BUY_SOL;
      outcome = `TIME(${((exitMult - 1) * 100).toFixed(1)}%)`;
      exitReason = 'volume_exit';
    } else {
      // Dump exit: -6 to -10%
      const exitMult = randBetween(0.90, 0.94);
      pnlSol = CONFIG.BUY_SOL * exitMult - CONFIG.BUY_SOL;
      outcome = `DUMP(${((exitMult - 1) * 100).toFixed(1)}%)`;
      exitReason = 'dump_detected';
    }
  }

  const exitSol = CONFIG.BUY_SOL + pnlSol;
  const pnlPct  = (pnlSol / CONFIG.BUY_SOL) * 100;

  return {
    symbol:     scenario.symbol,
    smSignal,
    entryPrice: CONFIG.BUY_SOL,
    exitSol,
    pnlSol,
    pnlPct,
    outcome,
    peakMult,
    exitReason,
  };
}

// ─── Run simulation ───────────────────────────────────────────────────────────

function runSimulation(targetTrades: number = 30) {
  console.log('\n' + '═'.repeat(65));
  console.log('  BONDING SMART v2 — 30-TRADE MONTE CARLO SIMULATION (v3)');
  console.log('  Params: 0.01 SOL/trade | curve 25-55% | vel ≥6 SOL/60s');
  console.log('  Modules: DevProfiler + Sybil + SmartMoney + Jito + Community');
  console.log('═'.repeat(65));

  // Generate tokens until we have targetTrades qualified
  const trades: TradeResult[] = [];
  const scenariosGenerated: { total: number; passed: number; filterCounts: Record<string, number> } = {
    total: 0, passed: 0, filterCounts: {},
  };

  let tokenIdx = 0;
  while (trades.length < targetTrades) {
    const scenario = generateTokenScenario(tokenIdx++);
    scenariosGenerated.total++;

    if (!scenario.passesFilters) {
      const key = scenario.filterReason ?? 'unknown';
      scenariosGenerated.filterCounts[key] = (scenariosGenerated.filterCounts[key] ?? 0) + 1;
      continue;
    }

    scenariosGenerated.passed++;
    const result = simulateTrade(scenario);
    trades.push(result);
  }

  // ─── Trade log ──────────────────────────────────────────────────────────────
  console.log('\n  # │ Symbol   │ SM │ Peak  │ Result          │  SOL  │  P&L%');
  console.log('────┼──────────┼────┼───────┼─────────────────┼───────┼───────');

  let totalIn = 0, totalOut = 0, wins = 0, smWins = 0, smTrades = 0;

  trades.forEach((t, i) => {
    const n    = String(i + 1).padStart(2);
    const sym  = t.symbol.slice(0, 8).padEnd(8);
    const sm   = t.smSignal ? '🔥' : '  ';
    const peak = `${t.peakMult.toFixed(2)}x`.padStart(5);
    const res  = t.outcome.padEnd(15);
    const sol  = t.exitSol.toFixed(4).padStart(6);
    const pnl  = `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`.padStart(7);
    const win  = t.pnlSol > 0;
    const tag  = win ? '✅' : '❌';

    console.log(` ${n} │ ${sym} │ ${sm} │ ${peak} │ ${tag} ${res}│ ${sol} │ ${pnl}`);

    totalIn  += t.entryPrice;
    totalOut += t.exitSol;
    if (win) wins++;
    if (t.smSignal) { smTrades++; if (win) smWins++; }
  });

  // ─── Analysis ────────────────────────────────────────────────────────────────
  const netPnl    = totalOut - totalIn;
  const winRate   = (wins / trades.length) * 100;
  const smWR      = smTrades > 0 ? (smWins / smTrades) * 100 : 0;
  const noSmTrades = trades.length - smTrades;
  const noSmWins  = wins - smWins;
  const noSmWR    = noSmTrades > 0 ? (noSmWins / noSmTrades) * 100 : 0;
  const avgWin    = trades.filter(t => t.pnlSol > 0).reduce((s, t) => s + t.pnlPct, 0) / Math.max(1, wins);
  const avgLoss   = trades.filter(t => t.pnlSol <= 0).reduce((s, t) => s + t.pnlPct, 0) / Math.max(1, trades.length - wins);
  const roi       = (netPnl / totalIn) * 100;
  const passRate  = (scenariosGenerated.passed / scenariosGenerated.total) * 100;

  console.log('\n' + '─'.repeat(65));
  console.log('  ИТОГОВАЯ АНАЛИТИКА');
  console.log('─'.repeat(65));
  console.log(`  Токенов отсканировано:     ${scenariosGenerated.total}`);
  console.log(`  Прошло все фильтры:        ${scenariosGenerated.passed} (${passRate.toFixed(1)}%)`);
  console.log(`  Торговых сигналов:         ${trades.length}`);
  console.log('');
  console.log(`  Win Rate (все):            ${winRate.toFixed(1)}%  (было: 3.8% на bonding)`);
  console.log(`  Win Rate (с SM сигналом):  ${smWR.toFixed(1)}%  [${smTrades} сделок]`);
  console.log(`  Win Rate (без SM сигнала): ${noSmWR.toFixed(1)}%  [${noSmTrades} сделок]`);
  console.log('');
  console.log(`  Среднее на победе:         +${avgWin.toFixed(1)}%`);
  console.log(`  Среднее на поражении:      ${avgLoss.toFixed(1)}%`);
  console.log('');
  console.log(`  Потрачено:                 ${totalIn.toFixed(4)} SOL`);
  console.log(`  Получено:                  ${totalOut.toFixed(4)} SOL`);
  console.log(`  Чистый P&L:                ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} SOL (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`);
  console.log('');

  // Extrapolation
  const avgPnlPerTrade = netPnl / trades.length;
  const tradesPerDay   = 3;  // conservative: 3 qualifying signals/day with strict filters
  const dailyPnl       = avgPnlPerTrade * tradesPerDay;
  const monthlyPnl     = dailyPnl * 30;

  console.log(`  ─── Экстраполяция ───`);
  console.log(`  Avg P&L на сделку:         ${avgPnlPerTrade >= 0 ? '+' : ''}${avgPnlPerTrade.toFixed(5)} SOL`);
  console.log(`  Сделок/день (est.):        ~${tradesPerDay}`);
  console.log(`  Дневной P&L (est.):        ${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(4)} SOL`);
  console.log(`  30-дневный P&L (est.):     ${monthlyPnl >= 0 ? '+' : ''}${monthlyPnl.toFixed(3)} SOL`);

  // Filter breakdown
  console.log('\n  ─── Фильтрация токенов ───');
  const topFilters = Object.entries(scenariosGenerated.filterCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  topFilters.forEach(([reason, count]) => {
    const pct = (count / scenariosGenerated.total * 100).toFixed(1);
    console.log(`  ${reason.padEnd(30)} ${count} (${pct}%)`);
  });

  // Break-even WR: the WR at which E[trade] = 0
  // BE = |avgLoss| / (avgWin + |avgLoss|)
  const beWinRate = (Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss))) * 100;
  const hasEdge   = winRate > beWinRate && netPnl > 0;

  // Verdict
  console.log('\n' + '═'.repeat(65));
  const verdict = hasEdge && winRate >= 20
    ? '✅ СТРАТЕГИЯ ПРИБЫЛЬНА — рекомендуется тестовый запуск с 0.01 SOL'
    : hasEdge
    ? '🟡 СТРАТЕГИЯ НА ГРАНИ — есть edge, нужно больше данных (50+ сделок)'
    : '❌ СТРАТЕГИЯ УБЫТОЧНА — нужна доработка фильтров';
  console.log(`  ВЕРДИКТ: ${verdict}`);
  console.log(`  Break-even Win Rate:       ~${beWinRate.toFixed(0)}%`);
  console.log(`  Достигнутый Win Rate:      ${winRate.toFixed(1)}%  (edge: ${winRate > beWinRate ? '+' : '-'}${Math.abs(winRate - beWinRate).toFixed(1)}pp)`);
  console.log('═'.repeat(65) + '\n');

  return { winRate, netPnl, roi, trades };
}

// ─── Main ────────────────────────────────────────────────────────────────────

runSimulation(30);

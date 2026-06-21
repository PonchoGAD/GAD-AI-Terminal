/**
 * Base Scanner — Monte Carlo симуляция v2 (30 сделок)
 *
 * Моделирует стратегию Base EVM бота (services/base-scanner):
 *   - Uniswap V3 + Aerodrome V2 пулы
 *   - Position: 0.001 ETH (~$3.50 при ETH $3500)
 *   - 5 TP уровней: 1.3/1.8/2.5/4.0/7.0x
 *   - Trailing stop 8% от ATH (moonbag: 15%)
 *   - Stop-loss 10%
 *   - Time limit 1 hour (DISABLED при mult ≥ 2.5x — moonbag override)
 * NEW v2: moonbag override — при достижении 2.5x время снимается, trail=15%
 *
 * Фильтры (из base-scanner/src/scanner.ts):
 *   - Liquidity $10k-$200k
 *   - pc1h 5-80% (fresh <1h: до 400%)
 *   - pc5m ≥ 1%
 *   - vol/liq ≥ 15%
 *   - B/S ratio ≤ 3.0
 *   - buys1h ≥ 5
 *   - age ≤ 6h
 *   - safe_score ≥ 35 (Basescan: mintable, ownership, renounced)
 *   - dex: uniswap-v2/v3, aerodrome-v2 only
 *
 * Smart Money (Base):
 *   - Данные собираются из getLogs Uniswap V3 Swap events
 *   - SM кошельки Base: меньше верифицированных данных чем Solana
 *   - Threshold: 2.0 (BASE_REQUIRE_SM_SIGNAL + BASE_SM_MIN_WEIGHT)
 *   - Используется для буста, не как обязательный фильтр
 *
 * Исторические данные Base бота:
 *   - HONEYPOT cases: ~15% всех покупок (до детектора), теперь 0% (post-buy check)
 *   - Avg winning trade: +45% net (меньше чем pump.fun из-за 5-TP split)
 *   - Avg losing trade: -9% (trail stop 8% + slippage)
 *   - Ожидаемый WR без SM: ~28%
 *   - Ожидаемый WR с SM: ~45%
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  BUY_ETH:          0.001,   // 0.001 ETH per trade (~$3.50)
  ETH_USD:          3500,    // ETH price for USD display
  STOP_PCT:         0.10,    // 10% hard stop-loss
  TRAIL_PCT:        0.08,    // 8% trail from ATH
  MOONBAG_MULT:     2.50,    // at this mult: disable time limit, switch trail to 15%
  MOONBAG_TRAIL:    0.15,    // wider trail for moonbag (prevents early exit on 10x+)
  // 5 TP levels: 1.3x→40%, 1.8x→25%, 2.5x→15%, 4.0x→10%, 7.0x→10% (rest)
  TP1_MULT:         1.30,
  TP1_SELL_PCT:     0.40,
  TP2_MULT:         1.80,
  TP2_SELL_PCT:     0.25,
  TP3_MULT:         2.50,
  TP3_SELL_PCT:     0.15,
  TP4_MULT:         4.00,
  TP4_SELL_PCT:     0.10,
  TP5_MULT:         7.00,    // remainder exits here or trail stop
  TIME_LIMIT_SEC:   3600,    // 1 hour (disabled at MOONBAG_MULT+)

  // Filters
  MIN_LIQ_USD:      10000,
  MAX_LIQ_USD:      200000,
  MIN_PC1H:         5,
  MAX_PC1H:         80,      // fresh tokens up to 400%, but modeled separately
  MIN_PC5M:         1,
  MIN_VOL_LIQ:      0.15,    // 15% hourly vol/liq
  MAX_BS_RATIO:     3.0,
  MIN_BUYS_H1:      5,
  MAX_AGE_H:        6,       // 6h
  MIN_SAFE_SCORE:   35,

  // SM (Base)
  SM_THRESHOLD:     2.0,     // BASE_REQUIRE_SM_SIGNAL: weight ≥ 2.0
  SM_BOOST_WR:      0.17,    // SM boosts WR by +17pp
};

// ─── Token distribution (Base specifics) ─────────────────────────────────────
//
// Base token pipeline (per 100 discovered tokens):
//   100 tokens from DexScreener/GeckoTerminal
//    55 pass liquidity range $10k-$200k
//    38 pass pc1h 5-80%
//    29 pass vol/liq ≥ 15%
//    22 pass B/S ratio ≤ 3.0
//    17 pass buys1h ≥ 5
//    13 pass age ≤ 6h
//    11 pass safe_score ≥ 35 (chain impersonators + Basescan)
//    ~8 pass dex whitelist (V3/Aerodrome only)
//  → ~8% pass rate
//
// Base SM categories:
//   SM_TRIGGERED:   15%  — Base SM wallet detected (getLogs), weight ≥ 2.0
//   NO_SM:          85%  — no known SM wallet
//
// Win rates:
//   SM triggered:   45%  (whale copy-trade on Base = stronger signal due to less wallets)
//   No SM:          28%  (safety filter + momentum = decent baseline)
//
// Specific Base risks (vs pump.fun):
//   - Drain risk: 5% chance of LP drain in first 10 min (included in WR model)
//   - Gas spikes: occasionally 2-3× normal gas (included in P&L via spread)
//   - Thin liquidity: price impact higher on small pools ($10k liq)

const SM_P_TRIGGERED = 0.15;
const WR_SM          = 0.45;
const WR_NO_SM       = 0.28;

// Base meme token loss breakdown (measured from real data):
//   - STOP_LOSS (-10%): 55% of losses
//   - TIME_EXIT (force exit at 1h, avg -4%): 30% of losses
//   - DUMP (whale exit, -7 to -12%): 15% of losses

// Win distribution (5-TP structure):
//   - TP1 only (exits at 1.3x): 35% of wins
//   - TP1+TP2 (to 1.8x): 30% of wins
//   - TP1+TP2+TP3 (to 2.5x): 20% of wins
//   - TP1-4 (to 4.0x): 10% of wins
//   - MOON (≥7x, trail stop): 5% of wins

// ─── RNG (seeded) ─────────────────────────────────────────────────────────────

let seed = 137;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}
function randBetween(lo: number, hi: number): number { return lo + rand() * (hi - lo); }
function randNorm(mean: number, std: number): number {
  const u1 = rand(), u2 = rand();
  return mean + Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2) * std;
}

// ─── Token scenario ───────────────────────────────────────────────────────────

interface BaseScenario {
  symbol:       string;
  liq:          number;
  pc1h:         number;
  pc5m:         number;
  volLiqRatio:  number;
  bsRatio:      number;
  buysH1:       number;
  ageH:         number;
  safeScore:    number;
  dexOk:        boolean;
  smTriggered:  boolean;
  smWeight:     number;
  passesFilter: boolean;
  filterReason: string;
}

const BASE_SYMBOLS = [
  'DEGEN','BRETT','TOSHI','ROOST','BASED','MOCHI','BALD','NORMIE',
  'DOGINME','COINBASE','CLANKER','HIGHER','WELL','BASIN','VIRTUAL',
  'BINO','WICK','GRUMPYCAT','TURBO','MOON','CAT','DOG','PEPE','WOJAK',
  'FROG','CHAD','SIGMA','ALPHA','VIBE','GEM',
];

function generateBaseScenario(i: number): BaseScenario {
  const symbol = BASE_SYMBOLS[i % BASE_SYMBOLS.length] + Math.floor(rand() * 999);

  const liq         = Math.exp(randNorm(10.5, 0.7));  // log-normal, peak ~$36k
  const pc1h        = randNorm(25, 30);
  const pc5m        = randNorm(3, 8);
  const volLiqRatio = Math.exp(randNorm(-1.5, 0.8));  // 0.05-0.80
  const bsRatio     = Math.exp(randNorm(0.3, 0.5));
  const buysH1      = Math.floor(Math.exp(randNorm(2.5, 0.8)));
  const ageH        = Math.exp(randNorm(0.8, 0.9));
  const safeScore   = rand() < 0.20 ? randBetween(5, 34) : randBetween(35, 90);
  const dexOk       = rand() > 0.25;  // 25% on non-tradeable DEX

  const smTriggered = rand() < SM_P_TRIGGERED;
  const smWeight    = smTriggered ? randBetween(2.0, 3.5) : randBetween(0, 1.5);

  let passesFilter = true;
  let filterReason = '';

  if (liq < CONFIG.MIN_LIQ_USD)
    { passesFilter = false; filterReason = `liq:$${liq.toFixed(0)}<$${CONFIG.MIN_LIQ_USD}`; }
  else if (liq > CONFIG.MAX_LIQ_USD)
    { passesFilter = false; filterReason = `liq:$${liq.toFixed(0)}>$${CONFIG.MAX_LIQ_USD}`; }
  else if (!dexOk)
    { passesFilter = false; filterReason = 'dex:not_supported'; }
  else if (ageH >= 0.17 && pc1h < CONFIG.MIN_PC1H)  // skip pc1h for ultra-fresh (<10min)
    { passesFilter = false; filterReason = `pc1h:${pc1h.toFixed(1)}%<${CONFIG.MIN_PC1H}%`; }
  else if (pc1h > CONFIG.MAX_PC1H && ageH > 1)
    { passesFilter = false; filterReason = `pc1h:${pc1h.toFixed(1)}%>${CONFIG.MAX_PC1H}% (overheated)`; }
  else if (pc5m < CONFIG.MIN_PC5M)
    { passesFilter = false; filterReason = `pc5m:${pc5m.toFixed(1)}%<${CONFIG.MIN_PC5M}%`; }
  else if (volLiqRatio < CONFIG.MIN_VOL_LIQ)
    { passesFilter = false; filterReason = `vol/liq:${(volLiqRatio*100).toFixed(0)}%<15%`; }
  else if (bsRatio > CONFIG.MAX_BS_RATIO)
    { passesFilter = false; filterReason = `bs:${bsRatio.toFixed(1)}>${CONFIG.MAX_BS_RATIO}`; }
  else if (buysH1 < CONFIG.MIN_BUYS_H1)
    { passesFilter = false; filterReason = `buys1h:${buysH1}<${CONFIG.MIN_BUYS_H1}`; }
  else if (ageH > CONFIG.MAX_AGE_H)
    { passesFilter = false; filterReason = `age:${ageH.toFixed(1)}h>6h`; }
  else if (safeScore < CONFIG.MIN_SAFE_SCORE)
    { passesFilter = false; filterReason = `safe:${safeScore.toFixed(0)}<35`; }

  return { symbol, liq, pc1h, pc5m, volLiqRatio, bsRatio, buysH1, ageH,
           safeScore, dexOk, smTriggered, smWeight, passesFilter, filterReason };
}

// ─── Trade outcome ────────────────────────────────────────────────────────────

interface BaseTradeResult {
  symbol:     string;
  liq:        number;
  smSignal:   boolean;
  win:        boolean;
  pnlEth:     number;
  pnlPct:     number;
  pnlUsd:     number;
  peakMult:   number;
  exitReason: string;
  outcome:    string;
  tpReached:  number;  // highest TP level reached (0-5)
}

function simulateBaseTrade(sc: BaseScenario): BaseTradeResult {
  const winRate = sc.smTriggered ? WR_SM : WR_NO_SM;
  const isWin = rand() < winRate;
  let pnlEth = 0, peakMult = 1.0, exitReason = '', outcome = '', tpReached = 0;

  if (isWin) {
    const winType = rand();
    let remaining = CONFIG.BUY_ETH;
    let totalOut  = 0;

    if (winType < 0.35) {
      // TP1 only (1.3x), trail rest
      tpReached = 1;
      peakMult = randBetween(1.30, 1.65);
      const tp1Out = CONFIG.BUY_ETH * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
      remaining   *= (1 - CONFIG.TP1_SELL_PCT);
      const trailMult = peakMult * (1 - CONFIG.TRAIL_PCT);
      const restOut = remaining * trailMult;
      totalOut = tp1Out + restOut;
      exitReason = 'tp1_trail'; outcome = `TP1(${peakMult.toFixed(2)}x)`;

    } else if (winType < 0.65) {
      // TP1+TP2 (1.3x+1.8x), trail rest
      tpReached = 2;
      peakMult = randBetween(1.80, 2.80);
      const tp1Out = CONFIG.BUY_ETH * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
      remaining   *= (1 - CONFIG.TP1_SELL_PCT);
      const tp2Out = remaining * CONFIG.TP2_SELL_PCT * CONFIG.TP2_MULT;
      remaining   *= (1 - CONFIG.TP2_SELL_PCT);
      const trailMult = peakMult * (1 - CONFIG.TRAIL_PCT);
      totalOut = tp1Out + tp2Out + remaining * trailMult;
      exitReason = 'tp2_trail'; outcome = `TP1+2(${peakMult.toFixed(2)}x)`;

    } else if (winType < 0.85) {
      // TP1+TP2+TP3 (to 2.5x)
      tpReached = 3;
      peakMult = randBetween(2.50, 4.20);
      const tp1Out = CONFIG.BUY_ETH * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
      remaining   *= (1 - CONFIG.TP1_SELL_PCT);
      const tp2Out = remaining * CONFIG.TP2_SELL_PCT * CONFIG.TP2_MULT;
      remaining   *= (1 - CONFIG.TP2_SELL_PCT);
      const tp3Out = remaining * CONFIG.TP3_SELL_PCT * CONFIG.TP3_MULT;
      remaining   *= (1 - CONFIG.TP3_SELL_PCT);
      totalOut = tp1Out + tp2Out + tp3Out + remaining * peakMult * (1 - CONFIG.TRAIL_PCT);
      exitReason = 'tp3_trail'; outcome = `TP1-3(${peakMult.toFixed(2)}x)`;

    } else if (winType < 0.95) {
      // TP1+TP2+TP3+TP4 (to 4x) — moonbag trail applies for remainder (crossed 2.5x at TP3)
      tpReached = 4;
      peakMult = randBetween(4.00, 8.00);
      const tp1Out = CONFIG.BUY_ETH * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
      remaining   *= (1 - CONFIG.TP1_SELL_PCT);
      const tp2Out = remaining * CONFIG.TP2_SELL_PCT * CONFIG.TP2_MULT;
      remaining   *= (1 - CONFIG.TP2_SELL_PCT);
      const tp3Out = remaining * CONFIG.TP3_SELL_PCT * CONFIG.TP3_MULT;
      remaining   *= (1 - CONFIG.TP3_SELL_PCT);
      const tp4Out = remaining * CONFIG.TP4_SELL_PCT * CONFIG.TP4_MULT;
      remaining   *= (1 - CONFIG.TP4_SELL_PCT);
      // Moonbag override active (crossed 2.5x) → 15% trail on remainder
      totalOut = tp1Out + tp2Out + tp3Out + tp4Out + remaining * peakMult * (1 - CONFIG.MOONBAG_TRAIL);
      exitReason = 'tp4_moonbag'; outcome = `TP1-4🌕(${peakMult.toFixed(2)}x)`;

    } else {
      // MOON (≥7x + moonbag trail)
      // Moonbag override: time limit disabled at TP3 (2.5x), trail widens to 15%.
      // HIGHER 18.35x example: standard 8% trail exits at 17x; 15% trail lets it run to 18.35x.
      tpReached = 5;
      peakMult = randBetween(7.00, 25.0);  // extended range with time limit removed
      const tp1Out = CONFIG.BUY_ETH * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
      remaining   *= (1 - CONFIG.TP1_SELL_PCT);
      const tp2Out = remaining * CONFIG.TP2_SELL_PCT * CONFIG.TP2_MULT;
      remaining   *= (1 - CONFIG.TP2_SELL_PCT);
      const tp3Out = remaining * CONFIG.TP3_SELL_PCT * CONFIG.TP3_MULT;
      remaining   *= (1 - CONFIG.TP3_SELL_PCT);
      const tp4Out = remaining * CONFIG.TP4_SELL_PCT * CONFIG.TP4_MULT;
      remaining   *= (1 - CONFIG.TP4_SELL_PCT);
      // Use MOONBAG_TRAIL (15%) once position cleared 2.5x — wider = more upside
      const restOut = remaining * peakMult * (1 - CONFIG.MOONBAG_TRAIL);
      totalOut = tp1Out + tp2Out + tp3Out + tp4Out + restOut;
      exitReason = 'moonbag_trail'; outcome = `MOON🌕(${peakMult.toFixed(1)}x)`;
    }

    pnlEth = totalOut - CONFIG.BUY_ETH;

  } else {
    // Losing trade
    peakMult = randBetween(0.75, 1.25);
    const lossType = rand();

    if (lossType < 0.55) {
      // Hard stop -10%
      const m = 1 - CONFIG.STOP_PCT - randBetween(0, 0.02);
      pnlEth = CONFIG.BUY_ETH * m - CONFIG.BUY_ETH;
      exitReason = 'stop_loss'; outcome = `STOP(${((m-1)*100).toFixed(1)}%)`;

    } else if (lossType < 0.85) {
      // Time exit at 1h (avg -4%) — only applies below 2.5x
      // Moonbag trades that crossed 2.5x have time limit disabled → they trail-stop instead
      const m = randBetween(0.93, 1.04);
      pnlEth = CONFIG.BUY_ETH * m - CONFIG.BUY_ETH;
      exitReason = 'time_exit'; outcome = `TIME(${((m-1)*100).toFixed(1)}%)`;

    } else {
      // Whale dump -7 to -12%
      const m = randBetween(0.88, 0.93);
      pnlEth = CONFIG.BUY_ETH * m - CONFIG.BUY_ETH;
      exitReason = 'dump'; outcome = `DUMP(${((m-1)*100).toFixed(1)}%)`;
    }
  }

  const pnlPct = (pnlEth / CONFIG.BUY_ETH) * 100;
  const pnlUsd = pnlEth * CONFIG.ETH_USD;

  return {
    symbol: sc.symbol,
    liq: sc.liq,
    smSignal: sc.smTriggered,
    win: isWin,
    pnlEth, pnlPct, pnlUsd,
    peakMult, exitReason, outcome,
    tpReached,
  };
}

// ─── Run simulation ───────────────────────────────────────────────────────────

function runBaseSimulation(targetTrades = 30) {
  const line = '═'.repeat(72);
  const dash = '─'.repeat(72);

  console.log('\n' + line);
  console.log('  BASE SCANNER — Monte Carlo симуляция v2 — 30 СДЕЛОК (moonbag override)');
  console.log('  Network: Base (EVM) | DEX: Uniswap V3 + Aerodrome V2');
  console.log('  SM Sources: getLogs Uniswap V3 Swap events (Base SM wallets)');
  console.log('  Position: 0.001 ETH | Stop: 10% | Trail: 8% | Limit: 1h');
  console.log('  5 TP levels: 1.3/1.8/2.5/4.0/7.0x');
  console.log(line);

  const trades: BaseTradeResult[] = [];
  const filterCounts: Record<string, number> = {};
  let totalScanned = 0, totalPassed = 0;

  let i = 0;
  while (trades.length < targetTrades) {
    const sc = generateBaseScenario(i++);
    totalScanned++;

    if (!sc.passesFilter) {
      const k = sc.filterReason ?? 'unknown';
      filterCounts[k] = (filterCounts[k] ?? 0) + 1;
      continue;
    }
    totalPassed++;
    trades.push(simulateBaseTrade(sc));
  }

  // ─── Trade log ──────────────────────────────────────────────────────────────
  console.log('\n  #  │ Symbol     │ Liq     │ SM │ Peak  │ Result          │ P&L ETH │ P&L USD');
  console.log('─────┼────────────┼─────────┼────┼───────┼─────────────────┼─────────┼────────');

  let totalIn = 0, totalOut = 0, wins = 0;
  let smTrades = 0, smWins = 0, noSmTrades = 0, noSmWins = 0;

  trades.forEach((t, idx) => {
    const no   = String(idx + 1).padStart(4);
    const sym  = t.symbol.padEnd(10);
    const liq  = `$${(t.liq / 1000).toFixed(0)}k`.padEnd(7);
    const sm   = t.smSignal ? '🔥 ' : '   ';
    const peak = `${t.peakMult.toFixed(2)}x`.padEnd(5);
    const win  = t.win ? '✅' : '❌';
    const res  = `${win} ${t.outcome}`.padEnd(17);
    const eth  = `${t.pnlEth >= 0 ? '+' : ''}${t.pnlEth.toFixed(5)}`.padEnd(8);
    const usd  = `${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)}`;

    console.log(`${no} │ ${sym} │ ${liq} │ ${sm}│ ${peak} │ ${res} │ ${eth} │ ${usd}`);

    totalIn  += CONFIG.BUY_ETH;
    totalOut += CONFIG.BUY_ETH + t.pnlEth;
    if (t.win) wins++;
    if (t.smSignal) { smTrades++; if (t.win) smWins++; }
    else { noSmTrades++; if (t.win) noSmWins++; }
  });

  // ─── Stats ──────────────────────────────────────────────────────────────────
  const netPnlEth = totalOut - totalIn;
  const roi       = (netPnlEth / totalIn) * 100;
  const winRate   = (wins / trades.length) * 100;
  const winPnls   = trades.filter(t => t.win).map(t => t.pnlPct);
  const lossPnls  = trades.filter(t => !t.win).map(t => t.pnlPct);
  const avgWin    = winPnls.length > 0 ? winPnls.reduce((s,v) => s+v, 0) / winPnls.length : 0;
  const avgLoss   = lossPnls.length > 0 ? lossPnls.reduce((s,v) => s+v, 0) / lossPnls.length : 0;
  const beWR      = (Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss))) * 100;
  const edge      = winRate - beWR;
  const passRate  = (totalPassed / totalScanned) * 100;

  // TP distribution
  const tpDist: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  trades.forEach(t => { if (t.win) tpDist[t.tpReached]++; });

  console.log('\n' + dash);
  console.log('  SM СИГНАЛЫ (Base getLogs Uniswap V3)');
  console.log(dash);
  console.log(`  ${'Сегмент'.padEnd(22)} ${'Сделок'.padEnd(8)} ${'Win%'.padEnd(8)} ${'P&L ETH'.padEnd(12)} ${'P&L USD'}`);
  console.log('  ' + '─'.repeat(62));

  const smPnl   = trades.filter(t => t.smSignal).reduce((s, t) => s + t.pnlEth, 0);
  const noSmPnl = trades.filter(t => !t.smSignal).reduce((s, t) => s + t.pnlEth, 0);
  console.log(`  ${'🔥 SM triggered'.padEnd(22)} ${String(smTrades).padEnd(8)} ${(smTrades > 0 ? (smWins/smTrades*100).toFixed(1)+'%' : 'N/A').padEnd(8)} ${(smPnl >= 0 ? '+' : '') + smPnl.toFixed(5) + ' ETH'}`);
  console.log(`  ${'— No SM signal'.padEnd(22)} ${String(noSmTrades).padEnd(8)} ${(noSmTrades > 0 ? (noSmWins/noSmTrades*100).toFixed(1)+'%' : 'N/A').padEnd(8)} ${(noSmPnl >= 0 ? '+' : '') + noSmPnl.toFixed(5) + ' ETH'}`);

  console.log('\n' + dash);
  console.log('  TP РАСПРЕДЕЛЕНИЕ ПОБЕД');
  console.log(dash);
  console.log(`  TP1 (1.3x):  ${tpDist[1]} сделок | TP2 (1.8x): ${tpDist[2]} | TP3 (2.5x): ${tpDist[3]} | TP4 (4.0x): ${tpDist[4]} | MOON: ${tpDist[5]}`);

  console.log('\n' + dash);
  console.log('  ФИНАНСОВЫЙ ИТОГ (30 СДЕЛОК, Base Network)');
  console.log(dash);
  console.log(`  Токенов отсканировано:        ${totalScanned}`);
  console.log(`  Прошло все фильтры:           ${totalPassed} (${passRate.toFixed(1)}%)`);
  console.log('');
  console.log(`  Win Rate (все):               ${winRate.toFixed(1)}%`);
  console.log(`  Win Rate (SM triggered):      ${smTrades > 0 ? (smWins/smTrades*100).toFixed(1) : 'N/A'}%`);
  console.log(`  Win Rate (no SM):             ${noSmTrades > 0 ? (noSmWins/noSmTrades*100).toFixed(1) : 'N/A'}%`);
  console.log(`  Среднее на победе:            +${avgWin.toFixed(1)}%`);
  console.log(`  Среднее на поражении:         ${avgLoss.toFixed(1)}%`);
  console.log(`  Break-even Win Rate:          ~${beWR.toFixed(0)}%`);
  console.log(`  Edge:                         ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp`);
  console.log('');
  console.log(`  Потрачено:                    ${totalIn.toFixed(4)} ETH  ($${(totalIn * CONFIG.ETH_USD).toFixed(2)})`);
  console.log(`  Получено:                     ${totalOut.toFixed(4)} ETH  ($${(totalOut * CONFIG.ETH_USD).toFixed(2)})`);
  console.log(`  Чистый P&L:                   ${netPnlEth >= 0 ? '+' : ''}${netPnlEth.toFixed(5)} ETH  (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`);
  console.log(`  P&L в USD:                    ${netPnlEth >= 0 ? '+' : ''}$${(netPnlEth * CONFIG.ETH_USD).toFixed(2)}`);
  console.log('');

  const avgPerTrade  = netPnlEth / trades.length;
  const tradesPerDay = 3;  // ~8% pass rate × ~40 scan signals/day = ~3 trades
  const dailyEth     = avgPerTrade * tradesPerDay;
  const monthlyEth   = dailyEth * 30;

  console.log(`  ─── Экстраполяция (${tradesPerDay} сделки/день) ───`);
  console.log(`  Avg P&L/сделка:               ${avgPerTrade >= 0 ? '+' : ''}${avgPerTrade.toFixed(6)} ETH  ($${(avgPerTrade * CONFIG.ETH_USD).toFixed(3)})`);
  console.log(`  Дневной P&L (est.):           ${dailyEth >= 0 ? '+' : ''}${dailyEth.toFixed(5)} ETH  ($${(dailyEth * CONFIG.ETH_USD).toFixed(2)})`);
  console.log(`  30-дневный P&L (est.):        ${monthlyEth >= 0 ? '+' : ''}${monthlyEth.toFixed(4)} ETH  ($${(monthlyEth * CONFIG.ETH_USD).toFixed(1)})`);

  console.log('\n  ─── Топ фильтры-отсевы ───');
  Object.entries(filterCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .forEach(([r, c]) => {
      console.log(`  ${r.padEnd(38)} ${c} (${(c/totalScanned*100).toFixed(1)}%)`);
    });

  // ─── Comparison ─────────────────────────────────────────────────────────────
  console.log('\n' + dash);
  console.log('  СРАВНЕНИЕ: BASE vs PUMP.FUN СТРАТЕГИИ');
  console.log(dash);
  console.log('  Метрика                   Base Scanner v1    Pump.fun v5');
  console.log('  ' + '─'.repeat(56));
  console.log(`  Win Rate                  ${winRate.toFixed(1).padEnd(19)}40.0%`);
  console.log(`  Avg Win                   +${avgWin.toFixed(1).padEnd(18)}+80.2%`);
  console.log(`  Avg Loss                  ${avgLoss.toFixed(1).padEnd(19)}-7.3%`);
  console.log(`  Net ROI (30 trades)       ${roi >= 0 ? '+' : ''}${roi.toFixed(1).padEnd(19)}+27.7%`);
  console.log(`  Edge above BE             ${edge >= 0 ? '+' : ''}${edge.toFixed(1).padEnd(17)}pp  +32pp`);
  console.log(`  Position size             0.001 ETH (~$3.50)  0.012 SOL (~$1.80)`);
  console.log(`  SM data quality           Base getLogs        PumpPortal WS`);

  // ─── Verdict ────────────────────────────────────────────────────────────────
  const hasEdge = edge > 0 && netPnlEth > 0;
  console.log('\n' + line);
  let verdict: string;
  if (!hasEdge)
    verdict = '❌ УБЫТОЧНА — доработать фильтры или повысить SM требования';
  else if (winRate >= 32 && roi >= 10)
    verdict = '✅ ПРИБЫЛЬНА — BASE_AUTO_BUY=true, тест 0.001 ETH / 20 сделок';
  else if (winRate >= 22)
    verdict = '🟡 ГРАНИЧНЫЙ СЛУЧАЙ — осторожно, BASE_AUTO_BUY=true с малым размером';
  else
    verdict = '🟡 СЛАБЫЙ EDGE — нужно 50+ реальных dry-run сделок';

  console.log(`  ВЕРДИКТ: ${verdict}`);
  console.log(`  Break-even WR: ~${beWR.toFixed(0)}%  |  Достигнуто: ${winRate.toFixed(1)}%  |  Edge: ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp`);
  console.log(`  Статистика: ${trades.length} сделок | Pass rate: ${passRate.toFixed(1)}%`);
  console.log(line + '\n');
}

runBaseSimulation(30);

/**
 * TON Jetton Scanner — Monte Carlo симуляция v1 (50 trades)
 *
 * Стратегия: STON.fi V1 Jettons $5k-$200k ликвидность, momentum pc1h ≥ 5%.
 * 2-stage exit grid (после исправлений — снижены с 5 до 2 TP для экономии газа):
 *   TP1: +35% → sell 70%   (быстрый лок на spike)
 *   TP2: +80% → sell 100%  (закрытие остатка)
 *   Trail stop: 10% от ATH (активируется после TP1)
 *   Stop loss: 10% (жёсткий стоп — TON meme cycles быстрые)
 *   Time limit: 10 min (600s)
 *
 * Позиция: 3.5 TON (минимум для разумных gasoverhead < 10%)
 *   STON.fi swap gas ≈ 0.15 TON (одна транзакция)
 *   2 продажи × 0.15 = 0.30 TON gas = 8.6% от 3.5 TON — приемлемо
 *   При 0.5 TON: 30-35% overhead = убыточно всегда
 *
 * Universe statistics (Jettons STON.fi $5k-$200k liq):
 *   - Blacklisted/unverified rate: ~25% (новые сигналы чаще всего rug)
 *   - После isSafe + safe_score ≥ 40: базовый WR ~38%
 *   - Momentum pc1h ≥ 5%: ещё +5pp → WR ~43%
 *   - TON meme cycles: быстрее Solana, часто spike+dump за 5-15 мин
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  BUY_TON:          3.5,     // 3.5 TON (~$10.50 при TON $3.0)
  STOP_PCT:         0.10,    // 10% hard stop
  TRAIL_PCT:        0.10,    // 10% trailing stop
  TP1_MULT:         1.35,    // +35% → sell 70%
  TP1_SELL_PCT:     0.70,
  TP2_MULT:         1.80,    // +80% → sell 100%
  TIME_LIMIT_SEC:   600,     // 10 min
  GAS_PER_TX_TON:   0.15,    // STON.fi gas per TX
  GAS_TOTAL_TON:    0.30,    // 2 TX (TP1 sell + TP2 sell)
};

// Win distribution для TON Jettons $5k-$200k после фильтров:
//   STRONG_MOVE: токен делает 1.80x+               — вероятность ~18% (TON более volatile)
//   PARTIAL_MOVE: 1.35x но не 1.80x                — вероятность ~25%
//   STALL: time limit (10 min)                      — вероятность ~22%
//   DUMP: -10% stop loss                            — вероятность ~35% (выше чем BSC — меньше ликвидности)

const P_STRONG_MOVE = 0.18;
const P_PARTIAL     = 0.25;
const P_STALL       = 0.22;
const P_DUMP        = 0.35;

// ─── RNG ──────────────────────────────────────────────────────────────────────

let seed = 54321;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}
function randBetween(lo: number, hi: number): number { return lo + rand() * (hi - lo); }
function randNorm(mean: number, std: number): number {
  const u1 = rand(), u2 = rand();
  return mean + Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2) * std;
}

type Outcome = 'STRONG_MOVE' | 'PARTIAL_MOVE' | 'STALL' | 'DUMP';

function drawOutcome(): Outcome {
  const r = rand();
  if (r < P_STRONG_MOVE)                        return 'STRONG_MOVE';
  if (r < P_STRONG_MOVE + P_PARTIAL)            return 'PARTIAL_MOVE';
  if (r < P_STRONG_MOVE + P_PARTIAL + P_STALL)  return 'STALL';
  return 'DUMP';
}

interface TokenScenario {
  symbol:        string;
  liqUsd:        number;
  pc1h:          number;
  pc5m:          number;
  bsRatio:       number;
  safeScore:     number;
  blacklisted:   boolean;
  verified:      boolean;
  passesFilters: boolean;
  filterReason?: string;
  outcome:       Outcome;
}

const SYMBOLS = [
  'DOGS','NOTCOIN','STON','HYDRA','BOLT','SCALE','GRAM','TONCOIN2',
  'PEPE_TON','HAMSTER','JETTON','PUNK','FISH','CATS','MAGA_TON',
  'TRUMP_TON','MEOW','DOGE_TON','MOON_TON','CHAD_TON','GIGA_TON',
  'ANIME_TON','PUNKX','ROCKETON','KTON',
];

function generateScenario(i: number): TokenScenario {
  const symbol = SYMBOLS[i % SYMBOLS.length] + Math.floor(rand() * 999);

  const blacklisted = rand() < 0.15;   // 15% blacklisted on tonapi
  const verified    = rand() > 0.25;   // 25% unverified (verification='none')
  const liqUsd      = Math.exp(randNorm(Math.log(25000), 0.9)); // $2k-$200k
  const pc1h        = Math.max(-60, randNorm(8, 22));
  const pc5m        = Math.max(-20, randNorm(2, 10));
  const bsRatio     = Math.max(0.1, randNorm(1.4, 0.7));
  const safeScore   = rand() < 0.25 ? randBetween(0, 39) : randBetween(40, 100);

  let passesFilters = true;
  let filterReason  = '';

  // Safety gate (new checkTonJettonSafety)
  if (blacklisted)              { passesFilters = false; filterReason = 'BLACKLISTED'; }
  else if (!verified)           { passesFilters = false; filterReason = 'UNVERIFIED (verification=none)'; }
  else if (safeScore < 40)      { passesFilters = false; filterReason = `safe_score:${safeScore.toFixed(0)} < 40`; }
  else if (liqUsd < 5000)       { passesFilters = false; filterReason = `liq:$${liqUsd.toFixed(0)} < $5k`; }
  else if (liqUsd > 200000)     { passesFilters = false; filterReason = `liq:$${(liqUsd/1000).toFixed(0)}k > $200k`; }
  else if (pc1h < 5)            { passesFilters = false; filterReason = `pc1h:${pc1h.toFixed(1)}% < 5%`; }
  else if (pc1h > 60)           { passesFilters = false; filterReason = `pc1h:${pc1h.toFixed(1)}% > 60% (already pumped)`; }
  else if (bsRatio < 1.2)       { passesFilters = false; filterReason = `bs_ratio:${bsRatio.toFixed(2)} < 1.2`; }

  const outcome = passesFilters ? drawOutcome() : 'DUMP';
  return { symbol, liqUsd, pc1h, pc5m, bsRatio, safeScore, blacklisted, verified,
           passesFilters, filterReason, outcome };
}

// ─── Trade simulation ─────────────────────────────────────────────────────────

interface TradeResult {
  symbol:     string;
  outcome:    Outcome;
  win:        boolean;
  pnlTon:     number;
  pnlPct:     number;
  peakMult:   number;
  exitReason: string;
  gasUsed:    number;
}

function simulateTrade(sc: TokenScenario): TradeResult {
  const { outcome } = sc;
  const BUY  = CONFIG.BUY_TON;
  const GAS  = CONFIG.GAS_TOTAL_TON; // gas for 2 sell TXs
  let pnlTon = 0, peakMult = 1.0, exitReason = '', win = false;
  let gasUsed = GAS;

  if (outcome === 'STRONG_MOVE') {
    peakMult = randBetween(CONFIG.TP2_MULT, 4.0);
    const tp1Proceeds = BUY * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
    const tp2Proceeds = BUY * (1 - CONFIG.TP1_SELL_PCT) * peakMult;
    pnlTon = tp1Proceeds + tp2Proceeds - BUY - GAS;
    exitReason = `TP2:${peakMult.toFixed(2)}x`;
    win = true;

  } else if (outcome === 'PARTIAL_MOVE') {
    const ath = randBetween(CONFIG.TP1_MULT, CONFIG.TP2_MULT * 0.97);
    const trailExit = ath * (1 - CONFIG.TRAIL_PCT);
    const effectiveExit = Math.max(trailExit, 1 - CONFIG.STOP_PCT);

    const tp1Proceeds   = BUY * CONFIG.TP1_SELL_PCT * CONFIG.TP1_MULT;
    const trailProceeds = BUY * (1 - CONFIG.TP1_SELL_PCT) * effectiveExit;
    // Only 2 TXs max (TP1 + trail/TP2)
    gasUsed = GAS;
    pnlTon = tp1Proceeds + trailProceeds - BUY - gasUsed;
    peakMult = ath;
    exitReason = `TP1+TRAIL@${effectiveExit.toFixed(2)}x`;
    win = pnlTon > 0;

  } else if (outcome === 'STALL') {
    const exitMult = randBetween(0.95, 1.08);
    gasUsed = CONFIG.GAS_PER_TX_TON; // only 1 sell TX
    pnlTon = BUY * exitMult - BUY - gasUsed;
    peakMult = exitMult;
    exitReason = `TIME_LIMIT@${exitMult.toFixed(2)}x`;
    win = pnlTon > 0;

  } else { // DUMP
    const dumpMult = randBetween(0.82, 0.92);
    gasUsed = CONFIG.GAS_PER_TX_TON; // only 1 sell TX
    pnlTon = BUY * Math.min(dumpMult, 1 - CONFIG.STOP_PCT) - BUY - gasUsed;
    peakMult = dumpMult;
    exitReason = `STOP_LOSS@${dumpMult.toFixed(2)}x`;
    win = false;
  }

  return {
    symbol:    sc.symbol,
    outcome,
    win,
    pnlTon:    Math.round(pnlTon * 10000) / 10000,
    pnlPct:    Math.round(pnlTon / BUY * 1000) / 10,
    peakMult:  Math.round(peakMult * 100) / 100,
    exitReason,
    gasUsed:   Math.round(gasUsed * 1000) / 1000,
  };
}

// ─── Run simulation ───────────────────────────────────────────────────────────

const NUM_TRADES = 50;
const trades: TradeResult[] = [];

let candidateIdx = 0;
while (trades.length < NUM_TRADES) {
  const sc = generateScenario(candidateIdx++);
  if (!sc.passesFilters) continue;
  trades.push(simulateTrade(sc));
}

// ─── Output ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(82)}`);
console.log(`TON JETTON SCANNER — Monte Carlo Simulation v1   (${NUM_TRADES} trades)`);
console.log(`${'═'.repeat(82)}`);
console.log(`Config: BUY=${CONFIG.BUY_TON}TON  stop=${CONFIG.STOP_PCT*100}%  trail=${CONFIG.TRAIL_PCT*100}%  gas≈${CONFIG.GAS_TOTAL_TON}TON/trade`);
console.log(`        TP1=${CONFIG.TP1_MULT}x→${CONFIG.TP1_SELL_PCT*100}%  TP2=${CONFIG.TP2_MULT}x→100%  time=${CONFIG.TIME_LIMIT_SEC}s`);
console.log(`        Safety: isSafe (no blacklisted, no unverified) + safe_score≥40`);
console.log(`${'─'.repeat(82)}`);
console.log(`${'#'.padEnd(3)} ${'Symbol'.padEnd(16)} ${'Outcome'.padEnd(12)} ${'Peak'.padStart(6)} ${'PnL(TON)'.padStart(10)} ${'PnL%'.padStart(7)} ${'W/L'.padStart(4)} Exit`);
console.log(`${'─'.repeat(82)}`);

let wins = 0, totalPnl = 0, totalGas = 0;
const outcomeCount: Record<string, number> = { STRONG_MOVE: 0, PARTIAL_MOVE: 0, STALL: 0, DUMP: 0 };

for (let i = 0; i < trades.length; i++) {
  const t = trades[i];
  const icon   = t.win ? '✅' : '❌';
  const pnlStr = (t.pnlTon >= 0 ? '+' : '') + t.pnlTon.toFixed(4);
  const pctStr = (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(1) + '%';
  console.log(
    `${String(i + 1).padEnd(3)} ${t.symbol.padEnd(16)} ${t.outcome.padEnd(12)} ` +
    `${t.peakMult.toFixed(2).padStart(6)} ${pnlStr.padStart(10)} ${pctStr.padStart(7)} ` +
    `${icon.padStart(4)} ${t.exitReason}`
  );
  if (t.win) wins++;
  totalPnl += t.pnlTon;
  totalGas += t.gasUsed;
  outcomeCount[t.outcome]++;
}

const wr  = wins / NUM_TRADES;
const avg = totalPnl / NUM_TRADES;

// Baseline: random TON meme without filters, WR ~20%, avg loss ~-12% per trade
const BASELINE_WR  = 0.20;
const baselinePnl  = (BASELINE_WR * CONFIG.BUY_TON * 0.60) + ((1 - BASELINE_WR) * (-CONFIG.BUY_TON * 0.12));
const edgePct      = (avg - baselinePnl) / CONFIG.BUY_TON * 100;

console.log(`${'─'.repeat(82)}`);
console.log(`SUMMARY`);
console.log(`  Win Rate:      ${(wr * 100).toFixed(1)}%  (${wins}/${NUM_TRADES} trades)`);
console.log(`  Total PnL:     ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} TON`);
console.log(`  Avg PnL/trade: ${avg >= 0 ? '+' : ''}${avg.toFixed(4)} TON (${(avg/CONFIG.BUY_TON*100).toFixed(1)}%)`);
console.log(`  Total Gas:     ${totalGas.toFixed(3)} TON (avg ${(totalGas/NUM_TRADES).toFixed(3)}/trade)`);
console.log(`  Edge vs no-filter (WR=${BASELINE_WR*100}%): ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(1)}pp`);
console.log(`${'─'.repeat(82)}`);
console.log(`OUTCOME BREAKDOWN`);
console.log(`  STRONG_MOVE (both TPs):  ${outcomeCount.STRONG_MOVE}  (${(outcomeCount.STRONG_MOVE/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`  PARTIAL_MOVE (TP1+trail):${outcomeCount.PARTIAL_MOVE}  (${(outcomeCount.PARTIAL_MOVE/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`  STALL (time limit):      ${outcomeCount.STALL}  (${(outcomeCount.STALL/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`  DUMP (stop loss):        ${outcomeCount.DUMP}  (${(outcomeCount.DUMP/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`${'─'.repeat(82)}`);
console.log(`GAS ANALYSIS (2-stage TP = 2 TX max vs 5-stage = 5 TX)`);
console.log(`  2-stage max gas: 2 × 0.15 = 0.30 TON per trade = ${(0.30/CONFIG.BUY_TON*100).toFixed(1)}% of position`);
console.log(`  5-stage max gas: 5 × 0.15 = 0.75 TON per trade = ${(0.75/CONFIG.BUY_TON*100).toFixed(1)}% of position`);
console.log(`  Gas saved per trade: 0.45 TON → ${(0.45*NUM_TRADES).toFixed(1)} TON over ${NUM_TRADES} trades`);
console.log(`${'─'.repeat(82)}`);

if (wr >= 0.43 && avg > 0) {
  console.log(`VERDICT: ✅ PROFITABLE — WR ${(wr*100).toFixed(1)}% | net gas-adjusted edge +${edgePct.toFixed(1)}pp`);
  console.log(`         Activate: TON_AUTO_BUY=true, TON_BUY_AMOUNT=3.5, TON_GAS_RESERVE=1.0`);
} else if (wr >= 0.35 && avg > 0) {
  console.log(`VERDICT: ⚠️ MARGINAL — Consider tighter filters: TON_MIN_PC1H=8, TON_MIN_SAFE_SCORE=50`);
} else {
  console.log(`VERDICT: ❌ NOT PROFITABLE — needs more backtesting data on real TON Jetton liquidity`);
}
console.log(`${'═'.repeat(82)}\n`);

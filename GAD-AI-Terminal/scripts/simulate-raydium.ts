/**
 * Raydium Scanner — 50-Trade Monte Carlo Simulation
 *
 * Mirrors services/autobuy Raydium logic:
 * - FRESH only: token age < 6h (RAYDIUM_MAX_AGE_SEC=21600)
 * - Min liq $12k, Max liq $300k
 * - Tiers: T1=$12-80k (most), T2=$80-250k (rare), T3=$250k+
 * - Market regime affects TP levels (FEAR/NEUTRAL/BULL)
 * - Stop 8%, Trail 12%, Early trail 4%
 * - Single-shot 100% sell at TP
 * - Buy 0.02 SOL per trade
 */

const NUM_TRADES = 50;
const BUY_SOL    = 0.02;
const STOP_PCT   = 0.08;
const TRAIL_PCT  = 0.12;

// TP multipliers by tier and regime (from VPS .env and auto-signal.ts)
const TP_BY_REGIME: Record<string, Record<string, number>> = {
  FEAR:    { T1: 1.20, T2: 1.18, T3: 1.15 },
  NEUTRAL: { T1: 1.30, T2: 1.28, T3: 1.25 },
  BULL:    { T1: 1.55, T2: 1.45, T3: 1.38 },
};

// From 79-trade audit: FRESH win rate by tier and regime
const WIN_RATES: Record<string, Record<string, number>> = {
  FEAR:    { T1: 0.462, T2: 0.28, T3: 0.15 },
  NEUTRAL: { T1: 0.38,  T2: 0.22, T3: 0.12 },
  BULL:    { T1: 0.35,  T2: 0.20, T3: 0.10 },
};

// Outcome distribution probabilities for losses (stop vs trail)
const STOP_LOSS_PROB = 0.55;  // 55% of losses hit stop-loss directly
// rest (45%) hit trail stop at various points, avg -15%

// Token tier distribution (market reality for fresh tokens)
const TIER_DIST = [
  { tier: 'T1', regime: 'FEAR',    weight: 20 },
  { tier: 'T1', regime: 'NEUTRAL', weight: 35 },
  { tier: 'T1', regime: 'BULL',    weight: 20 },
  { tier: 'T2', regime: 'NEUTRAL', weight: 15 },
  { tier: 'T2', regime: 'BULL',    weight: 7  },
  { tier: 'T3', regime: 'NEUTRAL', weight: 3  },
];
const TOTAL_WEIGHT = TIER_DIST.reduce((s, t) => s + t.weight, 0);

// Seeded LCG RNG for reproducibility
let seed = 13579;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}

function pickTierRegime(): { tier: string; regime: string } {
  const r = rand() * TOTAL_WEIGHT;
  let acc = 0;
  for (const t of TIER_DIST) {
    acc += t.weight;
    if (r <= acc) return t;
  }
  return TIER_DIST[TIER_DIST.length - 1];
}

interface Trade {
  n:      number;
  tier:   string;
  regime: string;
  tp:     number;
  outcome: 'WIN' | 'STOP' | 'TRAIL';
  pnlSol: number;
  roi:    number;
}

const trades: Trade[] = [];
let capital = 1.0; // 1 SOL starting

for (let i = 1; i <= NUM_TRADES; i++) {
  const { tier, regime } = pickTierRegime();
  const tp = TP_BY_REGIME[regime][tier];
  const wr = WIN_RATES[regime][tier];

  const roll = rand();
  let outcome: Trade['outcome'];
  let roi: number;

  if (roll < wr) {
    outcome = 'WIN';
    // Wins land between TP and TP*1.15 (some overshoot before exit)
    roi = tp + (rand() * (tp * 0.15 - 0.01));
  } else {
    if (rand() < STOP_LOSS_PROB) {
      outcome = 'STOP';
      roi = 1 - STOP_PCT - rand() * 0.02; // -8% to -10%
    } else {
      outcome = 'TRAIL';
      // Trail stop kicks in at ATH; exit -12% from ATH, ATH was 1.05-1.20x
      const ath = 1.05 + rand() * 0.15;
      roi = ath * (1 - TRAIL_PCT);
    }
  }

  const pnlSol = BUY_SOL * (roi - 1);
  trades.push({ n: i, tier, regime, tp, outcome, pnlSol, roi });
  capital += pnlSol;
}

// ─── Report ───────────────────────────────────────────────────────────────────
const wins   = trades.filter(t => t.outcome === 'WIN');
const stops  = trades.filter(t => t.outcome === 'STOP');
const trails = trades.filter(t => t.outcome === 'TRAIL');

const totalPnl   = trades.reduce((s, t) => s + t.pnlSol, 0);
const avgWinSol  = wins.length   ? wins.reduce((s, t)   => s + t.pnlSol, 0) / wins.length   : 0;
const avgLossSol = stops.length + trails.length
  ? [...stops, ...trails].reduce((s, t) => s + t.pnlSol, 0) / (stops.length + trails.length)
  : 0;
const wr         = wins.length / NUM_TRADES;
const edge       = wr - (1 - wr) * Math.abs(avgLossSol) / (avgWinSol || 1);

console.log('═══════════════════════════════════════════════════════');
console.log(' RAYDIUM SCANNER — 50-Trade Monte Carlo Simulation     ');
console.log('═══════════════════════════════════════════════════════');
console.log(`  Trades: ${NUM_TRADES}  Buy: ${BUY_SOL} SOL each  Stop: ${STOP_PCT*100}%  Trail: ${TRAIL_PCT*100}%`);
console.log('');
console.log('  OUTCOME BREAKDOWN:');
console.log(`    Wins    : ${wins.length.toString().padStart(3)}  (${(wr*100).toFixed(1)}%)`);
console.log(`    Stops   : ${stops.length.toString().padStart(3)}  (${(stops.length/NUM_TRADES*100).toFixed(1)}%)`);
console.log(`    Trails  : ${trails.length.toString().padStart(3)}  (${(trails.length/NUM_TRADES*100).toFixed(1)}%)`);
console.log('');
console.log('  P&L SUMMARY:');
console.log(`    Total PnL    : ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`);
console.log(`    Avg Win      : +${avgWinSol.toFixed(4)} SOL (+${((avgWinSol/BUY_SOL)*100).toFixed(1)}%)`);
console.log(`    Avg Loss     : ${avgLossSol.toFixed(4)} SOL (${((avgLossSol/BUY_SOL)*100).toFixed(1)}%)`);
console.log(`    Edge         : ${(edge*100).toFixed(1)}pp`);
console.log(`    Final capital: 1.0 → ${capital.toFixed(4)} SOL (${totalPnl >= 0 ? '+' : ''}${(totalPnl*100).toFixed(1)}% on 1 SOL bank)`);
console.log('');
console.log('  BY TIER:');
for (const tier of ['T1', 'T2', 'T3']) {
  const tTrades = trades.filter(t => t.tier === tier);
  const tWins   = tTrades.filter(t => t.outcome === 'WIN');
  const tPnl    = tTrades.reduce((s, t) => s + t.pnlSol, 0);
  if (tTrades.length)
    console.log(`    ${tier}: ${tTrades.length} trades  WR ${(tWins.length/tTrades.length*100).toFixed(0)}%  PnL ${tPnl >= 0 ? '+' : ''}${tPnl.toFixed(4)} SOL`);
}
console.log('');
console.log('  BY REGIME:');
for (const regime of ['FEAR', 'NEUTRAL', 'BULL']) {
  const rTrades = trades.filter(t => t.regime === regime);
  const rWins   = rTrades.filter(t => t.outcome === 'WIN');
  const rPnl    = rTrades.reduce((s, t) => s + t.pnlSol, 0);
  if (rTrades.length)
    console.log(`    ${regime.padEnd(7)}: ${rTrades.length.toString().padStart(2)} trades  WR ${(rWins.length/rTrades.length*100).toFixed(0)}%  PnL ${rPnl >= 0 ? '+' : ''}${rPnl.toFixed(4)} SOL`);
}
console.log('═══════════════════════════════════════════════════════');

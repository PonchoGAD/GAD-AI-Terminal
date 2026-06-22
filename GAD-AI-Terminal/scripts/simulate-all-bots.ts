/**
 * 50-Trade Monte Carlo Simulation — All Bots
 *
 * Runs 2000 iterations of 50 simulated trades per bot, based on empirically
 * observed or conservatively estimated parameters from trade history and CLAUDE.md.
 *
 * Parameters per bot:
 *   Raydium   : WR 41% (FRESH <6h data from 79-trade audit), avg_win 1.23x, avg_loss 0.90x
 *   Base      : WR 35% est. (sim mode, EVM shield now active), avg_win 1.20x, avg_loss 0.92x
 *   BSC       : WR 30% est. (conservative — less data), avg_win 1.18x, avg_loss 0.93x
 *   TON       : WR 28% est. (conservative — dry-run), avg_win 1.15x, avg_loss 0.92x
 *   Polymarket: WR 60% (59.7% from previous 2000-iteration simulation), EV target 12%
 *
 * Output: per-bot median P&L, Sharpe, % profitable runs
 *
 * Usage: npx ts-node -p tsconfig.launch.json scripts/simulate-all-bots.ts
 */

interface BotConfig {
  name:        string;
  tradeSize:   number;  // in SOL/ETH/TON/USDC
  currency:    string;
  winRate:     number;  // 0.0–1.0
  avgWinMult:  number;  // multiplier (1.20 = +20%)
  avgLossMult: number;  // multiplier (0.90 = -10%)
  note:        string;
}

const BOTS: BotConfig[] = [
  {
    name:        'Raydium (Solana)',
    tradeSize:   0.02,
    currency:    'SOL',
    winRate:     0.414,    // 79-trade audit FRESH <6h: 41.4% WR
    avgWinMult:  1.23,     // avg win ROI from audit
    avgLossMult: 0.905,    // avg loss from audit (stop-loss 8%)
    note:        'FRESH <6h strategy. Source: 79-trade audit June 2026',
  },
  {
    name:        'Base Scanner (EVM)',
    tradeSize:   0.001,
    currency:    'ETH',
    winRate:     0.35,     // conservative estimate — EVM Shield now active
    avgWinMult:  1.20,
    avgLossMult: 0.92,
    note:        'EVM Security Shield + Swap Simulator now active. Still in DRY-RUN.',
  },
  {
    name:        'BSC Scanner (EVM)',
    tradeSize:   0.001,
    currency:    'ETH',
    winRate:     0.30,
    avgWinMult:  1.18,
    avgLossMult: 0.93,
    note:        'Conservative — less historical data. Swap Simulator active.',
  },
  {
    name:        'TON Scanner',
    tradeSize:   0.5,
    currency:    'TON',
    winRate:     0.28,
    avgWinMult:  1.15,
    avgLossMult: 0.92,
    note:        'Conservative — DRY-RUN. Jetton safety validator now active.',
  },
  {
    name:        'Polymarket Bot',
    tradeSize:   10.0,
    currency:    'USDC',
    winRate:     0.60,     // 59.7% from June 2026 simulation
    avgWinMult:  1.35,     // TP at +35%
    avgLossMult: 0.60,     // SL at -40%
    note:        'Market Validator now active (MIN_VOL $50k, spread 0.88-1.12, max 14d). DRY-RUN.',
  },
];

const ITERATIONS   = 2000;
const TRADES       = 50;
const GAS_PCT      = 0.003; // 0.3% slippage+gas per trade

function runSimulation(cfg: BotConfig): void {
  const { name, tradeSize, currency, winRate, avgWinMult, avgLossMult } = cfg;

  const finalBalances: number[] = [];
  let wins = 0, losses = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    let balance = 0;
    let iterWins = 0;

    for (let t = 0; t < TRADES; t++) {
      const isWin = Math.random() < winRate;
      const gross = isWin
        ? tradeSize * (avgWinMult - 1)
        : tradeSize * (avgLossMult - 1);
      const gas   = -tradeSize * GAS_PCT;
      balance += gross + gas;
      if (isWin) iterWins++;
    }
    finalBalances.push(balance);
    wins   += iterWins;
    losses += (TRADES - iterWins);
  }

  finalBalances.sort((a, b) => a - b);

  const median      = finalBalances[Math.floor(ITERATIONS / 2)];
  const p10         = finalBalances[Math.floor(ITERATIONS * 0.1)];
  const p90         = finalBalances[Math.floor(ITERATIONS * 0.9)];
  const mean        = finalBalances.reduce((s, v) => s + v, 0) / ITERATIONS;
  const variance    = finalBalances.reduce((s, v) => s + (v - mean) ** 2, 0) / ITERATIONS;
  const stdDev      = Math.sqrt(variance);
  const sharpe      = stdDev > 0 ? mean / stdDev : 0;
  const profitPct   = (finalBalances.filter(b => b > 0).length / ITERATIONS * 100).toFixed(1);
  const breakEvenPt = finalBalances.findIndex(b => b >= 0);
  const realWR      = ((wins / (wins + losses)) * 100).toFixed(1);

  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${name}`);
  console.log(`${'─'.repeat(62)}`);
  console.log(`  Trade size:    ${tradeSize} ${currency}`);
  console.log(`  Sim WR:        ${realWR}% (target ${(winRate * 100).toFixed(0)}%)`);
  console.log(`  Avg win:       +${((avgWinMult - 1) * 100).toFixed(0)}%  |  Avg loss: ${((avgLossMult - 1) * 100).toFixed(0)}%`);
  console.log(`  P&L median:    ${median >= 0 ? '+' : ''}${median.toFixed(4)} ${currency}`);
  console.log(`  P&L mean:      ${mean >= 0 ? '+' : ''}${mean.toFixed(4)} ${currency}`);
  console.log(`  P10/P90:       ${p10.toFixed(4)} / ${p90.toFixed(4)} ${currency}`);
  console.log(`  Sharpe:        ${sharpe.toFixed(2)}`);
  console.log(`  Profitable:    ${profitPct}% of ${ITERATIONS} runs`);
  console.log(`  NOTE: ${cfg.note}`);
}

console.log(`\n${'═'.repeat(62)}`);
console.log(`  50-TRADE MONTE CARLO SIMULATION — ALL BOTS`);
console.log(`  ${ITERATIONS} iterations × ${TRADES} trades | Gas/slip: ${(GAS_PCT * 100).toFixed(1)}%`);
console.log(`${'═'.repeat(62)}`);

for (const bot of BOTS) {
  runSimulation(bot);
}

console.log(`\n${'═'.repeat(62)}`);
console.log(`  SAFETY MODULES ACTIVE (June 2026):`);
console.log(`  Solana : MintAuth + FreezeAuth + LP Burn (Gate 7 in auto-signal)`);
console.log(`  Base   : Anti-Impersonator + Security Shield + Swap Simulator`);
console.log(`  BSC    : Security Shield + Swap Simulator`);
console.log(`  TON    : Jetton Admin Renounce + Mintable check`);
console.log(`  Poly   : Volume $50k+ | Spread 0.88-1.12 | Max 14d duration`);
console.log(`${'═'.repeat(62)}\n`);

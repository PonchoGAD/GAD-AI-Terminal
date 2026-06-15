import { ethers } from 'ethers';
import { query } from '@lib/db';
import { sellToken, getTokenBalance, getEthBalance } from '@lib/base';
import axios from 'axios';

// ─── Config ──────────────────────────────────────────────────────────────────
// Adapted from Raydium/Phantom strategy that achieves 58%+ WR in FEAR market:
// - Early trail at +3% protects against quick reversals (Raydium EARLY_TRAIL_PCT=4)
// - Stop at 8% matches Raydium (was 10%)
// - Trail at 12% matches Raydium (was 8%)
// - TP1 at 1.25x (FEAR-conservative like Raydium 1.18-1.30x) → sell 80%
// - Time limit 2h (Base memes slower to develop than Solana bonding curve)
const STOP_LOSS_PCT    = Number(process.env.BASE_STOP_LOSS_PCT     || '8');    // 8% (Raydium parity)
const TRAIL_PCT        = Number(process.env.BASE_TRAIL_PCT         || '12');   // 12% (Raydium parity)
const EARLY_TRAIL_PCT  = Number(process.env.BASE_EARLY_TRAIL_PCT   || '3');    // activates trail before TP1
const TIME_LIMIT_SEC   = Number(process.env.BASE_TIME_LIMIT_SEC    || '7200'); // 2h
const POLL_INTERVAL_MS = Number(process.env.BASE_POLL_INTERVAL_MS  || '10000');
const BUY_ETH          = Number(process.env.BASE_BUY_ETH           || '0.001');

// TP levels — Raydium-style: capture most profit early, trail the rest
// Conservative targets fit current FEAR market (F&G=20)
const BASE_TPS = [
  { mult: 1.25, sellPct: 80 },   // lock 80% at +25% — Raydium FEAR mode equivalent
  { mult: 2.00, sellPct: 20 },   // close rest at 2x
];

interface Position {
  id:              string;
  contract_address:string;
  symbol:          string;
  wallet:          string;
  amount_eth:      number;
  token_amount:    string;
  entry_price_eth: number;
  bought_at:       Date;
  tp_index:        number;
  dex:             string;
  fee_tier:        number;
  trail_high:      number;
}

async function getOpenPositions(): Promise<Position[]> {
  const r = await query<Position>(
    `SELECT id, contract_address, symbol, wallet, amount_eth, token_amount,
            entry_price_eth, bought_at, tp_index, dex, fee_tier, trail_high
     FROM base_positions
     WHERE sold_at IS NULL AND is_active = true
     ORDER BY bought_at ASC`
  );
  return r.rows;
}

async function getCurrentPriceEth(contractAddress: string): Promise<number> {
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 5000 }
    );
    const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
    if (!pairs.length) return 0;
    return Number(pairs[0].priceNative ?? 0);
  } catch { return 0; }
}

// slippagePct=0 for forced exits (stop/trail/time) — accept any price, must exit
// slippagePct=3 for TP sells — enforce min ETH out to guard against MEV sandwiches
async function sellPosition(pos: Position, reason: string, sellPct: number, slippagePct = 0): Promise<void> {
  const tokenBalance = await getTokenBalance(pos.contract_address).catch(() => 0n);
  if (tokenBalance === 0n) {
    console.warn(`[base-monitor] ${pos.symbol} no token balance — marking inactive`);
    await query(`UPDATE base_positions SET is_active=false WHERE id=$1`, [pos.id]);
    return;
  }

  const amountToSell = sellPct >= 100
    ? tokenBalance
    : (tokenBalance * BigInt(sellPct)) / 100n;

  const ethBalBefore = await getEthBalance();

  const result = await sellToken(
    pos.contract_address,
    amountToSell,
    pos.dex as 'uniswap_v3' | 'aerodrome',
    pos.fee_tier,
    slippagePct,
  );

  if (!result.ok) {
    console.error(`[base-monitor] ${pos.symbol} sell FAILED: ${result.error}`);
    return;
  }

  const ethBalAfter = await getEthBalance();
  const ethReceived = Math.max(0, ethBalAfter - ethBalBefore);
  const isFull = sellPct >= 100 || (tokenBalance - amountToSell) < 100n;

  console.info(`[base-monitor] ${pos.symbol} SELL (${reason}) ${sellPct}% → ${ethReceived.toFixed(5)} ETH tx:${result.tx_hash?.slice(0, 12)}`);

  if (isFull) {
    await query(
      `UPDATE base_positions SET
         sold_at=NOW(), sell_tx=$2, sold_eth=$3, is_active=false, sell_reason=$4
       WHERE id=$1`,
      [pos.id, result.tx_hash, ethReceived, reason]
    );
    await updateDailyStats(pos, ethReceived);
  } else {
    const remainingPct = 100 - sellPct;
    const newAmount = (tokenBalance * BigInt(remainingPct)) / 100n;
    await query(
      `UPDATE base_positions SET
         token_amount=$2, tp_index=$3, total_sold_eth=COALESCE(total_sold_eth,0)+$4
       WHERE id=$1`,
      [pos.id, newAmount.toString(), pos.tp_index + 1, ethReceived]
    );
  }
}

async function updateDailyStats(pos: Position, ethReceived: number): Promise<void> {
  const pnl = ethReceived - pos.amount_eth;
  await query(
    `INSERT INTO base_stats (date, wallet, trades, wins, eth_in, eth_out, pnl_eth)
     VALUES (CURRENT_DATE, $1, 1, $2, $3, $4, $5)
     ON CONFLICT (date, wallet) DO UPDATE SET
       trades = base_stats.trades + 1,
       wins   = base_stats.wins + EXCLUDED.wins,
       eth_in = base_stats.eth_in + EXCLUDED.eth_in,
       eth_out= base_stats.eth_out + EXCLUDED.eth_out,
       pnl_eth= base_stats.pnl_eth + EXCLUDED.pnl_eth`,
    [pos.wallet, pnl > 0 ? 1 : 0, pos.amount_eth, ethReceived, pnl]
  );
}

async function pollPosition(pos: Position): Promise<void> {
  const currentPrice = await getCurrentPriceEth(pos.contract_address);
  if (currentPrice <= 0) return;

  const mult = currentPrice / pos.entry_price_eth;
  const ageSec = (Date.now() - new Date(pos.bought_at).getTime()) / 1000;
  const stopPrice = pos.entry_price_eth * (1 - STOP_LOSS_PCT / 100);

  // Time limit — forced exit
  if (ageSec > TIME_LIMIT_SEC) {
    await sellPosition(pos, 'TIME_LIMIT', 100, 0);
    return;
  }

  // Stop loss — forced exit
  if (currentPrice <= stopPrice) {
    await sellPosition(pos, 'STOP_LOSS', 100, 0);
    return;
  }

  // Trailing stop logic
  // Early trail (Raydium EARLY_TRAIL_PCT): activates even before TP1 if price moved +EARLY_TRAIL_PCT%
  // This prevents giving back small gains on reversals
  const earlyTrailActive = mult > (1 + EARLY_TRAIL_PCT / 100);
  // Regular trail: activates after first TP (tp_index > 0)
  const trailActive = earlyTrailActive || (pos.tp_index > 0 && mult > 1.01);

  if (trailActive) {
    const newHigh = Math.max(pos.trail_high, currentPrice);
    const trailStop = newHigh * (1 - TRAIL_PCT / 100);

    if (newHigh !== pos.trail_high) {
      await query(`UPDATE base_positions SET trail_high=$2 WHERE id=$1`, [pos.id, newHigh]);
      pos = { ...pos, trail_high: newHigh };
    }

    if (currentPrice <= trailStop) {
      const reason = earlyTrailActive && pos.tp_index === 0 ? 'EARLY_TRAIL' : 'TRAIL_STOP';
      await sellPosition(pos, reason, 100, 0);
      return;
    }
  }

  // TP levels — use 3% slippage protection against MEV sandwiches
  const nextTp = BASE_TPS[pos.tp_index];
  if (nextTp && mult >= nextTp.mult) {
    const isLast = pos.tp_index >= BASE_TPS.length - 1;
    await sellPosition(pos, `TP${pos.tp_index + 1}@${nextTp.mult}x`, isLast ? 100 : nextTp.sellPct, 3);
    if (!isLast) console.info(`[base-monitor] ${pos.symbol} TP${pos.tp_index + 1} hit — holding ${100 - nextTp.sellPct}% with ${TRAIL_PCT}% trail`);
  }

  console.debug(`[base-monitor] ${pos.symbol} ${mult.toFixed(3)}x [stop:${(STOP_LOSS_PCT)}% trail:${pos.trail_high > 0 ? `${(pos.trail_high * (1 - TRAIL_PCT / 100) / pos.entry_price_eth * 100 - 100).toFixed(0)}%` : 'inactive'}]`);
}

let monitorRunning = false;

async function monitorLoop(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    const positions = await getOpenPositions();
    if (positions.length === 0) return;

    console.debug(`[base-monitor] Polling ${positions.length} open positions`);
    await Promise.all(positions.map(p => pollPosition(p).catch(e =>
      console.error(`[base-monitor] Error polling ${p.symbol}: ${e.message}`)
    )));
  } catch (e: any) {
    console.error(`[base-monitor] Loop error: ${e.message}`);
  } finally {
    monitorRunning = false;
  }
}

export function startMonitor(): void {
  console.info(
    `[base-monitor] Starting — poll:${POLL_INTERVAL_MS / 1000}s | ` +
    `stop:${STOP_LOSS_PCT}% | trail:${TRAIL_PCT}% (early@+${EARLY_TRAIL_PCT}%) | ` +
    `TP:${BASE_TPS.map(t => `${t.mult}x→${t.sellPct}%`).join('/')} | time:${TIME_LIMIT_SEC / 3600}h`
  );
  setInterval(() => monitorLoop().catch(console.error), POLL_INTERVAL_MS);
}

export async function getPositionSummary(): Promise<any> {
  const open = await query(
    `SELECT contract_address, symbol, amount_eth, entry_price_eth, bought_at, tp_index
     FROM base_positions WHERE sold_at IS NULL AND is_active=true ORDER BY bought_at DESC`
  );
  const stats = await query(
    `SELECT COALESCE(SUM(trades),0) as trades, COALESCE(SUM(wins),0) as wins,
            COALESCE(SUM(pnl_eth),0) as pnl_eth
     FROM base_stats WHERE date = CURRENT_DATE`
  );
  const ethBal = await getEthBalance().catch(() => 0);
  const stat = stats.rows[0] ?? { trades: 0, wins: 0, pnl_eth: 0 };
  return {
    eth_balance: ethBal,
    open_count:  open.rows.length,
    open:        open.rows,
    today_trades: Number(stat.trades),
    today_wins:   Number(stat.wins),
    today_pnl_eth:Number(stat.pnl_eth),
  };
}

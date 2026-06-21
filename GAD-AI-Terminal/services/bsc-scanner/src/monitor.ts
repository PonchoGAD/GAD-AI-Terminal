import axios from 'axios';
import { ethers } from 'ethers';
import { query } from '@lib/db';
import { sellBscToken, getBscTokenBalance, getBnbBalance } from '@lib/bsc';

// ─── Config — Momentum Strategy ──────────────────────────────────────────────
// Buy BSC meme coins $500k-$10M on upward momentum.
// TP1: 1.2x → sell 60% (fast lock), TP2: 1.45x → sell 100% (close remainder).
// After TP1: breakeven stop (entry-2%), trail 10% from ATH, time limit 30min.

const STOP_LOSS_PCT   = Number(process.env.BSC_STOP_LOSS_PCT    || '8');    // 8% — tight stop for meme momentum
const TRAIL_PCT       = Number(process.env.BSC_TRAIL_PCT        || '10');   // 10% trailing stop (tighter than before)
const TIME_LIMIT_SEC  = Number(process.env.BSC_TIME_LIMIT_SEC   || '1800'); // 30 min — faster capital recycling
const POLL_INTERVAL   = Number(process.env.BSC_POLL_INTERVAL_MS || '15000'); // 15s poll — meme moves fast

//   TP1: 1.2x → sell 60% — quick profit lock on BSC meme spike
//   TP2: 1.45x → sell 100% — close remainder
//   After TP1: breakeven stop (entry-2%) — never give back a win
const BSC_TPS = [
  { mult: 1.2, sellPct: 60  },  // 1.2x: sell 60% — fast profit lock
  { mult: 1.45, sellPct: 100 }, // 1.45x: sell 100% — close position
];

interface BscPosition {
  id:               string;
  contract_address: string;
  symbol:           string;
  wallet:           string;
  amount_bnb:       number;
  token_amount:     string;    // bigint as string
  entry_price_bnb:  number;
  bought_at:        Date;
  tp_index:         number;
  trail_high:       number;
  buy_tax:          number;
  sell_tax:         number;
}

// Concurrent sell guard — prevents multiple poll cycles from selling simultaneously
const sellInProgress = new Set<string>();

async function getOpenPositions(): Promise<BscPosition[]> {
  const r = await query<BscPosition>(
    `SELECT id, contract_address, symbol, wallet, amount_bnb, token_amount,
            entry_price_bnb, bought_at, tp_index, trail_high, buy_tax, sell_tax
     FROM bsc_positions
     WHERE sold_at IS NULL AND is_active = true
     ORDER BY bought_at ASC`
  );
  return r.rows;
}

interface BscPriceData {
  priceBnb:   number;
  pc5m:       number;
  buys5m:     number;
  sells5m:    number;
  liqUsd:     number;
}

async function getBscTokenData(address: string): Promise<BscPriceData> {
  const empty: BscPriceData = { priceBnb: 0, pc5m: 0, buys5m: 0, sells5m: 0, liqUsd: 0 };
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { timeout: 5_000 }
    );
    const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'bsc');
    if (!pairs.length) return empty;
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return {
      priceBnb: Number(best.priceNative ?? 0),
      pc5m:     Number(best.priceChange?.m5  ?? 0),
      buys5m:   Number(best.txns?.m5?.buys   ?? 0),
      sells5m:  Number(best.txns?.m5?.sells  ?? 0),
      liqUsd:   Number(best.liquidity?.usd   ?? 0),
    };
  } catch { return empty; }
}

async function sellPosition(pos: BscPosition, reason: string, sellPct: number): Promise<void> {
  const tokenBalance = await getBscTokenBalance(pos.contract_address).catch(() => 0n);
  if (tokenBalance === 0n) {
    console.warn(`[bsc-monitor] ${pos.symbol} no token balance — marking inactive`);
    await query(`UPDATE bsc_positions SET is_active=false WHERE id=$1`, [pos.id]);
    return;
  }

  const amountToSell = sellPct >= 100
    ? tokenBalance
    : (tokenBalance * BigInt(sellPct)) / 100n;

  const bnbBefore = await getBnbBalance();
  const result = await sellBscToken(pos.contract_address, amountToSell, 0, true);

  if (!result.ok) {
    console.error(`[bsc-monitor] ${pos.symbol} sell FAILED (${reason}): ${result.error}`);
    return;
  }

  const bnbAfter   = await getBnbBalance();
  const bnbReceived = Math.max(0, bnbAfter - bnbBefore);
  const isFull = sellPct >= 100 || tokenBalance - amountToSell < 1000n;

  console.info(`[bsc-monitor] 💰 ${pos.symbol} SELL (${reason}) ${sellPct}% → ${bnbReceived.toFixed(5)} BNB`);

  if (isFull) {
    await query(
      `UPDATE bsc_positions SET
         sold_at=NOW(), sell_tx=$2, total_sold_bnb=$3, is_active=false, sell_reason=$4
       WHERE id=$1`,
      [pos.id, result.tx_hash, bnbReceived, reason]
    );
    // Update daily stats
    const bnbIn = pos.amount_bnb;
    const pnl   = bnbReceived - bnbIn;
    await query(
      `INSERT INTO bsc_stats (date, wallet, trades, wins, bnb_in, bnb_out)
       VALUES (CURRENT_DATE, $1, 1, $2, $3, $4)
       ON CONFLICT (date, wallet) DO UPDATE SET
         trades  = bsc_stats.trades  + 1,
         wins    = bsc_stats.wins    + EXCLUDED.wins,
         bnb_in  = bsc_stats.bnb_in  + EXCLUDED.bnb_in,
         bnb_out = bsc_stats.bnb_out + EXCLUDED.bnb_out`,
      [pos.wallet, pnl > 0 ? 1 : 0, bnbIn, bnbReceived]
    ).catch(() => {});
  } else {
    await query(
      `UPDATE bsc_positions SET
         tp_index=$2, total_sold_bnb=COALESCE(total_sold_bnb,0)+$3, last_activity_at=NOW()
       WHERE id=$1`,
      [pos.id, pos.tp_index + 1, bnbReceived]
    );
  }
}

async function checkPosition(pos: BscPosition): Promise<void> {
  // Concurrent sell guard — 8s poll + BSC TX latency = multiple cycles can overlap
  if (sellInProgress.has(pos.id)) {
    console.debug(`[bsc-monitor] ${pos.symbol} sell in progress — skipping poll`);
    return;
  }

  const data = await getBscTokenData(pos.contract_address);
  if (!data.priceBnb || data.priceBnb <= 0) return;

  const entryPrice = pos.entry_price_bnb;
  if (!entryPrice) return;

  const mult = data.priceBnb / entryPrice;
  const holdSec = (Date.now() - new Date(pos.bought_at).getTime()) / 1000;

  // Update trail_high
  const newTrailHigh = Math.max(pos.trail_high || entryPrice, data.priceBnb);
  if (newTrailHigh !== pos.trail_high) {
    await query(`UPDATE bsc_positions SET trail_high=$1 WHERE id=$2`, [newTrailHigh, pos.id]);
    pos.trail_high = newTrailHigh;
  }

  const holdDays = holdSec / 86400;
  console.info(
    `[bsc-monitor] 🔍 ${pos.symbol} ${mult.toFixed(2)}x` +
    ` pc5m:${data.pc5m.toFixed(1)}%` +
    ` liq:$${data.liqUsd.toFixed(0)} hold:${holdDays.toFixed(1)}d`
  );

  // Stop loss — after TP1 fires (tp_index >= 1), switch to breakeven stop (entry-2%)
  // This ensures we never give back a win once TP1 is locked.
  const effectiveStopPct = pos.tp_index >= 1 ? 2 : STOP_LOSS_PCT;
  if (mult <= (1 - effectiveStopPct / 100)) {
    const stopLabel = pos.tp_index >= 1 ? 'BREAKEVEN_STOP' : 'STOP_LOSS';
    console.info(`[bsc-monitor] 🔴 ${stopLabel} ${pos.symbol} ${mult.toFixed(3)}x (stop:${effectiveStopPct}%) — selling 100%`);
    sellInProgress.add(pos.id);
    await sellPosition(pos, stopLabel, 100).finally(() => sellInProgress.delete(pos.id));
    return;
  }

  // Time limit: 30 days. If still not 2x after 30 days, cut and redeploy capital elsewhere.
  if (holdSec > TIME_LIMIT_SEC) {
    console.info(`[bsc-monitor] ⏱ TIME_LIMIT ${pos.symbol} ${holdDays.toFixed(1)}d — selling 100%`);
    sellInProgress.add(pos.id);
    await sellPosition(pos, 'TIME_LIMIT', 100).finally(() => sellInProgress.delete(pos.id));
    return;
  }

  // Trailing stop — only activates after first TP fires (tp_index > 0).
  // Protects gains on the remaining position after 2x has been locked in.
  if (pos.tp_index > 0 && pos.trail_high > 0 && data.priceBnb < pos.trail_high * (1 - TRAIL_PCT / 100)) {
    console.info(`[bsc-monitor] 🎯 TRAIL_STOP ${pos.symbol} ${mult.toFixed(2)}x — ATH:${(pos.trail_high/entryPrice).toFixed(2)}x`);
    sellInProgress.add(pos.id);
    await sellPosition(pos, 'TRAIL_STOP', 100).finally(() => sellInProgress.delete(pos.id));
    return;
  }

  // TP levels
  const tps = BSC_TPS;
  let tpIdx = pos.tp_index;
  while (tpIdx < tps.length) {
    const tp = tps[tpIdx];
    if (mult >= tp.mult) {
      console.info(`[bsc-monitor] 🎯 TP${tpIdx + 1} ${pos.symbol} ${mult.toFixed(2)}x — selling ${tp.sellPct}%`);
      sellInProgress.add(pos.id);
      await sellPosition(pos, `TP${tpIdx + 1}`, tp.sellPct).finally(() => sellInProgress.delete(pos.id));
      tpIdx++;
    } else {
      break;
    }
  }
}

// Reload active positions on startup — handles cases where service restarted mid-sell.
// Checks token balance for each active position; if balance = 0 (sell TX completed but
// DB not updated), marks the position as sold with reason=RESTART_CLEANUP.
async function reloadActiveBscPositions(): Promise<void> {
  const positions = await getOpenPositions();
  if (!positions.length) {
    console.info('[bsc-monitor] reloadActiveBscPositions: no active positions');
    return;
  }
  console.info(`[bsc-monitor] reloadActiveBscPositions: checking ${positions.length} active positions…`);
  for (const pos of positions) {
    try {
      const tokenBalance = await getBscTokenBalance(pos.contract_address).catch(() => -1n);
      if (tokenBalance === 0n) {
        // Sell completed before restart but DB wasn't updated
        console.warn(`[bsc-monitor] ${pos.symbol} balance=0 after restart → marking sold (RESTART_CLEANUP)`);
        await query(
          `UPDATE bsc_positions SET is_active=false, sell_reason='RESTART_CLEANUP', sold_at=NOW() WHERE id=$1`,
          [pos.id]
        );
      } else {
        // Normal active position — reset any stale sell-in-progress flag (already cleared by Set re-init)
        console.info(
          `[bsc-monitor] ✅ Resume monitoring: ${pos.symbol}` +
          ` entry:${pos.entry_price_bnb.toFixed(8)} tp_index:${pos.tp_index}` +
          ` age:${Math.floor((Date.now() - new Date(pos.bought_at).getTime()) / 60000)}min`
        );
      }
    } catch (e: any) {
      console.warn(`[bsc-monitor] reloadActiveBscPositions ${pos.symbol}: ${e.message}`);
    }
  }
}

export async function startBscMonitor(): Promise<void> {
  console.info(`[bsc-monitor] Position monitor started — poll:${POLL_INTERVAL}ms stop:${STOP_LOSS_PCT}% trail:${TRAIL_PCT}% time:${TIME_LIMIT_SEC}s TP1:1.2x/60% TP2:1.45x/100%`);

  // Startup: check for positions that may have been partially sold before restart
  await reloadActiveBscPositions().catch(e =>
    console.warn(`[bsc-monitor] reloadActiveBscPositions failed: ${e.message}`)
  );

  async function loop(): Promise<void> {
    try {
      const positions = await getOpenPositions();
      for (const pos of positions) {
        await checkPosition(pos).catch(e =>
          console.error(`[bsc-monitor] Error on ${pos.symbol}: ${e.message}`)
        );
      }
    } catch (e: any) {
      console.error(`[bsc-monitor] Poll error: ${e.message}`);
    }
    setTimeout(loop, POLL_INTERVAL);
  }

  setTimeout(loop, 3_000); // initial delay to let service start
}

export async function getBscPositionSummary(): Promise<{
  open_positions: number;
  total_bnb_in: number;
  total_bnb_out: number;
}> {
  const r = await query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(amount_bnb),0) as bnb_in
     FROM bsc_positions WHERE is_active=true`
  );
  const stats = await query(
    `SELECT COALESCE(SUM(bnb_out),0) as bnb_out FROM bsc_stats WHERE date=CURRENT_DATE`
  );
  return {
    open_positions: Number(r.rows[0]?.cnt ?? 0),
    total_bnb_in:  Number(r.rows[0]?.bnb_in ?? 0),
    total_bnb_out: Number(stats.rows[0]?.bnb_out ?? 0),
  };
}

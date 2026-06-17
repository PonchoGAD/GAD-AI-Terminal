import axios from 'axios';
import { ethers } from 'ethers';
import { query } from '@lib/db';
import { sellBscToken, getBscTokenBalance, getBnbBalance } from '@lib/bsc';

// ─── Config — Dip Buyer Strategy ─────────────────────────────────────────────
// Buy established $20M+ mcap tokens on dips. Hold until 2x, then sell 50%.
// Remaining 50% runs with trailing stop — can recover further or exit at trail.

const STOP_LOSS_PCT   = Number(process.env.BSC_STOP_LOSS_PCT   || '35');   // 35% stop — give established coins room to recover
const TRAIL_PCT       = Number(process.env.BSC_TRAIL_PCT       || '25');   // 25% trailing stop after first TP fires
const TIME_LIMIT_SEC  = Number(process.env.BSC_TIME_LIMIT_SEC  || '2592000'); // 30 days — portfolio hold, not a quick trade
const POLL_INTERVAL   = Number(process.env.BSC_POLL_INTERVAL_MS || '60000'); // 60s poll — established tokens, no rush

// Pyramid scale-out: each 2x from entry doubles the multiplier, sell 50% each time.
// After 3 TPs, ~10% "неснижаемый остаток" (non-reducible moon bag) remains.
//   TP1: 2x → sell 50%  → 50% left
//   TP2: 4x → sell 50%  → 25% left
//   TP3: 8x → sell 60%  → ~10% left (moon bag, exits via TRAIL_STOP only)
const BSC_TPS = [
  { mult: 2.0, sellPct: 50 },  // 2x: sell 50% — recover initial investment
  { mult: 4.0, sellPct: 50 },  // 4x: sell 50% of remaining — lock +300% on that portion
  { mult: 8.0, sellPct: 60 },  // 8x: sell 60% of remaining → ~10% moon bag left
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

  // Stop loss — hard floor to prevent catastrophic losses.
  // 35% gives established tokens room to recover from dip without stopping prematurely.
  if (mult <= (1 - STOP_LOSS_PCT / 100)) {
    console.info(`[bsc-monitor] 🔴 STOP ${pos.symbol} ${mult.toFixed(3)}x (stop:${STOP_LOSS_PCT}%) — selling 100%`);
    sellInProgress.add(pos.id);
    await sellPosition(pos, 'STOP_LOSS', 100).finally(() => sellInProgress.delete(pos.id));
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

export async function startBscMonitor(): Promise<void> {
  console.info(`[bsc-monitor] Position monitor started — poll:${POLL_INTERVAL}ms stop:${STOP_LOSS_PCT}% trail:${TRAIL_PCT}% time:${TIME_LIMIT_SEC}s`);

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

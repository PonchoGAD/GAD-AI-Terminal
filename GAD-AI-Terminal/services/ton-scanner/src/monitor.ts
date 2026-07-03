import { query } from '@lib/db';
import { sellJetton, getJettonBalance, getPoolPrice } from '@lib/ton';

// ─── Config ────────────────────────────────────────────────────────────────────
// SL raised 8→10%, time 30min→10min: TON meme cycles are fast, don't overstay.
// 5-stage TP → 2-stage: 5 TX × 0.15 TON gas = 0.75 TON wasted; 2 TX = 0.30 TON.
const STOP_LOSS_PCT    = Number(process.env.TON_STOP_LOSS_PCT   || '10');
const TRAIL_PCT        = Number(process.env.TON_TRAIL_PCT        || '10');
const TIME_LIMIT_SEC   = Number(process.env.TON_TIME_LIMIT_SEC  || '600');
const POLL_INTERVAL    = Number(process.env.TON_POLL_INTERVAL_SEC || '15') * 1000;

// 2-stage TP: aggressive lock on spike, then close.
// Stage 1: +35% → sell 70% (fast lock captures spike)
// Stage 2: +80% → sell 100% (close remainder on extension)
const TP_STAGES = [
  { multiplier: 1.35, sellPct: 70  },
  { multiplier: 1.80, sellPct: 100 },
];

interface TonPosition {
  id:              string;
  jetton_address:  string;
  pool_address:    string;
  symbol:          string;
  wallet:          string;
  amount_ton:      number;
  token_amount:    string;   // bigint as string
  entry_price_ton: number;
  tp_index:        number;
  trail_high:      number;
  bought_at:       Date;
  be_active?:      boolean;  // break-even mode: after TP1, SL moves to entry price (0% loss)
}

export async function runTonMonitorCycle(): Promise<void> {
  const label = '[ton-monitor]';
  let positions: TonPosition[];

  try {
    const res = await query<TonPosition>(
      `SELECT id, jetton_address, pool_address, symbol, wallet, amount_ton,
              token_amount, entry_price_ton, tp_index, trail_high, bought_at
       FROM ton_positions
       WHERE is_active = true`,
      []
    );
    positions = res.rows;
  } catch (e: any) {
    console.error(`${label} DB query failed:`, e.message);
    return;
  }

  for (const pos of positions) {
    try {
      const nowSec       = Math.floor(Date.now() / 1000);
      const ageSec       = nowSec - Math.floor(pos.bought_at.getTime() / 1000);
      const currentPrice = await getPoolPrice(pos.pool_address);

      if (!currentPrice || currentPrice <= 0) {
        console.debug(`${label} ${pos.symbol} — no price data (pool_address:${pos.pool_address})`);
        continue;
      }

      if (!pos.entry_price_ton || pos.entry_price_ton <= 0) {
        // Try to resolve entry price from current jetton balance
        await query(
          `UPDATE ton_positions SET entry_price_ton=$1, last_activity_at=NOW() WHERE id=$2`,
          [currentPrice, pos.id]
        );
        continue;
      }

      const multiplier = currentPrice / pos.entry_price_ton;
      const newHigh    = Math.max(Number(pos.trail_high) || 0, multiplier);

      // Update trail high
      if (newHigh > Number(pos.trail_high)) {
        await query(`UPDATE ton_positions SET trail_high=$1 WHERE id=$2`, [newHigh, pos.id]);
      }

      const sym = pos.symbol?.padEnd(10) ?? '???       ';
      console.debug(`${label} ${sym} ${multiplier.toFixed(3)}x age:${Math.floor(ageSec/60)}m trail_high:${newHigh.toFixed(3)}x tp_idx:${pos.tp_index}`);

      // ─── TP check ──────────────────────────────────────────────────────────
      const stage = TP_STAGES[pos.tp_index];
      if (stage && multiplier >= stage.multiplier) {
        const tokenAmountNano = BigInt(pos.token_amount || '0');
        if (tokenAmountNano === 0n) {
          // Re-read from chain in case DB has stale '0'
          const actual = await getJettonBalance(pos.jetton_address);
          if (actual > 0n) {
            await query(`UPDATE ton_positions SET token_amount=$1 WHERE id=$2`, [actual.toString(), pos.id]);
          }
          continue;
        }

        const sellNano = tokenAmountNano * BigInt(stage.sellPct) / 100n;
        console.info(`${label} 🎯 TP${pos.tp_index + 1} ${sym} ${multiplier.toFixed(2)}x → sell ${stage.sellPct}%`);

        const result = await sellJetton(pos.jetton_address, sellNano);
        if (result.ok) {
          const isLastStage = pos.tp_index + 1 >= TP_STAGES.length;
          const remaining   = (tokenAmountNano - sellNano).toString();
          // Activate break-even after TP1: remaining tokens are now "house money" — SL moves to entry.
          if (pos.tp_index === 0) pos.be_active = true;
          await query(
            `UPDATE ton_positions
             SET tp_index=$1, token_amount=$2, sell_tx=$3, last_activity_at=NOW(),
                 is_active=$4, sold_at=CASE WHEN $4=false THEN NOW() ELSE NULL END,
                 sell_reason=CASE WHEN $4=false THEN 'TP_FINAL' ELSE sell_reason END
             WHERE id=$5`,
            [pos.tp_index + 1, remaining, result.tx_id, !isLastStage, pos.id]
          );
        } else {
          console.warn(`${label} TP sell failed ${sym}: ${result.error}`);
        }
        continue;
      }

      // ─── Trail stop ────────────────────────────────────────────────────────
      if (pos.tp_index > 0 && newHigh > 1) {
        const trailDrop = (newHigh - multiplier) / newHigh;
        if (trailDrop >= TRAIL_PCT / 100) {
          console.info(`${label} 📉 TRAIL STOP ${sym} ${multiplier.toFixed(2)}x (high:${newHigh.toFixed(2)}x dropped:${(trailDrop*100).toFixed(1)}%)`);
          await closePosition(pos, 'TRAIL_STOP');
          continue;
        }
      }

      // ─── Break-even stop (after TP1 hit) ──────────────────────────────────
      // Once we've locked 70% profit at TP1 (+35%), the remaining 30% risks nothing.
      // SL moves to entry price: if it falls back to entry → exit at 0% on remainder.
      if (pos.be_active && multiplier < 1.0) {
        console.info(`${label} 🔒 BE STOP ${sym} ${multiplier.toFixed(2)}x — locked TP1 profit, exit remainder at entry`);
        await closePosition(pos, 'BE_STOP');
        continue;
      }

      // ─── Stop loss ─────────────────────────────────────────────────────────
      if (multiplier <= 1 - STOP_LOSS_PCT / 100) {
        console.info(`${label} 🛑 STOP LOSS ${sym} ${multiplier.toFixed(2)}x`);
        await closePosition(pos, 'STOP_LOSS');
        continue;
      }

      // ─── Time limit ────────────────────────────────────────────────────────
      if (ageSec > TIME_LIMIT_SEC && multiplier < 1.05) {
        console.info(`${label} ⏰ TIME LIMIT ${sym} age:${Math.floor(ageSec/60)}m ${multiplier.toFixed(2)}x`);
        await closePosition(pos, 'TIME_LIMIT');
        continue;
      }

    } catch (e: any) {
      console.error(`${label} error monitoring ${pos.symbol}:`, e.message);
    }
  }
}

async function closePosition(pos: TonPosition, reason: string): Promise<void> {
  const label = '[ton-monitor]';
  const tokenAmountNano = BigInt(pos.token_amount || '0');

  if (tokenAmountNano === 0n) {
    // Nothing to sell, just close
    await query(
      `UPDATE ton_positions SET is_active=false, sold_at=NOW(), sell_reason=$1 WHERE id=$2`,
      [reason + '_ZERO_BAL', pos.id]
    );
    return;
  }

  const result = await sellJetton(pos.jetton_address, tokenAmountNano);
  if (result.ok) {
    await query(
      `UPDATE ton_positions
       SET is_active=false, sold_at=NOW(), sell_reason=$1, sell_tx=$2,
           token_amount='0', last_activity_at=NOW()
       WHERE id=$3`,
      [reason, result.tx_id, pos.id]
    );
    console.info(`[ton-monitor] ✅ CLOSED ${pos.symbol} reason:${reason} tx:${result.tx_id}`);
  } else {
    console.error(`${label} close failed ${pos.symbol}: ${result.error}`);
    await query(
      `UPDATE ton_positions SET last_activity_at=NOW(), sell_reason=$1 WHERE id=$2`,
      [reason + '_SELL_FAIL', pos.id]
    );
  }
}

async function cleanupStaleTonPositions(): Promise<void> {
  // On restart: close positions that exceeded their time limit while DB was unreachable.
  // Without this, positions stuck in 'open' state from PostgreSQL recovery events would
  // hold the TON wallet balance hostage indefinitely and inflate "active positions" count.
  try {
    const res = await query<{ id: string; symbol: string }>(
      `UPDATE ton_positions
         SET is_active=false, sold_at=NOW(), sell_reason='EXPIRED_ON_RESTART'
       WHERE is_active=true
         AND bought_at < NOW() - INTERVAL '${TIME_LIMIT_SEC} seconds'
       RETURNING id, symbol`,
      []
    );
    if (res.rows?.length) {
      const names = res.rows.map(r => r.symbol).join(', ');
      console.info(`[ton-monitor] 🔄 Startup cleanup: expired ${res.rows.length} stale positions (${names})`);
    }
  } catch (e: any) {
    console.warn(`[ton-monitor] Startup cleanup error: ${e.message}`);
  }
}

export async function startTonMonitor(): Promise<void> {
  console.info(`[ton-monitor] starting — SL:${STOP_LOSS_PCT}% trail:${TRAIL_PCT}% time_limit:${TIME_LIMIT_SEC}s poll:${POLL_INTERVAL/1000}s`);
  await cleanupStaleTonPositions();
  runTonMonitorCycle();
  setInterval(runTonMonitorCycle, POLL_INTERVAL);
}

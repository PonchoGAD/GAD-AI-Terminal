import { query } from '@lib/db';
import { getMidPrice } from './markets';
import { closePosition } from './trader';

// Prediction market TP/SL — different from crypto:
// Shares are binary (pay out $1.00 or $0.00 at resolution)
// We trade mid-price movements, not waiting for resolution
const TP_PCT        = Number(process.env.POLYMARKET_TP_PCT        || '35');  // +35% from entry
const IMPULSE_PCT   = Number(process.env.POLYMARKET_IMPULSE_PCT   || '22');  // quick +22% move = impulse TP
const SL_PCT        = Number(process.env.POLYMARKET_SL_PCT        || '40');  // -40% from entry
const TIME_LIMIT_S  = Number(process.env.POLYMARKET_TIME_LIMIT_S  || '7200'); // 2h
const POLL_MS       = Number(process.env.POLYMARKET_POLL_MS       || '30000'); // 30s

// Track first-seen price for impulse detection: posId → { entryTime, prices }
const priceHistory = new Map<number, { time: number; price: number }[]>();

interface Position {
  id:           number;
  market_id:    string;
  outcome:      string;
  amount_usdc:  number;
  shares:       number;
  entry_price:  number;
  token_id:     string;
  is_dry_run:   boolean;
  created_at:   Date;
  close_order_id: string | null;
}

async function getOpenPositions(): Promise<Position[]> {
  const { rows } = await query<Position>(
    `SELECT id, market_id, outcome, amount_usdc::float AS amount_usdc,
            shares::float AS shares, entry_price::float AS entry_price,
            token_id, is_dry_run, created_at
     FROM polymarket_positions WHERE is_active=true ORDER BY created_at ASC`
  );
  return rows;
}

async function recordClose(
  pos: Position, closePrice: number, reason: string, closeOrderId: string | null
): Promise<void> {
  const pnl = (closePrice - pos.entry_price) * pos.shares;
  await query(
    `UPDATE polymarket_positions SET
       is_active=false, closed_at=NOW(), close_price=$2, close_reason=$3,
       close_order_id=$4, pnl_usdc=$5
     WHERE id=$1`,
    [pos.id, closePrice, reason, closeOrderId, pnl]
  );
  await query(
    `INSERT INTO polymarket_stats (date, is_dry_run, trades, wins, usdc_in, usdc_out, pnl_usdc)
     VALUES (CURRENT_DATE,$1,1,$2,$3,$4,$5)
     ON CONFLICT (date, is_dry_run) DO UPDATE SET
       trades=polymarket_stats.trades+1,
       wins=polymarket_stats.wins+EXCLUDED.wins,
       usdc_in=polymarket_stats.usdc_in+EXCLUDED.usdc_in,
       usdc_out=polymarket_stats.usdc_out+EXCLUDED.usdc_out,
       pnl_usdc=polymarket_stats.pnl_usdc+EXCLUDED.pnl_usdc`,
    [pos.is_dry_run, pnl > 0 ? 1 : 0, pos.amount_usdc, closePrice * pos.shares, pnl]
  );
  priceHistory.delete(pos.id);

  const sign = pnl >= 0 ? '+' : '';
  console.info(
    `[poly-monitor] ${pnl >= 0 ? '✅' : '❌'} ${pos.outcome} closed (${reason}) ` +
    `@ $${closePrice.toFixed(3)} | PnL: ${sign}$${pnl.toFixed(3)} [${pos.is_dry_run ? 'DRY' : 'LIVE'}]`
  );
}

async function pollPosition(pos: Position): Promise<void> {
  const currentPrice = await getMidPrice(pos.token_id);
  if (!currentPrice || currentPrice <= 0) return;

  const ageSec  = (Date.now() - new Date(pos.created_at).getTime()) / 1000;
  const pnlPct  = ((currentPrice / pos.entry_price) - 1) * 100;

  // Track price history for impulse detection (keep last 10 readings ~5 min)
  const hist = priceHistory.get(pos.id) ?? [];
  hist.push({ time: Date.now(), price: currentPrice });
  if (hist.length > 10) hist.shift();
  priceHistory.set(pos.id, hist);

  // Impulse TP: price rose ≥ IMPULSE_PCT within 20 minutes
  const windowMs = 20 * 60 * 1000;
  const oldEnough = hist.filter(h => Date.now() - h.time >= windowMs);
  const impulse = oldEnough.length > 0
    ? ((currentPrice / oldEnough[0].price) - 1) * 100
    : 0;

  let reason: string | null = null;

  if (pnlPct >= TP_PCT)         reason = `TP${TP_PCT}%`;
  else if (impulse >= IMPULSE_PCT) reason = `IMPULSE_TP`;
  else if (pnlPct <= -SL_PCT)   reason = 'STOP_LOSS';
  else if (ageSec > TIME_LIMIT_S) reason = 'TIME_LIMIT';

  if (reason) {
    const result = await closePosition(pos.id, pos.token_id, pos.shares, reason, pos.is_dry_run);
    if (result.ok) {
      await recordClose(pos, result.executedPrice || currentPrice, reason, null);
    }
  } else {
    console.debug(
      `[poly-monitor] ${pos.outcome} ${pos.market_id.slice(0,12)} ` +
      `$${currentPrice.toFixed(3)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) | ` +
      `age:${Math.floor(ageSec/60)}min`
    );
  }
}

export async function monitorPositions(): Promise<void> {
  const positions = await getOpenPositions();
  if (!positions.length) return;
  await Promise.all(
    positions.map(p => pollPosition(p).catch(e =>
      console.error(`[poly-monitor] Error polling pos#${p.id}:`, e.message)
    ))
  );
}

export function startMonitor(): void {
  console.info(
    `[poly-monitor] Starting — poll:${POLL_MS/1000}s | TP:+${TP_PCT}% | impulse:+${IMPULSE_PCT}% | SL:-${SL_PCT}% | time:${TIME_LIMIT_S/3600}h`
  );
  setInterval(() => monitorPositions().catch(console.error), POLL_MS);
}

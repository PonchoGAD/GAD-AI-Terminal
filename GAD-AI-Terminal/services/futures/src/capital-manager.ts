import { query } from '@lib/db';
import { CapitalState, PositionSize } from './types';

// Leverage ladder by capital level
function calcLeverage(totalUsdc: number): number {
  if (totalUsdc >= 200) return 10;
  if (totalUsdc >=  50) return  5;
  if (totalUsdc >=  20) return  3;
  return 2; // $5-20 range → x2
}

// Risk per trade = 2% of available capital
const RISK_PCT        = parseFloat(process.env.FUTURES_RISK_PCT       || '0.02');
const TP_PCT          = parseFloat(process.env.FUTURES_TP_PCT         || '0.04'); // 4%
const SL_PCT          = parseFloat(process.env.FUTURES_SL_PCT         || '0.02'); // 2%
const TRAIL_PCT       = parseFloat(process.env.FUTURES_TRAIL_PCT      || '0.015'); // 1.5%
const DAILY_STOP_PCT  = parseFloat(process.env.FUTURES_DAILY_STOP_PCT || '0.06'); // 6%
const MAX_TRADES_DAY  = parseInt(process.env.FUTURES_MAX_TRADES_DAY   || '6', 10);

export async function getCapitalState(): Promise<CapitalState> {
  const res = await query<any>(
    `SELECT * FROM futures_capital ORDER BY ts DESC LIMIT 1`
  );
  if (!res.rows.length) {
    return {
      totalUsdc:    5.10,
      availableUsdc: 5.10,
      inTradeUsdc:  0,
      dailyPnlUsdc: 0,
      totalPnlUsdc: 0,
      winStreak:    0,
      lossStreak:   0,
      tradesToday:  0,
      dailyStopHit: false,
    };
  }
  const r = res.rows[0];
  return {
    totalUsdc:    parseFloat(r.total_usdc),
    availableUsdc: parseFloat(r.available_usdc),
    inTradeUsdc:  parseFloat(r.in_trade_usdc),
    dailyPnlUsdc: parseFloat(r.daily_pnl_usdc),
    totalPnlUsdc: parseFloat(r.total_pnl_usdc),
    winStreak:    r.win_streak,
    lossStreak:   r.loss_streak,
    tradesToday:  r.trades_today,
    dailyStopHit: r.daily_stop_hit,
  };
}

export async function updateCapitalState(patch: Partial<CapitalState>): Promise<void> {
  const cur = await getCapitalState();
  const merged = { ...cur, ...patch };
  await query(
    `INSERT INTO futures_capital
       (total_usdc, available_usdc, in_trade_usdc, daily_pnl_usdc, total_pnl_usdc,
        win_streak, loss_streak, trades_today, daily_stop_hit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      merged.totalUsdc, merged.availableUsdc, merged.inTradeUsdc,
      merged.dailyPnlUsdc, merged.totalPnlUsdc,
      merged.winStreak, merged.lossStreak, merged.tradesToday,
      merged.dailyStopHit,
    ]
  );
}

export function calcPositionSize(
  capital: CapitalState,
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  signalStrength: number // 0-100
): PositionSize | null {
  if (capital.dailyStopHit) return null;
  if (capital.tradesToday >= MAX_TRADES_DAY) return null;
  if (capital.availableUsdc < 1) return null;

  // daily stop check: if daily PnL < -6% of total
  const dailyStopThreshold = -(capital.totalUsdc * DAILY_STOP_PCT);
  if (capital.dailyPnlUsdc <= dailyStopThreshold) return null;

  const leverage = calcLeverage(capital.totalUsdc);

  // Size: risk 2% of available; if on win streak >3 → 2.5%, loss streak >2 → 1.5%
  let riskPct = RISK_PCT;
  if (capital.winStreak >= 3)  riskPct = 0.025;
  if (capital.lossStreak >= 2) riskPct = 0.015;

  // Signal strength scaling: 50-100% of target size based on signal
  const sigMult   = 0.5 + (signalStrength / 200); // 0.50 at str=0, 1.0 at str=100
  const riskUsdc  = capital.availableUsdc * riskPct * sigMult;
  // With SL at 2%, position size = risk / SL_PCT
  const sizeUsdc  = Math.min(capital.availableUsdc, riskUsdc / SL_PCT);
  const notional  = sizeUsdc * leverage;

  const tpMult   = side === 'LONG' ? 1 + TP_PCT : 1 - TP_PCT;
  const slMult   = side === 'LONG' ? 1 - SL_PCT : 1 + SL_PCT;

  return {
    sizeUsdc:     parseFloat(sizeUsdc.toFixed(4)),
    leverage,
    notionalUsdc: parseFloat(notional.toFixed(4)),
    riskUsdc:     parseFloat(riskUsdc.toFixed(4)),
    tpPrice:      parseFloat((entryPrice * tpMult).toFixed(4)),
    slPrice:      parseFloat((entryPrice * slMult).toFixed(4)),
    trailPct:     TRAIL_PCT,
  };
}

export function formatCapitalReport(c: CapitalState): string {
  const pnlSign  = c.totalPnlUsdc >= 0 ? '+' : '';
  const daySign  = c.dailyPnlUsdc >= 0 ? '+' : '';
  const streakTxt = c.winStreak > 0
    ? `🔥 Win streak: ${c.winStreak}`
    : c.lossStreak > 0
    ? `❄️ Loss streak: ${c.lossStreak}`
    : 'No streak';
  const stopBadge = c.dailyStopHit ? '\n⛔ DAILY STOP HIT — no new trades today' : '';

  return [
    `💼 CAPITAL STATUS`,
    ``,
    `Total:     $${c.totalUsdc.toFixed(2)} USDC`,
    `Available: $${c.availableUsdc.toFixed(2)} USDC`,
    `In trade:  $${c.inTradeUsdc.toFixed(2)} USDC`,
    ``,
    `Today P&L: ${daySign}$${c.dailyPnlUsdc.toFixed(2)}`,
    `Total P&L: ${pnlSign}$${c.totalPnlUsdc.toFixed(2)}`,
    `Trades/day: ${c.tradesToday}/${MAX_TRADES_DAY}`,
    ``,
    streakTxt,
    stopBadge,
  ].join('\n');
}

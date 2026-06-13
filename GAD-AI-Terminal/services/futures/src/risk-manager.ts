/**
 * RiskManager — monitors open positions and fires TP/SL/Trail closes.
 * Polls every 3 seconds independently of signal generation.
 */

import axios from 'axios';
import { getOpenPositions, closePosition, LIVE_MODE } from './drift-trader';
import { getCapitalState, updateCapitalState } from './capital-manager';
import { OpenPosition } from './types';

const POLL_MS       = parseInt(process.env.FUTURES_RISK_POLL_MS || '3000', 10);
const TP_PCT        = parseFloat(process.env.FUTURES_TP_PCT     || '0.04');
const SL_PCT        = parseFloat(process.env.FUTURES_SL_PCT     || '0.02');
const TRAIL_PCT     = parseFloat(process.env.FUTURES_TRAIL_PCT  || '0.015');
const BE_TRIGGER    = parseFloat(process.env.FUTURES_BE_TRIGGER || '0.03'); // move to BE at +3%

// Peak price tracking (in-memory between polls, good enough)
const peakPrice = new Map<string, number>();

async function getSolPrice(): Promise<number> {
  const res = await axios.get(
    'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    { timeout: 3_000 }
  );
  return parseFloat(res.data.price);
}

async function checkPosition(pos: OpenPosition, currentPrice: number): Promise<void> {
  const { tradeId, side, entryPrice, notionalUsdc } = pos;

  // Track peak
  const prev = peakPrice.get(tradeId) ?? entryPrice;
  const newPeak = side === 'LONG' ? Math.max(prev, currentPrice) : Math.min(prev, currentPrice);
  peakPrice.set(tradeId, newPeak);

  const pnlPct = side === 'LONG'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;

  const tpHit  = pnlPct >= TP_PCT;
  const slHit  = pnlPct <= -SL_PCT;

  // Trailing stop (only after BE_TRIGGER reached)
  const peakPnlPct = side === 'LONG'
    ? (newPeak - entryPrice) / entryPrice
    : (entryPrice - newPeak) / entryPrice;

  const trailHit = peakPnlPct >= BE_TRIGGER && (() => {
    const trailPrice = side === 'LONG'
      ? newPeak * (1 - TRAIL_PCT)
      : newPeak * (1 + TRAIL_PCT);
    return side === 'LONG' ? currentPrice < trailPrice : currentPrice > trailPrice;
  })();

  if (tpHit || slHit || trailHit) {
    const reason = tpHit ? 'TP' : slHit ? 'SL' : 'TRAIL';
    const netPnl = await closePosition(tradeId, currentPrice, reason);
    peakPrice.delete(tradeId);

    // Update capital
    const capital = await getCapitalState();
    const newTotal   = capital.totalUsdc + netPnl;
    const newDaily   = capital.dailyPnlUsdc + netPnl;
    const winStreak  = netPnl > 0 ? capital.winStreak + 1 : 0;
    const lossStreak = netPnl < 0 ? capital.lossStreak + 1 : 0;

    const dailyStopHit = newDaily <= -(capital.totalUsdc * 0.06);

    await updateCapitalState({
      totalUsdc:    newTotal,
      availableUsdc: newTotal - capital.inTradeUsdc + pos.sizeUsdc,
      inTradeUsdc:  Math.max(0, capital.inTradeUsdc - pos.sizeUsdc),
      dailyPnlUsdc: newDaily,
      totalPnlUsdc: capital.totalPnlUsdc + netPnl,
      winStreak,
      lossStreak,
      dailyStopHit,
    });

    console.log(`[risk] ${reason} fired  tradeId=${tradeId}  pnl=${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)}`);
  }
}

// ── Reset daily counters at midnight UTC ─────────────────────────────────────
function scheduleMidnightReset() {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(24, 0, 5, 0);
  const delay = next.getTime() - now.getTime();

  setTimeout(async () => {
    const capital = await getCapitalState();
    await updateCapitalState({
      dailyPnlUsdc: 0,
      tradesToday:  0,
      dailyStopHit: false,
      winStreak:    capital.winStreak, // preserve streaks
      lossStreak:   capital.lossStreak,
    });
    console.log('[risk] 🌙 Daily counters reset');
    scheduleMidnightReset();
  }, delay);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
export function startRiskManager(
  onEvent?: (msg: string) => void
): void {
  scheduleMidnightReset();

  setInterval(async () => {
    try {
      const positions = await getOpenPositions();
      if (!positions.length) return;

      const currentPrice = await getSolPrice();

      for (const pos of positions) {
        await checkPosition(pos, currentPrice);
      }
    } catch (err: any) {
      // non-fatal — retry next cycle
    }
  }, POLL_MS);

  const modeStr = LIVE_MODE === 'live' ? '🔴 LIVE (Drift on-chain)' : '📝 PAPER';
  console.log(`[risk] Risk manager started (${modeStr}, poll=${POLL_MS}ms, TP=${TP_PCT*100}%, SL=${SL_PCT*100}%)`);
}

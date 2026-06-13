/**
 * Futures Trading Service
 *
 * Runs two loops:
 *   1. Signal loop (every 5 min) → check macro + technical signal → open position if favorable
 *   2. Risk loop  (every 3 sec) → monitor open positions → fire TP/SL/Trail
 *
 * Mode:
 *   FUTURES_LIVE_MODE=false  → paper trading (default, safe)
 *   FUTURES_LIVE_MODE=true   → real Drift Protocol on Solana (requires USDC deposited to Drift)
 *
 * Telegram notifications via TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID
 */

import axios from 'axios';
import { getMacroState } from './macro-monitor';
import { getSignal } from './entry-strategy';
import { getCapitalState, updateCapitalState, calcPositionSize } from './capital-manager';
import { openPosition, LIVE_MODE, getOpenPositions } from './drift-trader';
import { startRiskManager } from './risk-manager';
import { query } from '@lib/db';

const SIGNAL_INTERVAL_MS = parseInt(process.env.FUTURES_SIGNAL_INTERVAL_MS || '300000', 10); // 5 min
const MIN_MACRO_SCORE    = parseInt(process.env.FUTURES_MIN_MACRO_SCORE || '45', 10);
const MIN_SIGNAL_STR     = parseInt(process.env.FUTURES_MIN_SIGNAL_STR  || '55', 10);
const FUTURES_ENABLED    = process.env.FUTURES_ENABLED !== 'false';

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '';

async function tgAlert(msg: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' },
      { timeout: 5_000 }
    );
  } catch {
    // non-fatal
  }
}

async function runSignalCycle(): Promise<void> {
  const capital = await getCapitalState();

  if (capital.dailyStopHit) {
    console.log('[futures] Daily stop hit — no new signals today');
    return;
  }

  const openPos = await getOpenPositions();
  if (openPos.length > 0) {
    console.log(`[futures] ${openPos.length} position(s) open — skipping new entry`);
    return;
  }

  const [macro, signal] = await Promise.all([getMacroState(), getSignal()]);

  // Persist signal to DB
  await query(
    `INSERT INTO futures_signals
       (price, ema21, ema50, rsi14, vol_ratio, signal, signal_str,
        btc_trend, fg_index, macro_ok, macro_score, suggested_usdc, daily_pnl_usdc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      signal.price, signal.ema21, signal.ema50, signal.rsi14, signal.volRatio,
      signal.signal, signal.strength,
      macro.btcTrend, macro.fearGreedIndex, macro.ok, macro.score,
      capital.availableUsdc * 0.02, capital.dailyPnlUsdc,
    ]
  );

  console.log(
    `[futures] signal=${signal.signal}(${signal.strength}) macro=${macro.score}/100 ok=${macro.ok} ` +
    `ema21=${signal.ema21.toFixed(2)} rsi=${signal.rsi14.toFixed(1)}`
  );

  // Gate: macro must be ok AND signal must be strong enough
  if (!macro.ok || macro.score < MIN_MACRO_SCORE) {
    console.log(`[futures] ⚠️ Macro not favorable (score=${macro.score}) — skip`);
    return;
  }

  if (signal.signal === 'FLAT' || signal.strength < MIN_SIGNAL_STR) {
    console.log(`[futures] ⚠️ Signal too weak (${signal.signal}/${signal.strength}) — skip`);
    return;
  }

  const side = signal.signal as 'LONG' | 'SHORT';
  const ps   = calcPositionSize(capital, signal.price, side, signal.strength);

  if (!ps) {
    console.log('[futures] ⚠️ Position sizing blocked (daily stop / max trades)');
    return;
  }

  console.log(`[futures] 🎯 Opening ${side}  size=$${ps.sizeUsdc}  lev=x${ps.leverage}  TP=$${ps.tpPrice}  SL=$${ps.slPrice}`);

  const position = await openPosition(side, signal.price, ps, {
    macroScore:  macro.score,
    signalScore: signal.strength,
    ema21:       signal.ema21,
    ema50:       signal.ema50,
    rsi14:       signal.rsi14,
    volRatio:    signal.volRatio,
  });

  if (!position) return;

  // Update capital: mark funds as in-trade
  await updateCapitalState({
    inTradeUsdc:  capital.inTradeUsdc + ps.sizeUsdc,
    availableUsdc: capital.availableUsdc - ps.sizeUsdc,
    tradesToday:  capital.tradesToday + 1,
  });

  const modeStr = LIVE_MODE === 'live' ? '🔴 LIVE' : '📝 PAPER';
  await tgAlert(
    `<b>🎯 FUTURES ${side} OPENED ${modeStr}</b>\n` +
    `SOL $${signal.price.toFixed(2)}  →  x${ps.leverage} leverage\n` +
    `Size: $${ps.sizeUsdc.toFixed(2)} | Notional: $${ps.notionalUsdc.toFixed(2)}\n` +
    `TP: $${ps.tpPrice.toFixed(2)} (+${(ps.notionalUsdc * 0.04).toFixed(2)})\n` +
    `SL: $${ps.slPrice.toFixed(2)} (-${(ps.notionalUsdc * 0.02).toFixed(2)})\n` +
    `Macro: ${macro.score}/100  Signal: ${signal.strength}/100`
  );
}

async function main(): Promise<void> {
  console.log(`[futures] 🚀 Futures service starting (mode=${LIVE_MODE}, enabled=${FUTURES_ENABLED})`);

  if (!FUTURES_ENABLED) {
    console.log('[futures] FUTURES_ENABLED=false — service idle');
    return;
  }

  // Start fast risk manager (TP/SL/Trail)
  startRiskManager();

  // First signal cycle immediately, then repeat
  await runSignalCycle().catch(console.error);

  setInterval(() => runSignalCycle().catch(console.error), SIGNAL_INTERVAL_MS);

  console.log(`[futures] Signal loop: every ${SIGNAL_INTERVAL_MS / 1000}s`);
}

main();

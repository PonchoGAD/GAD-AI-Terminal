/**
 * Auto-Signal Processor
 *
 * Reads high-score alerts from the scanner and automatically creates
 * autobuy jobs for qualifying tokens. Enforces safety limits:
 *  - MAX_AUTO_POSITIONS: max concurrent open positions
 *  - AUTO_BUY_SOL: SOL per trade
 *  - DAILY_MAX_SOL: max SOL spent per day across all auto-trades
 *  - MIN_SIGNAL_SCORE: minimum alert score to act on
 *  - SIGNAL_COOLDOWN_HOURS: don't rebuy same mint within this window
 *  - MIN_LIQUIDITY_USD: minimum DexScreener liquidity in USD
 *  - MIN_VOLUME_H1_USD: minimum 1h volume in USD
 */

import { query } from '@lib/db';
import axios from 'axios';

// ─── Config ───────────────────────────────────────────────────────────────────

export const AUTO_BUY_ENABLED       = process.env.AUTO_BUY_ENABLED === 'true';
const MAX_AUTO_POSITIONS            = Number(process.env.MAX_AUTO_POSITIONS   || '5');
const AUTO_BUY_SOL                  = Number(process.env.AUTO_BUY_SOL         || '0.05');
const DAILY_MAX_SOL                 = Number(process.env.DAILY_MAX_SOL        || '0.5');
const MIN_SIGNAL_SCORE              = Number(process.env.MIN_SIGNAL_SCORE     || '75');
const SIGNAL_COOLDOWN_HOURS         = Number(process.env.SIGNAL_COOLDOWN_HOURS || '4');

// WHALE_ACTIVITY is excluded — scanner gives score 100 to all pump.fun tokens (false signal)
// Only NEW_HIGH_SCORE is a genuine quality signal (top ~2% by AI score)
const SIGNAL_TYPES = ['NEW_HIGH_SCORE'];

// Minimum DexScreener liquidity and volume before entering a trade
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || '5000');
const MIN_VOLUME_H1_USD = Number(process.env.MIN_VOLUME_H1_USD || '1000');

// Time limit for positions (seconds) — sell 95% if no activity
const TIME_LIMIT_SECONDS = Number(process.env.TIME_LIMIT_SECONDS || '3600');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getDailySpent(): Promise<number> {
  const { rows } = await query<{ spent: string }>(
    `SELECT COALESCE(SUM(total_spent_sol), 0) AS spent
     FROM autobuy_jobs
     WHERE created_at > now() - interval '24 hours'
       AND label LIKE 'auto:%'`
  );
  return Number(rows[0]?.spent ?? 0);
}

async function getActiveAutoPositions(): Promise<number> {
  const { rows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM autobuy_jobs
     WHERE active = true AND label LIKE 'auto:%'`
  );
  return Number(rows[0]?.cnt ?? 0);
}

/** Check DexScreener liquidity/volume — reject low-liquidity rug candidates */
async function checkLiquidity(mint: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5_000 }
    );
    const pairs: any[] = res.data?.pairs ?? [];
    if (!pairs.length) return { ok: false, reason: 'no pairs found on DexScreener' };

    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const liq = best?.liquidity?.usd ?? 0;
    const vol1h = best?.volume?.h1 ?? 0;

    if (liq < MIN_LIQUIDITY_USD) {
      return { ok: false, reason: `liquidity $${liq.toFixed(0)} < min $${MIN_LIQUIDITY_USD}` };
    }
    if (vol1h < MIN_VOLUME_H1_USD) {
      return { ok: false, reason: `1h volume $${vol1h.toFixed(0)} < min $${MIN_VOLUME_H1_USD}` };
    }
    return { ok: true };
  } catch (err: any) {
    // Don't block on DexScreener failures — skip the token
    return { ok: false, reason: `DexScreener API error: ${err.message?.slice(0, 100)}` };
  }
}

/** Was this mint already bought within the cooldown window? */
async function recentlyBought(mint: string): Promise<boolean> {
  const { rows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM autobuy_jobs
     WHERE mint_address = $1
       AND created_at > now() - ($2 || ' hours')::interval`,
    [mint, String(SIGNAL_COOLDOWN_HOURS)]
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

/** Get unprocessed high-score alerts */
async function fetchQualifyingSignals(): Promise<Array<{ id: string; mint: string; score: number; type: string }>> {
  const { rows } = await query<{ id: string; subject: string; score: number; type: string }>(
    `SELECT id, type, subject, score
     FROM alerts
     WHERE type = ANY($1)
       AND score >= $2
       AND auto_trade_processed = false
       AND created_at > now() - interval '20 minutes'
     ORDER BY score DESC, created_at DESC
     LIMIT 5`,
    [SIGNAL_TYPES, MIN_SIGNAL_SCORE]
  );
  return rows.map(r => ({ id: r.id, mint: r.subject, score: r.score, type: r.type }));
}

/** Mark alert as processed so we don't act on it again */
async function markProcessed(alertIds: string[]): Promise<void> {
  if (!alertIds.length) return;
  await query(
    `UPDATE alerts SET auto_trade_processed = true WHERE id = ANY($1)`,
    [alertIds]
  );
}

// ─── Main processor ───────────────────────────────────────────────────────────

export async function processAutoSignals(walletAddress: string): Promise<void> {
  if (!AUTO_BUY_ENABLED) return;
  if (!walletAddress) return;

  // Safety gate 1: daily spend limit
  const dailySpent = await getDailySpent();
  if (dailySpent >= DAILY_MAX_SOL) {
    console.debug(`[auto-signal] Daily limit reached: ${dailySpent.toFixed(4)}/${DAILY_MAX_SOL} SOL`);
    return;
  }

  // Safety gate 2: concurrent position limit
  const activePositions = await getActiveAutoPositions();
  if (activePositions >= MAX_AUTO_POSITIONS) {
    console.debug(`[auto-signal] Max positions reached: ${activePositions}/${MAX_AUTO_POSITIONS}`);
    return;
  }

  const signals = await fetchQualifyingSignals();
  if (!signals.length) return;

  const processed: string[] = [];
  let newJobs = 0;

  for (const signal of signals) {
    if (activePositions + newJobs >= MAX_AUTO_POSITIONS) break;
    if (dailySpent + newJobs * AUTO_BUY_SOL >= DAILY_MAX_SOL) break;

    // Skip if recently bought
    if (await recentlyBought(signal.mint)) {
      processed.push(signal.id);
      continue;
    }

    // Liquidity gate: reject rug-pull candidates with no real volume/liquidity
    const liqCheck = await checkLiquidity(signal.mint);
    if (!liqCheck.ok) {
      console.info(`[auto-signal] ⚠️ Skipping ${signal.mint.slice(0, 8)} — ${liqCheck.reason}`);
      processed.push(signal.id);
      continue;
    }

    // Validate mint address (basic Solana format check)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signal.mint)) {
      console.warn(`[auto-signal] Invalid mint in alert ${signal.id}: ${signal.mint}`);
      processed.push(signal.id);
      continue;
    }

    // Create autobuy job
    try {
      await query(
        `INSERT INTO autobuy_jobs
           (mint_address, label, amount_sol, slippage_bps, interval_seconds,
            wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, true)`,
        [
          signal.mint,
          `auto:${signal.type.toLowerCase()}:score${signal.score}`,
          AUTO_BUY_SOL,
          100,     // 1% slippage
          86400,   // interval 24h (one-time buy — won't repeat for 24h)
          walletAddress,
          TIME_LIMIT_SECONDS,
        ]
      );
      console.info(
        `[auto-signal] ✅ Created buy job for ${signal.mint.slice(0, 8)}... ` +
        `type:${signal.type} score:${signal.score} amount:${AUTO_BUY_SOL}SOL`
      );
      newJobs++;
    } catch (err: any) {
      console.error(`[auto-signal] Failed to create job for ${signal.mint.slice(0, 8)}: ${err.message}`);
    }

    processed.push(signal.id);
  }

  if (processed.length) await markProcessed(processed);
  if (newJobs > 0) {
    console.info(
      `[auto-signal] Created ${newJobs} new job(s). ` +
      `Positions: ${activePositions + newJobs}/${MAX_AUTO_POSITIONS} ` +
      `Daily: ${(dailySpent + newJobs * AUTO_BUY_SOL).toFixed(4)}/${DAILY_MAX_SOL} SOL`
    );
  }
}

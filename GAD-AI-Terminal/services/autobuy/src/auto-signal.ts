/**
 * Auto-Signal Processor
 *
 * Only trades tokens that have GRADUATED from pump.fun (have a Raydium/Orca pool).
 * Pre-graduation pump.fun tokens have no real exit liquidity and are untradeable.
 *
 * Safety gates (in order):
 *  1. Daily spend limit (only actual successful buys count)
 *  2. Concurrent position limit
 *  3. DexScreener: must be on Raydium/Orca (not pump.fun bonding curve)
 *  4. Minimum liquidity $20k
 *  5. Minimum 1h volume $5k
 *  6. Token age >= 2h (avoid newly launched rugs)
 *  7. Price momentum: not in freefall (1h change > -20%)
 *  8. Cooldown: don't rebuy same mint within SIGNAL_COOLDOWN_HOURS
 */

import { query } from '@lib/db';
import axios from 'axios';

// ─── Config ───────────────────────────────────────────────────────────────────

export const AUTO_BUY_ENABLED   = process.env.AUTO_BUY_ENABLED === 'true';
const MAX_AUTO_POSITIONS        = Number(process.env.MAX_AUTO_POSITIONS    || '5');
const AUTO_BUY_SOL              = Number(process.env.AUTO_BUY_SOL          || '0.02');
const DAILY_MAX_SOL             = Number(process.env.DAILY_MAX_SOL         || '0.3');
// 80 = actual max score for NEW_HIGH_SCORE/AI_SCORE_INCREASE signals from the scanner.
// Real quality filtering is done by the DexScreener gate (Raydium, $20k liq, age, momentum).
const MIN_SIGNAL_SCORE          = Number(process.env.MIN_SIGNAL_SCORE      || '80');
const SIGNAL_COOLDOWN_HOURS     = Number(process.env.SIGNAL_COOLDOWN_HOURS || '6');

// Only act on top-quality signals
const SIGNAL_TYPES = ['NEW_HIGH_SCORE', 'AI_SCORE_INCREASE'];

// Minimum liquidity in USD — require $20k+ (only Raydium-graduated tokens)
const MIN_LIQUIDITY_USD  = Number(process.env.MIN_LIQUIDITY_USD  || '20000');
const MIN_VOLUME_H1_USD  = Number(process.env.MIN_VOLUME_H1_USD  || '5000');
// Minimum token age before trading (seconds) — avoid freshly launched rugs
const MIN_TOKEN_AGE_SEC  = Number(process.env.MIN_TOKEN_AGE_SEC  || '7200');  // 2h
// Minimum allowed 1h price change % (stop buying free-falling tokens)
const MIN_PRICE_CHANGE_1H = Number(process.env.MIN_PRICE_CHANGE_1H || '-20');
// Maximum 1h price change — don't buy at the top after a huge pump
const MAX_PRICE_CHANGE_1H = Number(process.env.MAX_PRICE_CHANGE_1H || '150');

// Time limit for positions (seconds) — sell 95% if no activity
const TIME_LIMIT_SECONDS = Number(process.env.TIME_LIMIT_SECONDS || '1800');

// DEX IDs that indicate a real liquidity pool (not pump.fun bonding curve)
const VALID_DEX_IDS = ['raydium', 'orca', 'meteora', 'lifinity', 'saber', 'aldrin'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getDailySpent(): Promise<number> {
  const { rows } = await query<{ spent: string }>(
    `SELECT COALESCE(SUM(amount_sol), 0) AS spent
     FROM autobuy_jobs
     WHERE created_at > now() - interval '24 hours'
       AND label LIKE 'auto:%'
       AND entry_price_sol IS NOT NULL`
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

interface LiqCheck {
  ok: boolean;
  reason?: string;
  dexId?: string;
  liquidityUsd?: number;
  vol1h?: number;
  priceChange1h?: number;
  pairAgeSeconds?: number;
}

/**
 * Full pre-trade validation via DexScreener.
 * Rejects tokens on pump.fun bonding curve — they have no real sell-side liquidity.
 */
async function checkLiquidity(mint: string): Promise<LiqCheck> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 6_000 }
    );
    const pairs: any[] = res.data?.pairs ?? [];
    if (!pairs.length) return { ok: false, reason: 'no pairs on DexScreener' };

    // Sort by liquidity descending, prefer established DEXes
    const sorted = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    // Find best pair on a real DEX (not pump.fun bonding curve)
    const realDexPair = sorted.find(p => VALID_DEX_IDS.includes(p.dexId?.toLowerCase() ?? ''));

    if (!realDexPair) {
      const bestDex = sorted[0]?.dexId ?? 'unknown';
      return { ok: false, reason: `no Raydium/Orca pool — best DEX: ${bestDex} (pump.fun bonding curve only)` };
    }

    const liq          = realDexPair.liquidity?.usd ?? 0;
    const vol1h        = realDexPair.volume?.h1 ?? 0;
    const pc1h         = Number(realDexPair.priceChange?.h1 ?? 0);
    const createdAt    = realDexPair.pairCreatedAt;  // unix ms
    const ageSeconds   = createdAt ? (Date.now() - Number(createdAt)) / 1000 : 0;

    if (liq < MIN_LIQUIDITY_USD) {
      return { ok: false, reason: `liquidity $${liq.toFixed(0)} < min $${MIN_LIQUIDITY_USD}` };
    }
    if (vol1h < MIN_VOLUME_H1_USD) {
      return { ok: false, reason: `1h volume $${vol1h.toFixed(0)} < min $${MIN_VOLUME_H1_USD}` };
    }
    if (ageSeconds > 0 && ageSeconds < MIN_TOKEN_AGE_SEC) {
      const ageMins = (ageSeconds / 60).toFixed(0);
      return { ok: false, reason: `pair only ${ageMins}min old (min ${MIN_TOKEN_AGE_SEC / 60}min)` };
    }
    if (pc1h < MIN_PRICE_CHANGE_1H) {
      return { ok: false, reason: `1h price ${pc1h.toFixed(1)}% < min ${MIN_PRICE_CHANGE_1H}% (freefall)` };
    }
    if (pc1h > MAX_PRICE_CHANGE_1H) {
      return { ok: false, reason: `1h price +${pc1h.toFixed(0)}% > max ${MAX_PRICE_CHANGE_1H}% (already at top)` };
    }

    return {
      ok: true,
      dexId: realDexPair.dexId,
      liquidityUsd: liq,
      vol1h,
      priceChange1h: pc1h,
      pairAgeSeconds: ageSeconds,
    };
  } catch (err: any) {
    return { ok: false, reason: `DexScreener error: ${err.message?.slice(0, 80)}` };
  }
}

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

async function fetchQualifyingSignals(): Promise<Array<{ id: string; mint: string; score: number; type: string }>> {
  const { rows } = await query<{ id: string; subject: string; score: number; type: string }>(
    `SELECT id, type, subject, score
     FROM alerts
     WHERE type = ANY($1)
       AND score >= $2
       AND auto_trade_processed = false
       AND created_at > now() - interval '60 minutes'
     ORDER BY score DESC, created_at DESC
     LIMIT 10`,
    [SIGNAL_TYPES, MIN_SIGNAL_SCORE]
  );
  return rows.map(r => ({ id: r.id, mint: r.subject, score: r.score, type: r.type }));
}

async function markProcessed(alertIds: string[]): Promise<void> {
  if (!alertIds.length) return;
  await query(`UPDATE alerts SET auto_trade_processed = true WHERE id = ANY($1)`, [alertIds]);
}

// ─── Main processor ───────────────────────────────────────────────────────────

export async function processAutoSignals(walletAddress: string): Promise<void> {
  if (!AUTO_BUY_ENABLED) return;
  if (!walletAddress) return;

  const dailySpent = await getDailySpent();
  if (dailySpent >= DAILY_MAX_SOL) {
    console.debug(`[auto-signal] Daily limit reached: ${dailySpent.toFixed(4)}/${DAILY_MAX_SOL} SOL`);
    return;
  }

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

    if (await recentlyBought(signal.mint)) {
      processed.push(signal.id);
      continue;
    }

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signal.mint)) {
      console.warn(`[auto-signal] Invalid mint in alert ${signal.id}: ${signal.mint}`);
      processed.push(signal.id);
      continue;
    }

    const liqCheck = await checkLiquidity(signal.mint);
    if (!liqCheck.ok) {
      console.info(`[auto-signal] ⚠️ Skip ${signal.mint.slice(0, 8)} — ${liqCheck.reason}`);
      processed.push(signal.id);
      continue;
    }

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
          100,
          86400,
          walletAddress,
          TIME_LIMIT_SECONDS,
        ]
      );
      console.info(
        `[auto-signal] ✅ Buy ${signal.mint.slice(0, 8)} ` +
        `score:${signal.score} dex:${liqCheck.dexId} ` +
        `liq:$${liqCheck.liquidityUsd?.toFixed(0)} ` +
        `vol1h:$${liqCheck.vol1h?.toFixed(0)} ` +
        `1h:${liqCheck.priceChange1h?.toFixed(1)}% ` +
        `age:${((liqCheck.pairAgeSeconds ?? 0) / 3600).toFixed(1)}h`
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
      `[auto-signal] Opened ${newJobs} position(s). ` +
      `Active: ${activePositions + newJobs}/${MAX_AUTO_POSITIONS} ` +
      `Daily: ${(dailySpent + newJobs * AUTO_BUY_SOL).toFixed(4)}/${DAILY_MAX_SOL} SOL`
    );
  }
}

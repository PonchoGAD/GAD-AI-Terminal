/**
 * Auto-Signal Processor
 *
 * Two trading tracks:
 *  1. Jupiter track  — Raydium/Orca/Meteora only, $20k+ liq, 30+ min age
 *  2. PumpPortal track — pump.fun/pumpswap/meteoradbc, $3k+ liq, 20+ min age
 *                        Uses PumpPortal Local TX API (pool:"auto") for buy+sell
 *
 * Safety gates (in order):
 *  1. Daily spend limit (only actual successful buys count)
 *  2. Concurrent position limit
 *  3. DexScreener: must be on a routable DEX
 *  4. Minimum liquidity (DEX-dependent)
 *  5. Minimum 1h volume $5k
 *  6. Token age minimum (DEX-dependent)
 *  7. Price momentum: not in freefall (1h change > -20%)
 *  8. Cooldown: don't rebuy same mint within SIGNAL_COOLDOWN_HOURS
 */

import { query } from '@lib/db';
import axios from 'axios';
import { analyzeTrend }   from '@lib/trend';
import { assessLiquidity } from '@lib/liqhealth';
import { detectHype }     from '@lib/hype';
import { detectBotActivity, randomTradeDelay } from '@lib/botshield';

// ─── Config ───────────────────────────────────────────────────────────────────

export const AUTO_BUY_ENABLED   = process.env.AUTO_BUY_ENABLED === 'true';
const MAX_AUTO_POSITIONS        = Number(process.env.MAX_AUTO_POSITIONS    || '5');
const AUTO_BUY_SOL              = Number(process.env.AUTO_BUY_SOL          || '0.02');
const DAILY_MAX_SOL             = Number(process.env.DAILY_MAX_SOL         || '0.3');
// 80 = actual max score for NEW_HIGH_SCORE/AI_SCORE_INCREASE signals from the scanner.
// Real quality filtering is done by the DexScreener gate (Raydium, $20k liq, age, momentum).
const MIN_SIGNAL_SCORE          = Number(process.env.MIN_SIGNAL_SCORE      || '80');
const SIGNAL_COOLDOWN_HOURS     = Number(process.env.SIGNAL_COOLDOWN_HOURS || '48');  // 2-day per-mint cooldown prevents re-buying rugs

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

// Jupiter track: established DEXes with real liquidity pools
const JUPITER_DEX_IDS = ['raydium', 'orca', 'meteora', 'lifinity', 'saber', 'aldrin'];
// PumpPortal track: pump.fun ecosystem DEXes — routed via pool:"auto"
const PUMP_DEX_IDS = ['pumpfun', 'pumpswap', 'meteoradbc', 'fluxbeam'];
const PUMP_PORTAL_ENABLED = process.env.PUMP_PORTAL_ENABLED === 'true';

// Thresholds for pump.fun tokens (lower since bonding curve has different dynamics)
const PUMP_MIN_LIQUIDITY_USD = Number(process.env.PUMP_MIN_LIQUIDITY_USD || '3000');
const PUMP_MIN_TOKEN_AGE_SEC = Number(process.env.PUMP_MIN_TOKEN_AGE_SEC || '1200'); // 20 min

// ─── Birdeye Holder Check ─────────────────────────────────────────────────────
// Min holder count before buying — tokens with <50 holders are whale traps
const BIRDEYE_MIN_HOLDERS = Number(process.env.BIRDEYE_MIN_HOLDERS || '50');
const BIRDEYE_API_KEY     = process.env.BIRDEYE_API_KEY ?? '';

async function checkHolderMomentum(mint: string): Promise<{ ok: boolean; holders?: number; reason?: string }> {
  if (!BIRDEYE_API_KEY) return { ok: true };  // skip if no key configured
  try {
    const r = await axios.get(
      `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
      {
        headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' },
        timeout: 5_000,
      }
    );
    const d = r.data?.data;
    if (!d) return { ok: true };
    const holders = Number(d.holder ?? d.uniqueWallet24h ?? 0);
    if (holders > 0 && holders < BIRDEYE_MIN_HOLDERS) {
      return { ok: false, holders, reason: `only ${holders} holders (min ${BIRDEYE_MIN_HOLDERS})` };
    }
    return { ok: true, holders };
  } catch {
    return { ok: true };  // fail open — don't block trades if Birdeye is down
  }
}

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
  executor?: 'jupiter' | 'pumpportal';
}

/**
 * Full pre-trade validation via DexScreener.
 * Returns which executor to use: 'jupiter' (Raydium/Orca) or 'pumpportal' (pump.fun).
 */
async function checkLiquidity(mint: string): Promise<LiqCheck> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 6_000 }
    );
    const pairs: any[] = res.data?.pairs ?? [];
    if (!pairs.length) return { ok: false, reason: 'no pairs on DexScreener' };

    const sorted = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    // Check Jupiter track first (Raydium/Orca — higher liquidity threshold)
    const jupiterPair = sorted.find(p => JUPITER_DEX_IDS.includes(p.dexId?.toLowerCase() ?? ''));
    if (jupiterPair) {
      const liq       = jupiterPair.liquidity?.usd ?? 0;
      const vol1h     = jupiterPair.volume?.h1 ?? 0;
      const pc1h      = Number(jupiterPair.priceChange?.h1 ?? 0);
      const createdAt = jupiterPair.pairCreatedAt;
      const ageSec    = createdAt ? (Date.now() - Number(createdAt)) / 1000 : 0;

      if (liq < MIN_LIQUIDITY_USD)
        return { ok: false, reason: `liquidity $${liq.toFixed(0)} < min $${MIN_LIQUIDITY_USD}` };
      if (vol1h < MIN_VOLUME_H1_USD)
        return { ok: false, reason: `1h volume $${vol1h.toFixed(0)} < min $${MIN_VOLUME_H1_USD}` };
      if (ageSec > 0 && ageSec < MIN_TOKEN_AGE_SEC)
        return { ok: false, reason: `pair only ${(ageSec / 60).toFixed(0)}min old (min ${MIN_TOKEN_AGE_SEC / 60}min)` };
      if (pc1h < MIN_PRICE_CHANGE_1H)
        return { ok: false, reason: `1h price ${pc1h.toFixed(1)}% < min ${MIN_PRICE_CHANGE_1H}% (freefall)` };
      if (pc1h > MAX_PRICE_CHANGE_1H)
        return { ok: false, reason: `1h price +${pc1h.toFixed(0)}% > max ${MAX_PRICE_CHANGE_1H}% (already at top)` };

      return { ok: true, executor: 'jupiter', dexId: jupiterPair.dexId, liquidityUsd: liq, vol1h, priceChange1h: pc1h, pairAgeSeconds: ageSec };
    }

    // Check PumpPortal track (pump.fun/pumpswap — lower thresholds)
    if (PUMP_PORTAL_ENABLED) {
      const pumpPair = sorted.find(p => PUMP_DEX_IDS.includes(p.dexId?.toLowerCase() ?? ''));
      if (pumpPair) {
        const liq       = pumpPair.liquidity?.usd ?? 0;
        const vol1h     = pumpPair.volume?.h1 ?? 0;
        const pc1h      = Number(pumpPair.priceChange?.h1 ?? 0);
        const createdAt = pumpPair.pairCreatedAt;
        const ageSec    = createdAt ? (Date.now() - Number(createdAt)) / 1000 : 0;

        if (liq < PUMP_MIN_LIQUIDITY_USD)
          return { ok: false, reason: `pump.fun liq $${liq.toFixed(0)} < min $${PUMP_MIN_LIQUIDITY_USD}` };
        if (vol1h < MIN_VOLUME_H1_USD)
          return { ok: false, reason: `1h volume $${vol1h.toFixed(0)} < min $${MIN_VOLUME_H1_USD}` };
        if (ageSec > 0 && ageSec < PUMP_MIN_TOKEN_AGE_SEC)
          return { ok: false, reason: `pump pair only ${(ageSec / 60).toFixed(0)}min old (min ${PUMP_MIN_TOKEN_AGE_SEC / 60}min)` };
        if (pc1h < MIN_PRICE_CHANGE_1H)
          return { ok: false, reason: `1h price ${pc1h.toFixed(1)}% < min ${MIN_PRICE_CHANGE_1H}% (freefall)` };
        if (pc1h > MAX_PRICE_CHANGE_1H)
          return { ok: false, reason: `1h price +${pc1h.toFixed(0)}% > max ${MAX_PRICE_CHANGE_1H}% (already at top)` };

        return { ok: true, executor: 'pumpportal', dexId: pumpPair.dexId, liquidityUsd: liq, vol1h, priceChange1h: pc1h, pairAgeSeconds: ageSec };
      }
    }

    const bestDex = sorted[0]?.dexId ?? 'unknown';
    return { ok: false, reason: `no routable pool — best DEX: ${bestDex}` };
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

// Block tokens we previously lost money on (>20% loss in last 7 days).
// Prevents re-buying rugs or already-crashed tokens after cooldown expires.
async function previouslyLost(mint: string): Promise<boolean> {
  const { rows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM autobuy_jobs
     WHERE mint_address = $1
       AND active = false
       AND amount_sol > 0
       AND total_sold_sol < amount_sol * 0.90
       AND created_at > now() - interval '14 days'`,
    [mint]
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
      const executor = liqCheck.executor ?? 'jupiter';
      const label = `auto:${signal.type.toLowerCase()}:score${signal.score}${executor === 'pumpportal' ? ':pumpportal' : ''}`;
      await query(
        `INSERT INTO autobuy_jobs
           (mint_address, label, amount_sol, slippage_bps, interval_seconds,
            wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, true)`,
        [
          signal.mint,
          label,
          AUTO_BUY_SOL,
          100,
          86400,
          walletAddress,
          TIME_LIMIT_SECONDS,
        ]
      );
      console.info(
        `[auto-signal] ✅ Buy ${signal.mint.slice(0, 8)} via ${executor.toUpperCase()} ` +
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

// ─── Raydium Direct Scanner ────────────────────────────────────────────────────
// Bypass scanner alerts — directly query DexScreener for Raydium/Jupiter pairs.
// Raydium tokens score 40-44 on GAD (never reach 80 alert threshold),
// but they have real liquidity and are tradeable via Jupiter.
// Uses DexScreener (not GeckoTerminal) to avoid rate-limiting scanner's endpoint.

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const GECKO_HEADERS = { 'Accept': 'application/json;version=20230302' };

// Min liquidity for Raydium scan — $8k captures pump.fun graduates (~85 SOL pool ~$12k)
const RAYDIUM_MIN_LIQUIDITY_USD = Number(process.env.RAYDIUM_MIN_LIQUIDITY_USD || '8000');
// Max liquidity — avoid large-cap tokens (slow movers)
const RAYDIUM_MAX_LIQUIDITY_USD = Number(process.env.RAYDIUM_MAX_LIQUIDITY_USD || '500000');
// No separate vol1h floor — Gate 4 vol/liq ratio check is the real stale-pool filter
const RAYDIUM_MIN_VOLUME_H1_USD = Number(process.env.RAYDIUM_MIN_VOLUME_H1_USD || '0');
// Min 1h price change — require positive momentum (5% = significant, filters noise)
const RAYDIUM_MIN_PC1H = Number(process.env.RAYDIUM_MIN_PC1H || '5');
// Max 1h price change — allow strong pumps (pump.fun graduates often 50-100% in first hour)
const RAYDIUM_MAX_PC1H = Number(process.env.RAYDIUM_MAX_PC1H || '100');
// Min 5m price change — require active momentum RIGHT NOW (key entry signal)
const RAYDIUM_MIN_PC5M = Number(process.env.RAYDIUM_MIN_PC5M || '0.5');
// Max token age — 14 days covers "rediscovered" pumpers (tokens sitting flat then getting KOL pump).
// 7 days was still too restrictive: SATX example was 9.4 days old and pumping +28% in 1h.
const RAYDIUM_MAX_AGE_SEC = Number(process.env.RAYDIUM_MAX_AGE_SEC || String(14 * 24 * 3600));
// Min token age — 30min prevents buying in the first minutes of Raydium launch
// Uses own env var, NOT MIN_TOKEN_AGE_SEC (which is 2h for auto-signal strategy)
const RAYDIUM_MIN_AGE_SEC = Number(process.env.RAYDIUM_MIN_AGE_SEC || '1800');
// Min vol/liq ratio — 5% hourly turnover is the stale-pool gate; 10% was too strict in quiet hours
const RAYDIUM_MIN_VOL_LIQ_RATIO = Number(process.env.RAYDIUM_MIN_VOL_LIQ_RATIO || '0.05');

// ─── Adaptive Tier System ─────────────────────────────────────────────────────
// Different liquidity tiers need different strategies:
//  T1 Micro  ($8k–$80k):   pump.fun graduates, explosive, 30min hold, TP1 12%
//  T2 Small  ($80k–$250k): normal memecoin, 30min hold, TP1 12%
//  T3 Mid    ($250k–$500k): steady runner, 30min hold, TP1 12%
export interface LiqTier {
  tier: 1 | 2 | 3;
  label: string;
  timeLimitSec: number;
  stopPct: number;      // stop-loss %
  trailPct: number;     // trailing stop %
  earlyTrailPct: number;
  sellStages: Array<{ stage: number; multiplier: number; sellPct: number }>;
}

export function getLiqTier(liqUsd: number): LiqTier {
  // T1 ($8k-$80k): DISABLED — consistent losses due to high slippage and low stability.
  // Use RAYDIUM_MIN_LIQUIDITY_USD=80000 env var to skip T1 entirely.
  if (liqUsd <= 80000) return {
    tier: 1, label: 't1',
    timeLimitSec: 1800,
    stopPct: 0.08,
    trailPct: 0.12,
    earlyTrailPct: 0.04,
    sellStages: [
      { stage: 1, multiplier: 2.0,  sellPct: 40 },  // take 40% at 2x
      { stage: 2, multiplier: 5.0,  sellPct: 100 }, // rest at 5x
    ],
  };
  // T2 ($80k-$250k): primary target — proven profitable via FeMb (+10.1%).
  // Keep large position for big moves — early trail exits most scenarios cleanly.
  // Staged backup: 2x (30%) → 5x (50%) → 15x (100%)
  if (liqUsd <= 250000) return {
    tier: 2, label: 't2',
    timeLimitSec: 2700,  // 45 min — give more time for the move to develop
    stopPct: 0.08,
    trailPct: 0.12,
    earlyTrailPct: 0.04,  // exit when 4% below peak (was 5%, tighter = faster profit lock)
    sellStages: [
      { stage: 1, multiplier: 2.0,  sellPct: 30 },  // 2x: take only 30% — keep position for moon
      { stage: 2, multiplier: 5.0,  sellPct: 50 },  // 5x: take 50% of remaining (35% original)
      { stage: 3, multiplier: 15.0, sellPct: 100 }, // 15x: sell everything — max capture
    ],
  };
  // T3 ($250k-$500k): steadier runners, tighter trail.
  return {
    tier: 3, label: 't3',
    timeLimitSec: 3600,
    stopPct: 0.07,
    trailPct: 0.12,
    earlyTrailPct: 0.05,
    sellStages: [
      { stage: 1, multiplier: 1.5,  sellPct: 25 },
      { stage: 2, multiplier: 3.0,  sellPct: 50 },
      { stage: 3, multiplier: 8.0,  sellPct: 100 },
    ],
  };
}

// Tokens to skip (SOL, stablecoins, wrapped, known non-memecoins)
const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

// Convert GeckoTerminal pool to DexScreener-like pair format.
// GeckoTerminal doesn't provide m5 data — m5 fields are set to 0.
// Caller must skip m5-based filters when vol.m5 === 0 (no 5m data available).
const GECKO_DEX_MAP: Record<string, string> = {
  'raydium': 'raydium', 'raydium-amm': 'raydium', 'raydium-amm-v4': 'raydium',
  'raydium-clmm': 'raydium', 'raydium-cp': 'raydium', 'raydium-cpmm': 'raydium',
  'orca': 'orca', 'orca-whirlpool': 'orca',
  'meteora': 'meteora', 'meteora-dlmm': 'meteora', 'meteora-dbc': 'meteora',
  'lifinity': 'lifinity', 'lifinity-v2': 'lifinity',
};

function geckoPoolToPair(pool: any): any | null {
  const tokenId: string = pool.relationships?.base_token?.data?.id ?? '';
  const parts = tokenId.split('_');
  if (parts.length !== 2) return null;
  const mint = parts[1];
  const attrs = pool.attributes ?? {};

  // Filter to only supported Jupiter-tradeable DEXes; skip pump.fun, fluxbeam, etc.
  const geckoDexId: string = (pool.relationships?.dex?.data?.id ?? '').toLowerCase();
  const dexId = GECKO_DEX_MAP[geckoDexId];
  if (!dexId) return null;

  return {
    baseToken: { address: mint, symbol: attrs.name ?? '' },
    dexId,
    chainId: 'solana',
    liquidity: { usd: Number(attrs.reserve_in_usd ?? 0) },
    volume: {
      m5: 0,   // Not available in GeckoTerminal — skip m5 acceleration filter for these pairs
      h1: Number(attrs.volume_usd?.h1 ?? 0),
      h24: Number(attrs.volume_usd?.h24 ?? 0),
    },
    priceChange: {
      m5: 0,   // Not available in GeckoTerminal
      h1: Number(attrs.price_change_percentage?.h1 ?? 0),
      h6: Number(attrs.price_change_percentage?.h6 ?? 0),
    },
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: {
        buys: attrs.transactions?.h1?.buys ?? 0,
        sells: attrs.transactions?.h1?.sells ?? 0,
      },
    },
    pairCreatedAt: attrs.pool_created_at ? new Date(attrs.pool_created_at).getTime() : null,
  };
}

// Run at most once per RAYDIUM_SCAN_INTERVAL_MS (120s to avoid rate limits)
let lastRaydiumScan = 0;
const RAYDIUM_SCAN_INTERVAL_MS = 120_000;

// ─── Fetch pairs from multiple sources ────────────────────────────────────────
// Sources ordered by signal quality (most actionable first):
//  1. DexScreener gainers     — tokens already moving UP now (highest signal)
//  2. DexScreener new pairs   — fresh Raydium pools ($20k-$500k liq tier)
//  3. DexScreener boosted     — promoted tokens with active community
//  4. DexScreener profiles    — new tokens getting first attention
//  5. Jupiter trending        — tokens with high Jupiter swap volume (= real trading)

async function fetchTokenPairs(mintAddress: string): Promise<any | null> {
  try {
    const r = await axios.get(`${DEXSCREENER_BASE}/tokens/${mintAddress}`, { timeout: 5_000 });
    const pairs: any[] = r.data?.pairs ?? [];
    return pairs
      .filter(x => JUPITER_DEX_IDS.includes(x.dexId?.toLowerCase() ?? '') && x.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
  } catch { return null; }
}

async function fetchRaydiumPairs(): Promise<any[]> {
  const seen = new Set<string>();
  const results: any[] = [];

  // Source 1: GeckoTerminal trending pools pages 2-4.
  // Page 1 is already consumed by the scanner service — we use pages 2-4 to avoid collision.
  // trending_pools = sorted by vol/liq momentum score = high-signal actionable entries.
  // geckoPoolToPair() filters to Raydium/Orca/Meteora/Lifinity only; skips pump.fun etc.
  let geckoCount = 0;
  for (let page = 2; page <= 4; page++) {
    try {
      const r = await axios.get(
        `${GECKO_BASE}/networks/solana/trending_pools?page=${page}&include=base_token,dex`,
        { headers: GECKO_HEADERS, timeout: 8_000 }
      );
      const pools: any[] = r.data?.data ?? [];
      for (const pool of pools) {
        const pair = geckoPoolToPair(pool);
        if (!pair) continue;
        const mint = pair.baseToken?.address;
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        results.push(pair);
        geckoCount++;
      }
      // 400ms between pages to avoid burst rate limit with scanner service
      await new Promise(r => setTimeout(r, 400));
    } catch (e: any) {
      const status = (e as any).response?.status ?? (e as any).code;
      console.debug(`[raydium-scan] GeckoTerminal trending page ${page}: ${status ?? (e as any).message?.slice(0, 30)}`);
      break;
    }
  }
  if (geckoCount > 0) {
    console.debug(`[raydium-scan] GeckoTerminal trending p2-4: ${geckoCount} Raydium/Orca pairs`);
  }

  // Source 2: DexScreener token-boosts endpoint — recently promoted Solana tokens.
  // These tokens have active communities paying for boosts = current hype = momentum trades.
  // After fetching boost list, look up each token's Raydium pair for full data.
  try {
    const boostR = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1', { timeout: 6_000 });
    const boosts: any[] = Array.isArray(boostR.data) ? boostR.data : (boostR.data?.data ?? []);
    const solMints = boosts
      .filter(b => b.chainId === 'solana' && b.tokenAddress)
      .map(b => b.tokenAddress as string)
      .filter(m => !seen.has(m))
      .slice(0, 20); // cap at 20 to avoid too many API calls
    if (solMints.length > 0) {
      // Batch fetch pairs for all boosted tokens in one call
      const pairR = await axios.get(
        `${DEXSCREENER_BASE}/tokens/${solMints.join(',')}`,
        { timeout: 8_000 }
      );
      const pairs: any[] = pairR.data?.pairs ?? [];
      let added = 0;
      for (const p of pairs) {
        if (p.chainId !== 'solana') continue;
        if (!JUPITER_DEX_IDS.includes(p.dexId?.toLowerCase() ?? '')) continue;
        const mint = p.baseToken?.address;
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        results.push(p);
        added++;
      }
      if (added > 0) console.debug(`[raydium-scan] DexScreener boosts: ${added} Raydium pairs from ${solMints.length} boosted tokens`);
    }
  } catch (e: any) {
    console.debug(`[raydium-scan] boosts error: ${(e as any).message?.slice(0, 40)}`);
  }

  const dxCount = results.length - geckoCount;
  console.debug(`[raydium-scan] total: ${results.length} unique candidates (${geckoCount} gecko + ${dxCount} boosts)`);
  return results;
}

export async function processRaydiumOpportunities(walletAddress: string): Promise<void> {
  if (!AUTO_BUY_ENABLED || !walletAddress) return;

  const now = Date.now();
  if (now - lastRaydiumScan < RAYDIUM_SCAN_INTERVAL_MS) return;
  lastRaydiumScan = now;

  const dailySpent = await getDailySpent();
  if (dailySpent >= DAILY_MAX_SOL) return;

  const activePositions = await getActiveAutoPositions();
  if (activePositions >= MAX_AUTO_POSITIONS) return;

  let pairs: any[] = [];
  try {
    pairs = await fetchRaydiumPairs();
  } catch (err: any) {
    console.debug(`[raydium-scan] Fetch failed: ${err.message?.slice(0, 60)}`);
    return;
  }

  console.info(`[raydium-scan] 🔍 Scanning ${pairs.length} pairs | Active: ${activePositions}/${MAX_AUTO_POSITIONS} | Daily: ${dailySpent.toFixed(4)}/${DAILY_MAX_SOL} SOL`);

  // Deduplicate by mint AND by normalized symbol (prevent buying 3 "SpaceX" variants)
  const seenMints = new Set<string>();
  const seenSymbols = new Set<string>();
  const uniquePairs: any[] = [];
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    const sym = (p.baseToken?.symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!mint || seenMints.has(mint)) continue;
    if (sym && seenSymbols.has(sym)) continue;
    seenMints.add(mint);
    if (sym) seenSymbols.add(sym);
    uniquePairs.push(p);
  }

  let newJobs = 0;
  let skipped = { liq: 0, age: 0, momentum: 0, vol: 0, cooldown: 0, known: 0, trend: 0, hype: 0, liqH: 0, bot: 0, holder: 0 };

  for (const pair of uniquePairs) {
    if (activePositions + newJobs >= MAX_AUTO_POSITIONS) break;
    if (dailySpent + newJobs * AUTO_BUY_SOL >= DAILY_MAX_SOL) break;

    // DexScreener pair structure
    const liq    = pair.liquidity?.usd ?? 0;
    const vol1h  = pair.volume?.h1 ?? 0;
    const vol5m  = pair.volume?.m5 ?? 0;
    const vol24h = pair.volume?.h24 ?? 0;
    const pc1h   = Number(pair.priceChange?.h1  ?? 0);
    const pc5m   = Number(pair.priceChange?.m5  ?? 0);
    const pc6h   = Number(pair.priceChange?.h6  ?? 0);
    const createdAt = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : 0;
    const ageSec = createdAt > 0 ? (now - createdAt) / 1000 : 999999;
    const mint   = pair.baseToken?.address ?? '';

    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) continue;
    if (SKIP_MINTS.has(mint)) { skipped.known++; continue; }

    const sym = pair.baseToken?.symbol ?? mint.slice(0, 8);

    // ── Gate 1: Liquidity / volume basics ──
    if (liq < RAYDIUM_MIN_LIQUIDITY_USD || liq > RAYDIUM_MAX_LIQUIDITY_USD || vol1h < RAYDIUM_MIN_VOLUME_H1_USD) {
      console.debug(`[raydium-scan] ✗liq  ${sym.padEnd(10)} liq:$${liq.toFixed(0)} vol1h:$${vol1h.toFixed(0)} pc1h:${pc1h.toFixed(1)}%`);
      skipped.liq++; continue;
    }

    // ── Gate 2: Age ──
    if (ageSec > 0 && (ageSec < RAYDIUM_MIN_AGE_SEC || ageSec > RAYDIUM_MAX_AGE_SEC)) {
      console.debug(`[raydium-scan] ✗age  ${sym.padEnd(10)} age:${(ageSec/3600).toFixed(1)}h liq:$${liq.toFixed(0)} pc1h:${pc1h.toFixed(1)}%`);
      skipped.age++; continue;
    }

    // ── Gate 3: momentum ──
    // Skip pc5m check when vol5m=0 (GeckoTerminal source has no m5 data).
    // pc1h and pc6h are always available.
    if (vol5m > 0 && pc5m < RAYDIUM_MIN_PC5M) {
      console.debug(`[raydium-scan] ✗mom  ${sym.padEnd(10)} pc5m:${pc5m.toFixed(1)}% liq:$${liq.toFixed(0)} pc1h:${pc1h.toFixed(1)}%`);
      skipped.momentum++; continue;
    }
    if (pc1h < RAYDIUM_MIN_PC1H || pc1h > RAYDIUM_MAX_PC1H) {
      console.debug(`[raydium-scan] ✗mom  ${sym.padEnd(10)} pc1h:${pc1h.toFixed(1)}% liq:$${liq.toFixed(0)}`);
      skipped.momentum++; continue;
    }

    // ── MAYHEM MODE filter: skip tokens in violent pump/dump phase ──
    // pc5m > 50% = already in blow-off top, likely about to dump hard
    // pc5m < -20% = already crashing, don't catch the falling knife
    if (vol5m > 0 && (pc5m > 50 || pc5m < -20)) {
      console.debug(`[raydium-scan] ✗mayhem ${sym.padEnd(10)} pc5m:${pc5m.toFixed(1)}% (MAYHEM MODE — skip)`);
      skipped.hype++; continue;
    }

    // ── Gate 3b: Buy/sell ratio — require net buying pressure ──
    // If 20%+ more sellers than buyers in the last hour: distribution phase, skip.
    // Only apply when we have real txn data (buys > 0). GeckoTerminal always has this.
    const buys1h = (pair.txns?.h1?.buys ?? 0) as number;
    const sells1h = (pair.txns?.h1?.sells ?? 0) as number;
    if (buys1h > 0 && sells1h > buys1h * 1.2) {
      console.debug(`[raydium-scan] ✗sell ${sym.padEnd(10)} buys:${buys1h} sells:${sells1h} (distribution)`);
      skipped.momentum++; continue;
    }

    // For tokens older than 6h, require positive 6h trend — don't buy downtrends.
    // Fresh tokens (<6h) may not have meaningful 6h data yet.
    if (ageSec > 6 * 3600 && pc6h <= 0) {
      console.debug(`[raydium-scan] ✗trend ${sym.padEnd(10)} pc6h:${pc6h.toFixed(1)}% age:${(ageSec/3600).toFixed(1)}h liq:$${liq.toFixed(0)}`);
      skipped.momentum++; continue;
    }
    if (pc6h < -15) { skipped.momentum++; continue; }

    // ── Gate 4: Volume quality ──
    // vol/liq ratio > 10% = real trading activity
    // vol acceleration check only when 5m data is available (vol5m > 0).
    // Without m5 data, vol5m*12 < vol1h*0.25 always triggers (0 < anything) — false positive.
    if (liq > 0 && vol1h / liq < RAYDIUM_MIN_VOL_LIQ_RATIO) {
      console.debug(`[raydium-scan] ✗ratio ${sym.padEnd(10)} vol/liq:${(vol1h/liq*100).toFixed(1)}% vol1h:$${vol1h.toFixed(0)} liq:$${liq.toFixed(0)}`);
      skipped.vol++; continue;
    }
    if (vol5m > 0 && vol1h > 0 && vol5m * 12 < vol1h * 0.25) { skipped.vol++; continue; }

    if (await recentlyBought(mint)) { skipped.cooldown++; continue; }
    if (await previouslyLost(mint)) { skipped.cooldown++; console.debug(`[raydium-scan] ♻️ Skip ${mint.slice(0,8)} — previously lost on this token (7-day blacklist)`); continue; }

    // ── Multi-module signal validation ──
    const trend = analyzeTrend(pair);
    if (trend.signal === 'SELL' || trend.stage === 'DEAD') { skipped.trend++; continue; }

    const hype = detectHype(pair);
    if (hype.exit_signal && !hype.entry_window) { skipped.hype++; continue; }

    const liqHealth = assessLiquidity(pair, 60, AUTO_BUY_SOL);
    if (liqHealth.auto_exit || liqHealth.rug_risk >= 60) { skipped.liqH++; continue; }

    const shield = detectBotActivity(pair);
    if (!shield.safe_to_trade) { skipped.bot++; continue; }

    // Apply bot-shield random delay before entry
    if (shield.recommended_delay > 0) {
      await randomTradeDelay(0, shield.recommended_delay * 1000);
    }

    // ── Gate 5: Birdeye holder momentum ──
    const holderCheck = await checkHolderMomentum(mint);
    if (!holderCheck.ok) {
      skipped.holder++;
      console.info(`[raydium-scan] ⚠️ Skip ${mint.slice(0, 8)} — ${holderCheck.reason}`);
      continue;
    }

    const slippage = shield.slippage_bps;
    console.info(
      `[raydium-scan] 🟢 PASS ${pair.baseToken?.symbol ?? mint.slice(0,8)} (${mint.slice(0,8)}) ` +
      `liq:$${liq.toFixed(0)} vol1h:$${vol1h.toFixed(0)} pc1h:${pc1h.toFixed(1)}% pc6h:${pc6h.toFixed(1)}% ` +
      `buys:${buys1h} sells:${sells1h} age:${(ageSec/3600).toFixed(1)}h`
    );

    try {
      const isFresh = ageSec < 6 * 3600;
      const ageTag = isFresh ? `fresh${Math.round(ageSec / 3600)}h` : `aged`;
      const tier = getLiqTier(liq);
      const label = `auto:raydium_scan:liq${Math.round(liq / 1000)}k:${ageTag}:${tier.label}`;
      await query(
        `INSERT INTO autobuy_jobs
           (mint_address, label, amount_sol, slippage_bps, interval_seconds,
            wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, true)`,
        [
          mint,
          label,
          AUTO_BUY_SOL,
          slippage,
          86400,
          walletAddress,
          tier.timeLimitSec,  // tier-specific hold time
        ]
      );
      console.info(
        `[raydium-scan] ✅ Buy ${pair.baseToken?.symbol ?? mint.slice(0,8)} (${mint.slice(0,8)}) ` +
        `[TIER${tier.tier} ${tier.timeLimitSec/60}min/${(tier.stopPct*100).toFixed(0)}%stop] ` +
        `dex:${pair.dexId} liq:$${liq.toFixed(0)} vol1h:$${vol1h.toFixed(0)} ` +
        `5m:${pc5m.toFixed(1)}% 1h:${pc1h.toFixed(1)}% age:${(ageSec/3600).toFixed(1)}h ` +
        `holders:${holderCheck.holders ?? 'n/a'} ` +
        `trend:${trend.stage} hype:${hype.hype_stage}(${hype.hype_score}) slip:${slippage}bps`
      );
      newJobs++;
    } catch (err: any) {
      console.error(`[raydium-scan] Failed to create job for ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  if (newJobs > 0) {
    console.info(
      `[raydium-scan] Opened ${newJobs} position(s). ` +
      `Active: ${activePositions + newJobs}/${MAX_AUTO_POSITIONS} ` +
      `Daily: ${(dailySpent + newJobs * AUTO_BUY_SOL).toFixed(4)}/${DAILY_MAX_SOL} SOL`
    );
  } else {
    console.info(
      `[raydium-scan] ❌ No entries — liq=${skipped.liq} age=${skipped.age} mom=${skipped.momentum} ratio=${skipped.vol} cooldown=${skipped.cooldown} known=${skipped.known} trend=${skipped.trend} hype=${skipped.hype} liqH=${skipped.liqH} bot=${skipped.bot} holders=${skipped.holder}`
    );
  }
}

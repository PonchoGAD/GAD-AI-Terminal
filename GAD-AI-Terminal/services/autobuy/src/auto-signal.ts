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

// Jupiter track: ONLY true Raydium/Orca/Meteora — pumpswap REMOVED.
// pump.fun graduates to pumpswap NOT raydium — Jupiter buy for pumpswap tokens
// causes zero-balance errors (0 tokens received). Must go PumpPortal or be skipped.
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

// ─── Top Holder Check (Rug Protection) ───────────────────────────────────────
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const TOP_HOLDER_RUG_PCT = Number(process.env.TOP_HOLDER_RUG_PCT || '50');

async function checkTopHolder(mint: string): Promise<number> {
  try {
    const resp = await axios.post(SOLANA_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'getTokenLargestAccounts',
      params: [mint, { commitment: 'confirmed' }],
    }, { timeout: 4_000 });
    const accounts: any[] = resp.data?.result?.value ?? [];
    if (accounts.length < 2) return 0;
    const top = Number(accounts[0].uiAmount ?? accounts[0].amount ?? 0);
    const total = accounts.reduce((s: number, a: any) => s + Number(a.uiAmount ?? a.amount ?? 0), 0);
    if (total <= 0) return 0;
    return (top / total) * 100;
  } catch {
    return 0; // fail-open: allow buy if RPC unavailable
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
       AND entry_price_sol IS NOT NULL
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

// ─── Market Regime Auto-Detection ────────────────────────────────────────────
// Fear & Greed index from Alternative.me. Cached 30 min.
// EXTREME_FEAR (<13): PAUSE all buys — true capitulation/black swan only
// FEAR (13-45):       STRICT mode — require strong pc1h, small positions (contrarian buy zone)
// NEUTRAL (45-60):    NORMAL mode — standard filters
// GREED (60-80):      BULL mode — lower TP targets, larger positions allowed
// EXTREME_GREED(>80): CAUTION — euphoria = top risk, tighten stops

let cachedFearGreed = 50;
let fgLastFetch = 0;

export async function getFearGreed(): Promise<number> {
  if (Date.now() - fgLastFetch < 30 * 60 * 1000) return cachedFearGreed;
  try {
    const r = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
    const val = Number(r.data?.data?.[0]?.value ?? 50);
    cachedFearGreed = val;
    fgLastFetch = Date.now();
    console.info(`[raydium-scan] 📊 Fear&Greed updated: ${val}`);
  } catch { }
  return cachedFearGreed;
}

// Returns market regime string based on F&G + manual override
export async function getMarketRegime(): Promise<string> {
  const override = (process.env.MARKET_REGIME ?? '').toUpperCase();
  if (override && override !== 'AUTO') return override;
  const fg = await getFearGreed();
  if (fg < 13) return 'EXTREME_FEAR';
  if (fg < 45) return 'FEAR';
  if (fg < 60) return 'NEUTRAL';
  if (fg < 80) return 'BULL';
  return 'EUPHORIA';
}

// ─── Raydium Direct Scanner ────────────────────────────────────────────────────
// Bypass scanner alerts — directly query DexScreener for Raydium/Jupiter pairs.
// Raydium tokens score 40-44 on GAD (never reach 80 alert threshold),
// but they have real liquidity and are tradeable via Jupiter.
// Uses DexScreener (not GeckoTerminal) to avoid rate-limiting scanner's endpoint.

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const GECKO_HEADERS = { 'Accept': 'application/json;version=20230302' };

// Min liquidity — raised to $30k based on 7-day audit (37 wins, 101 real buys).
// Avg liq of winning trades = $34k. Tokens $12-25k cause stop-loss slippage of -16.7%
// even with -8% programmatic stop (thin pool moves price on our own 0.02 SOL sell).
// $30k floor = dev buy ~1.0+ SOL, real skin in the game, enough depth for exit.
const RAYDIUM_MIN_LIQUIDITY_USD = Number(process.env.RAYDIUM_MIN_LIQUIDITY_USD || '30000');
// Max liquidity — avoid large-cap tokens (slow movers)
// T2 ($80k+) has 0% win rate across 79-trade audit — default excludes T2/T3.
// Override in .env: RAYDIUM_MAX_LIQUIDITY_USD=250000 to allow T2 after backtesting.
const RAYDIUM_MAX_LIQUIDITY_USD = Number(process.env.RAYDIUM_MAX_LIQUIDITY_USD || '80000');
// No separate vol1h floor — Gate 4 vol/liq ratio check is the real stale-pool filter
const RAYDIUM_MIN_VOLUME_H1_USD = Number(process.env.RAYDIUM_MIN_VOLUME_H1_USD || '0');
// Min 1h price change — real pump.fun winners show 0.5-20% in 1h at optimal entry
const RAYDIUM_MIN_PC1H = Number(process.env.RAYDIUM_MIN_PC1H || '1');
// Max 1h price change — tokens up >45% in 1h are near blow-off top, late entry
const RAYDIUM_MAX_PC1H = Number(process.env.RAYDIUM_MAX_PC1H || '45');
// Min 5m price change — require active momentum RIGHT NOW (key entry signal)
const RAYDIUM_MIN_PC5M = Number(process.env.RAYDIUM_MIN_PC5M || '1.5');
// Max token age — 48h: memecoins that haven't pumped in 2 days are usually dead
const RAYDIUM_MAX_AGE_SEC = Number(process.env.RAYDIUM_MAX_AGE_SEC || String(2 * 24 * 3600));
// Min token age — 30min prevents buying in the first minutes of Raydium launch
const RAYDIUM_MIN_AGE_SEC = Number(process.env.RAYDIUM_MIN_AGE_SEC || '1800');
// Min vol/liq ratio — 8% hourly turnover (from analysis: winners avg vol/mcap=6.5x in 24h)
const RAYDIUM_MIN_VOL_LIQ_RATIO = Number(process.env.RAYDIUM_MIN_VOL_LIQ_RATIO || '0.08');
// Max buy/sell ratio — >3.5x = likely wash trading or pump already completed.
// From analysis: Gaejuki 5.82x B/S + price -76% = pump&dump. RESERVE 5.7x → distribution next hour.
// Healthy accumulation: 1.2-1.8x (Merlin 1.26x +899%, trelon 1.23x +871%, Trilly 1.49x +559%).
const RAYDIUM_MAX_BUY_SELL_RATIO = Number(process.env.RAYDIUM_MAX_BUY_SELL_RATIO || '3.5');

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

export function getLiqTier(liqUsd: number, regime = 'NEUTRAL'): LiqTier {
  // TP strategy — 5 stages: sell equal ~20% portions of position at each level.
  // sellPct is % of REMAINING tokens at that stage, so to sell 20% of original each time:
  //   Stage 1: 20% of 100% = sell 20 → 80 left
  //   Stage 2: 25% of 80%  = sell 20 → 60 left
  //   Stage 3: 33% of 60%  = sell 20 → 40 left
  //   Stage 4: 50% of 40%  = sell 20 → 20 left (moon bag)
  //   Stage 5: 999x = moon bag placeholder — exits via trailing stop
  //
  // Breakeven stop: fires in scheduler when sell_stage_reached >= 1 (stop moved to entry)
  // earlyTrailPct: fires BEFORE TP1 when peak drops earlyTrailPct% AND trail > entry × 1.04
  const r = regime.toUpperCase();
  const isFear = r === 'FEAR' || r === 'EXTREME_FEAR';
  const isBull = r === 'BULL' || r === 'EUPHORIA';

  // T1: pump.fun graduates ($12k–$80k liq) — volatile, fast movers
  // FEAR: 3-stage — TP1 takes 60% at +15% to lock majority. After TP1 stop→entry (breakeven).
  //   TP1: 60% at 1.15x → lock big win immediately
  //   TP2: 50% of remaining (=20% original) at 1.45x → bonus
  //   TP3: 100% of remaining (=20% original) at 2.00x → moon bag
  if (liqUsd <= 80000) return {
    tier: 1, label: 't1',
    timeLimitSec: 0,
    stopPct: isFear ? 0.08 : 0.07,
    trailPct: isFear ? 0.15 : 0.18,
    earlyTrailPct: isFear ? 0.035 : 0.045,
    sellStages: [
      // FEAR TP1 raised 1.15→1.22: avg win on T1 FEAR = 1.22x, 1.15 fires too early on noise
      { stage: 1, multiplier: isBull ? 1.15 : isFear ? 1.22 : 1.12, sellPct: isFear ? 60 : 20 },
      { stage: 2, multiplier: isBull ? 1.35 : isFear ? 1.48 : 1.28, sellPct: isFear ? 50 : 25 },
      { stage: 3, multiplier: isBull ? 1.65 : isFear ? 2.00 : 1.55, sellPct: isFear ? 100 : 33 },
      { stage: 4, multiplier: isBull ? 2.30 : isFear ? 999  : 2.00, sellPct: 50 },
      { stage: 5, multiplier: 999, sellPct: 100 },
    ],
  };

  // T2: small-cap memecoins ($80k–$250k liq) — steadier movers
  // FEAR: same 3-stage approach with tighter targets (higher liq = harder to pump)
  if (liqUsd <= 250000) return {
    tier: 2, label: 't2',
    timeLimitSec: 0,
    stopPct: isFear ? 0.07 : 0.06,
    trailPct: 0.15,
    earlyTrailPct: isFear ? 0.03 : 0.04,
    sellStages: [
      // FEAR TP1 raised 1.12→1.20: T2 avg win = 1.25x (when profitable), 1.12 fired too soon
      { stage: 1, multiplier: isBull ? 1.12 : isFear ? 1.20 : 1.10, sellPct: isFear ? 60 : 20 },
      { stage: 2, multiplier: isBull ? 1.30 : isFear ? 1.38 : 1.23, sellPct: isFear ? 50 : 25 },
      { stage: 3, multiplier: isBull ? 1.55 : isFear ? 1.65 : 1.46, sellPct: isFear ? 100 : 33 },
      { stage: 4, multiplier: isBull ? 2.10 : isFear ? 999  : 1.85, sellPct: 50 },
      { stage: 5, multiplier: 999, sellPct: 100 },
    ],
  };

  // T3: mid-cap tokens ($250k+ liq) — slower, more predictable
  // FEAR: 3-stage with conservative targets
  return {
    tier: 3, label: 't3',
    timeLimitSec: 0,
    stopPct: isFear ? 0.06 : 0.05,
    trailPct: 0.12,
    earlyTrailPct: isFear ? 0.025 : 0.035,
    sellStages: [
      { stage: 1, multiplier: isBull ? 1.10 : isFear ? 1.10 : 1.08, sellPct: isFear ? 60 : 20 },
      { stage: 2, multiplier: isBull ? 1.22 : isFear ? 1.25 : 1.18, sellPct: isFear ? 50 : 25 },
      { stage: 3, multiplier: isBull ? 1.40 : isFear ? 1.50 : 1.33, sellPct: isFear ? 100 : 33 },
      { stage: 4, multiplier: isBull ? 1.80 : isFear ? 999  : 1.65, sellPct: 50 },
      { stage: 5, multiplier: 999, sellPct: 100 },
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

  // Source 0: DexScreener direct Raydium pairs endpoint — actual live Raydium market.
  // Returns active pairs sorted by volume. Highest signal quality: real trading happening NOW.
  // This replaces relying purely on keyword searches which return stale indexed tokens.
  try {
    const rayR = await axios.get(
      'https://api.dexscreener.com/latest/dex/pairs/solana/raydium?sort=volume&order=desc',
      { timeout: 7_000 }
    );
    const pairs: any[] = rayR.data?.pairs ?? [];
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
    if (added > 0) console.debug(`[raydium-scan] Direct Raydium endpoint: ${added} active pairs`);
  } catch (e: any) {
    console.debug(`[raydium-scan] Direct Raydium endpoint error: ${e.message?.slice(0, 40)}`);
  }

  const raydiumDexCount = results.length;

  // Source 1: DexScreener token-profiles/latest — freshly launched tokens with community profiles.
  // These are brand-new tokens someone just added a profile for — high community engagement signal.
  try {
    const profR = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 6_000 });
    const profiles: any[] = Array.isArray(profR.data) ? profR.data : [];
    const solMints = profiles
      .filter((p: any) => p.chainId === 'solana' && p.tokenAddress)
      .map((p: any) => p.tokenAddress as string)
      .filter((m: string) => !seen.has(m))
      .slice(0, 30);
    if (solMints.length > 0) {
      const pairR = await axios.get(`${DEXSCREENER_BASE}/tokens/${solMints.join(',')}`, { timeout: 8_000 });
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
      if (added > 0) console.debug(`[raydium-scan] DexScreener token-profiles: ${added} Raydium pairs from ${solMints.length} new tokens`);
    }
  } catch (e: any) {
    console.debug(`[raydium-scan] token-profiles error: ${(e as any).message?.slice(0, 40)}`);
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

  // Source 3: DexScreener top-boosts (highest total boost amount — different from latest)
  try {
    const topR = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 6_000 });
    const tops: any[] = Array.isArray(topR.data) ? topR.data : (topR.data?.data ?? []);
    const topMints = tops
      .filter((b: any) => b.chainId === 'solana' && b.tokenAddress)
      .map((b: any) => b.tokenAddress as string)
      .filter((m: string) => !seen.has(m))
      .slice(0, 20);
    if (topMints.length > 0) {
      const pairR = await axios.get(`${DEXSCREENER_BASE}/tokens/${topMints.join(',')}`, { timeout: 8_000 });
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
      if (added > 0) console.debug(`[raydium-scan] DexScreener top-boosts: ${added} pairs`);
    }
  } catch (e: any) {
    console.debug(`[raydium-scan] top-boosts error: ${(e as any).message?.slice(0, 40)}`);
  }

  // Source 4: DexScreener search queries — fresh active Solana tokens right now
  // PumpSwap and graduation-focused queries to catch recently graduated pump.fun tokens.
  // Avoid narrative keywords (dog/cat/pepe) — those return ancient established tokens.
  const SEARCH_QUERIES = ['pumpswap sol', 'pump graduate', 'new raydium sol', 'sol gem new', 'raydium launch', 'sol meme new', 'pumpswap new', 'sol new token'];
  for (const q of SEARCH_QUERIES) {
    try {
      const sr = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { timeout: 6_000 }
      );
      const pairs: any[] = sr.data?.pairs ?? [];
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
      if (added > 0) console.debug(`[raydium-scan] DexScreener search "${q}": ${added} pairs`);
      await new Promise(r => setTimeout(r, 300));
    } catch (e: any) {
      console.debug(`[raydium-scan] search "${q}" error: ${(e as any).message?.slice(0, 30)}`);
    }
  }

  // Source 5: Birdeye trending tokens — high-volume Solana tokens with real momentum.
  // Uses the same BIRDEYE_API_KEY as holder checks. Skip if no key configured.
  if (BIRDEYE_API_KEY) {
    try {
      const birdR = await axios.get(
        'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20&min_liquidity=5000',
        {
          headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' },
          timeout: 6_000,
        }
      );
      const birdTokens: any[] = birdR.data?.data?.tokens ?? birdR.data?.data ?? [];
      const birdMints: string[] = birdTokens
        .filter((t: any) => t.address && !seen.has(t.address))
        .map((t: any) => t.address as string)
        .slice(0, 20);

      if (birdMints.length > 0) {
        const chunks: string[][] = [];
        for (let i = 0; i < birdMints.length; i += 10) chunks.push(birdMints.slice(i, i + 10));
        let birdAdded = 0;
        for (const chunk of chunks) {
          try {
            const pr = await axios.get(
              `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
              { timeout: 6_000 }
            );
            const pairs: any[] = pr.data?.pairs ?? [];
            for (const p of pairs) {
              if (p.chainId !== 'solana') continue;
              if (!JUPITER_DEX_IDS.includes(p.dexId?.toLowerCase() ?? '')) continue;
              const mint = p.baseToken?.address;
              if (!mint || seen.has(mint)) continue;
              seen.add(mint);
              results.push(p);
              birdAdded++;
            }
            await new Promise(r => setTimeout(r, 300));
          } catch { /* skip chunk */ }
        }
        if (birdAdded > 0) console.debug(`[raydium-scan] Birdeye trending: ${birdAdded} new Raydium pairs`);
      }
    } catch (e: any) {
      console.debug(`[raydium-scan] Birdeye trending error: ${e.message?.slice(0, 50)}`);
    }
  }

  // Source 6 (REMOVED): PumpSwap graduates were included here but caused Token-2022
  // simulation failures. PumpSwap tokens use Token-2022 format; Jupiter's simulation
  // invokes GetAccountDataSize on the Token-2022 program and fails with custom error 0x1.
  // PumpSwap graduates are only tradeable via PumpPortal (disabled) — skip entirely.

  const dxCount = results.length - raydiumDexCount;
  console.debug(`[raydium-scan] total: ${results.length} unique candidates (${raydiumDexCount} raydium-dex + ${dxCount} dx)`);
  return results;
}

export async function processRaydiumOpportunities(walletAddress: string): Promise<void> {
  if (!AUTO_BUY_ENABLED || !walletAddress) return;

  const now = Date.now();
  if (now - lastRaydiumScan < RAYDIUM_SCAN_INTERVAL_MS) return;
  lastRaydiumScan = now;

  // ── Market Regime Gate ──────────────────────────────────────────────────────
  // EXTREME_FEAR (F&G < 13): true capitulation/black swan — pause all buys.
  // F&G 13-45 = FEAR = contrarian buy zone (user strategy: buy on fear).
  const regime = await getMarketRegime();
  if (regime === 'EXTREME_FEAR') {
    console.info(`[raydium-scan] 🚫 EXTREME_FEAR market (F&G=${cachedFearGreed} < 13) — pausing buys. Existing positions monitored.`);
    return;
  }

  // In FEAR regime: require 10% 1h momentum — a 5% move is easily reversed against bearish market.
  // Contrarian thesis only works if the token is actively BUCKING the fear, not just drifting up.
  const minPc1hOverride = regime === 'FEAR' ? Math.max(RAYDIUM_MIN_PC1H, 10) : RAYDIUM_MIN_PC1H;

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

  console.info(`[raydium-scan] 🔍 Scanning ${pairs.length} pairs [${regime} F&G:${cachedFearGreed}] | Active: ${activePositions}/${MAX_AUTO_POSITIONS} | Daily: ${dailySpent.toFixed(4)}/${DAILY_MAX_SOL} SOL`);

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
    // -1 = unknown creation date (DexScreener omits pairCreatedAt for old tokens)
    const ageSec = createdAt > 0 ? (now - createdAt) / 1000 : -1;
    const mint   = pair.baseToken?.address ?? '';

    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) continue;
    if (SKIP_MINTS.has(mint)) { skipped.known++; continue; }

    const sym = pair.baseToken?.symbol ?? mint.slice(0, 8);

    // ── Gate 1: Liquidity / volume basics ──
    if (liq < RAYDIUM_MIN_LIQUIDITY_USD || liq > RAYDIUM_MAX_LIQUIDITY_USD || vol1h < RAYDIUM_MIN_VOLUME_H1_USD) {
      console.debug(`[raydium-scan] ✗liq  ${sym.padEnd(10)} liq:$${liq.toFixed(0)} vol1h:$${vol1h.toFixed(0)} pc1h:${pc1h.toFixed(1)}%`);
      skipped.liq++; continue;
    }
    // FEAR liquidity floor: min liq is now $30k globally, but in FEAR we require $35k.
    // Thin pools cause stop-loss slippage amplified when market sentiment is weak.
    if (regime === 'FEAR' && liq < 35000) {
      console.debug(`[raydium-scan] ✗fear  ${sym.padEnd(10)} liq:$${liq.toFixed(0)} < $35k floor in FEAR`);
      skipped.liq++; continue;
    }

    // ── Gate 2: Age — allow unknown-age (ageSec=-1); momentum filters screen stale tokens ──
    if (ageSec >= 0 && (ageSec < RAYDIUM_MIN_AGE_SEC || ageSec > RAYDIUM_MAX_AGE_SEC)) {
      console.debug(`[raydium-scan] ✗age  ${sym.padEnd(10)} age:${(ageSec/3600).toFixed(1)}h liq:$${liq.toFixed(0)} pc1h:${pc1h.toFixed(1)}%`);
      skipped.age++; continue;
    }

    // ── Gate 3: momentum ──
    // Skip pc5m check when vol5m=0 (GeckoTerminal / direct Raydium endpoint with no m5 data).
    // No 5m data = no current signal — require stronger 1h momentum to compensate.
    if (vol5m === 0 && pc1h < 5) {
      console.debug(`[raydium-scan] ✗no5m ${sym.padEnd(10)} no 5m data + pc1h only ${pc1h.toFixed(1)}% (need ≥5%)`);
      skipped.momentum++; continue;
    }
    if (vol5m > 0 && pc5m < RAYDIUM_MIN_PC5M) {
      console.debug(`[raydium-scan] ✗mom  ${sym.padEnd(10)} pc5m:${pc5m.toFixed(1)}% liq:$${liq.toFixed(0)} pc1h:${pc1h.toFixed(1)}%`);
      skipped.momentum++; continue;
    }
    if (pc1h < minPc1hOverride || pc1h > RAYDIUM_MAX_PC1H) {
      const reason = pc1h > RAYDIUM_MAX_PC1H ? `max:${RAYDIUM_MAX_PC1H}% already pumped` : `min:${minPc1hOverride}% need momentum`;
      console.debug(`[raydium-scan] ✗mom  ${sym.padEnd(10)} pc1h:${pc1h.toFixed(1)}% liq:$${liq.toFixed(0)} [${reason}]`);
      skipped.momentum++; continue;
    }

    // ── MAYHEM MODE filter: skip tokens in violent pump/dump phase ──
    // pc5m > 20% = already in blow-off top on Raydium, we'd be entering the tail
    // pc5m < -20% = already crashing, don't catch the falling knife
    if (vol5m > 0 && (pc5m > 20 || pc5m < -20)) {
      console.debug(`[raydium-scan] ✗mayhem ${sym.padEnd(10)} pc5m:${pc5m.toFixed(1)}% (${pc5m > 20 ? 'late-pump tail' : 'crashing'} — skip)`);
      skipped.hype++; continue;
    }

    // ── Gate 3b: Buy/sell ratio + minimum unique buyers ──
    // If 20%+ more sellers than buyers in the last hour: distribution phase, skip.
    // If ratio >3.5x: wash trading OR pump already peaked (Gaejuki 5.82x then -76%).
    // Fresh tokens (<6h): require ≥40 buys in 1h — real organic demand, not dev-pumped price.
    // All tokens: require ≥20 buys in 1h — stale pools with 5-10 buys/h rarely pump.
    // High-liq fresh tokens ($40k+, <6h): require ≥1h age — inflated liq is a common rug setup.
    const buys1h  = (pair.txns?.h1?.buys  ?? 0) as number;
    const sells1h = (pair.txns?.h1?.sells ?? 0) as number;
    const buys5m  = (pair.txns?.m5?.buys  ?? 0) as number;
    const sells5m = (pair.txns?.m5?.sells ?? 0) as number;
    const isFreshToken = ageSec >= 0 && ageSec < 6 * 3600;
    // Age gate for all tokens liq < $45k: require ≥60 min.
    // Microcap tokens ($30-45k liq) are still vulnerable to dev dump in the first hour.
    // Tokens $45k+ liq need ≥60 min too (expanded from old $40k floor).
    if (ageSec >= 0 && ageSec < 3600 && liq < 45000) {
      console.debug(`[raydium-scan] ✗microcap1h ${sym.padEnd(10)} liq:$${liq.toFixed(0)} age:${(ageSec/60).toFixed(0)}min (liq<$45k needs ≥60min)`);
      skipped.age++; continue;
    }
    if (isFreshToken && liq >= 45000 && ageSec >= 0 && ageSec < 3600) {
      console.debug(`[raydium-scan] ✗hiLiqFresh ${sym.padEnd(10)} liq:$${liq.toFixed(0)} age:${(ageSec/60).toFixed(0)}min (≥$45k fresh needs ≥60min)`);
      skipped.age++; continue;
    }
    if (isFreshToken && buys1h < 40) {
      console.debug(`[raydium-scan] ✗buyers ${sym.padEnd(10)} buys1h:${buys1h} age:${(ageSec/3600).toFixed(1)}h (fresh needs ≥40 buys/h)`);
      skipped.momentum++; continue;
    }
    if (!isFreshToken && buys1h < 20) {
      console.debug(`[raydium-scan] ✗stale ${sym.padEnd(10)} buys1h:${buys1h} age:${(ageSec/3600).toFixed(1)}h (aged needs ≥20 buys/h)`);
      skipped.momentum++; continue;
    }
    if (buys1h > 0 && sells1h > buys1h * 1.2) {
      console.debug(`[raydium-scan] ✗dist ${sym.padEnd(10)} buys:${buys1h} sells:${sells1h} (distribution in 1h)`);
      skipped.momentum++; continue;
    }
    if (buys1h > 50 && sells1h > 0 && buys1h / sells1h > RAYDIUM_MAX_BUY_SELL_RATIO) {
      console.debug(`[raydium-scan] ✗wash ${sym.padEnd(10)} B/S=${(buys1h/sells1h).toFixed(1)}x (>${RAYDIUM_MAX_BUY_SELL_RATIO}x = wash or late)`);
      skipped.momentum++; continue;
    }

    // ── Gate 3c: 5-minute buyer dominance — "start of pump" entry signal ──
    // We want to enter at the BEGINNING of the volume pump, not after it peaked.
    // Key signal: fresh buy transactions in last 5 min with buyers > sellers.
    // Without this: bot enters when 1h chart shows +30% (pump already done).
    if (vol5m > 0) {
      if (buys5m < 2) {
        console.debug(`[raydium-scan] ✗5mbuy ${sym.padEnd(10)} buys5m:${buys5m} (need ≥2 — no fresh demand)`);
        skipped.momentum++; continue;
      }
      if (sells5m > buys5m * 1.3) {
        console.debug(`[raydium-scan] ✗5mdist ${sym.padEnd(10)} buys5m:${buys5m} sells5m:${sells5m} — 5m selling > buying`);
        skipped.momentum++; continue;
      }
    }

    // ── Gate 3d: Volume Velocity — active money flowing in RIGHT NOW ──
    // vol5m / liq ≥ 15% means: 15% pool turnover in last 5 minutes = real demand.
    // Prevents buying "sleeping" tokens: up 20% in 1h but completely stale in last 5 min.
    // Default: disabled (0.0). Enable with RAYDIUM_MIN_VOL5M_LIQ=0.15 in .env.
    const MIN_VOL5M_LIQ_RATIO = Number(process.env.RAYDIUM_MIN_VOL5M_LIQ || '0.0');
    if (MIN_VOL5M_LIQ_RATIO > 0 && vol5m > 0 && liq > 0) {
      const vel = vol5m / liq;
      if (vel < MIN_VOL5M_LIQ_RATIO) {
        console.debug(`[raydium-scan] ✗vel  ${sym.padEnd(10)} vol5m/liq:${(vel*100).toFixed(1)}% < ${(MIN_VOL5M_LIQ_RATIO*100).toFixed(0)}% (stale momentum)`);
        skipped.momentum++; continue;
      }
    }

    // For tokens older than 6h, require positive 6h trend — don't buy downtrends.
    // Fresh tokens (<6h) may not have meaningful 6h data yet.
    if (ageSec > 6 * 3600 && pc6h <= 0) {
      console.debug(`[raydium-scan] ✗trend ${sym.padEnd(10)} pc6h:${pc6h.toFixed(1)}% age:${(ageSec/3600).toFixed(1)}h liq:$${liq.toFixed(0)}`);
      skipped.momentum++; continue;
    }
    if (pc6h < -15) { skipped.momentum++; continue; }
    // In FEAR: fresh tokens must not be in a 6h downtrend — dead cat bounces are common.
    if (regime === 'FEAR' && ageSec > 0 && ageSec <= 6 * 3600 && pc6h < -5) {
      console.debug(`[raydium-scan] ✗fear-6h ${sym.padEnd(10)} pc6h:${pc6h.toFixed(1)}% fresh token declining in FEAR`);
      skipped.momentum++; continue;
    }

    // ── Gate 4: Volume quality ──
    // vol/liq ratio > 10% = real trading activity
    // vol acceleration check only when 5m data is available (vol5m > 0).
    // Without m5 data, vol5m*12 < vol1h*0.25 always triggers (0 < anything) — false positive.
    if (liq > 0 && vol1h / liq < RAYDIUM_MIN_VOL_LIQ_RATIO) {
      console.debug(`[raydium-scan] ✗ratio ${sym.padEnd(10)} vol/liq:${(vol1h/liq*100).toFixed(1)}% vol1h:$${vol1h.toFixed(0)} liq:$${liq.toFixed(0)}`);
      skipped.vol++; continue;
    }
    // Vol acceleration: current 5m rate must be ≥40% of 1h average (was 25% — too loose).
    // Prevents buying tokens where volume is tapering off (early dump detection).
    if (vol5m > 0 && vol1h > 0 && vol5m * 12 < vol1h * 0.40) {
      console.debug(`[raydium-scan] ✗vaccel ${sym.padEnd(10)} vol5m*12:$${(vol5m*12).toFixed(0)} < vol1h*40%:$${(vol1h*0.40).toFixed(0)} (tapering)`);
      skipped.vol++; continue;
    }

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

    // ── Gate 6: Top holder rug check ──
    // Single wallet holding >50% of supply = dev can dump at any moment
    const topHolderPct = await checkTopHolder(mint);
    if (topHolderPct > TOP_HOLDER_RUG_PCT) {
      console.info(`[raydium-scan] 🐋 SKIP ${pair.baseToken?.symbol ?? mint.slice(0,8)} — top holder ${topHolderPct.toFixed(0)}% (>${TOP_HOLDER_RUG_PCT}% = rug risk)`);
      skipped.bot++;
      continue;
    }

    const slippage = shield.slippage_bps;
    const rugTag = topHolderPct > 0 ? ` top_holder:${topHolderPct.toFixed(0)}%` : '';
    console.info(
      `[raydium-scan] 🟢 PASS ${pair.baseToken?.symbol ?? mint.slice(0,8)} (${mint.slice(0,8)}) ` +
      `liq:$${liq.toFixed(0)} vol1h:$${vol1h.toFixed(0)} pc5m:${pc5m.toFixed(1)}% pc1h:${pc1h.toFixed(1)}% ` +
      `buys5m:${buys5m} sells5m:${sells5m} buys1h:${buys1h} age:${(ageSec/3600).toFixed(1)}h${rugTag}`
    );

    try {
      const isFresh = ageSec < 6 * 3600;
      const ageTag = isFresh ? `fresh${Math.round(ageSec / 3600)}h` : `aged`;
      const tier = getLiqTier(liq, regime);
      const label = `auto:raydium_scan:liq${Math.round(liq / 1000)}k:${ageTag}:${tier.label}:${regime.toLowerCase()}`;
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

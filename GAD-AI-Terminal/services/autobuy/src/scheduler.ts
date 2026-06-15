import axios from 'axios';
import { query } from '@lib/db';
import {
  executeAutoBuy,
  executeAutoSell,
  getKeypairFromEnv,
  getConnection,
  SELL_STAGES,
} from '@lib/autobuy';
import { sellViaPumpPortal, buyViaPumpPortal } from './pumpportal';
import { PublicKey } from '@solana/web3.js';
import { processAutoSignals, processRaydiumOpportunities, AUTO_BUY_ENABLED, getLiqTier } from './auto-signal';
import { startGraduationScanner } from './graduation-scanner';
import { startBondingScanner } from './bonding-scanner';

const POLL_MS    = Number(process.env.AUTOBUY_POLL_SECONDS  || '15') * 1000;
const MAX_ERRORS = Number(process.env.AUTOBUY_MAX_ERRORS    || '5');

const AUTOSELL_SLIPPAGE_BPS      = Number(process.env.AUTOSELL_SLIPPAGE_BPS       || '500');
const AUTOSELL_SLIPPAGE_RETRY_BPS = Number(process.env.AUTOSELL_SLIPPAGE_RETRY_BPS || '1000');
const AUTOBUY_SLIPPAGE_BPS  = Number(process.env.AUTOBUY_SLIPPAGE_BPS  || '100');

// Stop-loss: sell ALL if price drops this % below entry (0 = disabled)
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || '5') / 100;   // was 8%

// Trailing stop: after first TP stage, sell ALL if price drops TRAIL_PCT from peak
const TRAIL_PCT = Number(process.env.TRAIL_PCT || '12') / 100;           // was 15%

// Time limit: sell 95% if token shows no price activity for this many seconds
const TIME_LIMIT_SECONDS      = Number(process.env.TIME_LIMIT_SECONDS      || '1200');  // was 1800 (30min) → 20min
const TIME_LIMIT_ACTIVITY_PCT = Number(process.env.TIME_LIMIT_ACTIVITY_PCT || '1') / 100;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AutobuyJob {
  id: string;
  mint_address: string;
  label: string | null;
  amount_sol: number;
  slippage_bps: number;
  interval_seconds: number;
  error_count: number;
  autosell_enabled: boolean;
}

interface AutosellStage {
  id: string;
  autobuy_job_id: string;
  mint_address: string;
  stage_number: number;
  trigger_mult: number;
  sell_percent: number;
  entry_price_sol: number;
  tokens_at_stage: number | null;
  status: string;
  // Time limit fields from autobuy_jobs
  time_limit_seconds: number;
  time_limit_enabled: boolean;
  bought_at: string | null;
  last_activity_at: string | null;
  sell_stage_reached: number; // how many TP stages already executed (for trailing stop)
  label: string | null;
}

// ─── In-memory state ─────────────────────────────────────────────────────────

// Consecutive price-check failures — 3 = token dead
const priceFailCount = new Map<string, number>();
const MAX_PRICE_FAILS = 3;

// Consecutive stop-loss sell failures — 3 = accept as total loss
const stopLossFailCount = new Map<string, number>();
const MAX_STOP_LOSS_FAILS = 3;

// Consecutive time-limit sell failures — 3 = accept as loss
const timeLimitFailCount = new Map<string, number>();
const MAX_TIME_LIMIT_FAILS = 3;

// Previous price per mint for activity detection
const prevPriceMap = new Map<string, number>();

// Price cache — shared between DexScreener and Jupiter sources
const priceCache = new Map<string, { price: number; ts: number }>();
// Fast cache: 1 second — price must be near-real-time for quick TP detection
const PRICE_CACHE_MS = 1000;

// Sell attempt cooldown after 429 — prevents rapid-fire rate-limit cascades
const sellCooldownMap = new Map<string, number>(); // stageId → unixMs when cooldown expires
const SELL_COOLDOWN_MS = 30_000; // 30s after any sell 429

// ─── Jupiter Lite price fetch (primary — fast, batch-friendly, no auth) ───────
// Falls back to DexScreener if Jupiter returns 0.
async function getPriceSolViaDS(mint: string): Promise<number> {
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.ts < PRICE_CACHE_MS) return cached.price;

  // Try Jupiter Lite first — typically <200ms, no rate-limit issues with single-mint calls
  try {
    const jupRes = await axios.get(
      `https://lite.jup.ag/v1/prices?ids=${mint}&vsToken=So11111111111111111111111111111111111111112`,
      { timeout: 2500 }
    );
    const jupPrice = Number(jupRes.data?.data?.[mint]?.price ?? 0);
    if (jupPrice > 0) {
      priceCache.set(mint, { price: jupPrice, ts: Date.now() });
      return jupPrice;
    }
  } catch { /* fall through to DexScreener */ }

  // Fallback: DexScreener (slower but reliable for established pairs)
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 4000 }
    );
    const pairs: any[] = r.data?.pairs ?? [];
    if (!pairs.length) return priceCache.get(mint)?.price ?? 0;
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = Number(best.priceNative ?? 0);
    if (price > 0) priceCache.set(mint, { price, ts: Date.now() });
    return price;
  } catch {
    return priceCache.get(mint)?.price ?? 0;
  }
}

// Peak price tracking for trailing stop (mint → highest price seen)
const peakPriceMap = new Map<string, number>();

// Peak price tracking for early trail (pre-TP1) — separate from post-TP1 trail
const earlyPeakMap = new Map<string, number>();

// Moon bag floor prices — set when stage 1 (90%) TP fires (jobId → TP floor price SOL/tok)
// If price drops back to this floor, sell 70% of moon bag. Remaining 30% rides trailing stop.
const moonbagFloorMap = new Map<string, number>();

// Stop-loss confirmation counter — require N consecutive readings below stop before firing.
// Prevents stop-hunts: whales briefly dip price below stop then immediately recover.
// Set to 1 for immediate stop (memecoins can drop 20% in 30s if we wait for 2 confirms).
const stopLossConfirmCount = new Map<string, number>();
const STOP_LOSS_CONFIRMS_REQUIRED = Number(process.env.STOP_LOSS_CONFIRMS || '1');

// ─── Buy helpers ──────────────────────────────────────────────────────────────

async function fetchAndLockDueJobs(): Promise<AutobuyJob[]> {
  const { rows } = await query<AutobuyJob>(
    `WITH locked AS (
       SELECT id FROM autobuy_jobs
       WHERE active = true AND next_run_at <= now()
         AND (label IS NULL OR label NOT LIKE 'auto:bonding%')
       ORDER BY next_run_at ASC LIMIT 20
       FOR UPDATE SKIP LOCKED
     )
     UPDATE autobuy_jobs SET next_run_at = now() + interval '1 hour'
     FROM locked
     WHERE autobuy_jobs.id = locked.id
     RETURNING autobuy_jobs.id, autobuy_jobs.mint_address, autobuy_jobs.label,
               autobuy_jobs.amount_sol, autobuy_jobs.slippage_bps,
               autobuy_jobs.interval_seconds, autobuy_jobs.error_count,
               autobuy_jobs.autosell_enabled`
  );
  return rows;
}

async function markBuySuccess(
  jobId: string, amountSol: number, signature: string,
  intervalSeconds: number, entryPriceSol: number | null, tokenAmountBought: bigint | null
) {
  await query(
    `UPDATE autobuy_jobs SET
       last_run_at         = now(),
       last_tx_signature   = $1,
       next_run_at         = now() + ($2 || ' seconds')::interval,
       total_buys          = total_buys + 1,
       total_spent_sol     = total_spent_sol + $3,
       error_count         = 0,
       last_error          = NULL,
       entry_price_sol     = COALESCE(entry_price_sol, $4),
       token_amount_bought = COALESCE(token_amount_bought, 0) + $5,
       bought_at           = COALESCE(bought_at, now()),
       last_activity_at    = now()
     WHERE id = $6`,
    [signature, String(intervalSeconds), amountSol,
     entryPriceSol, tokenAmountBought ? tokenAmountBought.toString() : '0', jobId]
  );
}

async function markBuyError(jobId: string, error: string, intervalSeconds: number) {
  const { rows } = await query<{ error_count: number }>(
    `UPDATE autobuy_jobs SET
       last_run_at = now(),
       next_run_at = now() + ($1 || ' seconds')::interval,
       error_count = error_count + 1,
       last_error  = $2
     WHERE id = $3 RETURNING error_count`,
    [String(intervalSeconds), error.slice(0, 500), jobId]
  );
  if ((rows[0]?.error_count ?? 0) >= MAX_ERRORS) {
    await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [jobId]);
    console.warn(`[autobuy] Job ${jobId.slice(0,8)} auto-disabled after ${rows[0].error_count} errors.`);
  }
}

// ─── Extract tier from job label ──────────────────────────────────────────────
// Labels: auto:raydium_scan:liq250k:fresh2h:t3  →  tier 3
function getTierFromLabel(label: string | null): ReturnType<typeof getLiqTier> {
  if (label?.includes(':t3')) {
    // Extract liq from label to get exact tier config
    const liqMatch = label.match(/:liq(\d+)k/);
    const liq = liqMatch ? Number(liqMatch[1]) * 1000 : 300000;
    return getLiqTier(Math.max(liq, 250001));  // force T3
  }
  if (label?.includes(':t1')) {
    const liqMatch = label.match(/:liq(\d+)k/);
    const liq = liqMatch ? Number(liqMatch[1]) * 1000 : 50000;
    return getLiqTier(Math.min(liq, 79999));   // force T1
  }
  // Default: T2 or derive from liq in label
  const liqMatch = label?.match(/:liq(\d+)k/);
  if (liqMatch) return getLiqTier(Number(liqMatch[1]) * 1000);
  return getLiqTier(100000);  // fallback to T2
}

// ─── Create sell stages after a buy ──────────────────────────────────────────

async function createSellStages(
  jobId: string, mintAddress: string, walletAddress: string,
  entryPriceSol: number, tokensBought: bigint, jobLabel: string | null
) {
  const tier = getTierFromLabel(jobLabel);
  const stages = tier.sellStages;
  let tokensRemaining = tokensBought;
  for (const stage of stages) {
    const tokensForStage = tokensRemaining;
    const tokensSold = BigInt(Math.floor(Number(tokensForStage) * stage.sellPct / 100));
    tokensRemaining -= tokensSold;
    await query(
      `INSERT INTO autosell_stages
         (autobuy_job_id, wallet_address, mint_address, stage_number,
          trigger_mult, sell_percent, tokens_at_stage, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       ON CONFLICT DO NOTHING`,
      [jobId, walletAddress, mintAddress, stage.stage,
       stage.multiplier, stage.sellPct, tokensForStage.toString()]
    );
  }
  console.info(`[autobuy] Created ${stages.length} sell stages (T${tier.tier}) for job ${jobId.slice(0,8)} — TP targets: ${stages.map(s => `${s.multiplier}x`).join('→')}`);
}

// ─── Sell stage fetching ──────────────────────────────────────────────────────

async function fetchPendingSellStages(): Promise<AutosellStage[]> {
  const { rows } = await query<AutosellStage>(
    `SELECT s.id, s.autobuy_job_id, s.mint_address, s.stage_number,
            s.trigger_mult, s.sell_percent, s.tokens_at_stage, s.status,
            j.entry_price_sol,
            j.time_limit_seconds,
            j.time_limit_enabled,
            j.bought_at,
            j.last_activity_at,
            COALESCE(j.sell_stage_reached, 0) AS sell_stage_reached,
            j.label
     FROM autosell_stages s
     JOIN autobuy_jobs j ON j.id = s.autobuy_job_id
     WHERE s.status = 'pending'
       AND j.active = true
       AND j.entry_price_sol IS NOT NULL
       AND s.tokens_at_stage IS NOT NULL
     ORDER BY s.stage_number ASC
     LIMIT 50`
  );
  return rows;
}

// ─── Shared sell helper ───────────────────────────────────────────────────────

async function claimAndSell(
  mint: string,
  jobId: string,
  sellPct: number,
  reason: 'STOP_LOSS' | 'TIME_LIMIT_EXPIRED',
  connection: ReturnType<typeof getConnection>,
  keypair: ReturnType<typeof getKeypairFromEnv>,
  isJupiterOnlyHint = false  // true for Raydium-track tokens — overridden if mint ends in 'pump'
): Promise<'success' | 'fail'> {
  // pump.fun tokens (mint ends in 'pump') can NEVER be sold via Jupiter — always allow PumpPortal
  const isJupiterOnly = isJupiterOnlyHint && !mint.endsWith('pump');
  if (!keypair) return 'fail';

  const { rows: claimed } = await query<{ id: string; tokens_at_stage: string }>(
    `UPDATE autosell_stages SET status = 'triggered'
     WHERE autobuy_job_id = $1 AND status = 'pending'
     RETURNING id, tokens_at_stage`,
    [jobId]
  );
  if (!claimed.length) return 'fail';

  // tokens_at_stage stores the REMAINING balance at each stage trigger point (cumulative, not incremental).
  // Stage 1 = full initial balance, Stage 2 = 60% remaining, etc.
  // Summing them all would produce 11x the real balance → 0x1788 InsufficientFunds.
  // Correct approach: read the actual on-chain wallet balance and sell sellPct% of that.
  let tokensToSell: bigint;
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const onChainBalance = BigInt(
      (tokenAccounts.value[0]?.account?.data as any)?.parsed?.info?.tokenAmount?.amount ?? '0'
    );
    tokensToSell = BigInt(Math.floor(Number(onChainBalance) * sellPct / 100));
    if (tokensToSell <= 0n) {
      console.warn(`[sell] ${mint.slice(0,8)} on-chain balance is 0 — marking as unsellable`);
      await query(`UPDATE autosell_stages SET status='pending' WHERE id=ANY($1)`, [claimed.map(r => r.id)]);
      return 'fail';
    }
  } catch (balErr: any) {
    // Fallback to stage 1 tokens_at_stage if on-chain check fails
    const stage1 = claimed.sort((a, b) => Number(b.tokens_at_stage ?? 0) - Number(a.tokens_at_stage ?? 0))[0];
    const stage1Tokens = BigInt(Math.floor(Number(stage1?.tokens_at_stage ?? 0)));
    tokensToSell = BigInt(Math.floor(Number(stage1Tokens) * sellPct / 100));
    console.warn(`[sell] On-chain balance check failed for ${mint.slice(0,8)}, using stage1 tokens: ${stage1Tokens}`);
  }
  const stageIds = claimed.map(r => r.id);

  // Attempt 1: normal slippage
  let sellResult = await executeAutoSell(
    { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_BPS },
    connection, keypair
  );

  // Attempt 2: if failed, wait 3s then retry with high slippage
  if (!sellResult.success) {
    console.warn(`[sell] Jupiter attempt 1 failed for ${mint.slice(0,8)}, retrying in 3s with ${AUTOSELL_SLIPPAGE_RETRY_BPS}bps...`);
    await new Promise(r => setTimeout(r, 3000));
    sellResult = await executeAutoSell(
      { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_RETRY_BPS },
      connection, keypair
    );
  }

  if (sellResult.success) {
    await query(
      `UPDATE autosell_stages
         SET status = 'executed', sol_received = $1, tx_signature = $2,
             executed_at = now(), sell_reason = $3
       WHERE id = ANY($4)`,
      [sellResult.solReceived, sellResult.txSignature, reason, stageIds]
    );
    await query(
      `UPDATE autobuy_jobs SET active = false, total_sold_sol = total_sold_sol + $1
       WHERE id = $2`,
      [sellResult.solReceived, jobId]
    );
    return 'success';
  }

  // Jupiter exhausted — PumpPortal fallback ONLY for pump.fun/pumpswap tokens (not Raydium)
  if (isJupiterOnly) {
    console.error(`[sell] Jupiter failed twice for Raydium token ${mint.slice(0,8)} — skipping PumpPortal (wrong DEX), will retry next cycle`);
    await query(`UPDATE autosell_stages SET status='pending' WHERE id=ANY($1)`, [stageIds]);
    return 'fail';
  }

  console.warn(`[sell] Jupiter failed for ${mint.slice(0,8)}, trying PumpPortal fallback...`);
  const ppResult = await sellViaPumpPortal(mint, sellPct, keypair, connection);
  if (ppResult.success && (ppResult.solReceived ?? 0) > 0) {
    await query(
      `UPDATE autosell_stages
         SET status = 'executed', sol_received = $1, tx_signature = $2,
             executed_at = now(), sell_reason = $3
       WHERE id = ANY($4)`,
      [ppResult.solReceived ?? 0, ppResult.txSignature, `${reason}_PUMPPORTAL`, stageIds]
    );
    await query(
      `UPDATE autobuy_jobs SET active = false, total_sold_sol = total_sold_sol + $1
       WHERE id = $2`,
      [ppResult.solReceived ?? 0, jobId]
    );
    console.info(`[sell] ✅ PumpPortal fallback succeeded for ${mint.slice(0,8)} → ${ppResult.solReceived?.toFixed(5)} SOL`);
    return 'success';
  }

  console.warn(`[sell] PumpPortal fallback also failed for ${mint.slice(0,8)}: ${ppResult.error}`);
  await query(`UPDATE autosell_stages SET status = 'pending' WHERE id = ANY($1)`, [stageIds]);
  return 'fail';
}

// ─── Moon bag partial sell (does NOT close job — 30% remainder rides trailing stop) ─────────

async function sellMoonbagFloor(
  mint: string,
  jobId: string,
  sellPct: number,
  connection: ReturnType<typeof getConnection>,
  keypair: ReturnType<typeof getKeypairFromEnv>,
  isJupiterOnlyHint = false
): Promise<'success' | 'fail'> {
  if (!keypair) return 'fail';
  const isJupiterOnly = isJupiterOnlyHint && !mint.endsWith('pump');

  let onChainBalance: bigint;
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey, { mint: new PublicKey(mint) }
    );
    onChainBalance = BigInt(
      (tokenAccounts.value[0]?.account?.data as any)?.parsed?.info?.tokenAmount?.amount ?? '0'
    );
  } catch {
    return 'fail';
  }

  if (onChainBalance <= 0n) {
    await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [jobId]);
    return 'success';
  }

  const tokensToSell = BigInt(Math.floor(Number(onChainBalance) * sellPct / 100));
  if (tokensToSell <= 0n) return 'fail';

  let sellResult = await executeAutoSell(
    { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_BPS },
    connection, keypair
  );
  if (!sellResult.success) {
    await new Promise(r => setTimeout(r, 2000));
    sellResult = await executeAutoSell(
      { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_RETRY_BPS },
      connection, keypair
    );
  }

  if (sellResult.success) {
    await query(
      `UPDATE autobuy_jobs SET total_sold_sol = total_sold_sol + $1, last_activity_at = now() WHERE id = $2`,
      [sellResult.solReceived, jobId]
    );
    console.info(`[autosell] 🌙 Moon bag floor SOLD ${sellPct}% → ${sellResult.solReceived?.toFixed(5)} SOL (30% remainder rides trailing stop)`);
    return 'success';
  }

  if (!isJupiterOnly) {
    const ppResult = await sellViaPumpPortal(mint, sellPct, keypair, connection);
    if (ppResult.success && (ppResult.solReceived ?? 0) > 0) {
      await query(
        `UPDATE autobuy_jobs SET total_sold_sol = total_sold_sol + $1, last_activity_at = now() WHERE id = $2`,
        [ppResult.solReceived ?? 0, jobId]
      );
      console.info(`[autosell] 🌙 Moon bag floor SOLD via PumpPortal ${mint.slice(0,8)} → ${ppResult.solReceived?.toFixed(5)} SOL`);
      return 'success';
    }
  }

  return 'fail';
}

// ─── Sell cycle ───────────────────────────────────────────────────────────────

async function checkAndExecuteSells(walletAddress: string) {
  const stages = await fetchPendingSellStages();
  if (!stages.length) return;

  const keypair = getKeypairFromEnv();
  if (!keypair) return;
  const connection = getConnection();

  const byMint = new Map<string, AutosellStage[]>();
  for (const s of stages) {
    const list = byMint.get(s.mint_address) ?? [];
    list.push(s);
    byMint.set(s.mint_address, list);
  }

  let firstMint = true;
  for (const [mint, mintStages] of byMint) {
    if (!firstMint) await new Promise(r => setTimeout(r, 1500));
    firstMint = false;

    const refStage = mintStages[0];
    if (!refStage.tokens_at_stage || Number(refStage.tokens_at_stage) <= 0) continue;

    // ── Price check via DexScreener (no auth/rate-limit, avoids Jupiter 429) ─
    let currentPriceSol: number;
    {
      const price = await getPriceSolViaDS(mint);
      if (price <= 0) {
        const fails = (priceFailCount.get(mint) ?? 0) + 1;
        priceFailCount.set(mint, fails);
        console.warn(`[autosell] Price=0 for ${mint.slice(0,8)} (${fails}/${MAX_PRICE_FAILS})`);
        if (fails >= MAX_PRICE_FAILS) {
          console.warn(`[autosell] 💀 ${mint.slice(0,8)} — ${MAX_PRICE_FAILS} price failures, marking as dead`);
          await query(
            `UPDATE autosell_stages SET status = 'failed', sell_reason = 'PRICE_UNAVAILABLE'
             WHERE mint_address = $1 AND status = 'pending'`,
            [mint]
          );
          await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [refStage.autobuy_job_id]);
          priceFailCount.delete(mint);
        }
        continue;
      }
      priceFailCount.delete(mint);
      currentPriceSol = price;
    }

    // ── Activity tracking (for time limit reset) ──────────────────────────────
    // ONLY reset timer on UPWARD moves — downward moves should NOT extend a losing position.
    // A 17% dump is not "activity" worth waiting for, it means the trade is failing.
    const prev = prevPriceMap.get(mint);
    prevPriceMap.set(mint, currentPriceSol);
    const refEntry = Number(refStage.entry_price_sol ?? 0);
    if (prev !== undefined && prev > 0 && currentPriceSol > prev) {
      const pctChange = (currentPriceSol - prev) / prev;
      // Only count as activity when price is rising AND above entry (real momentum, not dead-cat bounce)
      if (pctChange >= TIME_LIMIT_ACTIVITY_PCT && (refEntry === 0 || currentPriceSol >= refEntry)) {
        await query(
          `UPDATE autobuy_jobs SET last_activity_at = now() WHERE id = $1`,
          [refStage.autobuy_job_id]
        );
        console.info(
          `[time-limit] 📊 Activity on ${mint.slice(0,8)}: +${(pctChange * 100).toFixed(2)}% ↑ above entry — timer reset`
        );
      }
    }

    // ── Tier config for this job ──────────────────────────────────────────────
    const jobTier = getTierFromLabel(refStage.label);

    // ── Hard cap: max hold time from buy regardless of activity ───────────────
    // T1=30min, T2=60min, T3=4h (mid-caps can take time to move)
    const tierHardCap = jobTier.tier === 1 ? 1800 : jobTier.tier === 3 ? 14400 : 3600;
    const MAX_HOLD_SECONDS = Number(process.env.MAX_HOLD_SECONDS || String(tierHardCap));
    if (refStage.bought_at) {
      const totalElapsedSec = (Date.now() - new Date(refStage.bought_at).getTime()) / 1000;
      if (totalElapsedSec > MAX_HOLD_SECONDS) {
        const elapsedMin = Math.floor(totalElapsedSec / 60);
        // If above entry — skip hard cap, position is profitable (just slow) — let it reach TP
        if (refEntry > 0 && currentPriceSol > refEntry) {
          console.info(
            `[time-limit] ⏸️ HARD CAP ${mint.slice(0,8)} — above entry (+${((currentPriceSol / refEntry - 1) * 100).toFixed(1)}%) after ${elapsedMin}min — skipping, waiting for TP`
          );
        } else {
          console.warn(
            `[time-limit] 🔴 HARD CAP ${mint.slice(0,8)} — held ${elapsedMin}min (max ${MAX_HOLD_SECONDS / 60}min) — force sell`
          );
          const result = await claimAndSell(mint, refStage.autobuy_job_id, 95, 'TIME_LIMIT_EXPIRED', connection, keypair, !refStage.label?.includes(':pumpportal'));
          if (result === 'success') {
            console.info(`[time-limit] ✅ Hard cap sell EXECUTED for ${mint.slice(0,8)}`);
          }
          continue;
        }
      }
    }

    // ── Early trailing stop (pre-TP1: activates once position is profitable) ──
    // Solves the core loss pattern: token peaks +15% → falls to stop at -8% = net -8% loss.
    // With early trail: peaks +15%, trail fires at +9% (6% below peak) = +9% gain.
    // Only fires when trail-stop price > entry (guarantees we sell at a profit, never a loss).
    const EARLY_TRAIL_PCT = jobTier.earlyTrailPct;
    if (EARLY_TRAIL_PCT > 0 && refEntry > 0 && refStage.sell_stage_reached === 0) {
      const prevEarlyPeak = earlyPeakMap.get(mint) ?? currentPriceSol;
      const newEarlyPeak = Math.max(prevEarlyPeak, currentPriceSol);
      earlyPeakMap.set(mint, newEarlyPeak);
      const earlyStop = newEarlyPeak * (1 - EARLY_TRAIL_PCT);
      // Only fire if earlyStop is at least +10% above entry — covers fees and ensures real profit
      if (currentPriceSol < earlyStop && earlyStop > refEntry * 1.10) {
        const gainPct = ((currentPriceSol / refEntry - 1) * 100).toFixed(1);
        const peakPct = ((newEarlyPeak / refEntry - 1) * 100).toFixed(1);
        console.warn(
          `[autosell] 💰 EARLY TRAIL ${mint.slice(0,8)} — ` +
          `selling at +${gainPct}% (peak was +${peakPct}%, trail -${(EARLY_TRAIL_PCT * 100).toFixed(0)}% from peak)`
        );
        const result = await claimAndSell(mint, refStage.autobuy_job_id, 100, 'STOP_LOSS', connection, keypair, !refStage.label?.includes(':pumpportal'));
        if (result === 'success') {
          earlyPeakMap.delete(mint);
          console.info(`[autosell] 💰 Early trail EXECUTED for ${mint.slice(0,8)}`);
        } else {
          console.error(`[autosell] 💰 Early trail FAILED for ${mint.slice(0,8)}`);
        }
        continue;
      }
    }

    // ── Trailing stop (active only after first TP stage executed) ────────────
    const effectiveTrailPct = jobTier.trailPct || TRAIL_PCT;
    if (effectiveTrailPct > 0 && refStage.sell_stage_reached >= 1) {
      const peak = peakPriceMap.get(mint) ?? currentPriceSol;
      const newPeak = Math.max(peak, currentPriceSol);
      peakPriceMap.set(mint, newPeak);
      const trailStop = newPeak * (1 - effectiveTrailPct);
      if (currentPriceSol < trailStop) {
        const confirms = (stopLossConfirmCount.get(mint) ?? 0) + 1;
        stopLossConfirmCount.set(mint, confirms);
        if (confirms < STOP_LOSS_CONFIRMS_REQUIRED) {
          console.debug(`[autosell] 📉 Trail below ${mint.slice(0,8)} (${confirms}/${STOP_LOSS_CONFIRMS_REQUIRED})`);
        } else {
          stopLossConfirmCount.delete(mint);
          console.warn(
            `[autosell] 📉 TRAILING STOP confirmed for ${mint.slice(0,8)} — ` +
            `price ${currentPriceSol.toFixed(12)} < trail ${trailStop.toFixed(12)} ` +
            `(${(effectiveTrailPct * 100).toFixed(0)}% from peak ${newPeak.toFixed(12)})`
          );
          const result = await claimAndSell(mint, refStage.autobuy_job_id, 100, 'STOP_LOSS', connection, keypair, !refStage.label?.includes(':pumpportal'));
          if (result === 'success') {
            peakPriceMap.delete(mint);
            console.info(`[autosell] 📉 Trailing stop EXECUTED for ${mint.slice(0,8)}`);
          } else {
            console.error(`[autosell] 📉 Trailing stop FAILED for ${mint.slice(0,8)}`);
          }
          continue;
        }
      } else {
        if (stopLossConfirmCount.has(mint)) stopLossConfirmCount.delete(mint);
      }
    }

    // ── Moon bag floor stop (after TP: sell 70% if price drops back to TP level) ─
    // Stage 1 sells 90% at TP. moonbagFloorMap records the TP price. If price drops
    // back below that floor, we sell 70% of the remaining 10% (= 7% of original position).
    // The last 30% of moon bag (= 3% of original) continues under trailing stop / time limit.
    const moonbagFloor = moonbagFloorMap.get(refStage.autobuy_job_id);
    if (moonbagFloor && refStage.sell_stage_reached >= 1 && currentPriceSol < moonbagFloor * 0.99) {
      console.warn(
        `[autosell] 🌙 MOON BAG FLOOR hit ${mint.slice(0,8)} — ` +
        `price ${currentPriceSol.toExponential(4)} < floor ${moonbagFloor.toExponential(4)} — selling 70% of moon bag`
      );
      const result = await sellMoonbagFloor(
        mint, refStage.autobuy_job_id, 70, connection, keypair,
        !refStage.label?.includes(':pumpportal')
      );
      if (result === 'success') {
        moonbagFloorMap.delete(refStage.autobuy_job_id);
      }
      continue;
    }

    // ── Stop-loss check (with stop-hunt protection) ───────────────────────────
    if (STOP_LOSS_PCT > 0) {
      // Fresh tokens get slightly wider stop (10% vs 8%) to survive initial volatility.
      // Use tier-specific stop-loss — T1/T2 = tight (5%), T3 = wider (8%, less volatile)
      const effectiveStop = jobTier.stopPct || STOP_LOSS_PCT;

      if (refEntry > 0 && currentPriceSol < refEntry * (1 - effectiveStop)) {  // refEntry declared above in activity tracking block
        // Require N consecutive readings below stop before firing — filters out 1-candle stop hunts
        const confirms = (stopLossConfirmCount.get(mint) ?? 0) + 1;
        stopLossConfirmCount.set(mint, confirms);
        if (confirms < STOP_LOSS_CONFIRMS_REQUIRED) {
          console.debug(
            `[autosell] ⚠️ Stop below ${mint.slice(0,8)} — ` +
            `${currentPriceSol.toFixed(12)} < ${(refEntry * (1 - effectiveStop)).toFixed(12)} ` +
            `(${confirms}/${STOP_LOSS_CONFIRMS_REQUIRED} confirms, waiting...)`
          );
          // Don't fire yet — check next cycle
        } else {
          stopLossConfirmCount.delete(mint);
          console.warn(
            `[autosell] 🛑 STOP-LOSS confirmed for ${mint.slice(0,8)} — ` +
            `price ${currentPriceSol.toFixed(12)} < stop ${(refEntry * (1 - effectiveStop)).toFixed(12)} ` +
            `(${(effectiveStop * 100).toFixed(0)}% below entry, ${STOP_LOSS_CONFIRMS_REQUIRED} confirms)`
          );
          const result = await claimAndSell(mint, refStage.autobuy_job_id, 100, 'STOP_LOSS', connection, keypair, !refStage.label?.includes(':pumpportal'));
          if (result === 'success') {
            stopLossFailCount.delete(mint);
            console.info(`[autosell] 🛑 Stop-loss EXECUTED for ${mint.slice(0,8)}`);
          } else {
            const fails = (stopLossFailCount.get(mint) ?? 0) + 1;
            stopLossFailCount.set(mint, fails);
            console.error(`[autosell] 🛑 Stop-loss FAILED (${fails}/${MAX_STOP_LOSS_FAILS}) for ${mint.slice(0,8)}`);
            if (fails >= MAX_STOP_LOSS_FAILS) {
              console.warn(`[autosell] 💀 ${mint.slice(0,8)} — ${MAX_STOP_LOSS_FAILS} stop-loss failures, marking as total loss`);
              await query(
                `UPDATE autosell_stages SET status = 'failed', sell_reason = 'STOP_LOSS_UNSELLABLE'
                 WHERE autobuy_job_id = $1 AND status = 'pending'`,
                [refStage.autobuy_job_id]
              );
              await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [refStage.autobuy_job_id]);
              stopLossFailCount.delete(mint);
            }
          }
          continue;
        }
      } else {
        // Price recovered above stop — reset confirmation counter
        if (stopLossConfirmCount.has(mint)) {
          console.debug(`[autosell] ✅ ${mint.slice(0,8)} recovered above stop — resetting confirm count`);
          stopLossConfirmCount.delete(mint);
        }
      }
    }

    // ── Time limit check ──────────────────────────────────────────────────────
    if (refStage.time_limit_enabled && refStage.time_limit_seconds > 0) {
      const anchor = refStage.last_activity_at ?? refStage.bought_at;
      if (anchor) {
        const elapsedSec = (Date.now() - new Date(anchor).getTime()) / 1000;
        if (elapsedSec > refStage.time_limit_seconds) {
          const elapsedMin = Math.floor(elapsedSec / 60);
          // Above entry = profitable slow mover — reset timer, wait for TP instead of selling at a loss
          if (refEntry > 0 && currentPriceSol > refEntry) {
            await query(`UPDATE autobuy_jobs SET last_activity_at = now() WHERE id = $1`, [refStage.autobuy_job_id]);
            console.info(
              `[time-limit] ⏸️ ${mint.slice(0,8)} — above entry (+${((currentPriceSol / refEntry - 1) * 100).toFixed(1)}%) after ${elapsedMin}min — timer reset, waiting for TP`
            );
          } else {
            // Below entry and inactive — cut losses
            console.warn(
              `[time-limit] ⏰ TIME_LIMIT_EXPIRED for ${mint.slice(0,8)} — ` +
              `${elapsedMin}min of inactivity (limit: ${refStage.time_limit_seconds / 60}min) — selling 95%`
            );
            const result = await claimAndSell(mint, refStage.autobuy_job_id, 95, 'TIME_LIMIT_EXPIRED', connection, keypair, !refStage.label?.includes(':pumpportal'));
            if (result === 'success') {
              timeLimitFailCount.delete(mint);
              console.info(`[time-limit] ✅ TIME_LIMIT_EXPIRED sell EXECUTED for ${mint.slice(0,8)}`);
            } else {
              const fails = (timeLimitFailCount.get(mint) ?? 0) + 1;
              timeLimitFailCount.set(mint, fails);
              console.error(`[time-limit] ❌ TIME_LIMIT sell FAILED (${fails}/${MAX_TIME_LIMIT_FAILS}) for ${mint.slice(0,8)}`);
              if (fails >= MAX_TIME_LIMIT_FAILS) {
                await query(
                  `UPDATE autosell_stages SET status = 'failed', sell_reason = 'TIME_LIMIT_UNSELLABLE'
                   WHERE autobuy_job_id = $1 AND status = 'pending'`,
                  [refStage.autobuy_job_id]
                );
                await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [refStage.autobuy_job_id]);
                timeLimitFailCount.delete(mint);
              }
            }
            continue;
          }
        } else if (elapsedSec > refStage.time_limit_seconds * 0.75) {
          // Warn at 75% of time limit
          const remainMin = Math.ceil((refStage.time_limit_seconds - elapsedSec) / 60);
          console.info(`[time-limit] ⚠️ ${mint.slice(0,8)} — ${remainMin}min until time limit expires`);
        }
      }
    }

    // ── Normal staged sell check ──────────────────────────────────────────────
    for (const stage of mintStages.sort((a, b) => a.stage_number - b.stage_number)) {
      // Skip moon bag placeholder stage (trigger_mult=9999) — managed by floor/trail separately
      if (stage.trigger_mult >= 50) {
        console.debug(`[autosell] 🌙 ${mint.slice(0,8)} moon bag stage pending — floor/trail watches it`);
        break;
      }

      const targetPrice = Number(stage.entry_price_sol) * stage.trigger_mult;

      if (currentPriceSol < targetPrice) {
        const multiplier = refStage.entry_price_sol > 0
          ? (currentPriceSol / Number(refStage.entry_price_sol)).toFixed(2)
          : '?';
        console.debug(
          `[autosell] Stage ${stage.stage_number} not ready — ` +
          `${multiplier}x (need ${stage.trigger_mult}x)`
        );
        break;
      }

      // Cooldown after 429 — don't retry the same stage for SELL_COOLDOWN_MS
      const cdUntil = sellCooldownMap.get(stage.id);
      if (cdUntil && Date.now() < cdUntil) {
        const remaining = Math.ceil((cdUntil - Date.now()) / 1000);
        console.debug(`[autosell] ⏳ Stage ${stage.stage_number} ${mint.slice(0,8)} cooldown (${remaining}s)`);
        break;
      }

      console.info(
        `[autosell] 🎯 Stage ${stage.stage_number} TRIGGERED for ${mint.slice(0,8)} — ` +
        `${stage.trigger_mult}x — selling ${stage.sell_percent}%`
      );

      const tokensToSell = BigInt(Math.floor(Number(stage.tokens_at_stage) * stage.sell_percent / 100));

      const { rows: claimed } = await query(
        `UPDATE autosell_stages SET status = 'triggered'
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [stage.id]
      );
      if (!claimed.length) {
        console.warn(`[autosell] Stage ${stage.id.slice(0,8)} already claimed — skipping`);
        break;
      }

      let sellResult = await executeAutoSell(
        { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_BPS },
        connection, keypair
      );
      if (!sellResult.success) {
        // Brief pause before retry to reduce burst rate
        await new Promise(r => setTimeout(r, 2000));
        sellResult = await executeAutoSell(
          { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_RETRY_BPS },
          connection, keypair
        );
      }

      if (sellResult.success) {
        sellCooldownMap.delete(stage.id);
        await query(
          `UPDATE autosell_stages SET
             status = 'executed', tokens_sold = $1, sol_received = $2,
             sell_price_sol = $3, tx_signature = $4, executed_at = now(),
             sell_reason = 'TAKE_PROFIT'
           WHERE id = $5`,
          [tokensToSell.toString(), sellResult.solReceived, sellResult.currentPriceSol,
           sellResult.txSignature, stage.id]
        );
        await query(
          `UPDATE autobuy_jobs SET
             total_sold_sol    = total_sold_sol + $1,
             sell_stage_reached = GREATEST(sell_stage_reached, $2),
             last_activity_at  = now()
           WHERE id = $3`,
          [sellResult.solReceived, stage.stage_number, stage.autobuy_job_id]
        );
        console.info(
          `[autosell] ✅ Stage ${stage.stage_number} SOLD — ` +
          `${tokensToSell} tok → ${sellResult.solReceived?.toFixed(4)} SOL ` +
          `tx:${sellResult.txSignature}`
        );

        // After stage 1 (90% TP), record floor for moon bag protection
        // stage 2 (multiplier=9999) is the moon bag placeholder — skip normal path for it
        if (stage.stage_number === 1 && stage.sell_percent >= 85 && stage.trigger_mult < 50 && refEntry > 0) {
          const tpFloor = refEntry * stage.trigger_mult;
          moonbagFloorMap.set(stage.autobuy_job_id, tpFloor);
          console.info(`[autosell] 🌙 Moon bag active — floor set at ${tpFloor.toExponential(4)} SOL/tok for ${mint.slice(0,8)} (10% rides, floor at TP price)`);
        }

        // Auto-close job when last sell stage executes (100% sell_percent or no pending stages left)
        if (stage.sell_percent >= 100) {
          await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [stage.autobuy_job_id]);
          console.info(`[autosell] 🏁 Job ${stage.autobuy_job_id.slice(0,8)} closed — all tokens sold`);
        } else {
          const pending = await query(
            `SELECT COUNT(*) as cnt FROM autosell_stages WHERE autobuy_job_id=$1 AND status='pending'`,
            [stage.autobuy_job_id]
          );
          if (Number(pending.rows[0]?.cnt ?? 0) === 0) {
            await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [stage.autobuy_job_id]);
            console.info(`[autosell] 🏁 Job ${stage.autobuy_job_id.slice(0,8)} closed — no more pending stages`);
          }
        }
      } else {
        await query(
          `UPDATE autosell_stages SET status = 'pending' WHERE id = $1 AND status = 'triggered'`,
          [stage.id]
        );
        // Set cooldown — 30s before next attempt (prevents 429 cascade)
        sellCooldownMap.set(stage.id, Date.now() + SELL_COOLDOWN_MS);
        console.error(
          `[autosell] ❌ Stage ${stage.stage_number} FAILED (${mint.slice(0,8)}): ${sellResult.error?.slice(0,200)} — cooldown 30s`
        );
        break;
      }
    }
  }
}

// ─── Buy cycle ────────────────────────────────────────────────────────────────

async function runBuyCycle() {
  const keypair = getKeypairFromEnv();
  if (!keypair) {
    console.warn('[autobuy] WALLET_PRIVATE_KEY not set — skipping buy cycle.');
    return;
  }

  const connection = getConnection();
  const jobs = await fetchAndLockDueJobs();
  if (!jobs.length) return;

  console.info(`[autobuy] Processing ${jobs.length} buy job(s).`);

  for (const job of jobs) {
    const tag = job.label ? `"${job.label}"` : job.mint_address.slice(0, 8) + '...';
    const slippage = job.slippage_bps ?? AUTOBUY_SLIPPAGE_BPS;
    console.info(`[autobuy] Buying ${job.amount_sol} SOL of ${tag} (slippage: ${slippage}bps)`);

    // Use PumpPortal for pump.fun tokens (label contains ':pumpportal'), Jupiter for Raydium
    const usePumpPortal = (job.label ?? '').includes(':pumpportal');
    let result: Awaited<ReturnType<typeof executeAutoBuy>>;

    if (usePumpPortal) {
      console.info(`[autobuy] Using PumpPortal for pump.fun token ${tag}`);
      const ppBuy = await buyViaPumpPortal(job.mint_address, Number(job.amount_sol), keypair, connection);
      result = {
        success: ppBuy.success,
        txSignature: ppBuy.txSignature,
        error: ppBuy.error,
        outputAmount: undefined,
        outputAmountRaw: undefined,
        entryPriceSol: undefined,
        inputAmountSol: Number(job.amount_sol),
      } as any;
    } else {
      result = await executeAutoBuy(
        { mintAddress: job.mint_address, amountSol: Number(job.amount_sol), slippageBps: slippage },
        connection, keypair
      );
    }

    await new Promise(r => setTimeout(r, 3000)); // rate limit

    if (result.success && result.txSignature) {
      // Verify actual on-chain balance — Jupiter quote ≠ what wallet received
      // (token transfer fees, max-wallet limits, etc. can reduce actual amount)
      let actualTokensReceived = result.outputAmountRaw ?? 0n;
      // Entry price in SOL per READABLE token — must match DexScreener priceNative units.
      // Old bug: dividing SOL by base-unit count produced SOL/base-unit (10^9× smaller than
      // priceNative), making every TP target fire immediately on the first price check.
      let actualEntryReadable: number | null = null;
      let zeroBal = false;
      try {
        await new Promise(r => setTimeout(r, 2000)); // wait 2s for chain to finalize
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          keypair.publicKey,
          { mint: new PublicKey(job.mint_address) }
        );
        const parsedInfo = (tokenAccounts.value[0]?.account?.data as any)?.parsed?.info;
        const onChainBalance = BigInt(parsedInfo?.tokenAmount?.amount ?? '0');
        // uiAmount = human-readable token balance (base units / 10^decimals)
        const uiAmount = Number(parsedInfo?.tokenAmount?.uiAmount ?? 0);
        if (onChainBalance === 0n) {
          zeroBal = true;
        } else {
          if (onChainBalance !== actualTokensReceived) {
            console.warn(`[autobuy] Balance mismatch: expected ${actualTokensReceived}, got ${onChainBalance}`);
            actualTokensReceived = onChainBalance;
          }
          // SOL per readable token — same unit as DexScreener priceNative
          actualEntryReadable = uiAmount > 0 ? Number(job.amount_sol) / uiAmount : null;
        }
      } catch (balErr: any) {
        console.warn(`[autobuy] Balance check error — fetching entry price from DexScreener: ${balErr.message}`);
        // Fallback: use current market price as entry estimate (close enough for TP/SL)
        const dsPrice = await getPriceSolViaDS(job.mint_address);
        actualEntryReadable = dsPrice > 0 ? dsPrice : null;
      }

      if (zeroBal) {
        console.warn(`[autobuy] ⚠️ ${tag} — TX sent but 0 tokens in wallet. Marking as failed.`);
        await markBuyError(job.id, 'zero-balance: tokens not received on-chain', job.interval_seconds);
        continue;
      }

      console.info(
        `[autobuy] ✅ Bought ${tag} — tokens: ${actualTokensReceived} ` +
        `entry: ${actualEntryReadable?.toExponential(4) ?? 'unknown'} SOL/tok tx: ${result.txSignature}`
      );
      await markBuySuccess(
        job.id, Number(job.amount_sol), result.txSignature, job.interval_seconds,
        actualEntryReadable, actualTokensReceived
      );
      if (job.autosell_enabled && actualTokensReceived > 0n && actualEntryReadable) {
        await createSellStages(
          job.id, job.mint_address, keypair.publicKey.toBase58(),
          actualEntryReadable, actualTokensReceived, job.label
        );
      }
    } else {
      console.error(`[autobuy] ❌ FAIL ${tag} (job:${job.id.slice(0,8)}) — ${result.error}`);
      await markBuyError(job.id, result.error ?? 'unknown', job.interval_seconds);
    }
  }
}

// ─── Cleanup stuck jobs ───────────────────────────────────────────────────────

async function deactivateStuckJobs() {
  const { rows } = await query<{ id: string; mint_address: string; label: string }>(
    `UPDATE autobuy_jobs SET active = false
     WHERE active = true
       AND entry_price_sol IS NULL
       AND created_at < now() - interval '30 minutes'
       AND (
         (label LIKE 'auto:%' AND error_count > 0)
         OR next_run_at < now() - interval '10 minutes'
       )
     RETURNING id, mint_address, label`
  );
  for (const row of rows) {
    console.warn(
      `[autobuy] 🧹 Stuck job ${row.id.slice(0,8)} ` +
      `(${row.label ?? row.mint_address.slice(0,8)}) deactivated — no successful buy`
    );
  }
}

// ─── Main scheduler ───────────────────────────────────────────────────────────

export async function startAutobuyScheduler() {
  console.info(`[autobuy] Scheduler started. Poll every ${POLL_MS / 1000}s.`);
  console.info(`[autobuy] Sell stages: ${SELL_STAGES.map(s => `${s.multiplier}x(${s.sellPct}%)`).join(' → ')}`);
  console.info(`[autobuy] Slippage — buy: ${AUTOBUY_SLIPPAGE_BPS}bps, sell: ${AUTOSELL_SLIPPAGE_BPS}bps`);
  console.info(`[autobuy] Stop-loss: ${STOP_LOSS_PCT > 0 ? `${(STOP_LOSS_PCT * 100).toFixed(0)}%` : 'disabled'}`);
  const earlyTrailPct = Number(process.env.EARLY_TRAIL_PCT || '6');
  console.info(`[autobuy] Early trail: ${earlyTrailPct}% from peak (fires when trail-stop > entry, pre-TP1)`);
  console.info(`[autobuy] Time limit: ${TIME_LIMIT_SECONDS / 60}min (activity threshold: ${(TIME_LIMIT_ACTIVITY_PCT * 100).toFixed(1)}% UP-only)`);
  console.info(`[autobuy] Auto-signal: ${AUTO_BUY_ENABLED ? 'ENABLED' : 'disabled'}`);

  let shouldStop = false;
  process.on('SIGINT',  () => { shouldStop = true; });
  process.on('SIGTERM', () => { shouldStop = true; });

  const keypair = getKeypairFromEnv();
  const walletAddress = keypair?.publicKey.toBase58() ?? '';

  // Start real-time graduation scanner (WebSocket — sub-second latency for pump.fun graduates)
  if (walletAddress) startGraduationScanner(walletAddress);

  // Start bonding curve scanner — buys tokens BEFORE graduation using PUMPFUN_WALLET
  startBondingScanner();

  // ─── Fast sell loop — checks every 1 second for TP/SL hits ───────────────
  // The main poll loop runs every 5s (including raydium scan). Memecoins pump and
  // dump in 2-4 seconds — by the time the main loop runs checkAndExecuteSells,
  // the price has already reverted. This fast loop catches TP windows before they close.
  let fastSellRunning = false;
  const fastSellInterval = setInterval(async () => {
    if (fastSellRunning || !walletAddress) return;
    fastSellRunning = true;
    try {
      await checkAndExecuteSells(walletAddress);
    } catch { /* logged inside checkAndExecuteSells */ }
    finally { fastSellRunning = false; }
  }, 1000);

  while (!shouldStop) {
    try { await deactivateStuckJobs(); } catch (err) {
      console.error('[autobuy] Stuck job cleanup error:', err);
    }

    // processAutoSignals (score-80 pump.fun tokens) DISABLED — 100% loss rate:
    // pump.fun tokens can't be sold via Jupiter or PumpPortal reliably → 0 SOL returned every time.
    // Only Raydium direct scan is used for new positions.

    try {
      if (walletAddress) await processRaydiumOpportunities(walletAddress);
    } catch (err) {
      console.error('[autobuy] Raydium scan error:', err);
    }

    try { await runBuyCycle(); } catch (err) {
      console.error('[autobuy] Buy cycle error:', err);
    }

    try {
      if (walletAddress) await checkAndExecuteSells(walletAddress);
    } catch (err) {
      console.error('[autobuy] Sell cycle error:', err);
    }

    if (shouldStop) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  clearInterval(fastSellInterval);
  console.info('[autobuy] Scheduler stopped.');
}

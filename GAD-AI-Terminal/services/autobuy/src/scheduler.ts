import { query } from '@lib/db';
import {
  executeAutoBuy,
  executeAutoSell,
  getTokenPriceInSol,
  getKeypairFromEnv,
  getConnection,
  SELL_STAGES,
} from '@lib/autobuy';
import { PublicKey } from '@solana/web3.js';
import { processAutoSignals, AUTO_BUY_ENABLED } from './auto-signal';

const POLL_MS    = Number(process.env.AUTOBUY_POLL_SECONDS  || '15') * 1000;
const MAX_ERRORS = Number(process.env.AUTOBUY_MAX_ERRORS    || '5');

const AUTOSELL_SLIPPAGE_BPS = Number(process.env.AUTOSELL_SLIPPAGE_BPS || '150');
const AUTOBUY_SLIPPAGE_BPS  = Number(process.env.AUTOBUY_SLIPPAGE_BPS  || '100');

// Stop-loss: sell ALL if price drops this % below entry (0 = disabled)
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || '15') / 100;

// Trailing stop: after first TP stage, sell ALL if price drops TRAIL_PCT from peak
const TRAIL_PCT = Number(process.env.TRAIL_PCT || '20') / 100;

// Time limit: sell 95% if token shows no price activity for this many seconds
const TIME_LIMIT_SECONDS      = Number(process.env.TIME_LIMIT_SECONDS      || '3600');
const TIME_LIMIT_ACTIVITY_PCT = Number(process.env.TIME_LIMIT_ACTIVITY_PCT || '0.5') / 100;

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

// Peak price tracking for trailing stop (mint → highest price seen)
const peakPriceMap = new Map<string, number>();

// ─── Buy helpers ──────────────────────────────────────────────────────────────

async function fetchAndLockDueJobs(): Promise<AutobuyJob[]> {
  const { rows } = await query<AutobuyJob>(
    `WITH locked AS (
       SELECT id FROM autobuy_jobs
       WHERE active = true AND next_run_at <= now()
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

// ─── Create sell stages after a buy ──────────────────────────────────────────

async function createSellStages(
  jobId: string, mintAddress: string, walletAddress: string,
  entryPriceSol: number, tokensBought: bigint
) {
  let tokensRemaining = tokensBought;
  for (const stage of SELL_STAGES) {
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
  console.info(`[autobuy] Created ${SELL_STAGES.length} sell stages for job ${jobId.slice(0,8)}`);
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
            COALESCE(j.sell_stage_reached, 0) AS sell_stage_reached
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
  keypair: ReturnType<typeof getKeypairFromEnv>
): Promise<'success' | 'fail'> {
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

  const sellResult = await executeAutoSell(
    { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_BPS },
    connection, keypair
  );

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
  } else {
    await query(
      `UPDATE autosell_stages SET status = 'pending' WHERE id = ANY($1)`,
      [stageIds]
    );
    return 'fail';
  }
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

    // ── Price check ───────────────────────────────────────────────────────────
    let currentPriceSol: number;
    try {
      const { priceSol } = await getTokenPriceInSol(mint, BigInt(Math.floor(refStage.tokens_at_stage)));
      currentPriceSol = priceSol / Number(refStage.tokens_at_stage);
      priceFailCount.delete(mint);
    } catch (err: any) {
      const fails = (priceFailCount.get(mint) ?? 0) + 1;
      priceFailCount.set(mint, fails);
      console.warn(`[autosell] Price check failed for ${mint.slice(0,8)} (${fails}/${MAX_PRICE_FAILS}): ${err.message}`);
      if (fails >= MAX_PRICE_FAILS) {
        console.warn(`[autosell] 💀 ${mint.slice(0,8)} — ${MAX_PRICE_FAILS} price failures, marking as dead loss`);
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

    // ── Activity tracking (for time limit reset) ──────────────────────────────
    const prev = prevPriceMap.get(mint);
    prevPriceMap.set(mint, currentPriceSol);
    if (prev !== undefined && prev > 0 && currentPriceSol > 0) {
      const pctChange = Math.abs((currentPriceSol - prev) / prev);
      if (pctChange >= TIME_LIMIT_ACTIVITY_PCT) {
        await query(
          `UPDATE autobuy_jobs SET last_activity_at = now() WHERE id = $1`,
          [refStage.autobuy_job_id]
        );
        console.info(
          `[time-limit] 📊 Activity on ${mint.slice(0,8)}: ${(pctChange * 100).toFixed(2)}% price change — timer reset`
        );
      }
    }

    // ── Trailing stop (active only after first TP stage executed) ────────────
    if (TRAIL_PCT > 0 && refStage.sell_stage_reached >= 1) {
      const peak = peakPriceMap.get(mint) ?? currentPriceSol;
      const newPeak = Math.max(peak, currentPriceSol);
      peakPriceMap.set(mint, newPeak);
      const trailStop = newPeak * (1 - TRAIL_PCT);
      if (currentPriceSol < trailStop) {
        console.warn(
          `[autosell] 📉 TRAILING STOP triggered for ${mint.slice(0,8)} — ` +
          `price ${currentPriceSol.toFixed(12)} < trail ${trailStop.toFixed(12)} ` +
          `(${(TRAIL_PCT * 100).toFixed(0)}% from peak ${newPeak.toFixed(12)})`
        );
        const result = await claimAndSell(mint, refStage.autobuy_job_id, 100, 'STOP_LOSS', connection, keypair);
        if (result === 'success') {
          peakPriceMap.delete(mint);
          console.info(`[autosell] 📉 Trailing stop EXECUTED for ${mint.slice(0,8)}`);
        } else {
          console.error(`[autosell] 📉 Trailing stop FAILED for ${mint.slice(0,8)}`);
        }
        continue;
      }
    }

    // ── Stop-loss check ───────────────────────────────────────────────────────
    if (STOP_LOSS_PCT > 0) {
      const refEntry = Number(refStage.entry_price_sol ?? 0);
      if (refEntry > 0 && currentPriceSol < refEntry * (1 - STOP_LOSS_PCT)) {
        console.warn(
          `[autosell] 🛑 STOP-LOSS triggered for ${mint.slice(0,8)} — ` +
          `price ${currentPriceSol.toFixed(12)} < stop ${(refEntry * (1 - STOP_LOSS_PCT)).toFixed(12)} ` +
          `(${(STOP_LOSS_PCT * 100).toFixed(0)}% below entry)`
        );
        const result = await claimAndSell(mint, refStage.autobuy_job_id, 100, 'STOP_LOSS', connection, keypair);
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
    }

    // ── Time limit check ──────────────────────────────────────────────────────
    if (refStage.time_limit_enabled && refStage.time_limit_seconds > 0) {
      const anchor = refStage.last_activity_at ?? refStage.bought_at;
      if (anchor) {
        const elapsedSec = (Date.now() - new Date(anchor).getTime()) / 1000;
        if (elapsedSec > refStage.time_limit_seconds) {
          const elapsedMin = Math.floor(elapsedSec / 60);
          console.warn(
            `[time-limit] ⏰ TIME_LIMIT_EXPIRED for ${mint.slice(0,8)} — ` +
            `${elapsedMin}min of inactivity (limit: ${refStage.time_limit_seconds / 60}min) — selling 95%`
          );
          const result = await claimAndSell(mint, refStage.autobuy_job_id, 95, 'TIME_LIMIT_EXPIRED', connection, keypair);
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
        } else if (elapsedSec > refStage.time_limit_seconds * 0.75) {
          // Warn at 75% of time limit
          const remainMin = Math.ceil((refStage.time_limit_seconds - elapsedSec) / 60);
          console.info(`[time-limit] ⚠️ ${mint.slice(0,8)} — ${remainMin}min until time limit expires`);
        }
      }
    }

    // ── Normal staged sell check ──────────────────────────────────────────────
    for (const stage of mintStages.sort((a, b) => a.stage_number - b.stage_number)) {
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

      const sellResult = await executeAutoSell(
        { mintAddress: mint, tokenAmount: tokensToSell, slippageBps: AUTOSELL_SLIPPAGE_BPS },
        connection, keypair
      );

      if (sellResult.success) {
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
      } else {
        await query(
          `UPDATE autosell_stages SET status = 'pending' WHERE id = $1 AND status = 'triggered'`,
          [stage.id]
        );
        console.error(
          `[autosell] ❌ Stage ${stage.stage_number} FAILED (${mint.slice(0,8)}): ${sellResult.error?.slice(0,200)}`
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

    const result = await executeAutoBuy(
      { mintAddress: job.mint_address, amountSol: Number(job.amount_sol), slippageBps: slippage },
      connection, keypair
    );

    await new Promise(r => setTimeout(r, 3000)); // Jupiter rate limit

    if (result.success && result.txSignature) {
      // Verify actual on-chain balance — Jupiter quote ≠ what wallet received
      // (token transfer fees, max-wallet limits, etc. can reduce actual amount)
      let actualTokensReceived = result.outputAmountRaw ?? 0n;
      try {
        await new Promise(r => setTimeout(r, 2000)); // wait 2s for chain to finalize
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          keypair.publicKey,
          { mint: new PublicKey(job.mint_address) }
        );
        const onChainBalance = BigInt(
          (tokenAccounts.value[0]?.account?.data as any)?.parsed?.info?.tokenAmount?.amount ?? '0'
        );
        if (onChainBalance === 0n) {
          console.warn(`[autobuy] ⚠️ ${tag} — TX sent but 0 tokens in wallet. Marking as failed.`);
          await markBuyError(job.id, 'zero-balance: tokens not received on-chain', job.interval_seconds);
          continue;
        }
        if (onChainBalance !== actualTokensReceived) {
          console.warn(`[autobuy] Balance mismatch: expected ${actualTokensReceived}, got ${onChainBalance}`);
          actualTokensReceived = onChainBalance;
        }
      } catch (balErr: any) {
        console.warn(`[autobuy] Balance check error (using quote): ${balErr.message}`);
      }

      console.info(`[autobuy] ✅ Bought ${tag} — tokens: ${actualTokensReceived} tx: ${result.txSignature}`);
      const actualEntry = actualTokensReceived > 0n
        ? Number(job.amount_sol) / Number(actualTokensReceived)
        : (result.entryPriceSol ?? null);
      await markBuySuccess(
        job.id, Number(job.amount_sol), result.txSignature, job.interval_seconds,
        actualEntry, actualTokensReceived
      );
      if (job.autosell_enabled && actualTokensReceived > 0n && actualEntry) {
        await createSellStages(
          job.id, job.mint_address, keypair.publicKey.toBase58(),
          actualEntry, actualTokensReceived
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
  console.info(`[autobuy] Time limit: ${TIME_LIMIT_SECONDS / 60}min (activity threshold: ${(TIME_LIMIT_ACTIVITY_PCT * 100).toFixed(1)}%)`);
  console.info(`[autobuy] Auto-signal: ${AUTO_BUY_ENABLED ? 'ENABLED' : 'disabled'}`);

  let shouldStop = false;
  process.on('SIGINT',  () => { shouldStop = true; });
  process.on('SIGTERM', () => { shouldStop = true; });

  const keypair = getKeypairFromEnv();
  const walletAddress = keypair?.publicKey.toBase58() ?? '';

  while (!shouldStop) {
    try { await deactivateStuckJobs(); } catch (err) {
      console.error('[autobuy] Stuck job cleanup error:', err);
    }

    try {
      if (walletAddress) await processAutoSignals(walletAddress);
    } catch (err) {
      console.error('[autobuy] Auto-signal error:', err);
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

  console.info('[autobuy] Scheduler stopped.');
}

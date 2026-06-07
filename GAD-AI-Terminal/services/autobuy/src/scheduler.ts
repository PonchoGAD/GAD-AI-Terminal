import { query, transaction } from '@lib/db';
import {
  executeAutoBuy,
  executeAutoSell,
  getTokenPriceInSol,
  getKeypairFromEnv,
  getConnection,
  SELL_STAGES,
} from '@lib/autobuy';
import { processAutoSignals, AUTO_BUY_ENABLED } from './auto-signal';

const POLL_MS    = Number(process.env.AUTOBUY_POLL_SECONDS  || '15') * 1000;
const MAX_ERRORS = Number(process.env.AUTOBUY_MAX_ERRORS    || '5');

// Configurable via env — safe defaults for real money
const AUTOSELL_SLIPPAGE_BPS = Number(process.env.AUTOSELL_SLIPPAGE_BPS || '150');
const AUTOBUY_SLIPPAGE_BPS  = Number(process.env.AUTOBUY_SLIPPAGE_BPS  || '100');

// Stop-loss: sell ALL if price drops this % below entry (0 = disabled)
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || '50') / 100;

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
}

// ─── Buy helpers ──────────────────────────────────────────────────────────────

/**
 * Fetch due jobs with FOR UPDATE SKIP LOCKED — prevents two concurrent scheduler
 * instances from processing the same job simultaneously (double-buy protection).
 * Atomically pushes next_run_at forward so the job won't re-appear this cycle.
 */
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
       last_run_at          = now(),
       last_tx_signature    = $1,
       next_run_at          = now() + ($2 || ' seconds')::interval,
       total_buys           = total_buys + 1,
       total_spent_sol      = total_spent_sol + $3,
       error_count          = 0,
       last_error           = NULL,
       entry_price_sol      = COALESCE(entry_price_sol, $4),
       token_amount_bought  = COALESCE(token_amount_bought, 0) + $5
     WHERE id = $6`,
    [signature, String(intervalSeconds), amountSol,
     entryPriceSol, tokenAmountBought ? tokenAmountBought.toString() : '0', jobId]
  );
}

async function markBuyError(jobId: string, error: string, intervalSeconds: number) {
  const { rows } = await query<{ error_count: number }>(
    `UPDATE autobuy_jobs SET
       last_run_at  = now(),
       next_run_at  = now() + ($1 || ' seconds')::interval,
       error_count  = error_count + 1,
       last_error   = $2
     WHERE id = $3 RETURNING error_count`,
    [String(intervalSeconds), error.slice(0, 500), jobId]
  );
  if ((rows[0]?.error_count ?? 0) >= MAX_ERRORS) {
    await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [jobId]);
    console.warn(`[autobuy] Job ${jobId} auto-disabled after ${rows[0].error_count} errors.`);
  }
}

// ─── Create sell stages after a buy ──────────────────────────────────────────

async function createSellStages(
  jobId: string,
  mintAddress: string,
  walletAddress: string,
  entryPriceSol: number,
  tokensBought: bigint
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
  console.info(`[autobuy] Created ${SELL_STAGES.length} sell stages for job ${jobId.slice(0, 8)}`);
}

// ─── Sell cycle ───────────────────────────────────────────────────────────────

async function fetchPendingSellStages(): Promise<AutosellStage[]> {
  const { rows } = await query<AutosellStage & { entry_price_sol: number }>(
    `SELECT s.id, s.autobuy_job_id, s.mint_address, s.stage_number,
            s.trigger_mult, s.sell_percent, s.tokens_at_stage,
            j.entry_price_sol
     FROM autosell_stages s
     JOIN autobuy_jobs j ON j.id = s.autobuy_job_id
     WHERE s.status = 'pending'
       AND j.entry_price_sol IS NOT NULL
       AND s.tokens_at_stage IS NOT NULL
     ORDER BY s.stage_number ASC
     LIMIT 50`
  );
  return rows;
}

async function checkAndExecuteSells(walletAddress: string) {
  const stages = await fetchPendingSellStages();
  if (!stages.length) return;

  const keypair = getKeypairFromEnv();
  if (!keypair) return;
  const connection = getConnection();

  // Group by mint to batch price checks
  const byMint = new Map<string, AutosellStage[]>();
  for (const s of stages) {
    const list = byMint.get(s.mint_address) ?? [];
    list.push(s);
    byMint.set(s.mint_address, list);
  }

  for (const [mint, mintStages] of byMint) {
    const refStage = mintStages[0];
    if (!refStage.tokens_at_stage || Number(refStage.tokens_at_stage) <= 0) continue;

    let currentPriceSol: number;
    try {
      const { priceSol } = await getTokenPriceInSol(mint, BigInt(Math.floor(refStage.tokens_at_stage)));
      currentPriceSol = priceSol / Number(refStage.tokens_at_stage);
    } catch (err: any) {
      console.warn(`[autosell] Price check failed for ${mint.slice(0,8)}: ${err.message}`);
      continue;
    }

    // ── Stop-loss check ───────────────────────────────────────────────────────
    if (STOP_LOSS_PCT > 0) {
      const refEntry = Number(mintStages[0]?.entry_price_sol ?? 0);
      if (refEntry > 0 && currentPriceSol < refEntry * (1 - STOP_LOSS_PCT)) {
        console.warn(
          `[autosell] 🛑 STOP-LOSS triggered for ${mint.slice(0, 8)} — ` +
          `price ${currentPriceSol.toFixed(10)} < stop ${(refEntry * (1 - STOP_LOSS_PCT)).toFixed(10)} ` +
          `(${(STOP_LOSS_PCT * 100).toFixed(0)}% below entry ${refEntry.toFixed(10)})`
        );
        // Sell all pending stages immediately — claim stage 1 and sell all tokens
        const pendingStages = mintStages.filter(s => s.status === 'pending' && s.tokens_at_stage);
        const totalTokens = pendingStages.reduce((acc, s) => acc + Number(s.tokens_at_stage ?? 0), 0n as unknown as number);
        // Sum up tokens across all pending stages for stage-1 amount (this covers everything)
        const firstPending = pendingStages[0];
        if (firstPending && firstPending.tokens_at_stage) {
          const { rows: claimed } = await query(
            `UPDATE autosell_stages SET status = 'triggered'
             WHERE autobuy_job_id = $1 AND status = 'pending'
             RETURNING id, tokens_at_stage`,
            [firstPending.autobuy_job_id]
          );
          if (claimed.length) {
            const totalToSell = claimed.reduce(
              (acc, r) => acc + BigInt(Math.floor(Number(r.tokens_at_stage ?? 0))), 0n
            );
            const sellResult = await executeAutoSell(
              { mintAddress: mint, tokenAmount: totalToSell, slippageBps: AUTOSELL_SLIPPAGE_BPS },
              connection, keypair
            );
            const stageIds = claimed.map(r => r.id);
            if (sellResult.success) {
              await query(
                `UPDATE autosell_stages SET status = 'executed', sol_received = $1,
                   tx_signature = $2, executed_at = now()
                 WHERE id = ANY($3)`,
                [sellResult.solReceived, sellResult.txSignature, stageIds]
              );
              await query(
                `UPDATE autobuy_jobs SET active = false, total_sold_sol = total_sold_sol + $1
                 WHERE id = $2`,
                [sellResult.solReceived, firstPending.autobuy_job_id]
              );
              console.info(
                `[autosell] 🛑 Stop-loss EXECUTED — ${totalToSell}tok → ${sellResult.solReceived?.toFixed(4)}SOL ` +
                `tx:${sellResult.txSignature}`
              );
            } else {
              await query(
                `UPDATE autosell_stages SET status = 'pending' WHERE id = ANY($1)`,
                [stageIds]
              );
              console.error(`[autosell] 🛑 Stop-loss FAILED: ${sellResult.error}`);
            }
          }
        }
        continue; // Skip normal stage processing for this mint
      }
    }

    for (const stage of mintStages.sort((a, b) => a.stage_number - b.stage_number)) {
      const targetPrice = Number(stage.entry_price_sol) * stage.trigger_mult;

      if (currentPriceSol < targetPrice) {
        console.debug(
          `[autosell] Stage ${stage.stage_number} not ready — ` +
          `current ${currentPriceSol.toFixed(10)} < target ${targetPrice.toFixed(10)} ` +
          `(${stage.trigger_mult}x of entry)`
        );
        break;
      }

      console.info(
        `[autosell] 🎯 Stage ${stage.stage_number} TRIGGERED for ${mint.slice(0,8)} — ` +
        `${stage.trigger_mult}x — selling ${stage.sell_percent}% of position`
      );

      const tokensToSell = BigInt(Math.floor(
        Number(stage.tokens_at_stage) * stage.sell_percent / 100
      ));

      // Atomic claim: only one scheduler instance will succeed here.
      // If another instance already changed status away from 'pending', skip.
      const { rows: claimed } = await query(
        `UPDATE autosell_stages SET status = 'triggered'
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [stage.id]
      );
      if (!claimed.length) {
        console.warn(`[autosell] Stage ${stage.id} already claimed by another process — skipping`);
        break;
      }

      const sellResult = await executeAutoSell(
        {
          mintAddress: mint,
          tokenAmount: tokensToSell,
          slippageBps: AUTOSELL_SLIPPAGE_BPS,
        },
        connection,
        keypair
      );

      if (sellResult.success) {
        await query(
          `UPDATE autosell_stages SET
             status = 'executed', tokens_sold = $1, sol_received = $2,
             sell_price_sol = $3, tx_signature = $4, executed_at = now()
           WHERE id = $5`,
          [tokensToSell.toString(), sellResult.solReceived, sellResult.currentPriceSol,
           sellResult.txSignature, stage.id]
        );
        await query(
          `UPDATE autobuy_jobs SET
             total_sold_sol = total_sold_sol + $1,
             sell_stage_reached = GREATEST(sell_stage_reached, $2)
           WHERE id = $3`,
          [sellResult.solReceived, stage.stage_number, stage.autobuy_job_id]
        );
        console.info(
          `[autosell] ✅ Stage ${stage.stage_number} SOLD — ` +
          `${tokensToSell.toString()} tokens → ${sellResult.solReceived?.toFixed(4)} SOL ` +
          `(job:${stage.autobuy_job_id.slice(0,8)}) tx: ${sellResult.txSignature}`
        );
      } else {
        // Revert so next cycle retries — but only if we still own 'triggered'
        await query(
          `UPDATE autosell_stages SET status = 'pending'
           WHERE id = $1 AND status = 'triggered'`,
          [stage.id]
        );
        console.error(
          `[autosell] ❌ Stage ${stage.stage_number} sell failed ` +
          `(mint:${mint.slice(0,8)} job:${stage.autobuy_job_id.slice(0,8)}): ${sellResult.error}`
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
  // FOR UPDATE SKIP LOCKED prevents double-buy across concurrent instances
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

    if (result.success && result.txSignature) {
      console.info(`[autobuy] ✅ Bought ${tag} — tokens: ${result.outputAmount} tx: ${result.txSignature}`);
      await markBuySuccess(
        job.id, Number(job.amount_sol), result.txSignature, job.interval_seconds,
        result.entryPriceSol ?? null,
        result.outputAmountRaw ?? null
      );

      if (job.autosell_enabled && result.outputAmountRaw && result.entryPriceSol) {
        await createSellStages(
          job.id, job.mint_address, keypair.publicKey.toBase58(),
          result.entryPriceSol, result.outputAmountRaw
        );
      }
    } else {
      console.error(`[autobuy] ❌ FAIL ${tag} (job:${job.id.slice(0,8)}) — ${result.error}`);
      await markBuyError(job.id, result.error ?? 'unknown', job.interval_seconds);
    }
  }
}

// ─── Main scheduler ───────────────────────────────────────────────────────────

export async function startAutobuyScheduler() {
  console.info(`[autobuy] Scheduler started. Poll every ${POLL_MS / 1000}s.`);
  console.info(`[autobuy] Sell stages: ${SELL_STAGES.map(s => `${s.multiplier}x(${s.sellPct}%)`).join(' → ')}`);
  console.info(`[autobuy] Slippage — buy: ${AUTOBUY_SLIPPAGE_BPS}bps, sell: ${AUTOSELL_SLIPPAGE_BPS}bps`);
  console.info(`[autobuy] Stop-loss: ${STOP_LOSS_PCT > 0 ? `${(STOP_LOSS_PCT * 100).toFixed(0)}%` : 'disabled'}`);
  console.info(`[autobuy] Auto-signal: ${AUTO_BUY_ENABLED ? 'ENABLED' : 'disabled (set AUTO_BUY_ENABLED=true to activate)'}`);

  let shouldStop = false;
  process.on('SIGINT',  () => { shouldStop = true; });
  process.on('SIGTERM', () => { shouldStop = true; });

  const keypair = getKeypairFromEnv();
  const walletAddress = keypair?.publicKey.toBase58() ?? '';

  while (!shouldStop) {
    // 1. Process scanner signals → create buy jobs automatically
    try {
      if (walletAddress) await processAutoSignals(walletAddress);
    } catch (err) {
      console.error('[autobuy] Auto-signal error:', err);
    }

    // 2. Execute pending buy jobs
    try {
      await runBuyCycle();
    } catch (err) {
      console.error('[autobuy] Buy cycle error:', err);
    }

    // 3. Check sell stages + stop-loss
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

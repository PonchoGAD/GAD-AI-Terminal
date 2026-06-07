"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAutobuyScheduler = startAutobuyScheduler;
const db_1 = require("@lib/db");
const autobuy_1 = require("@lib/autobuy");
const POLL_INTERVAL_MS = Number(process.env.AUTOBUY_POLL_SECONDS || '15') * 1000;
// After this many consecutive errors on a job, deactivate it automatically
const MAX_CONSECUTIVE_ERRORS = Number(process.env.AUTOBUY_MAX_ERRORS || '5');
async function fetchDueJobs() {
    const { rows } = await (0, db_1.query)(`SELECT id, mint_address, label, amount_sol, slippage_bps, interval_seconds, error_count
     FROM autobuy_jobs
     WHERE active = true AND next_run_at <= now()
     ORDER BY next_run_at ASC
     LIMIT 20`);
    return rows;
}
async function markSuccess(jobId, amountSol, signature, intervalSeconds) {
    await (0, db_1.query)(`UPDATE autobuy_jobs SET
       last_run_at       = now(),
       last_tx_signature = $1,
       next_run_at       = now() + ($2 || ' seconds')::interval,
       total_buys        = total_buys + 1,
       total_spent_sol   = total_spent_sol + $3,
       error_count       = 0,
       last_error        = NULL
     WHERE id = $4`, [signature, String(intervalSeconds), amountSol, jobId]);
}
async function markError(jobId, error, intervalSeconds) {
    const { rows } = await (0, db_1.query)(`UPDATE autobuy_jobs SET
       last_run_at  = now(),
       next_run_at  = now() + ($1 || ' seconds')::interval,
       error_count  = error_count + 1,
       last_error   = $2
     WHERE id = $3
     RETURNING error_count`, [String(intervalSeconds), error.slice(0, 500), jobId]);
    const newErrorCount = rows[0]?.error_count ?? 0;
    if (newErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        await (0, db_1.query)(`UPDATE autobuy_jobs SET active = false WHERE id = $1`, [jobId]);
        console.warn(`[autobuy] Job ${jobId} auto-disabled after ${newErrorCount} consecutive errors.`);
    }
}
async function runCycle() {
    const keypair = (0, autobuy_1.getKeypairFromEnv)();
    if (!keypair) {
        console.warn('[autobuy] WALLET_PRIVATE_KEY not set — skipping cycle.');
        return;
    }
    const connection = (0, autobuy_1.getConnection)();
    const jobs = await fetchDueJobs();
    if (!jobs.length)
        return;
    console.info(`[autobuy] Processing ${jobs.length} due job(s).`);
    for (const job of jobs) {
        const tag = job.label ? `"${job.label}"` : job.mint_address.slice(0, 8) + '...';
        console.info(`[autobuy] Buying ${job.amount_sol} SOL of ${tag}`);
        const result = await (0, autobuy_1.executeAutoBuy)({
            mintAddress: job.mint_address,
            amountSol: Number(job.amount_sol),
            slippageBps: job.slippage_bps
        }, connection, keypair);
        if (result.success && result.txSignature) {
            console.info(`[autobuy] OK ${tag} — tx: ${result.txSignature}`);
            await markSuccess(job.id, Number(job.amount_sol), result.txSignature, job.interval_seconds);
        }
        else {
            console.error(`[autobuy] FAIL ${tag} — ${result.error}`);
            await markError(job.id, result.error ?? 'unknown error', job.interval_seconds);
        }
    }
}
async function startAutobuyScheduler() {
    console.info(`[autobuy] Scheduler started. Poll every ${POLL_INTERVAL_MS / 1000}s.`);
    let shouldStop = false;
    process.on('SIGINT', () => { shouldStop = true; });
    process.on('SIGTERM', () => { shouldStop = true; });
    while (!shouldStop) {
        try {
            await runCycle();
        }
        catch (err) {
            console.error('[autobuy] Cycle error:', err);
        }
        if (shouldStop)
            break;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    console.info('[autobuy] Scheduler stopped.');
}

/**
 * Graduation Scanner
 *
 * Monitors PumpPortal WebSocket for bonding curve completions (migrations to PumpSwap/Raydium).
 * When a token graduates from pump.fun bonding curve:
 *  1. Wait GRAD_DELAY_MS (default 45s) for DEX pool to be indexed by DexScreener
 *  2. Verify: liq > $10k, active trading (buys5m >= 3), not dumping (pc5m > -5%)
 *  3. Create autobuy job via Jupiter (routes through PumpSwap or Raydium)
 *
 * NOTE: pump.fun now graduates primarily to PumpSwap (not Raydium).
 * Jupiter supports PumpSwap routing, so this scanner handles both.
 */

import WebSocket from 'ws';
import axios from 'axios';
import { query } from '@lib/db';
import { AUTO_BUY_ENABLED, getLiqTier } from './auto-signal';

const PUMPPORTAL_WS   = 'wss://pumpportal.fun/api/data';
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens';

// Delay after detecting graduation — wait for DexScreener to index the Raydium pool
const GRAD_DELAY_MS      = Number(process.env.GRAD_DELAY_MS      || '45000'); // 45s
// Buy parameters for graduates
const GRAD_BUY_SOL       = Number(process.env.GRAD_BUY_SOL       || '0.02');
const GRAD_MAX_SOL_DAILY = Number(process.env.GRAD_MAX_SOL_DAILY || '0.3');
const GRAD_MAX_POSITIONS = Number(process.env.GRAD_MAX_POSITIONS || '3');
// Liquidity range — fresh pool is $10-200k
const GRAD_MIN_LIQ = Number(process.env.GRAD_MIN_LIQ || '10000');
const GRAD_MAX_LIQ = Number(process.env.GRAD_MAX_LIQ || '200000');
// How many buys in first 5m to confirm traders are active (not a ghost pool)
const GRAD_MIN_BUYS_5M = Number(process.env.GRAD_MIN_BUYS_5M || '3');
// Skip if dumping immediately after graduation
const GRAD_MIN_PC5M = Number(process.env.GRAD_MIN_PC5M || '-5');

// PumpSwap is pump.fun's own AMM — where most tokens graduate now. Jupiter routes through it.
const JUPITER_DEX_IDS = ['raydium', 'orca', 'meteora', 'lifinity', 'pumpswap'];
const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

// Deduplicate pending graduations
const pendingGraduates = new Map<string, number>(); // mint → queuedAt

async function getDailyGradSpent(): Promise<number> {
  const { rows } = await query<{ spent: string }>(
    `SELECT COALESCE(SUM(amount_sol), 0) AS spent
     FROM autobuy_jobs
     WHERE created_at > now() - interval '24 hours'
       AND label LIKE 'auto:graduate:%'
       AND entry_price_sol IS NOT NULL`
  );
  return Number(rows[0]?.spent ?? 0);
}

async function getActiveGradPositions(): Promise<number> {
  const { rows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM autobuy_jobs
     WHERE active = true AND label LIKE 'auto:graduate:%'`
  );
  return Number(rows[0]?.cnt ?? 0);
}

async function recentlyBought(mint: string): Promise<boolean> {
  const { rows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM autobuy_jobs
     WHERE mint_address = $1 AND created_at > now() - interval '8 hours'`,
    [mint]
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function previouslyLost(mint: string): Promise<boolean> {
  const { rows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM autobuy_jobs
     WHERE mint_address = $1
       AND active = false AND amount_sol > 0
       AND total_sold_sol < amount_sol * 0.80
       AND created_at > now() - interval '7 days'`,
    [mint]
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function processGraduate(mint: string): Promise<void> {
  if (!AUTO_BUY_ENABLED) return;
  if (SKIP_MINTS.has(mint)) return;

  const [dailySpent, activePos] = await Promise.all([getDailyGradSpent(), getActiveGradPositions()]);
  if (dailySpent >= GRAD_MAX_SOL_DAILY) {
    console.debug(`[grad-scan] Daily limit: ${dailySpent.toFixed(3)}/${GRAD_MAX_SOL_DAILY} SOL`);
    return;
  }
  if (activePos >= GRAD_MAX_POSITIONS) {
    console.debug(`[grad-scan] Max positions: ${activePos}/${GRAD_MAX_POSITIONS}`);
    return;
  }
  if (await recentlyBought(mint)) {
    console.debug(`[grad-scan] Already bought ${mint.slice(0, 8)}`);
    return;
  }
  if (await previouslyLost(mint)) {
    console.debug(`[grad-scan] Previously lost on ${mint.slice(0, 8)} — skip`);
    return;
  }

  // Verify Raydium pool via DexScreener
  try {
    const r = await axios.get(`${DEXSCREENER_URL}/${mint}`, { timeout: 8_000 });
    const pairs: any[] = r.data?.pairs ?? [];

    const bestPair = pairs
      .filter(p =>
        p.chainId === 'solana' &&
        JUPITER_DEX_IDS.includes(p.dexId?.toLowerCase() ?? '')
      )
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

    if (!bestPair) {
      // Not indexed yet — retry once after 30 more seconds
      console.debug(`[grad-scan] ${mint.slice(0, 8)} — no Raydium pool yet, retry in 30s`);
      setTimeout(() => processGraduate(mint).catch(() => {}), 30_000);
      return;
    }

    const liq    = bestPair.liquidity?.usd ?? 0;
    const vol5m  = bestPair.volume?.m5 ?? 0;
    const pc5m   = Number(bestPair.priceChange?.m5 ?? 0);
    const buys5m = bestPair.txns?.m5?.buys ?? 0;
    const sells5m = bestPair.txns?.m5?.sells ?? 0;
    const sym    = bestPair.baseToken?.symbol ?? mint.slice(0, 8);

    if (liq < GRAD_MIN_LIQ) {
      console.info(`[grad-scan] ✗liq  ${sym.padEnd(10)} liq:$${liq.toFixed(0)} < $${GRAD_MIN_LIQ}`);
      return;
    }
    if (liq > GRAD_MAX_LIQ) {
      console.info(`[grad-scan] ✗top  ${sym.padEnd(10)} liq:$${liq.toFixed(0)} — already pumped`);
      return;
    }
    if (buys5m < GRAD_MIN_BUYS_5M) {
      console.info(`[grad-scan] ✗dead ${sym.padEnd(10)} buys5m:${buys5m} — ghost pool`);
      return;
    }
    if (pc5m < GRAD_MIN_PC5M) {
      console.info(`[grad-scan] ✗dump ${sym.padEnd(10)} pc5m:${pc5m.toFixed(1)}% — dumping at open`);
      return;
    }

    console.info(
      `[grad-scan] 🎓 GRADUATE ${sym} (${mint.slice(0, 8)}) ` +
      `dex:${bestPair.dexId} liq:$${liq.toFixed(0)} ` +
      `vol5m:$${vol5m.toFixed(0)} pc5m:${pc5m.toFixed(1)}% ` +
      `buys:${buys5m} sells:${sells5m}`
    );

    if (!configuredWallet) {
      console.warn('[grad-scan] wallet not configured — cannot create job');
      return;
    }

    const tier = getLiqTier(liq);
    await query(
      `INSERT INTO autobuy_jobs
         (mint_address, label, amount_sol, slippage_bps, interval_seconds,
          wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, true)`,
      [
        mint,
        `auto:graduate:liq${Math.round(liq / 1000)}k:${bestPair.dexId}`,
        GRAD_BUY_SOL,
        300,           // 3% slippage — fresh pools have wider spread
        86400,
        configuredWallet,
        1200,          // 20 min hold — graduates move fast, don't overstay
      ]
    );

    console.info(`[grad-scan] ✅ Job created for ${sym} — ${GRAD_BUY_SOL} SOL via Jupiter`);
  } catch (err: any) {
    console.warn(`[grad-scan] Error verifying ${mint.slice(0, 8)}: ${err.message?.slice(0, 80)}`);
  }
}

// ─── WebSocket connection ──────────────────────────────────────────────────────

let wsInstance: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let gradCount = 0;

function connectGraduationWS(): void {
  if (wsInstance) {
    wsInstance.removeAllListeners();
    try { wsInstance.terminate(); } catch {}
    wsInstance = null;
  }

  const ws = new WebSocket(PUMPPORTAL_WS);
  wsInstance = ws;

  ws.on('open', () => {
    console.info('[grad-scan] ✅ Connected to PumpPortal WebSocket — subscribing migrations');
    ws.send(JSON.stringify({ method: 'subscribeMigrations' }));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // PumpPortal sends migration events when a token completes its bonding curve
      // Event fields: txType:"migrate", mint, signature, solAmount
      const isMigration =
        msg.txType === 'migrate' ||
        msg.txType === 'migration' ||
        (typeof msg.mint === 'string' && typeof msg.signature === 'string' && msg.bondingCurveKey);

      if (!isMigration) return;

      const mint: string = msg.mint ?? msg.baseMint ?? '';
      if (!mint || pendingGraduates.has(mint)) return;

      gradCount++;
      console.info(
        `[grad-scan] 🚀 Graduation #${gradCount}: ${mint.slice(0, 8)} ` +
        `sol:${Number(msg.solAmount ?? 0).toFixed(2)} — scheduling buy in ${GRAD_DELAY_MS / 1000}s`
      );

      pendingGraduates.set(mint, Date.now());
      setTimeout(() => {
        pendingGraduates.delete(mint);
        if (AUTO_BUY_ENABLED) {
          processGraduate(mint).catch(err =>
            console.warn(`[grad-scan] processGraduate error: ${err.message}`)
          );
        }
      }, GRAD_DELAY_MS);
    } catch { /* ignore JSON parse errors */ }
  });

  ws.on('error', (err) => {
    console.warn(`[grad-scan] WebSocket error: ${err.message?.slice(0, 80)}`);
  });

  ws.on('close', (code) => {
    wsInstance = null;
    console.warn(`[grad-scan] Connection closed (${code}) — reconnecting in 15s`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectGraduationWS, 15_000);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

let running = false;
let configuredWallet = '';

export function startGraduationScanner(walletAddress: string): void {
  if (running) return;
  running = true;
  configuredWallet = walletAddress;
  console.info('[grad-scan] Starting graduation scanner (PumpPortal WebSocket)');
  connectGraduationWS();
}

export function stopGraduationScanner(): void {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (wsInstance) {
    wsInstance.removeAllListeners();
    try { wsInstance.terminate(); } catch {}
    wsInstance = null;
  }
  console.info('[grad-scan] Stopped');
}

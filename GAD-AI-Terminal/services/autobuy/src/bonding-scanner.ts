/**
 * Bonding Curve Scanner — Delayed Entry Strategy
 *
 * Strategy:
 *  1. Detect new token launch (txType:create)
 *  2. Add to watchlist if dev buy >= 1.5 SOL
 *  3. Watch trade events for the token for up to 3 minutes
 *  4. Enter ONLY when 130+ unique wallets have bought AND mcap >= $9000
 *  5. Exit: 5 TP levels (1.5/2/3/5/8x) selling 20/20/20/20/10%
 *           10% moon bag with -20% trailing stop from ATH
 *           17% stop-loss from entry price
 *           10-minute hard time limit → force exit
 *
 * Ethics: no manipulation, no fake volume, no coordinated trading.
 */

import WebSocket from 'ws';
import axios from 'axios';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { query } from '@lib/db';
import { getFearGreed } from './auto-signal';
import { executeAutoSell, getKeypairFromEnv, getConnection } from '@lib/autobuy';

const PUMPPORTAL_WS  = 'wss://pumpportal.fun/api/data';
const PUMPPORTAL_BUY = 'https://pumpportal.fun/api/trade-local';
const BIRDEYE_BASE   = 'https://public-api.birdeye.so';
const PUMPFUN_API    = 'https://frontend-api.pump.fun';

// ─── Config ───────────────────────────────────────────────────────────────────

const BONDING_BUY_SOL        = Number(process.env.BONDING_BUY_SOL       || '0.02');
const BONDING_MAX_SOL_DAILY  = Number(process.env.BONDING_MAX_SOL_DAILY || '0.2');
const BONDING_MAX_POSITIONS  = Number(process.env.BONDING_MAX_POSITIONS || '3');

// Dev must have bought at least this much SOL at launch (skin in the game)
const BONDING_MIN_DEV_BUY    = Number(process.env.BONDING_MIN_DEV_BUY   || '0.3');

// Min market cap in USD at the moment we enter
const BONDING_MIN_MCAP_USD   = Number(process.env.BONDING_MIN_MCAP_USD  || '6000');

// Max market cap in SOL at entry (don't buy tokens that already pumped too much)
const BONDING_MAX_MCAP_SOL   = Number(process.env.BONDING_MAX_MCAP_SOL  || '600');

// Min unique buyers in watchlist window before we enter
const BONDING_MIN_BUYERS     = Number(process.env.BONDING_MIN_BUYERS    || '50');

// Watchlist window: drop candidate if buyers not reached within this time
const BONDING_WATCH_TIMEOUT_MS = Number(process.env.BONDING_WATCH_TIMEOUT_SEC || '1020') * 1000;

// Time limit before force-exit (seconds).
// 10 min hold — mover tokens can take 3-8 min to fully pump after initial signal.
const BONDING_TIME_LIMIT_SEC = Number(process.env.BONDING_TIME_LIMIT_SEC || '600');

// Stop loss: 10% from entry. Movers either go up fast or dump — no reason to hold losers.
const BONDING_STOP_PCT = Number(process.env.BONDING_STOP_PCT || '0.10');

// TP levels: aggressive early-exit strategy.
// Sell majority (60%) at 1.5x to lock profit, trail the rest.
// Bonding curve movers pump fast and dump fast — capture the spike, not the dream.
const BONDING_TPS = [
  { mult: 1.5, sellPct: 60 },  // lock 60% at 1.5x — first real profit
  { mult: 2.5, sellPct: 30 },  // 30% more at 2.5x — if it keeps going
  { mult: 5.0, sellPct: 10 },  // moon bag at 5x
];

// Moon bag trailing stop: sell remaining if price drops 15% from ATH
const MOON_BAG_TRAIL_PCT = Number(process.env.MOON_BAG_TRAIL_PCT || '0.15');

// Dump detection: if sell volume > buy volume * this ratio → exit
const BONDING_DUMP_RATIO = Number(process.env.BONDING_DUMP_RATIO || '2.5');

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY ?? '';
const SOLANA_RPC      = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

// ─── HOT token poller config (wallet 2) ──────────────────────────────────────
// Polls pump.fun for recently-traded bonding curve tokens not yet caught by WebSocket.
// Use case: tokens that launched before the scanner started, or are in the HOT section.
const BONDING_HOT_ENABLED     = process.env.BONDING_HOT_ENABLED === 'true';
// Poll every 20s to catch early movers before the pump is over
const BONDING_HOT_INTERVAL_MS = Number(process.env.BONDING_HOT_INTERVAL_SEC || '20') * 1000;
// $10k+ mcap = enough pool depth to avoid 20-50% slippage on exit (0.015 SOL = 0.01% of pool)
const BONDING_HOT_MIN_MCAP    = Number(process.env.BONDING_HOT_MIN_MCAP_USD || '10000');
const BONDING_HOT_MAX_MCAP    = Number(process.env.BONDING_HOT_MAX_MCAP_USD || '25000');
// Movers window: catch tokens 90 seconds to 8 minutes old.
// Past initial sniper bots (first 60-90s), but before the pump is fully in.
const BONDING_HOT_MIN_AGE_SEC = Number(process.env.BONDING_HOT_MIN_AGE_SEC || '60');    // 1 min
const BONDING_HOT_MAX_AGE_SEC = Number(process.env.BONDING_HOT_MAX_AGE_SEC || '1200'); // 20 min

// NEW token poller — catches tokens 1-14 min old before they become HOT
// Earlier stage = higher risk, smaller position, tighter limits
const BONDING_NEW_ENABLED      = process.env.BONDING_NEW_ENABLED === 'true';
const BONDING_NEW_INTERVAL_MS  = Number(process.env.BONDING_NEW_INTERVAL_SEC || '30') * 1000;
const BONDING_NEW_BUY_SOL      = Number(process.env.BONDING_NEW_BUY_SOL      || '0.01');
const BONDING_NEW_MIN_AGE_SEC  = Number(process.env.BONDING_NEW_MIN_AGE_SEC  || '60');   // 1 min min
const BONDING_NEW_MAX_AGE_SEC  = Number(process.env.BONDING_NEW_MAX_AGE_SEC  || '840');  // 14 min max
const BONDING_NEW_MIN_MCAP     = Number(process.env.BONDING_NEW_MIN_MCAP_USD || '500');
const BONDING_NEW_MAX_MCAP     = Number(process.env.BONDING_NEW_MAX_MCAP_USD || '5000');
const BONDING_NEW_TIME_LIMIT   = Number(process.env.BONDING_NEW_TIME_LIMIT_SEC || '120'); // 2 min max hold
const BONDING_NEW_STOP_PCT     = Number(process.env.BONDING_NEW_STOP_PCT     || '0.08'); // 8% stop

// ─── Graduation Hunter — pump.fun tokens close to $69k graduation ─────────────
// Pre-graduation pump: community rushes to push mcap over $69k → token graduates to Raydium.
// Entry at $40k-65k gives a 5-70% gain on graduation. Uses bonding curve sell (pool='pump').
const GRAD_HUNTER_ENABLED     = process.env.GRAD_HUNTER_ENABLED === 'true';
const GRAD_HUNTER_INTERVAL_MS = Number(process.env.GRAD_HUNTER_INTERVAL_SEC  || '30') * 1000;
const GRAD_HUNTER_BUY_SOL     = Number(process.env.GRAD_HUNTER_BUY_SOL       || '0.015');
const GRAD_HUNTER_MIN_MCAP    = Number(process.env.GRAD_HUNTER_MIN_MCAP_USD  || '25000');
const GRAD_HUNTER_MAX_MCAP    = Number(process.env.GRAD_HUNTER_MAX_MCAP_USD  || '65000');
const GRAD_HUNTER_TIME_LIMIT  = Number(process.env.GRAD_HUNTER_TIME_LIMIT_SEC || '1800'); // 30 min
const GRAD_HUNTER_STOP_PCT    = Number(process.env.GRAD_HUNTER_STOP_PCT       || '0.15'); // 15% — gives room for dips on freshly-graduated tokens
// TP: capture graduation pop ($25k → $69k = 2.76x max, $40k → $69k = 1.73x)
// At $25k entry: sell 40% at +50% (on the way up), rest at +120% (near graduation)
const GRAD_TPS = [
  { mult: 1.50, sellPct: 40 },  // lock 40% at +50%
  { mult: 2.20, sellPct: 60 },  // exit rest at +120% (approaching graduation)
];

// ─── PumpSwap Trader — graduated tokens on real AMM pool ─────────────────────
// After graduation to PumpSwap, tokens get real AMM depth → sell via PumpPortal pool='pumpswap'.
// Fresh graduates (<2h old) often rally 30-100% as new buyers discover them on DEX aggregators.
const PUMPSWAP_ENABLED        = process.env.PUMPSWAP_ENABLED === 'true';
const PUMPSWAP_INTERVAL_MS    = Number(process.env.PUMPSWAP_INTERVAL_SEC      || '20') * 1000;
const PUMPSWAP_BUY_SOL        = Number(process.env.PUMPSWAP_BUY_SOL           || '0.015');
const PUMPSWAP_MIN_LIQ        = Number(process.env.PUMPSWAP_MIN_LIQ_USD       || '8000');
const PUMPSWAP_MAX_LIQ        = Number(process.env.PUMPSWAP_MAX_LIQ_USD       || '500000');
const PUMPSWAP_MAX_AGE_MIN    = Number(process.env.PUMPSWAP_MAX_AGE_MIN       || '480');   // 8 hours
const PUMPSWAP_TIME_LIMIT     = Number(process.env.PUMPSWAP_TIME_LIMIT_SEC    || '1800');  // 30 min
const PUMPSWAP_STOP_PCT       = Number(process.env.PUMPSWAP_STOP_PCT          || '0.08');
const PUMPSWAP_TPS = [
  { mult: 1.30, sellPct: 60 },  // fresh graduates often +30-50%
  { mult: 2.00, sellPct: 40 },  // moon bag if it keeps running
];

// Live SOL price (updated every 5 min)
let solPriceUsd = 150;

async function refreshSolPrice(): Promise<void> {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 5000 });
    const p = Number(r.data?.solana?.usd);
    if (p > 0) solPriceUsd = p;
  } catch { /* keep existing price */ }
}

// Known rug / bot patterns — skip immediately
const RUG_PATTERNS = [
  'rug', 'scam', 'fake', 'test', 'airdrop', 'free', 'safe', 'legit',
  'moonhav', 'manhiv', 'manhive', 'moonhive',
];

function isRugPattern(name: string, symbol: string): boolean {
  const text = `${name} ${symbol}`.toLowerCase();
  return RUG_PATTERNS.some(p => text.includes(p));
}

// ─── Birdeye Security Check ───────────────────────────────────────────────────

interface SecurityResult { safe: boolean; reason?: string; }

async function checkBirdeyeSecurity(mint: string): Promise<SecurityResult> {
  if (!BIRDEYE_API_KEY) return { safe: true };
  try {
    const r = await axios.get(
      `${BIRDEYE_BASE}/defi/token_security?address=${mint}`,
      { headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }, timeout: 5_000 }
    );
    const d = r.data?.data;
    if (!d) return { safe: true };
    if (d.freezeAuthority) return { safe: false, reason: 'freeze authority' };
    if (d.mintAuthority)   return { safe: false, reason: 'mint authority' };
    const top1pct = Number(d.ownerPercent ?? d.top10HolderPercent ?? 0);
    if (top1pct > 80) return { safe: false, reason: `top holder ${top1pct.toFixed(0)}%` };
    return { safe: true };
  } catch {
    return { safe: true };
  }
}

// ─── Keypair loading ──────────────────────────────────────────────────────────

function loadPumpFunKeypair(): Keypair | null {
  const pk = process.env.PUMPFUN_WALLET_PRIVATE_KEY;
  if (!pk) { console.warn('[bonding-scan] PUMPFUN_WALLET_PRIVATE_KEY not set'); return null; }
  try { return Keypair.fromSecretKey(bs58.decode(pk)); }
  catch { console.error('[bonding-scan] Invalid PUMPFUN_WALLET_PRIVATE_KEY'); return null; }
}

function loadPumpFunKeypair2(): Keypair | null {
  const pk = process.env.PUMPFUN_WALLET_PRIVATE_KEY_2;
  if (!pk) return null;
  try { return Keypair.fromSecretKey(bs58.decode(pk)); }
  catch { console.error('[bonding-scan] Invalid PUMPFUN_WALLET_PRIVATE_KEY_2'); return null; }
}

// ─── Buy/sell via PumpPortal ──────────────────────────────────────────────────

async function sendPumpTx(
  txBytes: Uint8Array, keypair: Keypair, connection: Connection, skipPreflight = true
): Promise<string> {
  const { VersionedTransaction } = await import('@solana/web3.js');
  // VersionedTransaction.deserialize handles both versioned (v0) and legacy messages.
  // Do NOT check txBytes[0] — byte 0 is the compact-u16 signature count (0x01), not the
  // message version prefix. The version prefix lives at byte 65 (after 1-sig placeholder).
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([keypair]);
  return connection.sendTransaction(tx, { skipPreflight, maxRetries: 5 });
}

async function buyOnBondingCurve(
  mint: string, amountSol: number, keypair: Keypair, connection: Connection,
  pool: string = 'pump'
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  try {
    const resp = await axios.post(
      PUMPPORTAL_BUY,
      { publicKey: keypair.publicKey.toBase58(), action: 'buy', mint,
        amount: amountSol, denominatedInSol: 'true', slippage: 25, priorityFee: 0.002, pool },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );
    const txBytes = new Uint8Array(resp.data as ArrayBuffer);
    const txSignature = await sendPumpTx(txBytes, keypair, connection, true);
    await connection.confirmTransaction(txSignature, 'confirmed');
    console.info(`[bonding-scan] ✅ Bought ${mint.slice(0, 8)} for ${amountSol} SOL | tx:${txSignature.slice(0, 20)}`);
    return { success: true, txSignature };
  } catch (err: any) {
    const msg = err?.response?.data
      ? Buffer.from(err.response.data as ArrayBuffer).toString('utf8').slice(0, 200)
      : err.message?.slice(0, 200);
    console.warn(`[bonding-scan] Buy failed ${mint.slice(0, 8)}: ${msg}`);
    return { success: false, error: msg };
  }
}

async function sellOnBondingCurve(
  mint: string, pct: number, keypair: Keypair, connection: Connection,
  pool: string = 'pump'
): Promise<{ success: boolean; solReceived?: number }> {
  try {
    const balBefore = await connection.getBalance(keypair.publicKey).catch(() => 0);
    const resp = await axios.post(
      PUMPPORTAL_BUY,
      { publicKey: keypair.publicKey.toBase58(), action: 'sell', mint,
        amount: `${pct}%`, denominatedInSol: 'false', slippage: 50, priorityFee: 0.005, pool },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );
    const txBytes = new Uint8Array(resp.data as ArrayBuffer);
    // Log first bytes to detect error responses vs valid tx
    if (txBytes.length < 50) {
      const text = Buffer.from(txBytes).toString('utf8').slice(0, 200);
      console.warn(`[bonding-scan] Sell response too short (${txBytes.length}b): ${text}`);
      return { success: false };
    }
    const txSignature = await sendPumpTx(txBytes, keypair, connection, true);
    await connection.confirmTransaction(txSignature, 'confirmed');
    const balAfter = await connection.getBalance(keypair.publicKey).catch(() => 0);
    const solReceived = Math.max(0, (balAfter - balBefore) / 1e9);
    if (solReceived === 0) {
      console.warn(`[bonding-scan] ⚠️ Sell TX confirmed but 0 SOL received for ${mint.slice(0, 8)} — bonding curve may be graduated/empty`);
    } else {
      console.info(`[bonding-scan] 💰 Sold ${pct}% of ${mint.slice(0, 8)} → ${solReceived.toFixed(5)} SOL`);
    }

    // Accumulate total_sold_sol on EVERY sell (partial TPs + final)
    // pct >= 95 → close position (active=false); partial sells keep active=true
    await query(
      `UPDATE autobuy_jobs
       SET total_sold_sol  = COALESCE(total_sold_sol, 0) + $1,
           active          = CASE WHEN $2 >= 95 THEN false ELSE active END,
           last_activity_at = now()
       WHERE mint_address=$3 AND label LIKE 'auto:bonding%' AND active=true`,
      [solReceived, pct, mint]
    ).catch(() => {});
    return { success: true, solReceived };
  } catch (err: any) {
    console.warn(`[bonding-scan] Sell failed ${mint.slice(0, 8)}: ${err.message?.slice(0, 120)}`);
    return { success: false };
  }
}

// ─── Watchlist (candidates before entry) ─────────────────────────────────────

interface BondingCandidate {
  mint: string;
  symbol: string;
  name: string;
  devBuySol: number;
  mcapSol: number;
  uniqueBuyers: Set<string>;
  addedAt: number;
}

const candidateTokens = new Map<string, BondingCandidate>();

// ─── Position tracker ─────────────────────────────────────────────────────────

interface BondingPosition {
  mint: string;
  symbol: string;
  name: string;
  buyTx: string;
  buyTime: number;
  buySol: number;
  entryMcapSol: number;
  currentMcapSol: number;
  peakMcapSol: number;   // for moon-bag trailing stop
  tpIndex: number;       // next TP index (0-4), 5 = all TPs done
  allTpsDone: boolean;   // moon-bag mode: hold 10% with trailing stop
  uniqueBuyers: Set<string>;
  recentBuySol: number;
  recentSellSol: number;
  windowResetAt: number;
  dexPool?: string;      // 'pump' = bonding curve | 'pumpswap' = graduated PumpSwap
  tpLevels?: Array<{ mult: number; sellPct: number }>;  // per-strategy TP, defaults to BONDING_TPS
  stopPct?: number;      // per-strategy stop-loss, defaults to BONDING_STOP_PCT
}

const positions = new Map<string, BondingPosition>();
// Wallet 2 positions (HOT token trades)
const positions2 = new Map<string, BondingPosition>();

// Stop-loss confirmation counters — require 2 consecutive below-stop readings before firing
// Prevents single-candle stop hunts (one bad DexScreener reading triggers permanent sell)
const stopLossConfirms = new Map<string, number>();
const STOP_CONFIRMS_REQUIRED = 2;

// ─── DexScreener polling watchdog ────────────────────────────────────────────

// Poll positions every 10s so we don't miss a fast bonding curve peak
const DS_POLL_INTERVAL_MS = 10_000;
const lastWsEventAt = new Map<string, number>();

async function getDSMcapSol(mint: string): Promise<number> {
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5_000 }
    );
    const pairs: any[] = r.data?.pairs ?? [];
    if (!pairs.length) return 0;
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (best.marketCap) return Number(best.marketCap) / (Number(best.priceUsd ?? 1) / Number(best.priceNative ?? 1));
    return Number(best.fdv ?? 0) / Number(best.priceUsd ?? 1) * Number(best.priceNative ?? 0);
  } catch {
    return 0;
  }
}

async function pollBondingPositionsMap(
  posMap: Map<string, BondingPosition>, keypair: Keypair, connection: Connection
): Promise<void> {
  for (const [mint, pos] of posMap.entries()) {
    const lastEvent = lastWsEventAt.get(mint) ?? 0;
    if (Date.now() - lastEvent < 60_000 && lastEvent > 0) continue;

    const mcapSol = await getDSMcapSol(mint);
    if (!mcapSol || mcapSol < 0.01) continue;

    pos.currentMcapSol = mcapSol;
    pos.peakMcapSol = Math.max(pos.peakMcapSol, mcapSol);
    const mult = pos.entryMcapSol > 0 ? mcapSol / pos.entryMcapSol : 1;

    console.info(`[bonding-scan] 🔍 POLL ${pos.symbol} ${mult.toFixed(2)}x`);
    await checkPositionExits(mint, pos, mcapSol, mult, keypair, connection, 'poll', posMap);
    if (wsInstance?.readyState === WebSocket.OPEN) {
      wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }
  }
}

async function pollBondingPositions(keypair: Keypair, connection: Connection): Promise<void> {
  if (positions.size > 0) await pollBondingPositionsMap(positions, keypair, connection);
  if (positions2.size > 0 && keypairInstance2 && connectionInstance) {
    await pollBondingPositionsMap(positions2, keypairInstance2, connectionInstance);
  }
}

// ─── Shared exit logic ────────────────────────────────────────────────────────

async function checkPositionExits(
  mint: string, pos: BondingPosition, mcapSol: number, mult: number,
  keypair: Keypair, connection: Connection, source: string,
  posMap: Map<string, BondingPosition> = positions
): Promise<void> {
  const pool      = pos.dexPool ?? 'pump';
  const tpLevels  = pos.tpLevels ?? BONDING_TPS;
  const stopPct   = pos.stopPct  ?? BONDING_STOP_PCT;

  // Stop-loss (requires 2 consecutive below-stop readings to prevent stop-hunt sells)
  if (mult <= 1 - stopPct) {
    const confirms = (stopLossConfirms.get(mint) ?? 0) + 1;
    if (confirms < STOP_CONFIRMS_REQUIRED) {
      stopLossConfirms.set(mint, confirms);
      console.info(`[bonding-scan] ⚠️ STOP WARNING ${pos.symbol} ${mult.toFixed(2)}x [${source}] (${confirms}/${STOP_CONFIRMS_REQUIRED}) — waiting for confirmation`);
      return;
    }
    stopLossConfirms.delete(mint);
    console.info(`[bonding-scan] 🔴 STOP ${pos.symbol} ${mult.toFixed(2)}x [${source}] — confirmed ${STOP_CONFIRMS_REQUIRED}x — selling 100%`);
    posMap.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection, pool);
    return;
  }
  // Price recovered above stop — reset confirmation counter
  if (stopLossConfirms.has(mint)) stopLossConfirms.delete(mint);

  // Moon-bag trailing stop
  if (pos.allTpsDone) {
    const currentFromPeak = pos.peakMcapSol > 0 ? mcapSol / pos.peakMcapSol : 1;
    if (currentFromPeak <= 1 - MOON_BAG_TRAIL_PCT) {
      console.info(`[bonding-scan] 🌙 TRAIL ${pos.symbol} peak:${pos.peakMcapSol.toFixed(0)} now:${mcapSol.toFixed(0)} — selling moon bag`);
      posMap.delete(mint);
      await sellOnBondingCurve(mint, 100, keypair, connection, pool);
    }
    return;
  }

  // TP levels (per-strategy or global)
  while (pos.tpIndex < tpLevels.length) {
    const tp = tpLevels[pos.tpIndex];
    if (mult >= tp.mult) {
      console.info(`[bonding-scan] 🎯 TP${pos.tpIndex + 1} ${pos.symbol} ${mult.toFixed(2)}x — selling ${tp.sellPct}% [${source}]`);
      await sellOnBondingCurve(mint, tp.sellPct, keypair, connection, pool);
      pos.tpIndex++;
      if (pos.tpIndex >= tpLevels.length) {
        pos.allTpsDone = true;
        console.info(`[bonding-scan] 🌙 All TPs done ${pos.symbol} — moon bag mode, trail ${MOON_BAG_TRAIL_PCT * 100}%`);
      }
    } else {
      break;
    }
  }
}

// ─── Daily spend counter ──────────────────────────────────────────────────────

let bondingDailySpent = 0;
let bondingDailyResetAt = Date.now() + 86400_000;

function checkDailyBudget(amount: number): boolean {
  if (Date.now() > bondingDailyResetAt) {
    bondingDailySpent = 0;
    bondingDailyResetAt = Date.now() + 86400_000;
  }
  return bondingDailySpent + amount <= BONDING_MAX_SOL_DAILY;
}

let bonding2DailySpent = 0;
let bonding2DailyResetAt = Date.now() + 86400_000;

function checkDailyBudget2(amount: number): boolean {
  if (Date.now() > bonding2DailyResetAt) {
    bonding2DailySpent = 0;
    bonding2DailyResetAt = Date.now() + 86400_000;
  }
  return bonding2DailySpent + amount <= BONDING_MAX_SOL_DAILY;
}

const recentMints = new Set<string>();

// ─── Process new token event (add to watchlist) ───────────────────────────────

async function processNewToken(
  event: any, keypair: Keypair, connection: Connection
): Promise<void> {
  const mint: string   = event.mint ?? '';
  const name: string   = event.name ?? '';
  const symbol: string = event.symbol ?? '';
  const devBuySol      = Number(event.solAmount ?? 0);
  const mcapSol        = Number(event.marketCapSol ?? 0);

  if (!mint) return;
  if (recentMints.has(mint) || candidateTokens.has(mint) || positions.has(mint)) return;
  if (!checkDailyBudget(BONDING_BUY_SOL)) return;

  // Rug pattern filter
  if (isRugPattern(name, symbol)) return;

  // Dev buy filter
  if (devBuySol < BONDING_MIN_DEV_BUY) {
    console.debug(`[bonding-scan] ✗dev  ${symbol} devBuy:${devBuySol.toFixed(2)} (min ${BONDING_MIN_DEV_BUY})`);
    return;
  }

  // Max mcap guard (already pumped)
  if (mcapSol > BONDING_MAX_MCAP_SOL) {
    console.debug(`[bonding-scan] ✗mcap ${symbol} mcap:${mcapSol.toFixed(0)} SOL (max ${BONDING_MAX_MCAP_SOL})`);
    return;
  }

  // Birdeye security (3s timeout, fail-open)
  const security = await Promise.race([
    checkBirdeyeSecurity(mint),
    new Promise<SecurityResult>(r => setTimeout(() => r({ safe: true }), 3000)),
  ]) as SecurityResult;

  if (!security.safe) {
    console.info(`[bonding-scan] ✗sec  ${symbol} ${security.reason}`);
    return;
  }

  console.info(
    `[bonding-scan] 👀 WATCHING "${name}" ($${symbol}) devBuy:${devBuySol.toFixed(2)} SOL — waiting ${BONDING_MIN_BUYERS} buyers`
  );

  candidateTokens.set(mint, {
    mint, symbol, name, devBuySol, mcapSol,
    uniqueBuyers: new Set<string>(),
    addedAt: Date.now(),
  });

  // Expire from watchlist if buyers threshold not reached
  setTimeout(() => {
    if (candidateTokens.has(mint)) {
      const c = candidateTokens.get(mint)!;
      console.debug(`[bonding-scan] ⌛ EXPIRED ${c.symbol} — only ${c.uniqueBuyers.size} buyers in ${BONDING_WATCH_TIMEOUT_MS / 1000}s`);
      candidateTokens.delete(mint);
    }
  }, BONDING_WATCH_TIMEOUT_MS);
}

// ─── Execute buy when candidate threshold reached ─────────────────────────────

async function executeEntryBuy(
  candidate: BondingCandidate, keypair: Keypair, connection: Connection
): Promise<void> {
  if (positions.size >= BONDING_MAX_POSITIONS) {
    console.info(`[bonding-scan] ✗pos  ${candidate.symbol} — max positions reached`);
    return;
  }
  if (!checkDailyBudget(BONDING_BUY_SOL)) {
    console.info(`[bonding-scan] ✗budget ${candidate.symbol} — daily limit reached`);
    return;
  }

  recentMints.add(candidate.mint);

  console.info(
    `[bonding-scan] 🎯 ENTRY "${candidate.name}" ($${candidate.symbol}) ` +
    `buyers:${candidate.uniqueBuyers.size} mcap:${candidate.mcapSol.toFixed(1)} SOL ($${(candidate.mcapSol * solPriceUsd).toFixed(0)})`
  );

  const buyResult = await buyOnBondingCurve(candidate.mint, BONDING_BUY_SOL, keypair, connection);
  if (!buyResult.success) return;

  bondingDailySpent += BONDING_BUY_SOL;

  try {
    await query(
      `INSERT INTO autobuy_jobs
         (mint_address, label, amount_sol, slippage_bps, interval_seconds,
          autosell_enabled, active, last_tx_signature, bought_at, last_activity_at,
          total_spent_sol, time_limit_seconds, time_limit_enabled)
       VALUES ($1,$2,$3,250,60,false,true,$4,now(),now(),$3,$5,true)
       ON CONFLICT DO NOTHING`,
      [
        candidate.mint,
        `auto:bonding:${candidate.symbol}:mcap${Math.round(candidate.mcapSol)}sol`,
        BONDING_BUY_SOL,
        buyResult.txSignature ?? '',
        BONDING_TIME_LIMIT_SEC,
      ]
    );
  } catch (dbErr: any) {
    console.warn(`[bonding-scan] DB record failed ${candidate.mint.slice(0, 8)}: ${dbErr.message?.slice(0, 80)}`);
  }

  positions.set(candidate.mint, {
    mint: candidate.mint, symbol: candidate.symbol, name: candidate.name,
    buyTx: buyResult.txSignature ?? '',
    buyTime: Date.now(),
    buySol: BONDING_BUY_SOL,
    entryMcapSol: candidate.mcapSol,
    currentMcapSol: candidate.mcapSol,
    peakMcapSol: candidate.mcapSol,
    tpIndex: 0,
    allTpsDone: false,
    uniqueBuyers: new Set(candidate.uniqueBuyers),
    recentBuySol: 0,
    recentSellSol: 0,
    windowResetAt: Date.now() + 90_000,
  });

  // Hard time limit: sell everything after 10 minutes
  setTimeout(async () => {
    const pos = positions.get(candidate.mint);
    if (!pos) return;
    console.info(`[bonding-scan] ⏱ TIME_LIMIT ${pos.symbol} — selling 100%`);
    positions.delete(candidate.mint);
    await sellOnBondingCurve(candidate.mint, 100, keypair, connection);
  }, BONDING_TIME_LIMIT_SEC * 1000);
}

// ─── Monitor positions via trade events ──────────────────────────────────────

async function onTradeEvent(
  event: any, keypair: Keypair, connection: Connection
): Promise<void> {
  const mint       = event.mint ?? '';
  const mcapSol    = Number(event.marketCapSol ?? 0);
  const txType     = event.txType as 'buy' | 'sell';
  const solAmount  = Number(event.solAmount ?? 0);
  const traderWallet = event.traderPublicKey ?? '';

  if (!mint || !mcapSol) return;
  lastWsEventAt.set(mint, Date.now());

  // ── Update watchlist candidate ────────────────────────────────────────────
  const candidate = candidateTokens.get(mint);
  if (candidate) {
    candidate.mcapSol = mcapSol;
    if (txType === 'buy' && traderWallet) candidate.uniqueBuyers.add(traderWallet);

    const mcapUsd = mcapSol * solPriceUsd;
    if (
      candidate.uniqueBuyers.size >= BONDING_MIN_BUYERS &&
      mcapUsd >= BONDING_MIN_MCAP_USD &&
      mcapSol <= BONDING_MAX_MCAP_SOL
    ) {
      candidateTokens.delete(mint);
      await executeEntryBuy(candidate, keypair, connection);
      if (positions.has(mint) && wsInstance?.readyState === WebSocket.OPEN) {
        wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      }
    }
    return;
  }

  // ── Update active position (wallet 1) ────────────────────────────────────
  const pos = positions.get(mint);
  if (pos) {
    if (txType === 'buy') {
      if (traderWallet) pos.uniqueBuyers.add(traderWallet);
      pos.recentBuySol += solAmount;
    } else if (txType === 'sell') {
      pos.recentSellSol += solAmount;
    }
    if (Date.now() > pos.windowResetAt) {
      pos.recentBuySol = 0; pos.recentSellSol = 0;
      pos.windowResetAt = Date.now() + 90_000;
    }
    pos.currentMcapSol = mcapSol;
    pos.peakMcapSol = Math.max(pos.peakMcapSol, mcapSol);
    const mult = pos.entryMcapSol > 0 ? mcapSol / pos.entryMcapSol : 1;
    if (!pos.allTpsDone && pos.recentSellSol > pos.recentBuySol * BONDING_DUMP_RATIO && pos.recentSellSol > 1.0) {
      console.warn(`[bonding-scan] 🚨 DUMP ${pos.symbol} — exiting`);
      positions.delete(mint);
      await sellOnBondingCurve(mint, 100, keypair, connection);
      return;
    }
    const heldSec = (Date.now() - pos.buyTime) / 1000;
    if (heldSec > 60 && pos.uniqueBuyers.size < 5 && heldSec < 300) {
      console.warn(`[bonding-scan] 🤖 BOT ${pos.symbol} ${pos.uniqueBuyers.size} buyers — exiting`);
      positions.delete(mint);
      await sellOnBondingCurve(mint, 100, keypair, connection);
      return;
    }
    await checkPositionExits(mint, pos, mcapSol, mult, keypair, connection, 'ws', positions);
  }

  // ── Update active position (wallet 2 — HOT tokens) ────────────────────────
  const pos2 = positions2.get(mint);
  if (pos2 && keypairInstance2 && connectionInstance) {
    if (txType === 'buy') { if (traderWallet) pos2.uniqueBuyers.add(traderWallet); pos2.recentBuySol += solAmount; }
    else if (txType === 'sell') { pos2.recentSellSol += solAmount; }
    if (Date.now() > pos2.windowResetAt) {
      pos2.recentBuySol = 0; pos2.recentSellSol = 0;
      pos2.windowResetAt = Date.now() + 90_000;
    }
    pos2.currentMcapSol = mcapSol;
    pos2.peakMcapSol = Math.max(pos2.peakMcapSol, mcapSol);
    const mult2 = pos2.entryMcapSol > 0 ? mcapSol / pos2.entryMcapSol : 1;
    if (!pos2.allTpsDone && pos2.recentSellSol > pos2.recentBuySol * BONDING_DUMP_RATIO && pos2.recentSellSol > 1.0) {
      console.warn(`[bonding-scan] 🚨 DUMP HOT ${pos2.symbol} — exiting w2`);
      positions2.delete(mint);
      await sellOnBondingCurve(mint, 100, keypairInstance2, connectionInstance, pos2.dexPool ?? 'pump');
      return;
    }
    await checkPositionExits(mint, pos2, mcapSol, mult2, keypairInstance2, connectionInstance, 'ws', positions2);
  }

  if (!pos && !pos2) return;
}

// ─── HOT token poller (wallet 2) ─────────────────────────────────────────────
// Polls pump.fun /coins endpoint every 60s for tokens already in HOT section.
// These are 15min-4h old tokens with recent trading activity — past initial rug risk.
// Wallet 1 handles brand-new launches via WebSocket. Wallet 2 handles HOT entries.

// Min Fear & Greed to allow HOT/MOVERS buys — don't burn money buying $500-$6k tokens in FEAR
const BONDING_HOT_MIN_FNG = Number(process.env.BONDING_HOT_MIN_FNG || '40');

async function pollHotPumpfunTokens(keypair: Keypair, connection: Connection): Promise<void> {
  if (!BONDING_HOT_ENABLED) return;

  // Market regime gate — MOVERS strategy requires NEUTRAL market (F&G >= 40)
  // In FEAR (F&G < 40), sub-$25k mcap bonding curve tokens have near-zero survival rate
  try {
    const fng = await getFearGreed();
    if (fng < BONDING_HOT_MIN_FNG) {
      console.debug(`[bonding-scan] HOT gate: F&G=${fng} < ${BONDING_HOT_MIN_FNG} (FEAR) — skipping MOVERS buys`);
      return;
    }
  } catch { /* fail-open: if F&G check fails, allow trading */ }

  try {
  // pump.fun API is Cloudflare-protected from VPS IPs (530 error).
  // Use DexScreener search filtered to pumpfun/pumpswap DEX instead.
  const DEXSCREENER = 'https://api.dexscreener.com/latest/dex';
  const queries = ['sol new', 'sol meme', 'sol pump'];
  const seenDs = new Set<string>();
  const pairCandidates: any[] = [];

  for (const q of queries) {
    try {
      const r = await axios.get(`${DEXSCREENER}/search?q=${encodeURIComponent(q)}`, { timeout: 6_000 });
      for (const p of (r.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'solana') continue;
        const dex = (p.dexId ?? '').toLowerCase();
        if (!['pumpfun', 'pumpswap'].includes(dex)) continue;
        const m = p.baseToken?.address;
        if (!m || seenDs.has(m)) continue;
        seenDs.add(m);
        pairCandidates.push(p);
      }
      await new Promise(res => setTimeout(res, 500));
    } catch { /* skip failed query */ }
  }

  try {
    // Supplement with DexScreener latest token profiles (fresh listings)
    const profR = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 6_000 });
    const mints: string[] = ((Array.isArray(profR.data) ? profR.data : []) as any[])
      .filter((p: any) => p.chainId === 'solana' && p.tokenAddress && !seenDs.has(p.tokenAddress))
      .map((p: any) => { seenDs.add(p.tokenAddress); return p.tokenAddress; })
      .slice(0, 20);
    if (mints.length > 0) {
      const pr = await axios.get(`${DEXSCREENER}/tokens/${mints.join(',')}`, { timeout: 6_000 });
      for (const p of (pr.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'solana') continue;
        const dex = (p.dexId ?? '').toLowerCase();
        if (!['pumpfun', 'pumpswap'].includes(dex)) continue;
        const m = p.baseToken?.address;
        if (!m || seenDs.has(m)) continue;
        seenDs.add(m);
        pairCandidates.push(p);
      }
    }
  } catch { /* fail-open */ }

  const coins: any[] = pairCandidates.map(p => {
    const dex = (p.dexId ?? '').toLowerCase();
    return {
      mint: p.baseToken?.address,
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name ?? p.baseToken?.symbol,
      usd_market_cap: Number(p.fdv ?? p.marketCap ?? 0),
      last_trade_timestamp: (p.volume?.m5 ?? 0) > 0 ? Math.floor(Date.now() / 1000) : 0,
      created_timestamp:    p.pairCreatedAt ? Math.floor(Number(p.pairCreatedAt) / 1000) : 0,
      vol5m:  p.volume?.m5 ?? 0,
      vol1h:  p.volume?.h1 ?? 0,
      buys5m: p.txns?.m5?.buys ?? 0,
      sells5m: p.txns?.m5?.sells ?? 0,
      complete: false,
      raydium_pool: null,
      pc5m: Number(p.priceChange?.m5 ?? 0),
      pc1h: Number(p.priceChange?.h1 ?? 0),
      // 'pump' = bonding curve, 'pumpswap' = graduated PumpSwap
      dexPool: dex === 'pumpswap' ? 'pumpswap' : 'pump',
    };
  }).filter(c => (c.vol5m ?? 0) > 200);  // must have at least $200 volume in last 5m

    for (const coin of coins) {
      const mint: string = coin.mint ?? '';
      if (!mint) continue;
      if (coin.complete || coin.raydium_pool) continue; // already graduated to Raydium
      if (recentMints.has(mint) || candidateTokens.has(mint)) continue;
      if (positions.has(mint) || positions2.has(mint)) continue;
      if (!checkDailyBudget2(BONDING_BUY_SOL)) break;
      if (positions2.size >= BONDING_MAX_POSITIONS) break;

      // Movers range: enough mcap for liquidity (avoid slippage), not yet fully pumped
      const mcapUsd = Number(coin.usd_market_cap ?? 0);
      if (mcapUsd < BONDING_HOT_MIN_MCAP || mcapUsd > BONDING_HOT_MAX_MCAP) continue;

      // Must have traded very recently (< 90 seconds ago)
      const lastTradeTs = Number(coin.last_trade_timestamp ?? 0) * 1000;
      if (Date.now() - lastTradeTs > 90_000) continue;

      // Token must be in the "safe" age window — past initial bot/sniper phase
      const createdTs = Number(coin.created_timestamp ?? 0) * 1000;
      const tokenAgeSec = createdTs > 0 ? (Date.now() - createdTs) / 1000 : 0;
      if (tokenAgeSec < BONDING_HOT_MIN_AGE_SEC || tokenAgeSec > BONDING_HOT_MAX_AGE_SEC) continue;

      const symbol = (coin.symbol ?? mint.slice(0, 4)).toUpperCase();
      const name   = coin.name ?? symbol;
      if (isRugPattern(name, symbol)) continue;

      const mcapSol = mcapUsd / solPriceUsd;
      if (mcapSol > BONDING_MAX_MCAP_SOL) continue;

      // ── MOVERS filter: catch sharp early price moves with volume acceleration ──
      const buys5m  = Number(coin.buys5m  ?? 0);
      const sells5m = Number(coin.sells5m ?? 0);
      const vol5m   = Number(coin.vol5m   ?? 0);
      const vol1h   = Number(coin.vol1h   ?? 0);
      const pc5m    = Number(coin.pc5m    ?? 0);
      const bsRatio = sells5m > 0 ? buys5m / sells5m : buys5m;

      // Need real buy transactions in last 5m
      if (buys5m < 5) {
        console.debug(`[bonding-scan] ✗mover ${symbol} buys5m:${buys5m} (min 5)`);
        continue;
      }
      // Need some real volume ($300+) — weeds out micro-trades
      if (vol5m < 300) {
        console.debug(`[bonding-scan] ✗mover ${symbol} vol5m:$${vol5m.toFixed(0)} (min $300)`);
        continue;
      }
      // MOVERS: price moving SHARPLY upward (5-30%). Under 5% = not a mover yet.
      // Over 30% = DexScreener lag means the pump is already over.
      if (pc5m < 5 || pc5m > 30) {
        console.debug(`[bonding-scan] ✗mover ${symbol} pc5m:${pc5m.toFixed(1)}% (need 5-30%)`);
        continue;
      }
      // Buyers must outnumber sellers (momentum confirmation)
      if (bsRatio < 1.5) {
        console.debug(`[bonding-scan] ✗mover ${symbol} bsRatio:${bsRatio.toFixed(1)} (min 1.5)`);
        continue;
      }
      // Volume momentum: for tokens older than 5min, last 5min must be > 30% of 1h volume
      // (i.e., this IS the active period, not old volume residue)
      if (tokenAgeSec > 300 && vol1h > 0 && vol5m / vol1h < 0.25) {
        console.debug(`[bonding-scan] ✗mover ${symbol} vol5m/vol1h:${(vol5m/vol1h*100).toFixed(0)}% (min 25% — not currently active)`);
        continue;
      }

      const dexPool = coin.dexPool ?? 'pump';
      console.info(
        `[bonding-scan] 🚀 MOVER ${symbol} mcap:$${mcapUsd.toFixed(0)} ` +
        `buys5m:${buys5m} ratio:${bsRatio.toFixed(1)}x ` +
        `vol5m:$${vol5m.toFixed(0)} pc5m:+${pc5m.toFixed(1)}% ` +
        `age:${(tokenAgeSec / 60).toFixed(1)}min pool:${dexPool} — entering`
      );

      recentMints.add(mint);
      const buyResult = await buyOnBondingCurve(mint, BONDING_BUY_SOL, keypair, connection, dexPool);
      if (!buyResult.success) { recentMints.delete(mint); continue; }

      bonding2DailySpent += BONDING_BUY_SOL;

      try {
        await query(
          `INSERT INTO autobuy_jobs
             (mint_address, label, amount_sol, slippage_bps, interval_seconds,
              autosell_enabled, active, last_tx_signature, bought_at, last_activity_at,
              total_spent_sol, time_limit_seconds, time_limit_enabled)
           VALUES ($1,$2,$3,250,60,false,true,$4,now(),now(),$3,$5,true)
           ON CONFLICT DO NOTHING`,
          [
            mint,
            `auto:bonding:mover:${symbol}:${dexPool}:mcap${Math.round(mcapSol)}sol`,
            BONDING_BUY_SOL, buyResult.txSignature ?? '',
            BONDING_TIME_LIMIT_SEC,
          ]
        );
        // Enrich tokens table with symbol/name from DexScreener (bonding scanner bypasses scanner service)
        await query(
          `INSERT INTO tokens (mint_address, symbol, name, last_updated)
           VALUES ($1,$2,$3,now())
           ON CONFLICT (mint_address) DO UPDATE
             SET symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
                 name   = COALESCE(EXCLUDED.name, tokens.name),
                 last_updated = now()`,
          [mint, symbol || null, name || null]
        );
      } catch (dbErr: any) {
        console.warn(`[bonding-scan] HOT DB error ${mint.slice(0, 8)}: ${dbErr.message?.slice(0, 60)}`);
      }

      positions2.set(mint, {
        mint, symbol, name,
        buyTx: buyResult.txSignature ?? '',
        buyTime: Date.now(),
        buySol: BONDING_BUY_SOL,
        entryMcapSol: mcapSol, currentMcapSol: mcapSol, peakMcapSol: mcapSol,
        tpIndex: 0, allTpsDone: false,
        uniqueBuyers: new Set(),
        recentBuySol: 0, recentSellSol: 0,
        windowResetAt: Date.now() + 90_000,
        dexPool,
      });

      if (wsInstance?.readyState === WebSocket.OPEN) {
        wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      }

      setTimeout(async () => {
        const p = positions2.get(mint);
        if (!p) return;
        console.info(`[bonding-scan] ⏱ TIME_LIMIT HOT ${p.symbol} w2 — selling 100%`);
        positions2.delete(mint);
        await sellOnBondingCurve(mint, 100, keypair, connection, p.dexPool ?? 'pump');
      }, BONDING_TIME_LIMIT_SEC * 1000);

      await new Promise(res => setTimeout(res, 2000)); // rate-limit between HOT entries
    }
  } catch (err: any) {
    console.debug(`[bonding-scan] HOT poll error: ${err.message?.slice(0, 60)}`);
  }
}

// ─── NEW token poller — catches tokens 1-14 min old ──────────────────────────
// Tokens in this window are past initial sniper phase (first 60s) but haven't
// built up enough data for the HOT poller (15min+ age). High risk, small size.

async function pollNewPumpfunTokens(keypair: Keypair, connection: Connection): Promise<void> {
  if (!BONDING_NEW_ENABLED) return;
  try {
    const DEXSCREENER = 'https://api.dexscreener.com/latest/dex';
    const seenDs = new Set<string>();
    const pairCandidates: any[] = [];

    // Token-profiles endpoint returns freshest listings
    try {
      const profR = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 6_000 });
      const mints: string[] = ((Array.isArray(profR.data) ? profR.data : []) as any[])
        .filter((p: any) => p.chainId === 'solana' && p.tokenAddress)
        .map((p: any) => { seenDs.add(p.tokenAddress); return p.tokenAddress; })
        .slice(0, 30);
      if (mints.length > 0) {
        const pr = await axios.get(`${DEXSCREENER}/tokens/${mints.join(',')}`, { timeout: 6_000 });
        for (const p of (pr.data?.pairs ?? []) as any[]) {
          if (p.chainId !== 'solana') continue;
          const dex = (p.dexId ?? '').toLowerCase();
          if (!['pumpfun'].includes(dex)) continue; // new tokens only on bonding curve
          const m = p.baseToken?.address;
          if (!m) continue;
          pairCandidates.push(p);
        }
      }
    } catch { /* fail-open */ }

    // Also search for very new tokens
    for (const q of ['sol new', 'sol gem']) {
      try {
        const r = await axios.get(`${DEXSCREENER}/search?q=${encodeURIComponent(q)}`, { timeout: 5_000 });
        for (const p of (r.data?.pairs ?? []) as any[]) {
          if (p.chainId !== 'solana') continue;
          if ((p.dexId ?? '').toLowerCase() !== 'pumpfun') continue;
          const m = p.baseToken?.address;
          if (!m || seenDs.has(m)) continue;
          seenDs.add(m);
          pairCandidates.push(p);
        }
        await new Promise(res => setTimeout(res, 400));
      } catch { /* skip */ }
    }

    const coins = pairCandidates.map(p => ({
      mint:            p.baseToken?.address,
      symbol:          p.baseToken?.symbol,
      name:            p.baseToken?.name ?? p.baseToken?.symbol,
      usd_market_cap:  Number(p.fdv ?? p.marketCap ?? 0),
      created_timestamp: p.pairCreatedAt ? Math.floor(Number(p.pairCreatedAt) / 1000) : 0,
      last_trade_timestamp: (p.volume?.m5 ?? 0) > 0 ? Math.floor(Date.now() / 1000) : 0,
      vol5m:   p.volume?.m5 ?? 0,
      buys5m:  p.txns?.m5?.buys ?? 0,
      sells5m: p.txns?.m5?.sells ?? 0,
      pc5m:    Number(p.priceChange?.m5 ?? 0),
      dexPool: 'pump',
    }));

    for (const coin of coins) {
      const mint: string = coin.mint ?? '';
      if (!mint) continue;
      if (recentMints.has(mint) || candidateTokens.has(mint)) continue;
      if (positions.has(mint) || positions2.has(mint)) continue;
      if (!checkDailyBudget2(BONDING_NEW_BUY_SOL)) break;
      if (positions2.size >= BONDING_MAX_POSITIONS) break;

      const mcapUsd = Number(coin.usd_market_cap ?? 0);
      if (mcapUsd < BONDING_NEW_MIN_MCAP || mcapUsd > BONDING_NEW_MAX_MCAP) continue;

      // Must be in the "new" age window (1-14 min)
      const createdTs = Number(coin.created_timestamp ?? 0) * 1000;
      const tokenAgeSec = createdTs > 0 ? (Date.now() - createdTs) / 1000 : 0;
      if (tokenAgeSec < BONDING_NEW_MIN_AGE_SEC || tokenAgeSec > BONDING_NEW_MAX_AGE_SEC) continue;

      // Must have traded very recently
      const lastTradeTs = Number(coin.last_trade_timestamp ?? 0) * 1000;
      if (Date.now() - lastTradeTs > 120_000) continue;

      const symbol = (coin.symbol ?? mint.slice(0, 4)).toUpperCase();
      const name   = coin.name ?? symbol;
      if (isRugPattern(name, symbol)) continue;

      const buys5m  = Number(coin.buys5m ?? 0);
      const sells5m = Number(coin.sells5m ?? 0);
      const vol5m   = Number(coin.vol5m ?? 0);
      const pc5m    = Number(coin.pc5m ?? 0);
      const bsRatio = sells5m > 0 ? buys5m / sells5m : buys5m;

      // Early stage filters — looser than HOT but demanding strong buy pressure
      if (buys5m < 8) {
        console.debug(`[bonding-scan] ✗new ${symbol} buys5m:${buys5m} (min 8)`);
        continue;
      }
      if (vol5m < 300) {
        console.debug(`[bonding-scan] ✗new ${symbol} vol5m:$${vol5m.toFixed(0)} (min $300)`);
        continue;
      }
      if (pc5m < 3 || pc5m > 25) {
        console.debug(`[bonding-scan] ✗new ${symbol} pc5m:${pc5m.toFixed(1)}% (need 3-25%)`);
        continue;
      }
      if (bsRatio < 2.5) {
        console.debug(`[bonding-scan] ✗new ${symbol} bsRatio:${bsRatio.toFixed(1)} (min 2.5)`);
        continue;
      }

      const mcapSol = mcapUsd / solPriceUsd;
      console.info(
        `[bonding-scan] 🆕 NEW ${symbol} mcap:$${mcapUsd.toFixed(0)} ` +
        `buys5m:${buys5m} ratio:${bsRatio.toFixed(1)}x vol5m:$${vol5m.toFixed(0)} ` +
        `pc5m:${pc5m.toFixed(1)}% age:${(tokenAgeSec / 60).toFixed(1)}min — entering`
      );

      recentMints.add(mint);
      const buyResult = await buyOnBondingCurve(mint, BONDING_NEW_BUY_SOL, keypair, connection, 'pump');
      if (!buyResult.success) { recentMints.delete(mint); continue; }

      bonding2DailySpent += BONDING_NEW_BUY_SOL;

      try {
        await query(
          `INSERT INTO autobuy_jobs
             (mint_address, label, amount_sol, slippage_bps, interval_seconds,
              autosell_enabled, active, last_tx_signature, bought_at, last_activity_at,
              total_spent_sol, time_limit_seconds, time_limit_enabled)
           VALUES ($1,$2,$3,300,60,false,true,$4,now(),now(),$3,$5,true)
           ON CONFLICT DO NOTHING`,
          [
            mint,
            `auto:bonding:new:${symbol}:pump:mcap${Math.round(mcapSol)}sol`,
            BONDING_NEW_BUY_SOL, buyResult.txSignature ?? '',
            BONDING_NEW_TIME_LIMIT,
          ]
        );
      } catch (dbErr: any) {
        console.warn(`[bonding-scan] NEW DB error ${mint.slice(0, 8)}: ${dbErr.message?.slice(0, 60)}`);
      }

      positions2.set(mint, {
        mint, symbol, name,
        buyTx: buyResult.txSignature ?? '',
        buyTime: Date.now(),
        buySol: BONDING_NEW_BUY_SOL,
        entryMcapSol: mcapSol, currentMcapSol: mcapSol, peakMcapSol: mcapSol,
        tpIndex: 0, allTpsDone: false,
        uniqueBuyers: new Set(),
        recentBuySol: 0, recentSellSol: 0,
        windowResetAt: Date.now() + 90_000,
        dexPool: 'pump',
      });

      if (wsInstance?.readyState === WebSocket.OPEN) {
        wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      }

      // Tight time limit for new tokens
      setTimeout(async () => {
        const p = positions2.get(mint);
        if (!p) return;
        console.info(`[bonding-scan] ⏱ TIME_LIMIT NEW ${p.symbol} — selling 100%`);
        positions2.delete(mint);
        await sellOnBondingCurve(mint, 100, keypair, connection, 'pump');
      }, BONDING_NEW_TIME_LIMIT * 1000);

      await new Promise(res => setTimeout(res, 2000));
    }
  } catch (err: any) {
    console.debug(`[bonding-scan] NEW poll error: ${err.message?.slice(0, 60)}`);
  }
}

// ─── WebSocket connection ──────────────────────────────────────────────────────

let wsInstance: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let running = false;
let keypairInstance: Keypair | null = null;
let keypairInstance2: Keypair | null = null;
let connectionInstance: Connection | null = null;
// Whether to subscribe to new token events (only when WebSocket scanner is enabled).
// WebSocket is always connected for real-time position price updates.
let wsNewTokenEnabled = false;

function connectBondingWS(): void {
  if (wsInstance) {
    wsInstance.removeAllListeners();
    try { wsInstance.terminate(); } catch {}
    wsInstance = null;
  }

  const ws = new WebSocket(PUMPPORTAL_WS);
  wsInstance = ws;

  ws.on('open', () => {
    console.info('[bonding-scan] ✅ WebSocket connected' + (wsNewTokenEnabled ? ' — subscribing new tokens' : ' (position monitor only)'));
    if (wsNewTokenEnabled) {
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    }
    // Re-subscribe to trades for active positions after reconnect
    const activeMints = [...positions.keys(), ...positions2.keys(), ...candidateTokens.keys()];
    if (activeMints.length > 0) {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: activeMints }));
        }
      }, 2000);
    }
  });

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!keypairInstance || !connectionInstance) return;

      if (msg.txType === 'create') {
        await processNewToken(msg, keypairInstance, connectionInstance);
        // Subscribe to trades for the new candidate
        if (candidateTokens.has(msg.mint) && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
        }
      } else if (msg.txType === 'buy' || msg.txType === 'sell') {
        await onTradeEvent(msg, keypairInstance, connectionInstance);
      }
    } catch { /* ignore */ }
  });

  ws.on('error', (err) => {
    console.warn(`[bonding-scan] Error: ${err.message?.slice(0, 60)}`);
  });

  ws.on('close', (code) => {
    wsInstance = null;
    console.warn(`[bonding-scan] Closed (${code}) — reconnecting in 10s`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectBondingWS, 10_000);
  });
}

// ─── Graduation Hunter — buy pump.fun tokens at $40k-65k (pre-graduation zone) ──
// Strategy: community rushes to push mcap past $69k threshold → graduation pop.
// Entry in last mile before graduation → 5-70% gain with real AMM depth on exit.

async function pollGraduationHunterTokens(keypair: Keypair, connection: Connection): Promise<void> {
  try {
    const DEXSCREENER = 'https://api.dexscreener.com/latest/dex';
    const seen = new Set<string>();
    const candidates: any[] = [];

    for (const q of ['pumpfun sol', 'pump.fun bonding', 'sol bonding curve', 'pump sol new', 'sol meme pump']) {
      try {
        const r = await axios.get(`${DEXSCREENER}/search?q=${encodeURIComponent(q)}`, { timeout: 5_000 });
        for (const p of (r.data?.pairs ?? []) as any[]) {
          if (p.chainId !== 'solana') continue;
          if ((p.dexId ?? '').toLowerCase() !== 'pumpfun') continue;
          const m = p.baseToken?.address;
          if (!m || seen.has(m)) continue;
          seen.add(m);
          candidates.push(p);
        }
        await new Promise(res => setTimeout(res, 400));
      } catch { /* skip */ }
    }

    let gMcap = 0, gVol = 0, gAge = 0, gMom = 0;
    console.debug(`[bonding-scan] GRAD poll: ${candidates.length} candidates from DexScreener`);
    for (const p of candidates) {
      const mint: string = p.baseToken?.address ?? '';
      if (!mint) continue;
      if (recentMints.has(mint) || positions.has(mint) || positions2.has(mint)) continue;
      if (!checkDailyBudget2(GRAD_HUNTER_BUY_SOL)) break;
      if (positions2.size >= BONDING_MAX_POSITIONS) break;

      const mcapUsd = Number(p.fdv ?? p.marketCap ?? 0);
      if (mcapUsd < GRAD_HUNTER_MIN_MCAP || mcapUsd > GRAD_HUNTER_MAX_MCAP) { gMcap++; continue; }

      const vol5m  = Number(p.volume?.m5 ?? 0);
      if (vol5m < 100) { gVol++; continue; }

      const createdAt = p.pairCreatedAt ? Number(p.pairCreatedAt) : 0;
      const ageSec = createdAt > 0 ? (Date.now() - createdAt) / 1000 : 0;
      if (ageSec > 6 * 3600) { gAge++; continue; }

      const pc5m   = Number(p.priceChange?.m5 ?? 0);
      const buys5m = Number(p.txns?.m5?.buys ?? 0);
      const sells5m = Number(p.txns?.m5?.sells ?? 0);

      if (pc5m <= 0 || buys5m < 3) { gMom++; continue; }
      const bsRatio = sells5m > 0 ? buys5m / sells5m : buys5m;
      if (bsRatio < 1.2) { gMom++; continue; }

      const symbol = (p.baseToken?.symbol ?? mint.slice(0, 4)).toUpperCase();
      const name   = p.baseToken?.name ?? symbol;
      if (isRugPattern(name, symbol)) continue;

      const mcapSol = mcapUsd / solPriceUsd;
      const toGrad  = ((69000 - mcapUsd) / mcapUsd * 100).toFixed(0);

      console.info(
        `[bonding-scan] 🎓 GRAD-HUNTER ${symbol} mcap:$${mcapUsd.toFixed(0)} ` +
        `(${toGrad}% to graduation) buys5m:${buys5m} pc5m:+${pc5m.toFixed(1)}% ` +
        `age:${(ageSec / 60).toFixed(0)}min — entering`
      );

      recentMints.add(mint);
      const buyResult = await buyOnBondingCurve(mint, GRAD_HUNTER_BUY_SOL, keypair, connection, 'pump');
      if (!buyResult.success) { recentMints.delete(mint); continue; }

      bonding2DailySpent += GRAD_HUNTER_BUY_SOL;

      try {
        await query(
          `INSERT INTO autobuy_jobs
             (mint_address, label, amount_sol, slippage_bps, interval_seconds,
              autosell_enabled, active, last_tx_signature, bought_at, last_activity_at,
              total_spent_sol, time_limit_seconds, time_limit_enabled)
           VALUES ($1,$2,$3,200,60,false,true,$4,now(),now(),$3,$5,true)
           ON CONFLICT DO NOTHING`,
          [mint, `auto:bonding:grad:${symbol}:pump:mcap${Math.round(mcapSol)}sol`, GRAD_HUNTER_BUY_SOL, buyResult.txSignature ?? '', GRAD_HUNTER_TIME_LIMIT]
        );
        await query(
          `INSERT INTO tokens (mint_address, symbol, name, last_updated) VALUES ($1,$2,$3,now())
           ON CONFLICT (mint_address) DO UPDATE SET symbol=COALESCE(EXCLUDED.symbol,tokens.symbol), name=COALESCE(EXCLUDED.name,tokens.name), last_updated=now()`,
          [mint, symbol || null, name || null]
        );
      } catch (e: any) {
        console.warn(`[bonding-scan] GRAD DB error ${mint.slice(0, 8)}: ${e.message?.slice(0, 60)}`);
      }

      positions2.set(mint, {
        mint, symbol, name,
        buyTx: buyResult.txSignature ?? '',
        buyTime: Date.now(),
        buySol: GRAD_HUNTER_BUY_SOL,
        entryMcapSol: mcapSol, currentMcapSol: mcapSol, peakMcapSol: mcapSol,
        tpIndex: 0, allTpsDone: false,
        uniqueBuyers: new Set(), recentBuySol: 0, recentSellSol: 0,
        windowResetAt: Date.now() + 90_000,
        dexPool: 'pump',
        tpLevels: GRAD_TPS,
        stopPct: GRAD_HUNTER_STOP_PCT,
      });

      if (wsInstance?.readyState === WebSocket.OPEN) {
        wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      }

      setTimeout(async () => {
        const pos = positions2.get(mint);
        if (!pos) return;
        console.info(`[bonding-scan] ⏱ TIME_LIMIT GRAD ${pos.symbol} — selling 100%`);
        positions2.delete(mint);

        // Attempt 1: sell on bonding curve via PumpPortal
        const pumpResult = await sellOnBondingCurve(mint, 100, keypair, connection, 'pump');

        // If bonding curve returned 0 SOL, token likely graduated to PumpSwap → try Jupiter
        if (!pumpResult.success || (pumpResult.solReceived ?? 0) === 0) {
          console.warn(`[bonding-scan] ⏱ GRAD ${pos.symbol} bonding sell = 0 SOL — trying Jupiter fallback (may have graduated to PumpSwap)`);
          try {
            const kp = getKeypairFromEnv();
            const conn = getConnection();
            if (kp && conn) {
              // Get on-chain balance
              const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
                kp.publicKey, { mint: new PublicKey(mint) }
              );
              const rawAmount = BigInt(
                (tokenAccounts.value[0]?.account?.data as any)?.parsed?.info?.tokenAmount?.amount ?? '0'
              );
              if (rawAmount > 0n) {
                const jupResult = await executeAutoSell(
                  { mintAddress: mint, tokenAmount: rawAmount, slippageBps: 1000 },
                  conn, kp
                );
                if (jupResult.success && (jupResult.solReceived ?? 0) > 0) {
                  await query(
                    `UPDATE autobuy_jobs SET total_sold_sol = COALESCE(total_sold_sol, 0) + $1, active = false
                     WHERE mint_address = $2 AND label LIKE 'auto:bonding:grad%' AND active = true`,
                    [jupResult.solReceived, mint]
                  ).catch(() => {});
                  console.info(`[bonding-scan] ✅ GRAD Jupiter fallback SOLD ${pos.symbol} → ${jupResult.solReceived?.toFixed(5)} SOL`);
                } else {
                  console.error(`[bonding-scan] ❌ GRAD all sell attempts failed for ${pos.symbol}`);
                }
              }
            }
          } catch (jupErr: any) {
            console.warn(`[bonding-scan] GRAD Jupiter fallback error: ${jupErr.message?.slice(0, 80)}`);
          }
        }
      }, GRAD_HUNTER_TIME_LIMIT * 1000);

      await new Promise(res => setTimeout(res, 2000));
    }
    if (gMcap + gVol + gAge + gMom > 0) {
      console.info(`[bonding-scan] GRAD filtered: mcap=${gMcap} vol=${gVol} age=${gAge} mom=${gMom} (range $${GRAD_HUNTER_MIN_MCAP/1000}k-$${GRAD_HUNTER_MAX_MCAP/1000}k)`);
    }
  } catch (err: any) {
    console.debug(`[bonding-scan] GRAD poll error: ${err.message?.slice(0, 60)}`);
  }
}

// ─── PumpSwap Trader — graduated tokens with real AMM pool ────────────────────
// PumpSwap = Raydium-equivalent after pump.fun graduation.
// Real AMM depth means sells work properly (unlike bonding curve).
// Fresh graduates (<2h) often rally 30-100% as DEX aggregators list them.

async function pollPumpswapTokens(keypair: Keypair, connection: Connection): Promise<void> {
  try {
    const seen = new Set<string>();
    const candidates: any[] = [];

    // Primary: token profiles (trending/recently listed solana tokens)
    try {
      const profR = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 6_000 });
      const mints: string[] = ((Array.isArray(profR.data) ? profR.data : []) as any[])
        .filter((p: any) => p.chainId === 'solana' && p.tokenAddress && !seen.has(p.tokenAddress))
        .map((p: any) => { seen.add(p.tokenAddress); return p.tokenAddress; })
        .slice(0, 30);
      if (mints.length > 0) {
        const pr = await axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`,
          { timeout: 6_000 }
        );
        for (const p of (pr.data?.pairs ?? []) as any[]) {
          if (p.chainId !== 'solana') continue;
          if ((p.dexId ?? '').toLowerCase() !== 'pumpswap') continue;
          const m = p.baseToken?.address;
          if (!m || seen.has(m)) continue;
          seen.add(m);
          candidates.push(p);
        }
      }
    } catch { /* fail-open */ }

    // Secondary: DexScreener search for pumpswap tokens (returns actual pumpswap pairs)
    for (const q of ['pumpswap', 'pump fun graduated sol', 'new pumpswap']) {
      try {
        const r = await axios.get(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
          { timeout: 5_000 }
        );
        for (const p of (r.data?.pairs ?? []) as any[]) {
          if (p.chainId !== 'solana') continue;
          if ((p.dexId ?? '').toLowerCase() !== 'pumpswap') continue;
          const m = p.baseToken?.address;
          if (!m || seen.has(m)) continue;
          seen.add(m);
          candidates.push(p);
        }
        await new Promise(res => setTimeout(res, 300));
      } catch { /* skip */ }
    }

    let psLiq = 0, psAge = 0, psMom = 0;
    console.debug(`[bonding-scan] PUMPSWAP poll: ${candidates.length} candidates from DexScreener`);
    for (const p of candidates) {
      const mint: string = p.baseToken?.address ?? '';
      if (!mint) continue;
      if (recentMints.has(mint) || positions.has(mint) || positions2.has(mint)) continue;
      if (!checkDailyBudget2(PUMPSWAP_BUY_SOL)) break;
      if (positions2.size >= BONDING_MAX_POSITIONS) break;

      const liq = Number(p.liquidity?.usd ?? 0);
      if (liq < PUMPSWAP_MIN_LIQ || liq > PUMPSWAP_MAX_LIQ) { psLiq++; continue; }

      const createdAt = p.pairCreatedAt ? Number(p.pairCreatedAt) : 0;
      const ageSec    = createdAt > 0 ? (Date.now() - createdAt) / 1000 : 0;
      if (ageSec < 60 || ageSec > PUMPSWAP_MAX_AGE_MIN * 60) { psAge++; continue; }

      const pc5m   = Number(p.priceChange?.m5 ?? 0);
      const pc1h   = Number(p.priceChange?.h1 ?? 0);
      const vol1h  = Number(p.volume?.h1 ?? 0);
      const buys5m = Number(p.txns?.m5?.buys ?? 0);

      if (pc5m < 1 || pc1h < 0 || vol1h < 1000 || buys5m < 3) { psMom++; continue; }

      const symbol  = (p.baseToken?.symbol ?? mint.slice(0, 4)).toUpperCase();
      const name    = p.baseToken?.name ?? symbol;
      if (isRugPattern(name, symbol)) continue;

      const mcapUsd = Number(p.fdv ?? p.marketCap ?? 0);
      const mcapSol = mcapUsd / solPriceUsd;

      console.info(
        `[bonding-scan] 🔄 PUMPSWAP ${symbol} liq:$${liq.toFixed(0)} mcap:$${mcapUsd.toFixed(0)} ` +
        `pc5m:+${pc5m.toFixed(1)}% pc1h:+${pc1h.toFixed(1)}% vol1h:$${vol1h.toFixed(0)} ` +
        `age:${(ageSec / 60).toFixed(0)}min — entering`
      );

      recentMints.add(mint);
      const buyResult = await buyOnBondingCurve(mint, PUMPSWAP_BUY_SOL, keypair, connection, 'pumpswap');
      if (!buyResult.success) { recentMints.delete(mint); continue; }

      bonding2DailySpent += PUMPSWAP_BUY_SOL;

      try {
        await query(
          `INSERT INTO autobuy_jobs
             (mint_address, label, amount_sol, slippage_bps, interval_seconds,
              autosell_enabled, active, last_tx_signature, bought_at, last_activity_at,
              total_spent_sol, time_limit_seconds, time_limit_enabled)
           VALUES ($1,$2,$3,150,60,false,true,$4,now(),now(),$3,$5,true)
           ON CONFLICT DO NOTHING`,
          [mint, `auto:bonding:pumpswap:${symbol}:liq${Math.round(liq / 1000)}k:mcap${Math.round(mcapSol)}sol`, PUMPSWAP_BUY_SOL, buyResult.txSignature ?? '', PUMPSWAP_TIME_LIMIT]
        );
        await query(
          `INSERT INTO tokens (mint_address, symbol, name, last_updated) VALUES ($1,$2,$3,now())
           ON CONFLICT (mint_address) DO UPDATE SET symbol=COALESCE(EXCLUDED.symbol,tokens.symbol), name=COALESCE(EXCLUDED.name,tokens.name), last_updated=now()`,
          [mint, symbol || null, name || null]
        );
      } catch (e: any) {
        console.warn(`[bonding-scan] PUMPSWAP DB error ${mint.slice(0, 8)}: ${e.message?.slice(0, 60)}`);
      }

      positions2.set(mint, {
        mint, symbol, name,
        buyTx: buyResult.txSignature ?? '',
        buyTime: Date.now(),
        buySol: PUMPSWAP_BUY_SOL,
        entryMcapSol: mcapSol, currentMcapSol: mcapSol, peakMcapSol: mcapSol,
        tpIndex: 0, allTpsDone: false,
        uniqueBuyers: new Set(), recentBuySol: 0, recentSellSol: 0,
        windowResetAt: Date.now() + 90_000,
        dexPool: 'pumpswap',
        tpLevels: PUMPSWAP_TPS,
        stopPct: PUMPSWAP_STOP_PCT,
      });

      if (wsInstance?.readyState === WebSocket.OPEN) {
        wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      }

      setTimeout(async () => {
        const pos = positions2.get(mint);
        if (!pos) return;
        console.info(`[bonding-scan] ⏱ TIME_LIMIT PUMPSWAP ${pos.symbol} — selling 100%`);
        positions2.delete(mint);
        await sellOnBondingCurve(mint, 100, keypair, connection, 'pumpswap');
      }, PUMPSWAP_TIME_LIMIT * 1000);

      await new Promise(res => setTimeout(res, 2000));
    }
    if (psLiq + psAge + psMom > 0) {
      console.debug(`[bonding-scan] PUMPSWAP filtered: liq=${psLiq} age=${psAge} mom=${psMom}`);
    }
  } catch (err: any) {
    console.debug(`[bonding-scan] PUMPSWAP poll error: ${err.message?.slice(0, 60)}`);
  }
}

// ─── Recover positions from DB after restart ──────────────────────────────────

async function recoverOrphanedPositions(keypair: Keypair, connection: Connection): Promise<void> {
  try {
    const result = await query<{
      mint_address: string; label: string; amount_sol: string; bought_at: Date; time_limit_seconds: string;
    }>(
      `SELECT mint_address, label, amount_sol, bought_at, time_limit_seconds
       FROM autobuy_jobs WHERE (label LIKE 'auto:bonding%' OR label LIKE 'auto:mover%') AND active = true`
    );
    const rows = result.rows;
    if (!rows.length) return;
    console.info(`[bonding-scan] 🔄 Recovering ${rows.length} orphaned positions...`);

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    for (const row of rows) {
      const mint = row.mint_address;
      const boughtAt = new Date(row.bought_at).getTime();
      const timeLimitSec = Number(row.time_limit_seconds) || BONDING_TIME_LIMIT_SEC;
      const elapsed = (Date.now() - boughtAt) / 1000;

      let tokenBalance = 0;
      try {
        const accounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM_ID });
        for (const { account } of accounts.value) {
          const info = account.data.parsed?.info;
          if (info?.mint === mint) {
            tokenBalance = Number(info.tokenAmount?.uiAmount ?? 0);
            break;
          }
        }
      } catch { /* fail-open */ }

      if (tokenBalance <= 0) {
        await query(`UPDATE autobuy_jobs SET active=false WHERE mint_address=$1 AND label LIKE 'auto:bonding%' AND active=true`, [mint]).catch(() => {});
        console.info(`[bonding-scan] ✅ ${mint.slice(0, 8)} already sold — closed`);
        continue;
      }

      const labelParts = row.label.split(':');
      const symbol = labelParts[2] ?? mint.slice(0, 4);
      const mcapMatch = row.label.match(/mcap(\d+)sol/);
      const entryMcapSol = mcapMatch ? Number(mcapMatch[1]) : 0;
      const remainingMs = Math.max(5000, (timeLimitSec - elapsed) * 1000);

      positions.set(mint, {
        mint, symbol, name: symbol,
        buyTx: '', buyTime: boughtAt,
        buySol: Number(row.amount_sol),
        entryMcapSol, currentMcapSol: entryMcapSol, peakMcapSol: entryMcapSol,
        tpIndex: 0, allTpsDone: false,
        uniqueBuyers: new Set(),
        recentBuySol: 0, recentSellSol: 0,
        windowResetAt: Date.now() + 90_000,
      });
      recentMints.add(mint);

      console.info(`[bonding-scan] ♻️  Restored ${symbol} elapsed:${elapsed.toFixed(0)}s remaining:${(remainingMs / 1000).toFixed(0)}s`);

      setTimeout(async () => {
        const pos = positions.get(mint);
        if (!pos) return;
        console.info(`[bonding-scan] ⏱ TIME_LIMIT (recovered) ${pos.symbol} — selling 100%`);
        await sellOnBondingCurve(mint, 100, keypair, connection);
        positions.delete(mint);
      }, remainingMs);
    }

    if (positions.size > 0 && wsInstance?.readyState === WebSocket.OPEN) {
      wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...positions.keys()] }));
    }
  } catch (err: any) {
    console.warn(`[bonding-scan] recoverOrphanedPositions error: ${err.message?.slice(0, 80)}`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function startBondingScanner(): void {
  if (running) return;

  const wsEnabled   = process.env.BONDING_SCANNER_ENABLED === 'true';
  const hotEnabled  = BONDING_HOT_ENABLED;
  const gradEnabled = GRAD_HUNTER_ENABLED;
  const psEnabled   = PUMPSWAP_ENABLED;

  // Need at least one active mode and a keypair to run
  if (!wsEnabled && !hotEnabled && !gradEnabled && !psEnabled) {
    console.info('[bonding-scan] All modes disabled (WS/HOT/GRAD/PUMPSWAP) — skipping');
    return;
  }

  // HOT/GRAD/PUMPSWAP modes use wallet 2
  const hotKeypairRaw = loadPumpFunKeypair2();
  if ((hotEnabled || gradEnabled || psEnabled) && !wsEnabled && !hotKeypairRaw) {
    console.info('[bonding-scan] HOT/GRAD/PUMPSWAP modes require PUMPFUN_WALLET_PRIVATE_KEY_2 — disabled');
    return;
  }

  // WebSocket mode requires wallet 1
  const keypair = loadPumpFunKeypair();
  if (wsEnabled && !keypair) return;

  // Use wallet 1 as connection base (or create dummy connection for HOT-only)
  const baseKeypair = keypair ?? hotKeypairRaw!;
  keypairInstance = baseKeypair;
  connectionInstance = new Connection(SOLANA_RPC, 'confirmed');
  running = true;

  if (hotKeypairRaw) {
    keypairInstance2 = hotKeypairRaw;
    console.info(`[bonding-scan] Wallet 2 loaded: ${hotKeypairRaw.publicKey.toBase58().slice(0, 8)} (HOT tokens)`);
  }

  if (wsEnabled) {
    console.info(
      `[bonding-scan] Starting — wallet1:${baseKeypair.publicKey.toBase58().slice(0, 8)} ` +
      `buy:${BONDING_BUY_SOL} SOL daily:${BONDING_MAX_SOL_DAILY} SOL ` +
      `entry:${BONDING_MIN_BUYERS}+ buyers $${BONDING_MIN_MCAP_USD}+ mcap ` +
      `stop:${BONDING_STOP_PCT * 100}% TPs:1.5/2/3/5/8x trail:${MOON_BAG_TRAIL_PCT * 100}% ` +
      `HOT:${hotEnabled ? `enabled w${hotKeypairRaw ? '2' : '1'} every ${BONDING_HOT_INTERVAL_MS / 1000}s` : 'disabled'}`
    );
  } else {
    console.info(
      `[bonding-scan] HOT-only mode — WebSocket scanner disabled. ` +
      `wallet:${baseKeypair.publicKey.toBase58().slice(0, 8)} ` +
      `buy:${BONDING_BUY_SOL} SOL stop:${BONDING_STOP_PCT * 100}% maxMcap:$${BONDING_HOT_MAX_MCAP} ` +
      `poll every ${BONDING_HOT_INTERVAL_MS / 1000}s`
    );
  }

  refreshSolPrice().catch(() => {});
  setInterval(() => refreshSolPrice().catch(() => {}), 5 * 60_000);

  // Restore today's spending from DB so daily limit survives container restarts
  query<{ spent: string }>(
    `SELECT COALESCE(SUM(total_spent_sol), 0) AS spent FROM autobuy_jobs
     WHERE label LIKE 'auto:bonding%' AND bought_at >= CURRENT_DATE`
  ).then(r => {
    bonding2DailySpent = Number(r.rows[0]?.spent ?? 0);
    console.info(`[bonding-scan] Daily spent (W2) restored: ${bonding2DailySpent.toFixed(4)} SOL`);
  }).catch(() => {});

  recoverOrphanedPositions(baseKeypair, connectionInstance).catch(() => {});
  setInterval(() => pollBondingPositions(baseKeypair, connectionInstance!).catch(() => {}), DS_POLL_INTERVAL_MS);

  // HOT token poll — use wallet 2 if available, otherwise wallet 1
  if (hotEnabled) {
    const hotKeypair = keypairInstance2 ?? baseKeypair;
    setInterval(() => pollHotPumpfunTokens(hotKeypair, connectionInstance!).catch(() => {}), BONDING_HOT_INTERVAL_MS);
    console.info(`[bonding-scan] HOT poller scheduled every ${BONDING_HOT_INTERVAL_MS / 1000}s`);
  }

  // NEW token poll — catches tokens 1-14 min old before HOT window
  if (BONDING_NEW_ENABLED) {
    const newKeypair = keypairInstance2 ?? baseKeypair;
    setTimeout(() => {
      setInterval(() => pollNewPumpfunTokens(newKeypair, connectionInstance!).catch(() => {}), BONDING_NEW_INTERVAL_MS);
    }, 15_000);
    console.info(`[bonding-scan] NEW poller scheduled every ${BONDING_NEW_INTERVAL_MS / 1000}s (0.01 SOL, 1-14min age)`);
  }

  // Graduation Hunter — pre-graduation pump.fun tokens ($40k-65k mcap)
  if (gradEnabled) {
    const gradKeypair = keypairInstance2 ?? baseKeypair;
    // Offset 10s from HOT poll to spread DexScreener load
    setTimeout(() => {
      setInterval(() => pollGraduationHunterTokens(gradKeypair, connectionInstance!).catch(() => {}), GRAD_HUNTER_INTERVAL_MS);
    }, 10_000);
    console.info(`[bonding-scan] GRAD-HUNTER scheduled every ${GRAD_HUNTER_INTERVAL_MS / 1000}s ($${GRAD_HUNTER_MIN_MCAP / 1000}k-${GRAD_HUNTER_MAX_MCAP / 1000}k mcap)`);
  }

  // PumpSwap Trader — recently graduated tokens on real AMM
  if (psEnabled) {
    const psKeypair = keypairInstance2 ?? baseKeypair;
    // Offset 20s from grad poll
    setTimeout(() => {
      setInterval(() => pollPumpswapTokens(psKeypair, connectionInstance!).catch(() => {}), PUMPSWAP_INTERVAL_MS);
    }, 20_000);
    console.info(`[bonding-scan] PUMPSWAP scheduled every ${PUMPSWAP_INTERVAL_MS / 1000}s (liq $${PUMPSWAP_MIN_LIQ / 1000}k-${PUMPSWAP_MAX_LIQ / 1000}k, max age ${PUMPSWAP_MAX_AGE_MIN}min)`);
  }

  // Always connect WebSocket — needed for real-time TP/stop sells even in HOT-only mode.
  // wsNewTokenEnabled controls whether we subscribe to new-token events (WS scanner).
  wsNewTokenEnabled = wsEnabled;
  connectBondingWS();
}

export function stopBondingScanner(): void {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (wsInstance) {
    wsInstance.removeAllListeners();
    try { wsInstance.terminate(); } catch {}
    wsInstance = null;
  }
}

export function getBondingPositions(): BondingPosition[] {
  return [...positions.values(), ...positions2.values()];
}

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

const PUMPPORTAL_WS  = 'wss://pumpportal.fun/api/data';
const PUMPPORTAL_BUY = 'https://pumpportal.fun/api/trade-local';
const BIRDEYE_BASE   = 'https://public-api.birdeye.so';

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

// Time limit before force-exit on bonding curve (seconds)
const BONDING_TIME_LIMIT_SEC = Number(process.env.BONDING_TIME_LIMIT_SEC || '600');

// Stop loss: 17% from entry price
const BONDING_STOP_PCT = Number(process.env.BONDING_STOP_PCT || '0.17');

// 5 TP levels: mult → sell pct
const BONDING_TPS = [
  { mult: 1.5, sellPct: 20 },
  { mult: 2.0, sellPct: 20 },
  { mult: 3.0, sellPct: 20 },
  { mult: 5.0, sellPct: 20 },
  { mult: 8.0, sellPct: 10 },
];

// Moon bag trailing stop: sell remaining 10% if price drops this much from ATH
const MOON_BAG_TRAIL_PCT = Number(process.env.MOON_BAG_TRAIL_PCT || '0.20');

// Dump detection: if sell volume > buy volume * this ratio → exit
const BONDING_DUMP_RATIO = Number(process.env.BONDING_DUMP_RATIO || '2.5');

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY ?? '';
const SOLANA_RPC      = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

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

// ─── Buy/sell via PumpPortal ──────────────────────────────────────────────────

async function buyOnBondingCurve(
  mint: string, amountSol: number, keypair: Keypair, connection: Connection
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  try {
    const { VersionedTransaction, Transaction } = await import('@solana/web3.js');
    const resp = await axios.post(
      PUMPPORTAL_BUY,
      {
        publicKey: keypair.publicKey.toBase58(),
        action: 'buy',
        mint,
        amount: amountSol,
        denominatedInSol: 'true',
        slippage: 25,
        priorityFee: 0.002,
        pool: 'pump',
      },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );

    const txBytes = new Uint8Array(resp.data as ArrayBuffer);
    let txSignature: string;
    try {
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([keypair]);
      txSignature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    } catch {
      const tx = Transaction.from(Buffer.from(txBytes));
      tx.partialSign(keypair);
      txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }

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
  mint: string, pct: number, keypair: Keypair, connection: Connection
): Promise<{ success: boolean; solReceived?: number }> {
  try {
    const { VersionedTransaction, Transaction } = await import('@solana/web3.js');
    const balBefore = await connection.getBalance(keypair.publicKey).catch(() => 0);
    const resp = await axios.post(
      PUMPPORTAL_BUY,
      {
        publicKey: keypair.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: `${pct}%`,
        denominatedInSol: 'false',
        slippage: 30,
        priorityFee: 0.002,
        pool: 'auto',
      },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );

    const txBytes = new Uint8Array(resp.data as ArrayBuffer);
    let txSignature: string;
    try {
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([keypair]);
      txSignature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    } catch {
      const tx = Transaction.from(Buffer.from(txBytes));
      tx.partialSign(keypair);
      txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }

    await connection.confirmTransaction(txSignature, 'confirmed');
    const balAfter = await connection.getBalance(keypair.publicKey).catch(() => 0);
    const solReceived = Math.max(0, (balAfter - balBefore) / 1e9);
    console.info(`[bonding-scan] 💰 Sold ${pct}% of ${mint.slice(0, 8)} → ${solReceived.toFixed(5)} SOL`);

    if (pct >= 95) {
      await query(
        `UPDATE autobuy_jobs SET active=false, total_sold_sol=$1
         WHERE mint_address=$2 AND label LIKE 'auto:bonding%' AND active=true`,
        [solReceived, mint]
      ).catch(() => {});
    }
    return { success: true, solReceived };
  } catch (err: any) {
    console.warn(`[bonding-scan] Sell failed ${mint.slice(0, 8)}: ${err.message?.slice(0, 80)}`);
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
}

const positions = new Map<string, BondingPosition>();

// ─── DexScreener polling watchdog ────────────────────────────────────────────

const DS_POLL_INTERVAL_MS = 30_000;
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

async function pollBondingPositions(keypair: Keypair, connection: Connection): Promise<void> {
  if (positions.size === 0) return;

  for (const [mint, pos] of positions.entries()) {
    const lastEvent = lastWsEventAt.get(mint) ?? 0;
    if (Date.now() - lastEvent < 60_000 && lastEvent > 0) continue;

    const mcapSol = await getDSMcapSol(mint);
    if (!mcapSol || mcapSol < 0.01) continue;

    pos.currentMcapSol = mcapSol;
    pos.peakMcapSol = Math.max(pos.peakMcapSol, mcapSol);
    const mult = pos.entryMcapSol > 0 ? mcapSol / pos.entryMcapSol : 1;

    console.info(`[bonding-scan] 🔍 POLL ${pos.symbol} ${mult.toFixed(2)}x`);
    await checkPositionExits(mint, pos, mcapSol, mult, keypair, connection, 'poll');
    if (wsInstance?.readyState === WebSocket.OPEN) {
      wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }
  }
}

// ─── Shared exit logic ────────────────────────────────────────────────────────

async function checkPositionExits(
  mint: string, pos: BondingPosition, mcapSol: number, mult: number,
  keypair: Keypair, connection: Connection, source: string
): Promise<void> {
  // Stop-loss: 17% from entry
  if (mult <= 1 - BONDING_STOP_PCT) {
    console.info(`[bonding-scan] 🔴 STOP ${pos.symbol} ${mult.toFixed(2)}x [${source}] — selling 100%`);
    positions.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection);
    return;
  }

  // Moon-bag trailing stop
  if (pos.allTpsDone) {
    const currentFromPeak = pos.peakMcapSol > 0 ? mcapSol / pos.peakMcapSol : 1;
    if (currentFromPeak <= 1 - MOON_BAG_TRAIL_PCT) {
      console.info(`[bonding-scan] 🌙 TRAIL ${pos.symbol} peak:${pos.peakMcapSol.toFixed(0)} now:${mcapSol.toFixed(0)} — selling moon bag`);
      positions.delete(mint);
      await sellOnBondingCurve(mint, 100, keypair, connection);
    }
    return;
  }

  // 5 TP levels
  while (pos.tpIndex < BONDING_TPS.length) {
    const tp = BONDING_TPS[pos.tpIndex];
    if (mult >= tp.mult) {
      console.info(`[bonding-scan] 🎯 TP${pos.tpIndex + 1} ${pos.symbol} ${mult.toFixed(2)}x — selling ${tp.sellPct}% [${source}]`);
      await sellOnBondingCurve(mint, tp.sellPct, keypair, connection);
      pos.tpIndex++;
      if (pos.tpIndex >= BONDING_TPS.length) {
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

  // ── Update active position ────────────────────────────────────────────────
  const pos = positions.get(mint);
  if (!pos) return;

  if (txType === 'buy') {
    if (traderWallet) pos.uniqueBuyers.add(traderWallet);
    pos.recentBuySol += solAmount;
  } else if (txType === 'sell') {
    pos.recentSellSol += solAmount;
  }

  if (Date.now() > pos.windowResetAt) {
    pos.recentBuySol = 0;
    pos.recentSellSol = 0;
    pos.windowResetAt = Date.now() + 90_000;
  }

  pos.currentMcapSol = mcapSol;
  pos.peakMcapSol = Math.max(pos.peakMcapSol, mcapSol);
  const mult = pos.entryMcapSol > 0 ? mcapSol / pos.entryMcapSol : 1;

  // Dump detection
  if (!pos.allTpsDone && pos.recentSellSol > pos.recentBuySol * BONDING_DUMP_RATIO && pos.recentSellSol > 1.0) {
    console.warn(`[bonding-scan] 🚨 DUMP ${pos.symbol} — exiting`);
    positions.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection);
    return;
  }

  // Bot pattern: <5 unique buyers after 60s
  const heldSec = (Date.now() - pos.buyTime) / 1000;
  if (heldSec > 60 && pos.uniqueBuyers.size < 5 && heldSec < 300) {
    console.warn(`[bonding-scan] 🤖 BOT ${pos.symbol} ${pos.uniqueBuyers.size} buyers — exiting`);
    positions.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection);
    return;
  }

  await checkPositionExits(mint, pos, mcapSol, mult, keypair, connection, 'ws');
}

// ─── WebSocket connection ──────────────────────────────────────────────────────

let wsInstance: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let running = false;
let keypairInstance: Keypair | null = null;
let connectionInstance: Connection | null = null;

function connectBondingWS(): void {
  if (wsInstance) {
    wsInstance.removeAllListeners();
    try { wsInstance.terminate(); } catch {}
    wsInstance = null;
  }

  const ws = new WebSocket(PUMPPORTAL_WS);
  wsInstance = ws;

  ws.on('open', () => {
    console.info('[bonding-scan] ✅ Connected — subscribing new tokens');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    // Re-subscribe to trades for active positions after reconnect
    const activeMints = [...positions.keys(), ...candidateTokens.keys()];
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

// ─── Recover positions from DB after restart ──────────────────────────────────

async function recoverOrphanedPositions(keypair: Keypair, connection: Connection): Promise<void> {
  try {
    const result = await query<{
      mint_address: string; label: string; amount_sol: string; bought_at: Date; time_limit_seconds: string;
    }>(
      `SELECT mint_address, label, amount_sol, bought_at, time_limit_seconds
       FROM autobuy_jobs WHERE label LIKE 'auto:bonding%' AND active = true`
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

  if (process.env.BONDING_SCANNER_ENABLED !== 'true') {
    console.info('[bonding-scan] BONDING_SCANNER_ENABLED≠true — disabled');
    return;
  }

  if (!process.env.PUMPFUN_WALLET_PRIVATE_KEY) {
    console.info('[bonding-scan] PUMPFUN_WALLET_PRIVATE_KEY not set — disabled');
    return;
  }

  const keypair = loadPumpFunKeypair();
  if (!keypair) return;

  keypairInstance = keypair;
  connectionInstance = new Connection(SOLANA_RPC, 'confirmed');
  running = true;

  console.info(
    `[bonding-scan] Starting — wallet:${keypair.publicKey.toBase58().slice(0, 8)} ` +
    `buy:${BONDING_BUY_SOL} SOL daily:${BONDING_MAX_SOL_DAILY} SOL ` +
    `entry:${BONDING_MIN_BUYERS}+ buyers $${BONDING_MIN_MCAP_USD}+ mcap ` +
    `stop:${BONDING_STOP_PCT * 100}% TPs:1.5/2/3/5/8x trail:${MOON_BAG_TRAIL_PCT * 100}%`
  );

  refreshSolPrice().catch(() => {});
  setInterval(() => refreshSolPrice().catch(() => {}), 5 * 60_000);

  recoverOrphanedPositions(keypair, connectionInstance).catch(() => {});
  setInterval(() => pollBondingPositions(keypair, connectionInstance!).catch(() => {}), DS_POLL_INTERVAL_MS);

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
  return [...positions.values()];
}

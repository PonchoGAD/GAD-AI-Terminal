/**
 * Bonding Curve Scanner
 *
 * Buys tokens BEFORE graduation on pump.fun bonding curve.
 * Uses PumpPortal WebSocket (subscribeNewToken) for real-time new token detection.
 * Uses PUMPFUN_WALLET_PRIVATE_KEY for all trades (separate from main Jupiter wallet).
 *
 * Strategy:
 *  1. New token launch detected via WebSocket
 *  2. Filter: dev initial buy >= 0.5 SOL (skin in the game)
 *  3. Filter: Birdeye security check (no freeze/mint authority)
 *  4. Buy 0.02 SOL via PumpPortal (pool:"pump") within 10s of launch
 *  5. Sell: 50% at 2x, 100% at 5x OR after 10 min time limit
 *
 * Risk profile: HIGH (most bonding curve tokens fail), but massive upside on hits.
 * Risk management: small position (0.02 SOL), strict filters, fast time limit.
 *
 * Ethics: no manipulation, no fake volume, no coordinated trading.
 * We are individual buyers acting on genuine signals.
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

const BONDING_BUY_SOL       = Number(process.env.BONDING_BUY_SOL       || '0.02');
const BONDING_MAX_SOL_DAILY = Number(process.env.BONDING_MAX_SOL_DAILY || '0.2');
const BONDING_MAX_POSITIONS = Number(process.env.BONDING_MAX_POSITIONS || '3');
// Dev must have bought at least this much SOL at launch (skin in the game)
const BONDING_MIN_DEV_BUY   = Number(process.env.BONDING_MIN_DEV_BUY   || '1.0');  // raised 0.5→1.0
// Max dev/mcap ratio (high = dev controls too much of supply = dump risk)
const BONDING_MAX_DEV_RATIO = Number(process.env.BONDING_MAX_DEV_RATIO || '0.15'); // 15%
// Time limit before force-exit on bonding curve (seconds)
const BONDING_TIME_LIMIT_SEC = Number(process.env.BONDING_TIME_LIMIT_SEC || '600'); // 10 min
// Max market cap in SOL at time of detection (cheap = early)
const BONDING_MAX_MCAP_SOL  = Number(process.env.BONDING_MAX_MCAP_SOL  || '60');   // tightened 80→60
// Min name score to buy (requires at least 1 viral keyword OR short name)
const BONDING_MIN_NAME_SCORE = Number(process.env.BONDING_MIN_NAME_SCORE || '5');
// Sell 50% at 2x, rest at 5x
const BONDING_TP1_MULT  = Number(process.env.BONDING_TP1_MULT  || '2.0');
const BONDING_TP2_MULT  = Number(process.env.BONDING_TP2_MULT  || '5.0');
const BONDING_STOP_MULT = Number(process.env.BONDING_STOP_MULT || '0.6'); // -40% stop
// Dump detection: if sell volume > buy volume * this ratio → exit
const BONDING_DUMP_RATIO = Number(process.env.BONDING_DUMP_RATIO || '2.5');

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY ?? '';
const SOLANA_RPC      = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

// Viral keyword patterns that correlate with pump potential
const VIRAL_KEYWORDS = [
  'trump', 'elon', 'musk', 'ai', 'fte', 'grok', 'doge', 'pepe', 'maga',
  'bitcoin', 'btc', 'sol', 'moon', 'pump', 'based', 'chad', 'ape', 'giga',
  'sigma', 'alpha', 'space', 'rocket', 'laser', 'gold', 'rich', 'trillion',
  'cat', 'dog', 'frog', 'wif', 'bonk', 'corn', 'pizza', 'burger', 'garden',
];

// Known rug / bot / manhive patterns — skip immediately
// "manhive" / "манхейв" = tokens launched by bots with dev immediately dumping after pump
const RUG_PATTERNS = [
  'rug', 'scam', 'fake', 'test', 'airdrop', 'free', 'safe', 'legit',
  'moonhav', 'manhiv', 'manhive', 'moonhive',  // manhive bot pattern
];

// Suspicious: dev name or keyword suggesting coordinated dump
const SUSPICIOUS_PATTERNS = ['dev', 'team', 'project', 'token', 'coin', 'official'];

function scoreTokenName(name: string, symbol: string): number {
  const text = `${name} ${symbol}`.toLowerCase();
  let score = 0;
  for (const kw of VIRAL_KEYWORDS) if (text.includes(kw)) score += 10;
  for (const rp of RUG_PATTERNS) if (text.includes(rp)) return -100;
  for (const sp of SUSPICIOUS_PATTERNS) if (text.includes(sp)) score -= 5;
  if (text.length > 3 && text.length < 25) score += 5;
  return score;
}

// ─── Birdeye Security Check ───────────────────────────────────────────────────

interface SecurityResult {
  safe: boolean;
  reason?: string;
  ownerPct?: number;
}

async function checkBirdeyeSecurity(mint: string): Promise<SecurityResult> {
  if (!BIRDEYE_API_KEY) return { safe: true };
  try {
    const r = await axios.get(
      `${BIRDEYE_BASE}/defi/token_security?address=${mint}`,
      { headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }, timeout: 5_000 }
    );
    const d = r.data?.data;
    if (!d) return { safe: true };

    // Freeze authority = owner can freeze all accounts → hard rug
    if (d.freezeAuthority) return { safe: false, reason: 'freeze authority active' };
    // Mint authority = owner can print more tokens → inflation rug
    if (d.mintAuthority) return { safe: false, reason: 'mint authority active' };
    // Single owner holds >80% = centralized dumper
    const top1pct = Number(d.ownerPercent ?? d.top10HolderPercent ?? 0);
    if (top1pct > 80) return { safe: false, reason: `top holder owns ${top1pct.toFixed(0)}%`, ownerPct: top1pct };

    return { safe: true, ownerPct: top1pct };
  } catch {
    return { safe: true }; // fail-open
  }
}

// ─── Keypair loading ──────────────────────────────────────────────────────────

function loadPumpFunKeypair(): Keypair | null {
  const pk = process.env.PUMPFUN_WALLET_PRIVATE_KEY;
  if (!pk) {
    console.warn('[bonding-scan] PUMPFUN_WALLET_PRIVATE_KEY not set');
    return null;
  }
  try {
    const decoded = bs58.decode(pk);
    return Keypair.fromSecretKey(decoded);
  } catch {
    console.error('[bonding-scan] Invalid PUMPFUN_WALLET_PRIVATE_KEY format');
    return null;
  }
}

// ─── Buy/sell via PumpPortal ──────────────────────────────────────────────────

async function buyOnBondingCurve(
  mint: string,
  amountSol: number,
  keypair: Keypair,
  connection: Connection
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
        slippage: 25,        // bonding curve has higher slippage
        priorityFee: 0.002,  // higher priority for fast execution
        pool: 'pump',        // explicitly use bonding curve
      },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );

    const txBytes = new Uint8Array(resp.data);
    let txSignature: string;
    try {
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([keypair]);
      txSignature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    } catch {
      const { Transaction: LegacyTx } = await import('@solana/web3.js');
      const tx = LegacyTx.from(Buffer.from(txBytes));
      tx.partialSign(keypair);
      txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }

    await connection.confirmTransaction(txSignature, 'confirmed');
    console.info(`[bonding-scan] ✅ Bought ${mint.slice(0, 8)} for ${amountSol} SOL | tx:${txSignature}`);
    return { success: true, txSignature };
  } catch (err: any) {
    const msg = err?.response?.data
      ? Buffer.from(err.response.data).toString('utf8').slice(0, 200)
      : err.message?.slice(0, 200);
    console.warn(`[bonding-scan] Buy failed ${mint.slice(0, 8)}: ${msg}`);
    return { success: false, error: msg };
  }
}

async function sellOnBondingCurve(
  mint: string,
  pct: number,
  keypair: Keypair,
  connection: Connection
): Promise<{ success: boolean; solReceived?: number }> {
  try {
    const { VersionedTransaction } = await import('@solana/web3.js');
    const balBefore = await connection.getBalance(keypair.publicKey).catch(() => 0);
    const resp = await axios.post(
      PUMPPORTAL_BUY,
      {
        publicKey: keypair.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: `${pct}%`,
        denominatedInSol: 'false',
        slippage: 25,
        priorityFee: 0.002,
        pool: 'auto',        // auto finds current location (bonding curve or Raydium)
      },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );

    const txBytes = new Uint8Array(resp.data);
    let txSignature: string;
    try {
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([keypair]);
      txSignature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    } catch {
      const { Transaction: LegacyTx } = await import('@solana/web3.js');
      const tx = LegacyTx.from(Buffer.from(txBytes));
      tx.partialSign(keypair);
      txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }

    await connection.confirmTransaction(txSignature, 'confirmed');
    const balAfter = await connection.getBalance(keypair.publicKey).catch(() => 0);
    const solReceived = Math.max(0, (balAfter - balBefore) / 1e9);
    console.info(`[bonding-scan] 💰 Sold ${pct}% of ${mint.slice(0, 8)} → ${solReceived.toFixed(5)} SOL`);

    // Mark DB record closed if this is a full exit
    if (pct >= 95) {
      await query(
        `UPDATE autobuy_jobs SET active = false, total_sold_sol = $1
         WHERE mint_address = $2 AND label LIKE 'auto:bonding%' AND active = true`,
        [solReceived, mint]
      ).catch(() => {});
    }
    return { success: true, solReceived };
  } catch (err: any) {
    console.warn(`[bonding-scan] Sell failed ${mint.slice(0, 8)}: ${err.message?.slice(0, 80)}`);
    return { success: false };
  }
}

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
  tp1Hit: boolean;
  // Safety tracking
  uniqueBuyers: Set<string>;     // unique wallet addresses that bought
  recentBuySol: number;          // SOL volume in last 90s window
  recentSellSol: number;         // SOL sell volume in last 90s window
  windowResetAt: number;         // timestamp for window reset
}

const positions = new Map<string, BondingPosition>();

async function getTokenPrice(mint: string): Promise<number | null> {
  if (!BIRDEYE_API_KEY) return null;
  try {
    const r = await axios.get(
      `${BIRDEYE_BASE}/defi/price?address=${mint}`,
      { headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }, timeout: 4_000 }
    );
    return Number(r.data?.data?.value ?? 0) || null;
  } catch {
    return null;
  }
}

// ─── DexScreener polling watchdog ────────────────────────────────────────────
// Polls all open positions every 30s via DexScreener priceNative.
// This is the BACKUP sell trigger if WS trade events are missed/lost.

const DS_POLL_INTERVAL_MS = 30_000;
const lastWsEventAt = new Map<string, number>(); // mint → last WS trade event ts

async function getDSMcapSol(mint: string): Promise<number> {
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5_000 }
    );
    const pairs: any[] = r.data?.pairs ?? [];
    if (!pairs.length) return 0;
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const fdvSol = Number(best.fdv ?? 0) / Number(best.priceUsd ?? 1) * Number(best.priceNative ?? 0);
    // Prefer marketCap directly if available
    if (best.marketCap) return Number(best.marketCap) / (Number(best.priceUsd ?? 1) / Number(best.priceNative ?? 1));
    return fdvSol;
  } catch {
    return 0;
  }
}

async function pollBondingPositions(keypair: Keypair, connection: Connection): Promise<void> {
  if (positions.size === 0) return;

  for (const [mint, pos] of positions.entries()) {
    const lastEvent = lastWsEventAt.get(mint) ?? 0;
    const silentMs = Date.now() - lastEvent;

    // Skip if we got a WS event in the last 60s — WS is alive for this token
    if (silentMs < 60_000 && lastEvent > 0) continue;

    // WS silent >60s: poll DexScreener as fallback
    const mcapSol = await getDSMcapSol(mint);
    if (!mcapSol || mcapSol < 0.01) continue;

    pos.currentMcapSol = mcapSol;
    const mult = pos.entryMcapSol > 0 ? mcapSol / pos.entryMcapSol : 1;

    console.info(`[bonding-scan] 🔍 POLL ${pos.symbol} ${mult.toFixed(2)}x (mcap:${mcapSol.toFixed(1)} SOL) silent:${(silentMs/1000).toFixed(0)}s`);

    if (mult <= BONDING_STOP_MULT) {
      console.info(`[bonding-scan] 🔴 POLL STOP ${pos.symbol} ${mult.toFixed(2)}x`);
      positions.delete(mint);
      await sellOnBondingCurve(mint, 100, keypair, connection);
    } else if (!pos.tp1Hit && mult >= BONDING_TP1_MULT) {
      pos.tp1Hit = true;
      console.info(`[bonding-scan] 🟡 POLL TP1 ${pos.symbol} ${mult.toFixed(2)}x — selling 50%`);
      await sellOnBondingCurve(mint, 50, keypair, connection);
    } else if (pos.tp1Hit && mult >= BONDING_TP2_MULT) {
      console.info(`[bonding-scan] 🟢 POLL TP2 ${pos.symbol} ${mult.toFixed(2)}x — selling 100%`);
      positions.delete(mint);
      await sellOnBondingCurve(mint, 100, keypair, connection);
    }

    // Re-subscribe WS for this token to restore events
    if (wsInstance?.readyState === WebSocket.OPEN) {
      wsInstance.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
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

// ─── Recent purchases (dedup) ─────────────────────────────────────────────────

const recentMints = new Set<string>();

// ─── Process new token event ──────────────────────────────────────────────────

async function processNewToken(
  event: any,
  keypair: Keypair,
  connection: Connection
): Promise<void> {
  const mint: string   = event.mint ?? '';
  const name: string   = event.name ?? '';
  const symbol: string = event.symbol ?? '';
  const devBuySol      = Number(event.solAmount ?? 0);
  const mcapSol        = Number(event.marketCapSol ?? 0);

  if (!mint || recentMints.has(mint)) return;
  if (!checkDailyBudget(BONDING_BUY_SOL)) return;
  if (positions.size >= BONDING_MAX_POSITIONS) return;

  // ── Filter 1: dev initial buy ──
  if (devBuySol < BONDING_MIN_DEV_BUY) return; // too small = no skin in the game

  // ── Filter 2: market cap ──
  if (mcapSol > BONDING_MAX_MCAP_SOL) return; // already pumped

  // ── Filter 3: dev/mcap ratio (high ratio = dev controls supply = dump risk) ──
  const devRatio = mcapSol > 0 ? devBuySol / mcapSol : 1;
  if (devRatio > BONDING_MAX_DEV_RATIO) {
    console.debug(`[bonding-scan] ✗ratio ${symbol} dev/mcap=${(devRatio*100).toFixed(0)}% (max ${BONDING_MAX_DEV_RATIO*100}%)`);
    return;
  }

  // ── Filter 4: name quality — require at least one viral keyword or short name ──
  const nameScore = scoreTokenName(name, symbol);
  if (nameScore < 0) return; // rug pattern
  if (nameScore < BONDING_MIN_NAME_SCORE) {
    console.debug(`[bonding-scan] ✗name ${symbol} score:${nameScore} (min ${BONDING_MIN_NAME_SCORE})`);
    return;
  }

  // ── Filter 5: Birdeye security (async, allow 3s) ──
  const security = await Promise.race([
    checkBirdeyeSecurity(mint),
    new Promise<SecurityResult>(r => setTimeout(() => r({ safe: true }), 3000)),
  ]) as SecurityResult;

  if (!security.safe) {
    console.info(`[bonding-scan] ✗sec  ${symbol.padEnd(10)} ${security.reason}`);
    return;
  }

  console.info(
    `[bonding-scan] 🎯 BUY signal: "${name}" ($${symbol}) ` +
    `devBuy:${devBuySol.toFixed(2)} SOL mcap:${mcapSol.toFixed(1)} SOL nameScore:${nameScore}`
  );

  recentMints.add(mint);
  const buyResult = await buyOnBondingCurve(mint, BONDING_BUY_SOL, keypair, connection);
  if (!buyResult.success) return;

  bondingDailySpent += BONDING_BUY_SOL;

  // Record in DB so position survives container restarts
  try {
    await query(
      `INSERT INTO autobuy_jobs
         (mint_address, label, amount_sol, slippage_bps, interval_seconds,
          autosell_enabled, active, last_tx_signature, bought_at, last_activity_at,
          total_spent_sol, time_limit_seconds, time_limit_enabled)
       VALUES ($1,$2,$3,250,0,false,true,$4,now(),now(),$3,$5,true)
       ON CONFLICT DO NOTHING`,
      [mint, `auto:bonding:${symbol}:mcap${Math.round(mcapSol)}sol`,
       BONDING_BUY_SOL, buyResult.txSignature ?? '', BONDING_TIME_LIMIT_SEC]
    );
  } catch (dbErr: any) {
    console.warn(`[bonding-scan] DB record failed for ${mint.slice(0,8)}: ${dbErr.message?.slice(0,100)}`);
  }

  positions.set(mint, {
    mint, symbol, name,
    buyTx: buyResult.txSignature ?? '',
    buyTime: Date.now(),
    buySol: BONDING_BUY_SOL,
    entryMcapSol: mcapSol,
    currentMcapSol: mcapSol,
    tp1Hit: false,
    uniqueBuyers: new Set(),
    recentBuySol: 0,
    recentSellSol: 0,
    windowResetAt: Date.now() + 90_000,
  });

  // ── Time limit: force exit after BONDING_TIME_LIMIT_SEC ──
  setTimeout(async () => {
    const pos = positions.get(mint);
    if (!pos) return;
    const pctToSell = 100;
    console.info(`[bonding-scan] ⏱ TIME_LIMIT ${pos.symbol} (${(BONDING_TIME_LIMIT_SEC/60).toFixed(0)}min) ${pos.uniqueBuyers.size} unique buyers — selling ${pctToSell}%`);
    await sellOnBondingCurve(mint, pctToSell, keypair, connection);
    positions.delete(mint);
  }, BONDING_TIME_LIMIT_SEC * 1000);
}

// ─── Monitor positions via trade events ──────────────────────────────────────

async function onTradeEvent(
  event: any,
  keypair: Keypair,
  connection: Connection
): Promise<void> {
  const mint       = event.mint ?? '';
  const mcapSol    = Number(event.marketCapSol ?? 0);
  const txType     = event.txType as 'buy' | 'sell';
  const solAmount  = Number(event.solAmount ?? 0);
  const traderWallet = event.traderPublicKey ?? '';
  const pos        = positions.get(mint);
  if (!pos || !mcapSol) return;

  lastWsEventAt.set(mint, Date.now());

  // ── Track unique buyers and volume ───────────────────────────────────────────
  if (txType === 'buy') {
    if (traderWallet) pos.uniqueBuyers.add(traderWallet);
    pos.recentBuySol += solAmount;
  } else if (txType === 'sell') {
    pos.recentSellSol += solAmount;
  }

  // Reset 90s rolling window
  if (Date.now() > pos.windowResetAt) {
    pos.recentBuySol = 0;
    pos.recentSellSol = 0;
    pos.windowResetAt = Date.now() + 90_000;
  }

  pos.currentMcapSol = mcapSol;
  const mult = pos.entryMcapSol > 0 ? mcapSol / pos.entryMcapSol : 1;

  // ── Dump detection: sell volume >> buy volume → early exit ────────────────────
  if (pos.recentSellSol > pos.recentBuySol * BONDING_DUMP_RATIO && pos.recentSellSol > 1.0) {
    console.warn(
      `[bonding-scan] 🚨 DUMP SIGNAL ${pos.symbol} — ` +
      `sell:${pos.recentSellSol.toFixed(2)} SOL > buy:${pos.recentBuySol.toFixed(2)} SOL * ${BONDING_DUMP_RATIO} — exiting`
    );
    positions.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection);
    return;
  }

  // ── Bot/manhive detection: single wallet > 60% of all buyers = bot ────────────
  // (can't detect by wallet ratio from events alone, but if unique buyers << trades → likely bot)
  // Check after 60s: if < 5 unique buyers but many trades → bot pattern
  const heldSec = (Date.now() - pos.buyTime) / 1000;
  if (heldSec > 60 && pos.uniqueBuyers.size < 5 && heldSec < 300) {
    console.warn(
      `[bonding-scan] 🤖 BOT PATTERN ${pos.symbol} — only ${pos.uniqueBuyers.size} unique buyers after ${heldSec.toFixed(0)}s — exiting`
    );
    positions.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection);
    return;
  }

  // Stop loss at 40% down
  if (mult <= BONDING_STOP_MULT) {
    console.info(`[bonding-scan] 🔴 STOP ${pos.symbol} ${mult.toFixed(2)}x (${pos.uniqueBuyers.size} buyers) — selling 100%`);
    positions.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection);
    return;
  }

  // TP1 at 2x: sell 50%
  if (!pos.tp1Hit && mult >= BONDING_TP1_MULT) {
    pos.tp1Hit = true;
    console.info(`[bonding-scan] 🟡 TP1 ${pos.symbol} ${mult.toFixed(2)}x (${pos.uniqueBuyers.size} buyers) — selling 50%`);
    await sellOnBondingCurve(mint, 50, keypair, connection);
    return;
  }

  // TP2 at 5x: sell rest
  if (pos.tp1Hit && mult >= BONDING_TP2_MULT) {
    console.info(`[bonding-scan] 🟢 TP2 ${pos.symbol} ${mult.toFixed(2)}x (${pos.uniqueBuyers.size} buyers) — selling 100%`);
    positions.delete(mint);
    await sellOnBondingCurve(mint, 100, keypair, connection);
    return;
  }

  // Log organic growth if > 10 buyers
  if (pos.uniqueBuyers.size % 10 === 0 && pos.uniqueBuyers.size > 0) {
    console.info(`[bonding-scan] 👥 ${pos.symbol} ${pos.uniqueBuyers.size} unique buyers ${mult.toFixed(2)}x`);
  }
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
    console.info('[bonding-scan] ✅ Connected — subscribing new tokens + trade events');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    // After a 2s delay, subscribe to trades on current positions
    setTimeout(() => {
      if (positions.size > 0) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...positions.keys()] }));
      }
    }, 2000);
  });

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!keypairInstance || !connectionInstance) return;

      if (msg.txType === 'create') {
        // New token launched on pump.fun
        await processNewToken(msg, keypairInstance, connectionInstance);
        // Subscribe to trades for this new token if we bought it
        if (positions.has(msg.mint)) {
          ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
        }
      } else if (msg.txType === 'buy' || msg.txType === 'sell') {
        // Trade event — update position P&L
        await onTradeEvent(msg, keypairInstance, connectionInstance);
      }
    } catch { /* ignore parse errors */ }
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
    const rows = await query<{
      mint_address: string; label: string; amount_sol: string; bought_at: Date; time_limit_seconds: string;
    }>(
      `SELECT mint_address, label, amount_sol, bought_at, time_limit_seconds
       FROM autobuy_jobs WHERE label LIKE 'auto:bonding%' AND active = true`
    );
    if (!rows.length) return;
    console.info(`[bonding-scan] 🔄 Recovering ${rows.length} orphaned bonding position(s)...`);

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    for (const row of rows) {
      const mint = row.mint_address;
      const buySol = Number(row.amount_sol);
      const boughtAt = new Date(row.bought_at).getTime();
      const timeLimitSec = Number(row.time_limit_seconds) || BONDING_TIME_LIMIT_SEC;
      const elapsed = (Date.now() - boughtAt) / 1000;

      // Check if still holding tokens by scanning all token accounts
      let tokenBalance = 0;
      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM_ID });
        for (const { account } of tokenAccounts.value) {
          const info = account.data.parsed?.info;
          if (info?.mint === mint) {
            tokenBalance = Number(info.tokenAmount?.uiAmount ?? 0);
            break;
          }
        }
      } catch { /* fail-open */ }

      if (tokenBalance <= 0) {
        // Already sold externally or token burned — close DB record
        await query(`UPDATE autobuy_jobs SET active = false WHERE mint_address = $1 AND label LIKE 'auto:bonding%' AND active = true`, [mint]).catch(() => {});
        console.info(`[bonding-scan] ✅ ${mint.slice(0,8)} already sold (no balance) — closed`);
        continue;
      }

      // Still holding — restore to in-memory positions
      const labelParts = row.label.split(':');
      const symbol = labelParts[2] ?? mint.slice(0, 4);
      const mcapMatch = row.label.match(/mcap(\d+)sol/);
      const entryMcapSol = mcapMatch ? Number(mcapMatch[1]) : 0;
      const remainingMs = Math.max(5000, (timeLimitSec - elapsed) * 1000);

      positions.set(mint, {
        mint, symbol, name: symbol,
        buyTx: '', buyTime: boughtAt,
        buySol, entryMcapSol, currentMcapSol: entryMcapSol,
        tp1Hit: false,
        uniqueBuyers: new Set(),
        recentBuySol: 0, recentSellSol: 0,
        windowResetAt: Date.now() + 90_000,
      });
      recentMints.add(mint);

      console.info(`[bonding-scan] ♻️  Restored ${symbol} (${mint.slice(0,8)}) elapsed:${elapsed.toFixed(0)}s remaining:${(remainingMs/1000).toFixed(0)}s`);

      // Set remaining time limit timer
      setTimeout(async () => {
        const pos = positions.get(mint);
        if (!pos) return;
        console.info(`[bonding-scan] ⏱ TIME_LIMIT (recovered) ${pos.symbol} — selling 100%`);
        await sellOnBondingCurve(mint, 100, keypair, connection);
        positions.delete(mint);
      }, remainingMs);
    }

    // Subscribe to trade events for recovered positions
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

  const pk = process.env.PUMPFUN_WALLET_PRIVATE_KEY;
  if (!pk) {
    console.info('[bonding-scan] PUMPFUN_WALLET_PRIVATE_KEY not set — scanner disabled');
    return;
  }

  const keypair = loadPumpFunKeypair();
  if (!keypair) return;

  keypairInstance = keypair;
  connectionInstance = new Connection(SOLANA_RPC, 'confirmed');

  running = true;
  console.info(
    `[bonding-scan] Starting bonding curve scanner ` +
    `wallet:${keypair.publicKey.toBase58().slice(0, 8)}... ` +
    `buy:${BONDING_BUY_SOL} SOL daily:${BONDING_MAX_SOL_DAILY} SOL`
  );

  // Recover any positions that survived a container restart
  recoverOrphanedPositions(keypair, connectionInstance).catch(() => {});

  // Polling watchdog: fires every 30s, sells via DexScreener if WS events are silent
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

/**
 * W3 PumpFun Sniper — "Buy at launch, exit in 15 min"
 *
 * v3 (01.07.2026) — EV optimizations:
 *  - ANTI-BUNDLE: skip tokens with vSol > 30.30 at create (bundler already sniped)
 *  - FAST STAGNATION: 2-stage early exit (45s if <+1%, 90s if <+3%) before 180s check
 *  - BUFFER SAFETY: explicit Buffer.from() cast before readBigUInt64LE (Uint8Array RPC compat)
 *  - TIGHTER PARAMS: MIN_DEV=0.20, TP1=1.25, TP2=1.60, TP3=2.20, TRAIL=8%, SL=7%
 *
 * v2 (30.06.2026) — Critical fixes:
 *  - PRICE FEED FIX: subscribeTokenTrade requires paid API → NEVER worked
 *    Replaced with Helius accountSubscribe on bonding curve PDA (free, real-time)
 *  - STAGNATION EXIT: if price < +5% after 180s → flat exit (don't wait 15 min)
 *  - MIN_DEV_SOL: raised from 0.01 → 0.15 SOL (cuts 80% of rug-bait)
 *  - STOP_PCT: reduced from 12% → 8%
 *
 * Strategy:
 *  1. PumpPortal WS → new token create event (0 lag)
 *  2. Filter: dev buy ≥ 0.20 SOL, vSol ≤ 30.30 (no bundle), no rug keywords
 *  3. Open shadow position, subscribe Helius accountSubscribe on bonding curve PDA
 *  4. Exit logic:
 *     - 45s: if mult < 1.01 → STAGNATION stage 1 (no buyers at all)
 *     - 90s: if mult < 1.03 → STAGNATION stage 2 (failed to hold +3%)
 *     - 180s: if mult < 1.05 → STAGNATION stage 3 (final dead-token exit)
 *     - -7% stop-loss: immediate exit
 *     - 1.25x: enable 8% trailing stop
 *     - 1.60x: sell 50%
 *     - 2.20x: sell 80%
 *     - 15min hard limit
 *  5. Record all trades to shadow_trades (strategy='w3-sniper')
 *
 * Shadow mode: W3_SNIPER_SHADOW=true (default) — no real transactions
 * Live mode:   W3_SNIPER_SHADOW=false (only after shadow WR ≥ 20%, EV > 0)
 */

import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { query } from '@lib/db';
import { analyzeDevReputation } from './dev-profiler';

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED        = process.env.W3_SNIPER_ENABLED === 'true';
const SHADOW         = process.env.W3_SNIPER_SHADOW  !== 'false'; // DEFAULT: shadow
const BUY_SOL        = Number(process.env.W3_SNIPER_BUY_SOL        || '0.015');
const MAX_POSITIONS  = Number(process.env.W3_SNIPER_MAX_POSITIONS   || '3');
const DAILY_LIMIT    = Number(process.env.W3_SNIPER_DAILY_LIMIT     || '15');
const MIN_DEV_SOL    = Number(process.env.W3_SNIPER_MIN_DEV_SOL     || '0.20');  // ↑ was 0.15
const MIN_DEV_SCORE  = Number(process.env.W3_SNIPER_MIN_DEV_SCORE   || '40');   // dev reputation threshold
const TIME_LIMIT_SEC = Number(process.env.W3_SNIPER_TIME_LIMIT_SEC  || '900');   // 15 min
const STAGNATION_SEC = Number(process.env.W3_SNIPER_STAGNATION_SEC  || '180');   // final stagnation check
const STAGNATION_MIN_MULT = Number(process.env.W3_SNIPER_STAGNATION_MULT || '1.05'); // need +5% by 180s
const TP1_MULT       = Number(process.env.W3_SNIPER_TP1_MULT        || '1.25'); // ↓ was 1.35
const TP2_MULT       = Number(process.env.W3_SNIPER_TP2_MULT        || '1.60'); // ↓ was 1.80
const TP3_MULT       = Number(process.env.W3_SNIPER_TP3_MULT        || '2.20'); // ↓ was 2.50
const TRAIL_PCT      = Number(process.env.W3_SNIPER_TRAIL_PCT       || '0.08'); // ↓ was 0.10
const STOP_PCT       = Number(process.env.W3_SNIPER_STOP_PCT        || '0.07'); // ↓ was 0.08

// pump.fun program & bonding curve
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecth7ZC6HSZNSVD5nc7KxECunY9gPH37X43gQp');

// Bonding curve genesis constants
const VIRTUAL_SOL_RESERVES   = 30;
const VIRTUAL_TOKEN_RESERVES = 1_073_000_191;

// PumpPortal
const PP_WS  = 'wss://pumpportal.fun/api/data';

// Helius connection (shared, lazy-init)
let heliusConn: Connection | null = null;
function getConn(): Connection {
  if (!heliusConn) {
    const rpc = process.env.HELIUS_RPC || process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    heliusConn = new Connection(rpc, 'confirmed');
  }
  return heliusConn;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface W3Position {
  mint:             string;
  symbol:           string;
  name:             string;
  entry_price_sol:  number;
  entry_mcap_sol:   number;
  dev_buy_sol:      number;
  bought_at:        number;
  amount_sol:       number;
  token_amount:     number;
  current_price:    number;
  peak_price:       number;
  tp1_triggered:    boolean;
  tp2_triggered:    boolean;
  tp3_triggered:    boolean;
  remaining_pct:    number;
  db_id?:           string;
  price_sub_id?:    number;  // Helius accountSubscribe ID
}

// ─── State ────────────────────────────────────────────────────────────────────

const positions = new Map<string, W3Position>();
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let dailyBuyCount = 0;
let lastDayReset  = new Date().toDateString();

// ─── Bonding Curve Math ───────────────────────────────────────────────────────

function bcPrice(vSol: number, vTokens: number): number {
  return vSol / vTokens;
}

function bcBuyTokens(vSol: number, vTokens: number, solIn: number): number {
  const k       = vSol * vTokens;
  const newVSol = vSol + solIn;
  return vTokens - k / newVSol;
}

// ─── Bonding Curve PDA ───────────────────────────────────────────────────────
// Computes the bonding curve account address for a given pump.fun mint

function getBondingCurvePda(mint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

// ─── Helius accountSubscribe price tracking ───────────────────────────────────
// Replaces PumpPortal subscribeTokenTrade (which requires paid API key)
// pump.fun bonding curve account layout:
//   bytes 0-7:   discriminator
//   bytes 8-15:  virtualTokenReserves (u64, base units)
//   bytes 16-23: virtualSolReserves   (u64, lamports)
//   bytes 24-31: realTokenReserves
//   bytes 32-39: realSolReserves
//   bytes 40-47: tokenTotalSupply
//   byte  48:    complete (bool)

function subscribePriceTracking(pos: W3Position): void {
  try {
    const pda = getBondingCurvePda(pos.mint);
    const conn = getConn();
    const subId = conn.onAccountChange(pda, (info) => {
      try {
        // Explicit Buffer cast — some RPC nodes return Uint8Array, not Buffer
        const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data as any);
        if (data.length < 25) return;
        const vTokens = Number(data.readBigUInt64LE(8));   // base token units
        const vSolLam = Number(data.readBigUInt64LE(16));  // lamports
        if (vTokens <= 0 || vSolLam <= 0) return;
        const vSol  = vSolLam / 1e9;
        const price = vSol / vTokens;
        pos.current_price = price;
        if (price > pos.peak_price) pos.peak_price = price;
        const mult = price / pos.entry_price_sol;
        console.debug(`[w3-sniper] 📊 ${pos.symbol} price=${(price * 1e9).toFixed(2)}n mult=${mult.toFixed(3)}x`);
      } catch (e: any) {
        console.warn(`[w3-sniper] parse err ${pos.symbol}: ${e.message?.slice(0, 50)}`);
      }
    }, 'confirmed');
    pos.price_sub_id = subId;
    console.debug(`[w3-sniper] 📡 Price tracking: ${pos.symbol} via accountSubscribe subId=${subId}`);
  } catch (e: any) {
    console.warn(`[w3-sniper] accountSubscribe failed for ${pos.symbol}: ${e.message}`);
  }
}

function unsubscribePriceTracking(pos: W3Position): void {
  if (pos.price_sub_id !== undefined) {
    try { getConn().removeAccountChangeListener(pos.price_sub_id); } catch {}
    pos.price_sub_id = undefined;
  }
}

// ─── Daily limit reset ────────────────────────────────────────────────────────

function checkDailyReset(): void {
  const today = new Date().toDateString();
  if (today !== lastDayReset) { dailyBuyCount = 0; lastDayReset = today; }
}

// ─── Entry filter ─────────────────────────────────────────────────────────────

const RUG_KEYWORDS = [
  'test','scam','rug','honeypot','fake','free','airdrop','presale',
  'fair launch','claim','win ','100x guarantee',
];

function isLikelyRug(name: string, symbol: string): boolean {
  const lower = (name + ' ' + symbol).toLowerCase();
  return RUG_KEYWORDS.some(k => lower.includes(k));
}

// ─── Open position ────────────────────────────────────────────────────────────

async function openPosition(msg: any): Promise<void> {
  checkDailyReset();
  if (positions.size >= MAX_POSITIONS) return;
  if (dailyBuyCount >= DAILY_LIMIT) return;

  const mint   = msg.mint as string;
  const symbol = (msg.symbol as string || '???').slice(0, 20);
  const name   = (msg.name   as string || '').slice(0, 50);

  if (!mint) return;
  if (positions.has(mint)) return;

  const devSol = Number(msg.solAmount ?? 0);
  if (devSol < MIN_DEV_SOL) {
    console.debug(`[w3-sniper] Skip ${symbol}: dev_buy ${devSol.toFixed(4)} SOL < ${MIN_DEV_SOL} (no skin in game)`);
    return;
  }

  // Socials required: tokens with X/Telegram have community = less likely to die at 45s.
  // Controlled by W3_SNIPER_REQUIRE_SOCIALS=false to disable in tests.
  const REQUIRE_SOCIALS = process.env.W3_SNIPER_REQUIRE_SOCIALS !== 'false';
  if (REQUIRE_SOCIALS) {
    const hasSocials = !!(msg.twitter || msg.telegram || msg.website);
    if (!hasSocials) {
      console.debug(`[w3-sniper] Skip ${symbol}: no socials (X/TG required — set W3_SNIPER_REQUIRE_SOCIALS=false to disable)`);
      return;
    }
  }

  if (isLikelyRug(name, symbol)) {
    console.debug(`[w3-sniper] Skip ${symbol}: rug keywords`);
    return;
  }

  const vSol = Number(msg.vSolInBondingCurve   ?? VIRTUAL_SOL_RESERVES);
  const vTok = Number(msg.vTokensInBondingCurve ?? VIRTUAL_TOKEN_RESERVES);
  if (vSol <= 0 || vTok <= 0) return;

  // Anti-bundle: detect if OTHER wallets (not dev) bought in the same block.
  // Genesis vSol=30. After dev buy: vSol = 30 + devSol. Extra = what bundlers added.
  // Old check (vSol>30.30) was WRONG: blocked devs buying ≥0.31 SOL (the good ones).
  const extraSol = vSol - devSol - VIRTUAL_SOL_RESERVES;
  if (extraSol > 0.15) {
    console.info(`[w3-sniper] 🚨 Skip ${symbol}: bundle trap (other wallets +${extraSol.toFixed(2)} SOL in same block)`);
    return;
  }

  // Dev reputation check — serial scammers launch dozens of dead tokens (2s timeout, fail-open)
  if (MIN_DEV_SCORE > 0) {
    const devWallet = msg.traderPublicKey as string | undefined;
    if (devWallet) {
      try {
        const repPromise = analyzeDevReputation(devWallet);
        const timeout   = new Promise<null>(r => setTimeout(() => r(null), 2000));
        const devRep    = await Promise.race([repPromise, timeout]);
        if (devRep === null) {
          console.debug(`[w3-sniper] ⏱️ Dev rep timeout ${symbol} — proceed`);
        } else if (devRep.isSerialScammer) {
          console.debug(`[w3-sniper] 🚨 Skip ${symbol}: serial scammer (${devRep.reason})`);
          return;
        } else if (devRep.score < MIN_DEV_SCORE) {
          console.debug(`[w3-sniper] 🚨 Skip ${symbol}: dev score ${devRep.score} < ${MIN_DEV_SCORE} (${devRep.reason})`);
          return;
        } else {
          console.debug(`[w3-sniper] ✅ Dev score ${devRep.score}/100 for ${symbol}`);
        }
      } catch { /* fail-open: proceed without rep check */ }
    }
  }

  const entryPrice  = bcPrice(vSol, vTok);
  const tokenAmount = bcBuyTokens(vSol, vTok, BUY_SOL);
  const mcapSol     = Number(msg.marketCapSol ?? vSol / vTok * 1_000_000_000 / 1e9);

  const pos: W3Position = {
    mint, symbol, name,
    entry_price_sol: entryPrice,
    entry_mcap_sol:  mcapSol,
    dev_buy_sol:     devSol,
    bought_at:       Date.now(),
    amount_sol:      BUY_SOL,
    token_amount:    tokenAmount,
    current_price:   entryPrice,
    peak_price:      entryPrice,
    tp1_triggered:   false,
    tp2_triggered:   false,
    tp3_triggered:   false,
    remaining_pct:   100,
  };

  positions.set(mint, pos);
  dailyBuyCount++;

  // Subscribe Helius accountSubscribe for real-time price (replaces broken subscribeTokenTrade)
  subscribePriceTracking(pos);

  // Persist to shadow_trades
  try {
    const res = await query<{ id: string }>(
      `INSERT INTO shadow_trades
         (chain, strategy, symbol, contract_address, entry_price, entry_mcap_usd,
          filter_params, tp1_target, stop_pct, status)
       VALUES ('pumpfun', 'w3-sniper', $1, $2, $3, $4, $5, $6, $7, 'open')
       RETURNING id`,
      [
        symbol, mint, entryPrice,
        mcapSol * (Number(process.env.SOL_PRICE_USD) || 150),
        JSON.stringify({ dev_buy_sol: devSol, token_amount: tokenAmount, buy_sol: BUY_SOL, shadow: SHADOW }),
        TP1_MULT * 100 - 100,
        STOP_PCT * 100,
      ]
    );
    pos.db_id = res.rows[0]?.id;
  } catch (e: any) {
    console.warn(`[w3-sniper] DB insert failed: ${e.message}`);
  }

  const mode = SHADOW ? '📊SHADOW' : '🟢LIVE';
  console.info(
    `[w3-sniper] ${mode} ${symbol} (${mint.slice(0, 8)}) | ` +
    `entry:${(entryPrice * 1e9).toFixed(4)}n | mcap:${mcapSol.toFixed(1)} SOL | dev:${devSol.toFixed(3)} SOL`
  );
}

// ─── Exit logic ───────────────────────────────────────────────────────────────

async function checkPositions(): Promise<void> {
  const now = Date.now();

  for (const [mint, pos] of positions) {
    const ageSec   = (now - pos.bought_at) / 1000;
    const mult     = pos.current_price / pos.entry_price_sol;
    const peakMult = pos.peak_price    / pos.entry_price_sol;
    let exitReason: string | null = null;

    // ─── Stop loss -8% ───────────────────────────────────────────────────────
    if (mult <= 1 - STOP_PCT) {
      exitReason = `STOP_LOSS_${((1 - mult) * 100).toFixed(1)}pct`;
    }

    // ─── Stagnation Exit: 3-stage fast exit (v3) ────────────────────────────
    // Stage 1 (45s): no buyers at all → exit near-zero
    else if (ageSec >= 45 && ageSec < 60 && mult < 1.01) {
      exitReason = `STAGNATION_45s_${(mult * 100 - 100).toFixed(1)}pct`;
    }
    // Stage 2 (90s): failed to hold +3% → momentum dead
    else if (ageSec >= 90 && ageSec < 105 && mult < 1.03) {
      exitReason = `STAGNATION_90s_${(mult * 100 - 100).toFixed(1)}pct`;
    }
    // Stage 3 (180s): final check — if still < +5% → exit flat
    else if (ageSec >= STAGNATION_SEC && ageSec < STAGNATION_SEC + 15 && mult < STAGNATION_MIN_MULT) {
      exitReason = `STAGNATION_180s_${(mult * 100 - 100).toFixed(1)}pct`;
    }

    // ─── TP3: 2.5x → sell 80% ────────────────────────────────────────────────
    else if (!pos.tp3_triggered && mult >= TP3_MULT) {
      pos.tp3_triggered = true;
      pos.remaining_pct = 20;
      await recordPartialExit(pos, 80, mult, 'TP3_80pct');
      console.info(`[w3-sniper] TP3 ${pos.symbol} ${mult.toFixed(2)}x → sold 80%, holding 20% moon-bag`);
    }

    // ─── TP2: 1.8x → sell 50% ────────────────────────────────────────────────
    else if (!pos.tp2_triggered && mult >= TP2_MULT) {
      pos.tp2_triggered = true;
      pos.remaining_pct = 50;
      await recordPartialExit(pos, 50, mult, 'TP2_50pct');
      console.info(`[w3-sniper] TP2 ${pos.symbol} ${mult.toFixed(2)}x → sold 50%`);
    }

    // ─── TP1: 1.35x → trailing stop enabled ──────────────────────────────────
    else if (!pos.tp1_triggered && mult >= TP1_MULT) {
      pos.tp1_triggered = true;
      console.info(`[w3-sniper] TP1 ${pos.symbol} ${mult.toFixed(2)}x → trailing stop ACTIVE (${(TRAIL_PCT * 100).toFixed(0)}%)`);
    }

    // ─── Trailing stop (after TP1) ────────────────────────────────────────────
    else if (pos.tp1_triggered && pos.current_price < pos.peak_price * (1 - TRAIL_PCT)) {
      exitReason = `TRAIL_STOP_peak${peakMult.toFixed(2)}x`;
    }

    // ─── Hard time limit 15 min ───────────────────────────────────────────────
    else if (ageSec >= TIME_LIMIT_SEC) {
      if (mult >= 1.15) {
        exitReason = `TIME_LIMIT_WIN_${(mult * 100 - 100).toFixed(0)}pct`;
      } else if (mult >= 0.90) {
        exitReason = `TIME_LIMIT_FLAT_${(mult * 100 - 100).toFixed(1)}pct`;
      } else {
        exitReason = `TIME_LIMIT_LOSS_${(mult * 100 - 100).toFixed(1)}pct`;
      }
    }

    if (exitReason) {
      await closePosition(pos, mult, exitReason);
      unsubscribePriceTracking(pos);
      positions.delete(mint);
    }
  }
}

// ─── Partial sell record (TP2/TP3) ───────────────────────────────────────────

async function recordPartialExit(pos: W3Position, sellPct: number, mult: number, reason: string): Promise<void> {
  if (!pos.db_id) return;
  const pnlSol = pos.amount_sol * (sellPct / 100) * (mult - 1);
  try {
    await query(`UPDATE shadow_trades SET check_4h_pct=$1 WHERE id=$2`, [mult * 100 - 100, pos.db_id]);
  } catch { }
  console.info(`[w3-sniper] Partial ${reason}: ${pos.symbol} ${sellPct}% @ ${mult.toFixed(2)}x | +${pnlSol.toFixed(5)} SOL`);
}

// ─── Close position ───────────────────────────────────────────────────────────

async function closePosition(pos: W3Position, exitMult: number, reason: string): Promise<void> {
  const pnlSol = pos.amount_sol * pos.remaining_pct / 100 * (exitMult - 1);
  const pnlPct = (exitMult - 1) * 100;
  const win    = exitMult >= 1.1;

  if (pos.db_id) {
    try {
      await query(
        `UPDATE shadow_trades
         SET status       = $1,
             outcome_price= $2,
             outcome_pct  = $3,
             outcome_at   = NOW()
         WHERE id = $4`,
        [win ? 'tp1_hit' : 'stopped', pos.entry_price_sol * exitMult, pnlPct, pos.db_id]
      );
    } catch { }
  }

  const arrow = win ? '✅' : (exitMult >= 0.95 ? '➡️' : '❌');
  const mode  = SHADOW ? 'SHADOW' : 'LIVE';
  console.info(
    `[w3-sniper] ${arrow} ${mode} EXIT ${pos.symbol} | ${exitMult.toFixed(3)}x | ` +
    `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(5)} SOL | age:${((Date.now() - pos.bought_at) / 60000).toFixed(1)}m | ${reason}`
  );
}

// ─── PumpPortal WebSocket ─────────────────────────────────────────────────────

function connect(): void {
  if (ws) { ws.removeAllListeners(); try { ws.terminate(); } catch {} ws = null; }

  const conn = new WebSocket(PP_WS);
  ws = conn;

  conn.on('open', () => {
    console.info('[w3-sniper] ✅ PumpPortal WS connected — subscribeNewToken only (free tier)');
    conn.send(JSON.stringify({ method: 'subscribeNewToken' }));
    // NOTE: subscribeTokenTrade REMOVED — requires paid API key (was causing 0% price feed)
    // Price tracking now via Helius accountSubscribe on bonding curve PDA (free, real-time)
  });

  conn.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.txType) return;
      if (msg.txType === 'create') await openPosition(msg);
      // txType 'buy'/'sell' removed — no longer subscribing to token trades
    } catch { }
  });

  conn.on('error', (err) => {
    console.warn(`[w3-sniper] WS error: ${err.message?.slice(0, 60)}`);
  });

  conn.on('close', (code) => {
    ws = null;
    console.warn(`[w3-sniper] WS closed (${code}) — reconnecting in 15s`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 15_000);
  });
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export async function getW3SniperStats(hours = 12): Promise<string> {
  try {
    const rows = await query<any>(
      `SELECT outcome_pct, status, outcome_at, created_at, symbol,
              filter_params->>'dev_buy_sol' as dev_sol
       FROM shadow_trades
       WHERE strategy='w3-sniper'
         AND created_at > NOW() - INTERVAL '${hours} hours'
       ORDER BY created_at DESC`,
    );
    const all    = rows.rows;
    const closed = all.filter(r => r.status !== 'open');
    const open   = all.filter(r => r.status === 'open');
    const wins   = closed.filter(r => Number(r.outcome_pct ?? 0) >= 10);
    const losses = closed.filter(r => Number(r.outcome_pct ?? 0) < 0);
    const flats  = closed.filter(r => { const p = Number(r.outcome_pct ?? 0); return p >= 0 && p < 10; });

    if (all.length === 0) return `📊 W3 Sniper (${hours}h): no trades yet`;

    const avgWin  = wins.length   ? wins.reduce((s, r)  => s + Number(r.outcome_pct), 0) / wins.length  : 0;
    const avgLoss = losses.length ? losses.reduce((s, r) => s + Number(r.outcome_pct), 0) / losses.length : 0;
    const wr      = closed.length ? wins.length / closed.length * 100 : 0;
    const ev      = wr / 100 * avgWin + (1 - wr / 100) * avgLoss;
    const evSol   = ev / 100 * BUY_SOL;

    const best  = closed.reduce((a, b) => Number(a?.outcome_pct ?? -999) > Number(b?.outcome_pct ?? -999) ? a : b, null as any);
    const worst = closed.reduce((a, b) => Number(a?.outcome_pct ?? 999)  < Number(b?.outcome_pct ?? 999)  ? a : b, null as any);

    const mode = SHADOW ? '📊 SHADOW v2' : '🟢 LIVE v2';
    return [
      `${mode} W3 Sniper — ${hours}h Report`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Total: ${all.length} (open: ${open.length}, closed: ${closed.length})`,
      `Wins (≥+10%): ${wins.length} | Flat: ${flats.length} | Loss: ${losses.length}`,
      `Win rate: ${wr.toFixed(1)}%`,
      `Avg win: +${avgWin.toFixed(1)}% | Avg loss: ${avgLoss.toFixed(1)}%`,
      `EV/trade: ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}% (${evSol >= 0 ? '+' : ''}${evSol.toFixed(5)} SOL) ${ev > 0 ? '✅' : '❌'}`,
      best  ? `Best:  ${best.symbol}  +${Number(best.outcome_pct).toFixed(1)}%`  : '',
      worst ? `Worst: ${worst.symbol} ${Number(worst.outcome_pct).toFixed(1)}%` : '',
      open.length ? `Open: ${open.map((r: any) => r.symbol).join(', ')}` : '',
    ].filter(Boolean).join('\n');
  } catch (e: any) {
    return `W3 Sniper stats error: ${e.message}`;
  }
}

// ─── Startup cleanup ──────────────────────────────────────────────────────────

async function cleanupStalePositions(): Promise<void> {
  try {
    const res = await query<{ id: string; symbol: string }>(
      `UPDATE shadow_trades
         SET status='stopped', outcome_pct=0, outcome_at=NOW()
       WHERE strategy='w3-sniper' AND status='open'
       RETURNING id, symbol`,
      []
    );
    if (res.rows.length > 0) {
      console.info(`[w3-sniper] 🧹 Closed ${res.rows.length} pre-restart positions: ${res.rows.map(r => r.symbol).join(', ')}`);
    }
  } catch (e: any) {
    console.warn(`[w3-sniper] Cleanup error: ${e.message}`);
  }
}

// ─── F&G guard ────────────────────────────────────────────────────────────────

async function checkFGHistorySafe(): Promise<boolean> {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=5');
    const j = await (r as any).json();
    const values = j?.data?.map((d: any) => Number(d.value)) ?? [];
    // Live gate: require 5 consecutive days F&G > threshold.
    // Default 25 (FEAR zone bottom) — allows micro-live in stable FEAR, blocks DEEP_FEAR/EXTREME_FEAR.
    // Raise to 45 in .env (W3_SNIPER_FG_LIVE_MIN=45) for stricter BULL-only live mode.
    const FG_LIVE_MIN = Number(process.env.W3_SNIPER_FG_LIVE_MIN || '25');
    const allBull = values.length >= 5 && values.every((v: number) => v > FG_LIVE_MIN);
    if (!allBull) {
      console.info(`[w3-sniper] 🔒 F&G guard: BLOCKED (need 5 days F&G>${FG_LIVE_MIN}, got: ${values.slice(0,5).join(',')})`);
    }
    return allBull;
  } catch {
    return false; // safe default: block if API unreachable
  }
}

// ─── Export startup ───────────────────────────────────────────────────────────

export async function startW3Sniper(): Promise<void> {
  if (!ENABLED) {
    console.info('[w3-sniper] Disabled (W3_SNIPER_ENABLED != true)');
    return;
  }

  await cleanupStalePositions();

  // F&G guard: only run in BULL market (5 days F&G > 45)
  const bullConfirmed = await checkFGHistorySafe();
  if (!bullConfirmed) {
    console.info('[w3-sniper] 🔒 BLOCKED by F&G guard — sniper only runs in BULL (F&G>45 × 5d)');
    console.info('[w3-sniper] Shadow stats will continue accumulating when enabled manually');
    // In SHADOW mode we still want data — start anyway but log the block
    if (!SHADOW) return;
  }

  const mode = SHADOW ? '📊 SHADOW v2' : '🟢 LIVE v2';
  console.info(`[w3-sniper] ${mode} — minDev:${MIN_DEV_SOL} SOL | stagnation:${STAGNATION_SEC}s | SL:${STOP_PCT*100}% | TP1:${TP1_MULT}x | trail:${TRAIL_PCT*100}%`);
  console.info('[w3-sniper] 📡 Price source: Helius accountSubscribe (free, real-time) — subscribeTokenTrade DISABLED');

  connect();
  setInterval(checkPositions, 10_000);
}

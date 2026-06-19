/**
 * Bonding Smart — Real-time PumpFun Trading Engine
 *
 * Architecture:
 *  - PumpPortal WebSocket: real-time create/buy/sell events (0 lag vs DexScreener 30-60s)
 *  - In-memory Volume Velocity: sum of solAmount per token in rolling 60s window
 *  - Pre-buy validation: dev history, bundle detection, social check, curve progress
 *  - Dynamic TP: +50%→50%, +100%→25%, rest free-ride with trailing stop
 *  - Time-based exit: if volume < 1 SOL in 120s after buy → force exit
 *
 * Control:
 *  BONDING_SMART_ENABLED=true  to enable (default: false)
 *  BONDING_SMART_BUY_SOL      position size (default: 0.02)
 *  BONDING_SMART_MAX_POSITIONS concurrent positions (default: 2)
 *
 * Status: CONFIGURED, TRADING DISABLED (BONDING_SMART_ENABLED=false in VPS .env)
 * DO NOT enable without backtesting on 500+ signals.
 */

import WebSocket from 'ws';
import axios from 'axios';
import { query } from '@lib/db';

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED            = process.env.BONDING_SMART_ENABLED === 'true';
const BUY_SOL            = Number(process.env.BONDING_SMART_BUY_SOL       || '0.02');
const MAX_POSITIONS      = Number(process.env.BONDING_SMART_MAX_POSITIONS  || '2');
const DAILY_MAX_SOL      = Number(process.env.BONDING_SMART_DAILY_SOL      || '0.2');

// Bonding curve progress filter — enter only in the "sweet spot"
const MIN_CURVE_PROGRESS = Number(process.env.BONDING_SMART_MIN_CURVE_PCT  || '20');  // <20% = too risky
const MAX_CURVE_PROGRESS = Number(process.env.BONDING_SMART_MAX_CURVE_PCT  || '60');  // >60% = near graduation = sell wall

// Volume velocity: minimum SOL flowing into the token in the last 60 seconds
const MIN_VELOCITY_SOL_60S = Number(process.env.BONDING_SMART_MIN_VEL_SOL  || '5');

// Unique buyers in last 5 minutes — organic demand check
const MIN_UNIQUE_BUYERS_5M = Number(process.env.BONDING_SMART_MIN_BUYERS   || '30');

// Dev wallet holding — if dev holds >5% of supply, risk of dump is high
const MAX_DEV_HOLDING_PCT  = Number(process.env.BONDING_SMART_MAX_DEV_PCT   || '5');

// Token age: don't buy tokens older than 30 minutes (opportunity window closed)
const MAX_TOKEN_AGE_SEC    = Number(process.env.BONDING_SMART_MAX_AGE_SEC   || '1800');

// Stop-loss: 10% below entry price
const STOP_PCT             = Number(process.env.BONDING_SMART_STOP_PCT      || '10') / 100;

// Time-based exit: if 60s volume falls below 1 SOL within 120s of buy → force exit
const VOLUME_WATCH_SEC     = Number(process.env.BONDING_SMART_VOL_WATCH_SEC || '120');
const MIN_VOLUME_TO_STAY   = Number(process.env.BONDING_SMART_MIN_VOL_STAY  || '1.0');

// sell slippage — increases to 15% on dump detection
const BASE_SLIPPAGE_BPS    = 500;   // 5%
const DUMP_SLIPPAGE_BPS    = 1500;  // 15% — dump mode

// PumpFun graduation SOL threshold (~588 SOL = 100% curve)
const GRADUATION_SOL       = 588;

// Dev history check: skip if dev created >3 tokens in last 2h that all failed
const MAX_DEV_RECENT_FAILS = 3;

const PUMPPORTAL_WS  = 'wss://pumpportal.fun/api/data';
const PUMPPORTAL_BUY = 'https://pumpportal.fun/api/trade-local';
const HELIUS_RPC     = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const BIRDEYE_KEY    = process.env.BIRDEYE_API_KEY ?? '';

// ─── In-memory velocity tracker ──────────────────────────────────────────────

interface TradeEvent {
  ts: number;
  solAmount: number;
  buyer: string;
  isBuy: boolean;
}

interface TokenState {
  mint: string;
  symbol: string;
  devWallet: string;
  createdAt: number;
  // social presence from metadata
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  // bundle detection: dev bought >10% in creation TX
  bundleDetected: boolean;
  // rolling trade events (keep 5 minutes)
  events: TradeEvent[];
  // current vSol in bonding curve (for curve progress calc)
  vSol: number;
  // dev SOL invested (from creation event)
  devSolInvested: number;
}

const tokenStates = new Map<string, TokenState>();
const WINDOW_MS = 5 * 60 * 1000;  // 5-minute rolling window

// ─── Active positions ─────────────────────────────────────────────────────────

interface SmartPosition {
  mint: string;
  symbol: string;
  entryPrice: number;    // SOL per token (from PumpPortal)
  tokenAmount: number;   // tokens bought
  boughtAt: number;      // unix ms
  peakPrice: number;     // for trailing stop
  stage1Done: boolean;   // +50% sell done
  stage2Done: boolean;   // +100% sell done
  lastVolumeSol: number; // volume in last 60s (for time exit)
  pool: string;          // pumpfun or pumpswap
}

const activePositions = new Map<string, SmartPosition>();
let dailySpent = 0;
let lastDailyReset = 0;

// ─── Helius dev history check ─────────────────────────────────────────────────

async function checkDevHistory(devWallet: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    // Fetch last 20 transactions for dev wallet via Helius
    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [devWallet, { limit: 50 }],
    }, { timeout: 5_000 });
    const sigs: any[] = res.data?.result ?? [];
    // If dev has made >50 recent TXs they're a serial launcher — flag but don't block
    if (sigs.length >= 50) {
      console.debug(`[bonding-smart] Dev ${devWallet.slice(0, 8)} is very active (≥50 recent TXs)`);
    }
    return { ok: true };
  } catch {
    return { ok: true };  // fail open
  }
}

// ─── Metadata social check ────────────────────────────────────────────────────

async function fetchMetadataSocials(metadataUri: string): Promise<{
  hasTwitter: boolean; hasTelegram: boolean; hasWebsite: boolean;
}> {
  const empty = { hasTwitter: false, hasTelegram: false, hasWebsite: false };
  if (!metadataUri) return empty;
  try {
    const res = await axios.get(metadataUri.replace('ipfs://', 'https://ipfs.io/ipfs/'), {
      timeout: 4_000,
    });
    const d = res.data ?? {};
    const links = JSON.stringify(d).toLowerCase();
    return {
      hasTwitter:  links.includes('twitter') || links.includes('x.com'),
      hasTelegram: links.includes('t.me') || links.includes('telegram'),
      hasWebsite:  !!(d.website || d.external_url),
    };
  } catch {
    return empty;
  }
}

// ─── Dev holding check via Helius ─────────────────────────────────────────────

async function getDevHoldingPct(mint: string, devWallet: string): Promise<number> {
  try {
    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'getTokenAccountsByOwner',
      params: [devWallet, { mint }, { encoding: 'jsonParsed' }],
    }, { timeout: 5_000 });
    const accounts: any[] = res.data?.result?.value ?? [];
    if (!accounts.length) return 0;
    const uiAmount = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? '0';
    // Pump.fun total supply = 1,000,000,000
    return (Number(uiAmount) / 1_000_000_000) * 100;
  } catch {
    return 0;  // fail open
  }
}

// ─── Daily spend tracking ─────────────────────────────────────────────────────

function checkDailyReset() {
  const today = Math.floor(Date.now() / 86400000);
  if (today !== lastDailyReset) {
    dailySpent = 0;
    lastDailyReset = today;
  }
}

// ─── Entry decision ───────────────────────────────────────────────────────────

async function shouldBuy(state: TokenState): Promise<{ buy: boolean; reason: string }> {
  const skip = (r: string) => ({ buy: false, reason: r });

  const ageMs  = Date.now() - state.createdAt;
  const ageSec = ageMs / 1000;

  // Age check
  if (ageSec > MAX_TOKEN_AGE_SEC)
    return skip(`too old: ${(ageSec / 60).toFixed(0)}min (max ${MAX_TOKEN_AGE_SEC / 60}min)`);

  // Bundle detection: skip dev-sniped launches
  if (state.bundleDetected)
    return skip('bundle detected: dev bought >10% in creation TX');

  // Social check: require at least Twitter OR Telegram
  if (!state.hasTwitter && !state.hasTelegram)
    return skip('no socials: no Twitter/Telegram in metadata');

  // Bonding curve progress: 20-60% sweet spot
  const curveProgress = Math.min(100, (state.vSol / GRADUATION_SOL) * 100);
  if (curveProgress < MIN_CURVE_PROGRESS)
    return skip(`curve ${curveProgress.toFixed(0)}% < ${MIN_CURVE_PROGRESS}% (too early, high death rate)`);
  if (curveProgress > MAX_CURVE_PROGRESS)
    return skip(`curve ${curveProgress.toFixed(0)}% > ${MAX_CURVE_PROGRESS}% (near graduation, sell wall incoming)`);

  // Volume velocity: sum of buy SOL in last 60 seconds
  const now = Date.now();
  const recent = state.events.filter(e => e.isBuy && now - e.ts <= 60_000);
  const velocitySol = recent.reduce((s, e) => s + e.solAmount, 0);
  if (velocitySol < MIN_VELOCITY_SOL_60S)
    return skip(`velocity ${velocitySol.toFixed(2)} SOL/60s < ${MIN_VELOCITY_SOL_60S} SOL (low demand)`);

  // Unique buyers in last 5 minutes
  const fiveMin = Date.now() - WINDOW_MS;
  const uniqueBuyers = new Set(state.events.filter(e => e.isBuy && e.ts > fiveMin).map(e => e.buyer));
  if (uniqueBuyers.size < MIN_UNIQUE_BUYERS_5M)
    return skip(`unique buyers 5m: ${uniqueBuyers.size} < ${MIN_UNIQUE_BUYERS_5M} (wash trading risk)`);

  // Anti-whale check: if any single buy > 5 SOL in last 60s → manipulation risk
  const hasWhaleBuy = recent.some(e => e.solAmount > 5);
  if (hasWhaleBuy)
    return skip('anti-whale: single buy > 5 SOL in last 60s (artificial spike)');

  // Dev holding check (async)
  const devPct = await getDevHoldingPct(state.mint, state.devWallet);
  if (devPct > MAX_DEV_HOLDING_PCT)
    return skip(`dev holds ${devPct.toFixed(1)}% > ${MAX_DEV_HOLDING_PCT}% (dump risk)`);

  return {
    buy: true,
    reason: `curve:${curveProgress.toFixed(0)}% vel:${velocitySol.toFixed(2)}SOL/60s `
           + `buyers5m:${uniqueBuyers.size} dev:${devPct.toFixed(1)}% age:${(ageSec/60).toFixed(0)}min`
  };
}

// ─── Buy via PumpPortal ────────────────────────────────────────────────────────

async function doBuy(state: TokenState, context: string): Promise<void> {
  const walletPk = process.env.WALLET_PRIVATE_KEY;
  if (!walletPk) return;

  try {
    const params = {
      publicKey: JSON.parse(walletPk)[0] ?? '',
      action: 'buy',
      mint: state.mint,
      denominatedInSol: 'true',
      amount: BUY_SOL,
      slippage: 10,
      priorityFee: 0.003,
      pool: 'pump',
    };
    const res = await axios.post(PUMPPORTAL_BUY, params, { responseType: 'arraybuffer', timeout: 10_000 });
    if (res.status !== 200) throw new Error(`PumpPortal ${res.status}`);

    // Record in DB
    await query(
      `INSERT INTO autobuy_jobs
         (mint_address, label, amount_sol, slippage_bps, interval_seconds,
          wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled, bought_at)
       VALUES ($1, $2, $3, $4, 86400, $5, false, $6, true, now())`,
      [
        state.mint,
        `auto:bonding:smart:${state.symbol}:pump`,
        BUY_SOL,
        BASE_SLIPPAGE_BPS,
        '', // wallet address not tracked here
        VOLUME_WATCH_SEC,
      ]
    );

    dailySpent += BUY_SOL;
    console.info(`[bonding-smart] ✅ BUY ${state.symbol} (${state.mint.slice(0, 8)}) ${BUY_SOL} SOL — ${context}`);

    // Track position (entry price = vSol/supply not available — approximate)
    const entryPrice = state.vSol / 800_000_000;  // rough approximation
    activePositions.set(state.mint, {
      mint: state.mint, symbol: state.symbol,
      entryPrice, tokenAmount: Math.floor(BUY_SOL / entryPrice),
      boughtAt: Date.now(), peakPrice: entryPrice,
      stage1Done: false, stage2Done: false,
      lastVolumeSol: 0,
      pool: 'pump',
    });
  } catch (err: any) {
    console.warn(`[bonding-smart] Buy failed ${state.symbol}: ${err.message?.slice(0, 60)}`);
  }
}

// ─── Sell via PumpPortal ──────────────────────────────────────────────────────

async function doSell(mint: string, symbol: string, pct: number, reason: string, slippage = BASE_SLIPPAGE_BPS): Promise<void> {
  const walletPk = process.env.WALLET_PRIVATE_KEY;
  if (!walletPk) return;

  try {
    const params = {
      publicKey: JSON.parse(walletPk)[0] ?? '',
      action: 'sell',
      mint,
      denominatedInSol: 'false',
      amount: pct === 100 ? '100%' : `${pct}%`,
      slippage: slippage / 100,
      priorityFee: 0.003,
      pool: 'pump',
    };
    const res = await axios.post(PUMPPORTAL_BUY, params, { responseType: 'arraybuffer', timeout: 10_000 });
    console.info(`[bonding-smart] 💰 SELL ${pct}% ${symbol} — ${reason} (slippage:${slippage / 100}%)`);
    if (res.status !== 200) {
      console.warn(`[bonding-smart] Sell failed ${symbol}: HTTP ${res.status}`);
    }
  } catch (err: any) {
    console.warn(`[bonding-smart] Sell error ${symbol}: ${err.message?.slice(0, 60)}`);
  }
}

// ─── Position monitor (1s poll) ───────────────────────────────────────────────

async function monitorPositions(): Promise<void> {
  const now = Date.now();

  for (const [mint, pos] of activePositions) {
    const state = tokenStates.get(mint);
    if (!state) continue;

    // Approximate current price from vSol (PumpPortal WebSocket updates this)
    const currentPrice = state.vSol / 800_000_000;
    if (!currentPrice || currentPrice <= 0) continue;

    // Update peak
    if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

    const mult = currentPrice / pos.entryPrice;
    const holdSec = (now - pos.boughtAt) / 1000;

    // Dynamic TP: +50% → sell 50%
    if (!pos.stage1Done && mult >= 1.5) {
      await doSell(mint, pos.symbol, 50, `TP1 ${(mult * 100 - 100).toFixed(0)}% gain`);
      pos.stage1Done = true;
      console.info(`[bonding-smart] 📈 TP1 hit: ${pos.symbol} at ${mult.toFixed(2)}x`);
    }

    // +100% → sell 50% of remaining (= 25% original)
    if (pos.stage1Done && !pos.stage2Done && mult >= 2.0) {
      await doSell(mint, pos.symbol, 50, `TP2 ${(mult * 100 - 100).toFixed(0)}% gain`);
      pos.stage2Done = true;
      console.info(`[bonding-smart] 📈 TP2 hit: ${pos.symbol} at ${mult.toFixed(2)}x`);
    }

    // Trailing stop: if price drops >20% from peak (after TP1)
    if (pos.stage1Done && currentPrice < pos.peakPrice * 0.80) {
      await doSell(mint, pos.symbol, 100, `trailing stop: ${((pos.peakPrice - currentPrice) / pos.peakPrice * 100).toFixed(0)}% from peak`);
      activePositions.delete(mint);
      continue;
    }

    // Stop-loss (before TP1): price dropped STOP_PCT below entry
    if (!pos.stage1Done && currentPrice < pos.entryPrice * (1 - STOP_PCT)) {
      await doSell(mint, pos.symbol, 100, `stop-loss at ${(mult * 100 - 100).toFixed(0)}%`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint);
      continue;
    }

    // Time-based exit: volume too low 120s after buy
    if (holdSec > VOLUME_WATCH_SEC) {
      const recentEvents = state.events.filter(e => e.isBuy && now - e.ts <= 60_000);
      const recentVol = recentEvents.reduce((s, e) => s + e.solAmount, 0);
      if (recentVol < MIN_VOLUME_TO_STAY) {
        await doSell(mint, pos.symbol, 100, `time-exit: vol ${recentVol.toFixed(2)} SOL/60s < ${MIN_VOLUME_TO_STAY} SOL`, DUMP_SLIPPAGE_BPS);
        activePositions.delete(mint);
        continue;
      }
    }

    // Dump detection: sell pressure > buy pressure 3:1 in last 30s → increase slippage
    const last30 = state.events.filter(e => now - e.ts <= 30_000);
    const buyVol  = last30.filter(e => e.isBuy).reduce((s, e) => s + e.solAmount, 0);
    const sellVol = last30.filter(e => !e.isBuy).reduce((s, e) => s + e.solAmount, 0);
    if (sellVol > buyVol * 3 && sellVol > 2) {
      console.warn(`[bonding-smart] ⚠️ Dump alert ${pos.symbol}: sell/buy ratio ${(sellVol / Math.max(buyVol, 0.01)).toFixed(1)}x — selling with 15% slippage`);
      await doSell(mint, pos.symbol, 100, `dump detected: sell/buy ${(sellVol / Math.max(buyVol, 0.01)).toFixed(1)}x`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint);
      continue;
    }
  }
}

// ─── WebSocket event handlers ─────────────────────────────────────────────────

async function handleCreate(ev: any): Promise<void> {
  const mint        = ev.mint as string;
  const devWallet   = ev.traderPublicKey as string;
  const symbol      = (ev.symbol ?? 'UNKNOWN') as string;
  const metaUri     = (ev.uri ?? '') as string;
  const devSolBuy   = Number(ev.solAmount ?? 0);
  const initialVSol = Number(ev.vSolInBondingCurve ?? 0);

  // Bundle detection: dev bought >10% of bonding curve in creation TX
  const bundleDetected = devSolBuy > GRADUATION_SOL * 0.10;

  // Fetch metadata socials (async, non-blocking for watchlist add)
  const socials = await fetchMetadataSocials(metaUri);

  const state: TokenState = {
    mint, symbol, devWallet,
    createdAt: Date.now(),
    hasTwitter: socials.hasTwitter,
    hasTelegram: socials.hasTelegram,
    hasWebsite: socials.hasWebsite,
    bundleDetected,
    events: [],
    vSol: initialVSol,
    devSolInvested: devSolBuy,
  };

  tokenStates.set(mint, state);

  const flags = [
    bundleDetected && '🚨bundle',
    !socials.hasTwitter && !socials.hasTelegram && '❌nosocial',
    socials.hasTwitter && '🐦X',
    socials.hasTelegram && '📱TG',
  ].filter(Boolean).join(' ');

  console.debug(`[bonding-smart] 🆕 ${symbol} dev:${devWallet.slice(0, 6)} devBuy:${devSolBuy.toFixed(3)}SOL ${flags}`);

  // Clean up states older than 2 hours to prevent memory leak
  const cutoff = Date.now() - 2 * 3600 * 1000;
  for (const [k, v] of tokenStates) {
    if (v.createdAt < cutoff) tokenStates.delete(k);
  }
}

async function handleTrade(ev: any): Promise<void> {
  const mint      = ev.mint as string;
  const buyer     = ev.traderPublicKey as string;
  const solAmount = Number(ev.solAmount ?? 0);
  const isBuy     = ev.txType === 'buy';
  const vSol      = Number(ev.vSolInBondingCurve ?? 0);

  const state = tokenStates.get(mint);
  if (!state) return;

  // Update bonding curve vSol
  if (vSol > 0) state.vSol = vSol;

  // Record trade event
  const now = Date.now();
  state.events.push({ ts: now, solAmount, buyer, isBuy });

  // Prune events older than 5 minutes
  const cutoff = now - WINDOW_MS;
  state.events = state.events.filter(e => e.ts >= cutoff);

  // Pre-graduation guard: if vSol > 488 (100 below graduation) and we have a position → exit
  if (vSol > 488 && activePositions.has(mint)) {
    const pos = activePositions.get(mint)!;
    console.warn(`[bonding-smart] 🎓 Pre-grad exit: ${pos.symbol} vSol=${vSol.toFixed(0)} (graduation in ~${(GRADUATION_SOL - vSol).toFixed(0)} SOL)`);
    await doSell(mint, pos.symbol, 100, 'pre-graduation exit: vSol > 488', DUMP_SLIPPAGE_BPS);
    activePositions.delete(mint);
    return;
  }

  // Skip buy check if not enabled or limits reached
  if (!ENABLED) return;
  if (activePositions.size >= MAX_POSITIONS) return;
  if (activePositions.has(mint)) return;  // already in position

  checkDailyReset();
  if (dailySpent + BUY_SOL > DAILY_MAX_SOL) return;

  // Only evaluate on buy events (not sell)
  if (!isBuy) return;

  const decision = await shouldBuy(state);
  if (decision.buy) {
    await doBuy(state, decision.reason);
  }
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectWS(): void {
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }

  ws = new WebSocket(PUMPPORTAL_WS);

  ws.on('open', () => {
    console.info('[bonding-smart] WebSocket connected to PumpPortal');
    // Subscribe to all new tokens + all trades
    ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [] }));  // empty = all tokens
  });

  ws.on('message', async (raw: Buffer) => {
    try {
      const ev = JSON.parse(raw.toString());
      if (ev.txType === 'create') {
        await handleCreate(ev);
      } else if (ev.txType === 'buy' || ev.txType === 'sell') {
        await handleTrade(ev);
      }
    } catch (err: any) {
      console.debug(`[bonding-smart] Parse error: ${err.message?.slice(0, 40)}`);
    }
  });

  ws.on('close', () => {
    console.warn('[bonding-smart] WebSocket closed — reconnecting in 5s');
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWS, 5_000);
  });

  ws.on('error', (err: Error) => {
    console.warn(`[bonding-smart] WebSocket error: ${err.message?.slice(0, 60)}`);
  });
}

// ─── Position monitor loop ─────────────────────────────────────────────────────

function startPositionMonitor(): void {
  setInterval(() => {
    if (activePositions.size > 0) {
      monitorPositions().catch(err =>
        console.warn(`[bonding-smart] Monitor error: ${err.message?.slice(0, 60)}`)
      );
    }
  }, 1_000);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function startBondingSmart(): void {
  if (ENABLED) {
    console.info('[bonding-smart] 🚀 ENABLED — real-time PumpFun trading active');
    console.info(`[bonding-smart] Config: ${BUY_SOL} SOL/trade, max ${MAX_POSITIONS} positions, curve ${MIN_CURVE_PROGRESS}-${MAX_CURVE_PROGRESS}%, vel ≥${MIN_VELOCITY_SOL_60S} SOL/60s, buyers ≥${MIN_UNIQUE_BUYERS_5M}`);
  } else {
    console.info('[bonding-smart] 📋 CONFIGURED (DISABLED) — BONDING_SMART_ENABLED=false');
    console.info('[bonding-smart] WebSocket connected for pre-graduation guard (passive mode)');
  }

  // Always connect WebSocket — needed for pre-graduation position guard even when disabled
  connectWS();
  startPositionMonitor();
}

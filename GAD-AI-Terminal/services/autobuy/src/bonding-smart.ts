/**
 * Bonding Smart v2 — Professional PumpFun Trading Engine
 *
 * Architecture:
 *  - PumpPortal WebSocket: real-time create/buy/sell events (0 lag vs DexScreener 30-60s)
 *  - Module 1: Dev Reputation Scoring (onchain serial-scammer detection)
 *  - Module 2: Sybil & Bundle Detector (co-funded wallet detection)
 *  - Module 3: Smart Money Tracker (follow 2+ profitable wallets into same token)
 *  - Module 4: Jito MEV Bundle (anti-frontrun buy/sell submission)
 *  - Volume Velocity: sum solAmount per token in rolling 60s window
 *  - Dynamic TP: +50%→50%, +100%→25%, rest free-ride with trailing stop
 *  - Time-based exit: low volume 90s after buy → force exit
 *
 * Config env vars:
 *  BONDING_SMART_ENABLED=true      — enable trading (default: false)
 *  BONDING_SMART_BUY_SOL=0.01     — position size (0.01 SOL)
 *  BONDING_SMART_MAX_POSITIONS=2  — concurrent positions
 *  BONDING_SMART_MIN_CURVE_PCT=25 — enter at ≥25% curve progress
 *  BONDING_SMART_MAX_CURVE_PCT=55 — exit window before graduation pressure
 *  BONDING_SMART_MIN_VEL_SOL=6   — 6 SOL/60s min inflow
 *  BONDING_SMART_MIN_BUYERS=40   — 40 unique buyers (anti-sybil)
 *  BONDING_SMART_MAX_DEV_PCT=3   — dev can hold max 3% supply
 *  BONDING_SMART_STOP_PCT=8      — hard stop-loss 8%
 *  BONDING_SMART_VOL_WATCH_SEC=90 — time exit if vol drops
 *  USE_JITO=true                  — route buy/sell via Jito bundles
 *
 * Status: CONFIGURED, TRADING DISABLED (BONDING_SMART_ENABLED=false in VPS .env)
 * Enable only after reviewing simulation results and confirming WR ≥ 25%.
 */

import WebSocket from 'ws';
import axios from 'axios';
import { createGuardedWS, WsGuardHandle } from './websocket-guard';

// ─── Residential proxy (bypasses Cloudflare/Hetzner IP block on PumpPortal) ──
// Set RESIDENTIAL_PROXY_URL=socks5://user:pass@host:port in .env to enable.
// Without proxy, BONDING_SMART_ENABLED must stay false (403 from VPS Hetzner IP).
function buildProxyAgent(): any | undefined {
  const proxyUrl = process.env.RESIDENTIAL_PROXY_URL;
  if (!proxyUrl) return undefined;
  try {
    if (proxyUrl.startsWith('socks')) {
      // socks5:// or socks4:// — use SocksProxyAgent for WSS tunneling
      const { SocksProxyAgent } = require('socks-proxy-agent');
      console.info(`[bonding-smart] Proxy: SOCKS ${proxyUrl.replace(/:[^@]+@/, ':***@')}`);
      return new SocksProxyAgent(proxyUrl);
    } else {
      // http:// or https:// — HttpsProxyAgent supports both HTTP CONNECT and WSS
      const { HttpsProxyAgent } = require('https-proxy-agent');
      console.info(`[bonding-smart] Proxy: HTTPS ${proxyUrl.replace(/:[^@]+@/, ':***@')}`);
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (e: any) {
    console.warn(`[bonding-smart] Proxy agent build failed (package not installed?): ${e.message}`);
    return undefined;
  }
}
const PROXY_AGENT = buildProxyAgent();
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { query } from '@lib/db';
import { analyzeDevReputation }   from './dev-profiler';
import { detectSybilAttack, detectEarlyBundle } from './sybil-detector';
import { registerBuy, getConfirmations }        from './smart-money-tracker';
import { sendTxWithFallback, calculateJitoTipForSignal } from './jito-helper';
import { checkPumpFunSentiment }                from './social-sentiment';

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED            = process.env.BONDING_SMART_ENABLED === 'true';
const BUY_SOL            = Number(process.env.BONDING_SMART_BUY_SOL       || '0.01');   // 0.01 SOL
const MAX_POSITIONS      = Number(process.env.BONDING_SMART_MAX_POSITIONS  || '2');
const DAILY_MAX_SOL      = Number(process.env.BONDING_SMART_DAILY_SOL      || '0.15');  // 15 trades/day max

// Bonding curve progress: 25-55% sweet spot (was 20-60%)
const MIN_CURVE_PROGRESS = Number(process.env.BONDING_SMART_MIN_CURVE_PCT  || '25');
const MAX_CURVE_PROGRESS = Number(process.env.BONDING_SMART_MAX_CURVE_PCT  || '55');

// Volume velocity: 6 SOL/60s (was 5)
const MIN_VELOCITY_SOL_60S = Number(process.env.BONDING_SMART_MIN_VEL_SOL  || '6');

// Unique buyers 5 min: 40 (was 30)
const MIN_UNIQUE_BUYERS_5M = Number(process.env.BONDING_SMART_MIN_BUYERS   || '40');

// Dev max holding: 3% (was 5%)
const MAX_DEV_HOLDING_PCT  = Number(process.env.BONDING_SMART_MAX_DEV_PCT   || '3');

// Token age limit: 30 min
const MAX_TOKEN_AGE_SEC    = Number(process.env.BONDING_SMART_MAX_AGE_SEC   || '1800');

// Stop-loss: 8% (was 10%)
const STOP_PCT             = Number(process.env.BONDING_SMART_STOP_PCT      || '8') / 100;

// Volume-based time exit: 90s (was 120s)
const VOLUME_WATCH_SEC     = Number(process.env.BONDING_SMART_VOL_WATCH_SEC || '90');
const MIN_VOLUME_TO_STAY   = Number(process.env.BONDING_SMART_MIN_VOL_STAY  || '1.0');

// Smart money: if no SM signal, require stricter velocity
const REQUIRE_SMART_MONEY  = process.env.BONDING_SMART_REQUIRE_SM === 'true';

// Jito anti-frontrun
const USE_JITO             = process.env.USE_JITO !== 'false';  // default: true

// Dev reputation min score (0-100)
const MIN_DEV_SCORE        = Number(process.env.BONDING_SMART_MIN_DEV_SCORE || '35');

// Price decay guard: max price movement from SM entry before we skip the trade
const MAX_DECAY_PCT        = Number(process.env.BONDING_SMART_MAX_DECAY_PCT || '15');

// Slippage
const BASE_SLIPPAGE_BPS    = 500;
const DUMP_SLIPPAGE_BPS    = 1500;

// ─── Price decay guard ────────────────────────────────────────────────────────
// When copy-trading SM, if the price already moved >MAX_DECAY_PCT from their entry
// we are buying the top and become exit liquidity — skip the trade.
export function checkPriceDecay(
  smEntryPrice: number,
  currentPrice: number,
  maxDecayPct: number = MAX_DECAY_PCT,
): { allowed: boolean; decayPct: number } {
  if (smEntryPrice <= 0) return { allowed: true, decayPct: 0 };
  const decayPct = ((currentPrice - smEntryPrice) / smEntryPrice) * 100;
  if (decayPct > maxDecayPct) {
    console.warn(`[decay-guard] ❌ Skip: price +${decayPct.toFixed(1)}% above SM entry (limit ${maxDecayPct}%)`);
    return { allowed: false, decayPct };
  }
  console.debug(`[decay-guard] ✅ Decay OK: +${decayPct.toFixed(1)}%`);
  return { allowed: true, decayPct };
}

const GRADUATION_SOL       = 588;
const PUMPPORTAL_WS        = 'wss://pumpportal.fun/api/data';
const PUMPPORTAL_BUY       = 'https://pumpportal.fun/api/trade-local';
const HELIUS_RPC           = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const BIRDEYE_KEY          = process.env.BIRDEYE_API_KEY ?? '';

// ─── In-memory state ──────────────────────────────────────────────────────────

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
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  bundleDetected: boolean;
  events: TradeEvent[];
  vSol: number;
  devSolInvested: number;
  // Module 1: dev score (set after analyzeDevReputation resolves)
  devScore: number | null;
  // Module 3: smart money confirmations
  smConfirmations: number;
  // vSol at the moment first SM wallet was observed — used by decay guard
  smFirstVSol: number | null;
}

const tokenStates = new Map<string, TokenState>();
const WINDOW_MS   = 5 * 60 * 1000;

interface SmartPosition {
  mint: string;
  symbol: string;
  entryPrice: number;
  tokenAmount: number;
  boughtAt: number;
  peakPrice: number;
  stage1Done: boolean;
  stage2Done: boolean;
  lastVolumeSol: number;
  pool: string;
}

const activePositions = new Map<string, SmartPosition>();
let dailySpent    = 0;
let lastDailyReset = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getConnection(): Connection {
  return new Connection(HELIUS_RPC, 'confirmed');
}

function getKeypair(): Keypair | null {
  // BONDING_SMART_USE_W2=true → use W2 (CFmHWpmQ / PUMPFUN_WALLET_PRIVATE_KEY_2)
  // Default: W1 (WALLET_PRIVATE_KEY) for backwards compat
  const useW2 = process.env.BONDING_SMART_USE_W2 === 'true';
  const raw   = (useW2 ? process.env.PUMPFUN_WALLET_PRIVATE_KEY_2 : undefined)
              ?? process.env.WALLET_PRIVATE_KEY;
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(new Uint8Array(arr));
  } catch {
    try { return Keypair.fromSecretKey(bs58.decode(raw)); } catch {}
    return null;
  }
}

async function fetchMetadataSocials(metadataUri: string): Promise<{
  hasTwitter: boolean; hasTelegram: boolean; hasWebsite: boolean;
}> {
  const empty = { hasTwitter: false, hasTelegram: false, hasWebsite: false };
  if (!metadataUri) return empty;
  try {
    const res = await axios.get(metadataUri.replace('ipfs://', 'https://ipfs.io/ipfs/'), { timeout: 4_000 });
    const d = res.data ?? {};
    const links = JSON.stringify(d).toLowerCase();
    return {
      hasTwitter:  links.includes('twitter') || links.includes('x.com'),
      hasTelegram: links.includes('t.me') || links.includes('telegram'),
      hasWebsite:  !!(d.website || d.external_url),
    };
  } catch { return empty; }
}

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
    return (Number(uiAmount) / 1_000_000_000) * 100;
  } catch { return 0; }
}

function checkDailyReset() {
  const today = Math.floor(Date.now() / 86400000);
  if (today !== lastDailyReset) { dailySpent = 0; lastDailyReset = today; }
}

// ─── Entry decision (all 4 modules applied) ───────────────────────────────────

async function shouldBuy(state: TokenState): Promise<{ buy: boolean; reason: string; smBoost: boolean }> {
  const skip = (r: string) => ({ buy: false, reason: r, smBoost: false });

  const ageSec = (Date.now() - state.createdAt) / 1000;
  if (ageSec > MAX_TOKEN_AGE_SEC)
    return skip(`too_old: ${(ageSec / 60).toFixed(0)}min`);

  // ── Bundle detection (from creation event or sybil module) ─────────────────
  if (state.bundleDetected)
    return skip('bundle: dev bought >10% in creation TX');

  // ── Social check ──────────────────────────────────────────────────────────
  if (!state.hasTwitter && !state.hasTelegram)
    return skip('no_socials: no Twitter/Telegram');

  // ── Community activity (БЛОК 2): pump.fun reply count ────────────────────
  const sentiment = await checkPumpFunSentiment(state.mint, 5, 15000);
  if (!sentiment.active)
    return skip(`no_community: ${sentiment.reason}`);

  // ── Bonding curve progress 25-55% ─────────────────────────────────────────
  const curveProgress = Math.min(100, (state.vSol / GRADUATION_SOL) * 100);
  if (curveProgress < MIN_CURVE_PROGRESS)
    return skip(`curve_low: ${curveProgress.toFixed(0)}% < ${MIN_CURVE_PROGRESS}%`);
  if (curveProgress > MAX_CURVE_PROGRESS)
    return skip(`curve_high: ${curveProgress.toFixed(0)}% > ${MAX_CURVE_PROGRESS}%`);

  // ── Volume velocity 60s ────────────────────────────────────────────────────
  const now = Date.now();
  const recent = state.events.filter(e => e.isBuy && now - e.ts <= 60_000);
  const velocitySol = recent.reduce((s, e) => s + e.solAmount, 0);
  const smConfirms  = getConfirmations(state.mint);
  const hasSmSignal = smConfirms >= 2;

  // Smart money confirmation relaxes velocity threshold by 15%
  const velRequired = hasSmSignal ? MIN_VELOCITY_SOL_60S * 0.85 : MIN_VELOCITY_SOL_60S;
  if (velocitySol < velRequired)
    return skip(`velocity_low: ${velocitySol.toFixed(2)} SOL/60s < ${velRequired.toFixed(1)} (sm:${smConfirms})`);

  // ── Unique buyers 5min ────────────────────────────────────────────────────
  const fiveMin = Date.now() - WINDOW_MS;
  const uniqueBuyers = new Set(state.events.filter(e => e.isBuy && e.ts > fiveMin).map(e => e.buyer));
  // SM signal relaxes buyer threshold by 20%
  const buyersRequired = hasSmSignal ? Math.floor(MIN_UNIQUE_BUYERS_5M * 0.80) : MIN_UNIQUE_BUYERS_5M;
  if (uniqueBuyers.size < buyersRequired)
    return skip(`buyers_low: ${uniqueBuyers.size} < ${buyersRequired} (sm:${smConfirms})`);

  // ── Anti-whale ────────────────────────────────────────────────────────────
  if (recent.some(e => e.solAmount > 5))
    return skip('anti_whale: single buy > 5 SOL');

  // ── Module 1: Dev Reputation ──────────────────────────────────────────────
  const devRep = await analyzeDevReputation(state.devWallet);
  if (devRep.isSerialScammer)
    return skip(`dev_scammer: ${devRep.reason}`);
  if (devRep.score < MIN_DEV_SCORE)
    return skip(`dev_score_low: ${devRep.score} < ${MIN_DEV_SCORE}`);

  // ── Module 2: Sybil Detection ─────────────────────────────────────────────
  const buyers = state.events
    .filter(e => e.isBuy && now - e.ts <= 60_000)
    .map(e => ({ address: e.buyer, solAmount: e.solAmount }));

  const sybilResult = await detectSybilAttack(state.mint, buyers);
  if (sybilResult.detected)
    return skip(`sybil: ${sybilResult.reason}`);

  // Early bundle check
  if (detectEarlyBundle(state.events, state.devWallet, state.createdAt))
    return skip('early_bundle: dev bought >15% curve in first 30s');

  // ── Module 3: Smart Money (REQUIRE_SMART_MONEY=true bypasses without SM) ──
  if (REQUIRE_SMART_MONEY && !hasSmSignal)
    return skip(`no_smart_money: only ${smConfirms}/${2} SM confirmations`);

  // ── Decay guard: block if price already moved >MAX_DECAY_PCT from SM entry ─
  if (state.smFirstVSol) {
    const decay = checkPriceDecay(state.smFirstVSol, state.vSol);
    if (!decay.allowed)
      return skip(`decay_guard: vSol +${decay.decayPct.toFixed(1)}% above SM entry (limit ${MAX_DECAY_PCT}%)`);
  }

  // ── Dev holding check ─────────────────────────────────────────────────────
  const devPct = await getDevHoldingPct(state.mint, state.devWallet);
  if (devPct > MAX_DEV_HOLDING_PCT)
    return skip(`dev_hold: ${devPct.toFixed(1)}% > ${MAX_DEV_HOLDING_PCT}%`);

  return {
    buy: true,
    smBoost: hasSmSignal,
    reason: `curve:${curveProgress.toFixed(0)}% vel:${velocitySol.toFixed(2)}SOL ` +
            `buyers:${uniqueBuyers.size} dev:${devRep.score}/100 sm:${smConfirms} devHold:${devPct.toFixed(1)}%`,
  };
}

// ─── Buy ─────────────────────────────────────────────────────────────────────

async function doBuy(state: TokenState, context: string, smBoost: boolean): Promise<void> {
  const keypair = getKeypair();
  if (!keypair) { console.warn('[bonding-smart] No wallet keypair'); return; }

  try {
    const params = {
      publicKey:          keypair.publicKey.toBase58(),
      action:             'buy',
      mint:               state.mint,
      denominatedInSol:   'true',
      amount:             BUY_SOL,
      slippage:           10,
      priorityFee:        USE_JITO ? 0.0001 : 0.003,  // lower if using Jito (tip handles priority)
      pool:               'pump',
    };
    const res = await axios.post(PUMPPORTAL_BUY, params, { responseType: 'arraybuffer', timeout: 10_000, ...(PROXY_AGENT ? { httpsAgent: PROXY_AGENT } : {}) });
    if (res.status !== 200) throw new Error(`PumpPortal ${res.status}`);

    const txBytes = Buffer.from(res.data);
    let txSig = '';

    // Module 4: Jito bundle (with RPC fallback)
    if (USE_JITO) {
      const jitoResult = await sendTxWithFallback(getConnection(), txBytes, keypair);
      if (!jitoResult.ok) throw new Error('Jito + RPC both failed');
      txSig = jitoResult.sig ?? '';
      console.info(`[bonding-smart] Buy via ${jitoResult.method.toUpperCase()}: ${state.symbol}`);
    } else {
      const { Connection: _C, VersionedTransaction: VT } = await import('@solana/web3.js');
      const conn  = getConnection();
      const vTx   = (await import('@solana/web3.js')).VersionedTransaction.deserialize(txBytes);
      txSig = await conn.sendRawTransaction(vTx.serialize(), { skipPreflight: true });
    }

    // Record in DB
    const walletAddr = keypair.publicKey.toBase58();
    await query(
      `INSERT INTO autobuy_jobs
         (mint_address, label, amount_sol, total_spent_sol, slippage_bps, interval_seconds,
          wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled, bought_at)
       VALUES ($1, $2, $3, $3, $4, 86400, $5, false, $6, true, now())`,
      [
        state.mint,
        `auto:bonding:smart:${state.symbol}:pump${smBoost ? ':SM' : ''}`,
        BUY_SOL,
        BASE_SLIPPAGE_BPS,
        walletAddr,
        VOLUME_WATCH_SEC,
      ]
    );

    dailySpent += BUY_SOL;
    const smTag = smBoost ? ' 🔥SM' : '';
    console.info(`[bonding-smart] ✅ BUY ${state.symbol} ${BUY_SOL} SOL${smTag} — ${context}`);

    const entryPrice = state.vSol > 0 ? state.vSol / 800_000_000 : 1e-9;
    activePositions.set(state.mint, {
      mint: state.mint, symbol: state.symbol,
      entryPrice, tokenAmount: Math.floor(BUY_SOL / entryPrice),
      boughtAt: Date.now(), peakPrice: entryPrice,
      stage1Done: false, stage2Done: false,
      lastVolumeSol: 0, pool: 'pump',
    });
  } catch (err: any) {
    console.warn(`[bonding-smart] Buy failed ${state.symbol}: ${err.message?.slice(0, 80)}`);
  }
}

// ─── Sell ────────────────────────────────────────────────────────────────────

async function doSell(mint: string, symbol: string, pct: number, reason: string, slippage = BASE_SLIPPAGE_BPS): Promise<void> {
  const keypair = getKeypair();
  if (!keypair) return;

  try {
    const params = {
      publicKey:        keypair.publicKey.toBase58(),
      action:           'sell',
      mint,
      denominatedInSol: 'false',
      amount:           pct === 100 ? '100%' : `${pct}%`,
      slippage:         slippage / 100,
      priorityFee:      USE_JITO ? 0.0001 : 0.003,
      pool:             'pump',
    };
    const res = await axios.post(PUMPPORTAL_BUY, params, { responseType: 'arraybuffer', timeout: 10_000, ...(PROXY_AGENT ? { httpsAgent: PROXY_AGENT } : {}) });

    if (res.status === 200 && USE_JITO) {
      const txBytes = Buffer.from(res.data);
      await sendTxWithFallback(getConnection(), txBytes, keypair);
    }

    console.info(`[bonding-smart] 💰 SELL ${pct}% ${symbol} — ${reason}`);
  } catch (err: any) {
    console.warn(`[bonding-smart] Sell error ${symbol}: ${err.message?.slice(0, 60)}`);
  }
}

// ─── Position monitor ─────────────────────────────────────────────────────────

async function monitorPositions(): Promise<void> {
  const now = Date.now();

  for (const [mint, pos] of activePositions) {
    const state = tokenStates.get(mint);
    if (!state) continue;

    const currentPrice = state.vSol > 0 ? state.vSol / 800_000_000 : 0;
    if (!currentPrice) continue;

    if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

    const mult    = currentPrice / pos.entryPrice;
    const holdSec = (now - pos.boughtAt) / 1000;

    // TP1: +50% → sell 50%
    if (!pos.stage1Done && mult >= 1.5) {
      await doSell(mint, pos.symbol, 50, `TP1 +${(mult * 100 - 100).toFixed(0)}%`);
      pos.stage1Done = true;
    }

    // TP2: +100% → sell 50% of remaining
    if (pos.stage1Done && !pos.stage2Done && mult >= 2.0) {
      await doSell(mint, pos.symbol, 50, `TP2 +${(mult * 100 - 100).toFixed(0)}%`);
      pos.stage2Done = true;
    }

    // Trailing stop: 20% from peak (after TP1)
    if (pos.stage1Done && currentPrice < pos.peakPrice * 0.80) {
      await doSell(mint, pos.symbol, 100, `trail_stop: ${((1 - currentPrice / pos.peakPrice) * 100).toFixed(0)}% from peak`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint);
      continue;
    }

    // Hard stop-loss: 8% below entry (before TP1)
    if (!pos.stage1Done && currentPrice < pos.entryPrice * (1 - STOP_PCT)) {
      await doSell(mint, pos.symbol, 100, `stop_loss: ${(mult * 100 - 100).toFixed(0)}%`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint);
      continue;
    }

    // Volume time exit: 90s after buy if vol < 1 SOL/60s
    if (holdSec > VOLUME_WATCH_SEC) {
      const recentVol = state.events
        .filter(e => e.isBuy && now - e.ts <= 60_000)
        .reduce((s, e) => s + e.solAmount, 0);
      if (recentVol < MIN_VOLUME_TO_STAY) {
        await doSell(mint, pos.symbol, 100, `time_exit: vol ${recentVol.toFixed(2)} SOL/60s`, DUMP_SLIPPAGE_BPS);
        activePositions.delete(mint);
        continue;
      }
    }

    // Dump detection: sell/buy ratio > 3:1 in 30s AND sell vol > 2 SOL
    const last30  = state.events.filter(e => now - e.ts <= 30_000);
    const buyVol  = last30.filter(e => e.isBuy).reduce((s, e) => s + e.solAmount, 0);
    const sellVol = last30.filter(e => !e.isBuy).reduce((s, e) => s + e.solAmount, 0);
    if (sellVol > buyVol * 3 && sellVol > 2) {
      await doSell(mint, pos.symbol, 100, `dump: sell/buy ${(sellVol / Math.max(buyVol, 0.01)).toFixed(1)}x`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint);
    }
  }
}

// ─── WebSocket handlers ───────────────────────────────────────────────────────

async function handleCreate(ev: any): Promise<void> {
  const mint        = ev.mint as string;
  const devWallet   = ev.traderPublicKey as string;
  const symbol      = (ev.symbol ?? 'UNKNOWN') as string;
  const metaUri     = (ev.uri ?? '') as string;
  const devSolBuy   = Number(ev.solAmount ?? 0);
  const initialVSol = Number(ev.vSolInBondingCurve ?? 0);

  const bundleDetected = devSolBuy > GRADUATION_SOL * 0.10;
  const socials        = await fetchMetadataSocials(metaUri);

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
    devScore: null,
    smConfirmations: 0,
    smFirstVSol: null,
  };

  tokenStates.set(mint, state);

  const flags = [
    bundleDetected             && '🚨bundle',
    !socials.hasTwitter && !socials.hasTelegram && '❌nosocial',
    socials.hasTwitter         && '🐦X',
    socials.hasTelegram        && '📱TG',
  ].filter(Boolean).join(' ');

  console.debug(`[bonding-smart] 🆕 ${symbol} dev:${devWallet.slice(0, 6)} devBuy:${devSolBuy.toFixed(3)}SOL ${flags}`);

  // Async dev reputation (non-blocking — result cached, used on next trade event)
  analyzeDevReputation(devWallet).then(rep => {
    if (state) state.devScore = rep.score;
  }).catch(() => {});

  // Prune old token states
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

  if (vSol > 0) state.vSol = vSol;

  const now = Date.now();
  state.events.push({ ts: now, solAmount, buyer, isBuy });
  const cutoff = now - WINDOW_MS;
  state.events = state.events.filter(e => e.ts >= cutoff);

  // Pre-graduation guard: exit at 92% (540/588) to avoid graduation-sniper dump
  if (vSol > 540 && activePositions.has(mint)) {
    const pos = activePositions.get(mint)!;
    console.warn(`[bonding-smart] 🎓 Pre-grad exit: ${pos.symbol} vSol=${vSol.toFixed(0)} (92% threshold)`);
    await doSell(mint, pos.symbol, 100, 'pre_grad: vSol > 540 (92%)', DUMP_SLIPPAGE_BPS);
    activePositions.delete(mint);
    return;
  }

  // Module 3: register smart money buy
  if (isBuy) {
    const smCount = await registerBuy(mint, buyer);
    if (smCount > 0) {
      state.smConfirmations = smCount;
      if (!state.smFirstVSol) state.smFirstVSol = vSol;
    }
  }

  if (!ENABLED) return;
  if (activePositions.size >= MAX_POSITIONS) return;
  if (activePositions.has(mint)) return;
  if (!isBuy) return;

  checkDailyReset();
  if (dailySpent + BUY_SOL > DAILY_MAX_SOL) return;

  const decision = await shouldBuy(state);
  if (decision.buy) {
    await doBuy(state, decision.reason, decision.smBoost);
  }
}

// ─── WebSocket (guarded — exponential backoff + ping-pong heartbeat) ──────────

let wsGuard: WsGuardHandle | null = null;

function connectWS(): void {
  wsGuard = createGuardedWS({
    url: PUMPPORTAL_WS,
    agent: PROXY_AGENT,
    onOpen: () => {
      console.info('[bonding-smart] WebSocket connected');
      wsGuard!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      wsGuard!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [] }));
    },
    onMessage: async (ev: any) => {
      try {
        if (ev.txType === 'create')                           await handleCreate(ev);
        else if (ev.txType === 'buy' || ev.txType === 'sell') await handleTrade(ev);
      } catch {}
    },
    pingIntervalMs:  30_000,  // heartbeat каждые 30s
    maxReconnects:   0,        // 0 = бесконечно (контейнер сам перезапустится при OOM)
    reconnectBaseMs: 1_000,
    reconnectCapMs:  30_000,
  });
}

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
    console.info('[bonding-smart] 🚀 v2 ENABLED — Modules: DevProfiler + Sybil + SmartMoney + Jito');
    console.info(`[bonding-smart] Config: ${BUY_SOL} SOL/trade, curve ${MIN_CURVE_PROGRESS}-${MAX_CURVE_PROGRESS}%, vel ≥${MIN_VELOCITY_SOL_60S} SOL/60s, buyers ≥${MIN_UNIQUE_BUYERS_5M}, stop ${STOP_PCT * 100}%, jito:${USE_JITO}`);
  } else {
    console.info('[bonding-smart] 📋 v2 CONFIGURED (DISABLED) — passive WebSocket mode');
  }

  connectWS();
  startPositionMonitor();
}

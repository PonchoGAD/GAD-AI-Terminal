/**
 * Bonding Smart — Real-time PumpFun Trading Engine
 *
 * Data sources (all FREE):
 *  - PumpPortal WS: create events (mint, devBuy, metadata URI)
 *  - Helius accountSubscribe: bonding curve PDA → real-time vSol + delta events
 *  - Helius logsSubscribe: Anchor TradeEvent decode → buyer address, SOL amount (0 RPC)
 *  - PostgreSQL smart_money_wallets: local smart-money wallet whitelist
 *
 * Trade flow:
 *  1. PumpPortal create event → initial filters (social, devBuy, sniper trap)
 *  2. Pass → subscribeTokenLogs + subscribeBondingCurve on same Helius WS
 *  3. Buy (or DRY BUY)
 *  4. logsNotification → parsePumpAnchorEvent('Program data:') → buyer+SOL (free, real-time)
 *     Fallback: getParsedTransaction debounced 1/s
 *  5. accountSubscribe → vSol delta → velocity/dump/pre-grad detection
 *  6. monitorPositions 1s: TP1/TP2/trail/SL/breakeven/time-exit
 *
 * ENV vars:
 *  BONDING_SMART_ENABLED, BONDING_SMART_DRY_RUN
 *  BONDING_SMART_BUY_SOL, BONDING_SMART_MAX_POSITIONS, BONDING_SMART_DAILY_SOL
 *  BONDING_SMART_STOP_PCT, BONDING_SMART_VOL_WATCH_SEC, BONDING_SMART_MIN_VOL_STAY
 *  BONDING_SMART_MIN_DEV_BUY, BONDING_SMART_MAX_DEV_BUY, BONDING_SMART_MAX_DEV_PCT
 *  BONDING_SMART_REQUIRE_SOCIAL, BONDING_SMART_MIN_BUYERS
 *  BONDING_SMART_REQUIRE_SM (require smart money confirmation)
 */

import WebSocket from 'ws';
import axios from 'axios';
import { decode } from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { query } from '@lib/db';

// ─── Config ───────────────────────────────────────────────────────────────────
const ENABLED       = process.env.BONDING_SMART_ENABLED === 'true';
const DRY_RUN       = process.env.BONDING_SMART_DRY_RUN === 'true';
const BUY_SOL       = Number(process.env.BONDING_SMART_BUY_SOL       || '0.02');
const MAX_POSITIONS = Number(process.env.BONDING_SMART_MAX_POSITIONS  || '2');
const DAILY_MAX_SOL = Number(process.env.BONDING_SMART_DAILY_SOL      || '0.05');
const STOP_PCT      = Number(process.env.BONDING_SMART_STOP_PCT       || '8') / 100;
const VOLUME_WATCH_SEC   = Number(process.env.BONDING_SMART_VOL_WATCH_SEC || '40');
const MIN_VOLUME_TO_STAY = Number(process.env.BONDING_SMART_MIN_VOL_STAY  || '1.5');
const MAX_TOKEN_AGE_SEC  = Number(process.env.BONDING_SMART_MAX_AGE_SEC   || '1800');

const BASE_SLIPPAGE_BPS = 500;
const DUMP_SLIPPAGE_BPS = 1500;
const GRADUATION_SOL    = 588;
const BONDING_BASE_SOL  = 28;  // pump.fun virtual SOL baseline at creation
const PRIORITY_FEE      = 0.0005; // 5x default — fast tx landing in congestion

const PUMPPORTAL_WS  = 'wss://pumpportal.fun/api/data';
const PUMPPORTAL_BUY = 'https://pumpportal.fun/api/trade-local';
const HELIUS_RPC     = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const PUMP_PROGRAM_ID = '6EF8rrecth7ZC6HSZNSVD5nc7KxECunY9gPH37X43gQp';

// ─── Types ────────────────────────────────────────────────────────────────────
interface TradeEvent {
  ts: number;
  solAmount: number;
  buyer: string;
  isBuy: boolean;
  isSmart?: boolean;
}
interface TokenState {
  mint: string;
  symbol: string;
  devWallet: string;
  createdAt: number;
  hasTwitter: boolean;
  hasTelegram: boolean;
  bundleDetected: boolean;
  events: TradeEvent[];
  vSol: number;
  devSolInvested: number;
  smConfirmations: number;
}
interface Position {
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
  dryRun?: boolean;
}

// ─── In-memory state ──────────────────────────────────────────────────────────
const tokenStates     = new Map<string, TokenState>();
const activePositions = new Map<string, Position>();
let dailySpent    = 0;
let lastDailyReset = 0;
let buyInProgress = false;

// ─── Smart Money — local wallet whitelist ─────────────────────────────────────
// Loaded from PostgreSQL `smart_money_wallets` table at startup.
// O(1) lookup via Set — no external API calls.
const smartMoneySet = new Set<string>();

async function loadSmartMoneyWallets(): Promise<void> {
  try {
    const { rows } = await query('SELECT wallet_address AS address FROM smart_money_wallets WHERE active = true');
    smartMoneySet.clear();
    rows.forEach((r: { address: string }) => smartMoneySet.add(r.address));
    console.info(`[bonding-smart] 🧠 Smart money loaded: ${smartMoneySet.size} addresses`);
  } catch (err: any) {
    console.warn('[bonding-smart] Smart money load failed (table may not exist yet): ' + String(err?.message).slice(0, 60));
  }
}

// ─── Helius WS — shared connection for both accountSubscribe and logsSubscribe ─
let heliusWs: WebSocket | null = null;
let heliusReqId = 200;

// accountSubscribe (curve price tracking)
const heliusPendingSubs    = new Map<string, number>(); // mint → reqId
const heliusSubIds         = new Map<string, number>(); // mint → subId

// logsSubscribe (trade event tracking — unique buyers, velocity, smart money)
const heliusLogPendingSubs = new Map<string, number>(); // mint → reqId
const heliusLogSubIds      = new Map<string, number>(); // mint → subId

// Debounce getParsedTransaction (max 1 call/s per token)
const lastParsedTx = new Map<string, number>();

// ─── Anchor TradeEvent decoder ────────────────────────────────────────────────
// Decodes pump.fun Anchor events from 'Program data: <base64>' log lines.
// TradeEvent IDL: mint(32)+solAmount(u64)+tokenAmount(u64)+isBuy(bool)+user(32)+ts(i64)+vSol(u64)+vToken(u64)
// Zero RPC calls — real-time buyer address with 100% trade coverage.
interface AnchorTradeEvent {
  mint: string;
  solAmount: number;
  isBuy: boolean;
  buyer: string;
  vSolReserves: number;
}

function parsePumpAnchorEvent(logLine: string): AnchorTradeEvent | null {
  try {
    if (!logLine.startsWith('Program data: ')) return null;
    const buf = Buffer.from(logLine.slice('Program data: '.length).trim(), 'base64');
    if (buf.length < 113) return null; // 8 discriminator + 105 event bytes
    let o = 8;
    const mintB = buf.slice(o, o + 32); o += 32;
    const solAmount = Number(buf.readBigUInt64LE(o)) / 1e9; o += 8;
    o += 8; // skip tokenAmount
    const isBuy = buf[o] === 1; o += 1;
    const userB = buf.slice(o, o + 32); o += 32;
    o += 8; // skip timestamp
    const vSolReserves = Number(buf.readBigUInt64LE(o)) / 1e9;
    if (mintB.every((b: number) => b === 0) || userB.every((b: number) => b === 0)) return null;
    if (solAmount <= 0 || solAmount > 1000) return null;
    return {
      mint: new PublicKey(mintB).toBase58(),
      solAmount,
      isBuy,
      buyer: new PublicKey(userB).toBase58(),
      vSolReserves,
    };
  } catch { return null; }
}

function getHeliusWsUrl(): string {
  return HELIUS_RPC
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://');
}

function getBondingCurvePda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM_ID)
  );
  return pda.toBase58();
}

// ─── accountSubscribe — real-time curve price ─────────────────────────────────
function subscribeBondingCurve(mint: string): void {
  if (!heliusWs || heliusWs.readyState !== WebSocket.OPEN) return;
  if (heliusSubIds.has(mint) || heliusPendingSubs.has(mint)) return;
  try {
    const curvePda = getBondingCurvePda(mint);
    const reqId = ++heliusReqId;
    heliusPendingSubs.set(mint, reqId);
    heliusWs.send(JSON.stringify({
      jsonrpc: '2.0', id: reqId,
      method: 'accountSubscribe',
      params: [curvePda, { encoding: 'base64', commitment: 'processed' }],
    }));
    const state = tokenStates.get(mint);
    console.info(`[bonding-smart] 📡 Price track: ${state?.symbol || mint.slice(0, 8)} curve=${curvePda.slice(0, 8)}`);
  } catch (e: any) {
    console.warn('[bonding-smart] subscribeBondingCurve error: ' + String(e?.message).slice(0, 60));
  }
}

function unsubscribeBondingCurve(mint: string): void {
  const subId = heliusSubIds.get(mint);
  if (subId != null && heliusWs && heliusWs.readyState === WebSocket.OPEN) {
    heliusWs.send(JSON.stringify({ jsonrpc: '2.0', id: ++heliusReqId, method: 'accountUnsubscribe', params: [subId] }));
  }
  heliusSubIds.delete(mint);
  heliusPendingSubs.delete(mint);
}

function parseBondingCurveUpdate(mint: string, base64Data: string): void {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 24) return;
    const vSol = Number(buf.readBigUInt64LE(16)) / 1e9;
    if (vSol <= 0) return;
    const state = tokenStates.get(mint);
    if (!state) return;
    const prev = state.vSol;
    state.vSol = vSol;
    if (prev > 0 && Math.abs(vSol - prev) / prev > 0.005 && activePositions.has(mint)) {
      const pos = activePositions.get(mint)!;
      const mult = pos.entryPrice > 0 ? (vSol / 800_000_000) / pos.entryPrice : 1;
      console.info(`[bonding-smart] 📊 ${state.symbol} vSol=${vSol.toFixed(3)} mult=${mult.toFixed(3)}x`);
    }
  } catch { /* ignore */ }
}

// ─── logsSubscribe — per-token trade events (buyers + velocity + smart money) ─
function subscribeTokenLogs(mint: string): void {
  if (!heliusWs || heliusWs.readyState !== WebSocket.OPEN) return;
  if (heliusLogSubIds.has(mint) || heliusLogPendingSubs.has(mint)) return;
  try {
    const reqId = ++heliusReqId;
    heliusLogPendingSubs.set(mint, reqId);
    heliusWs.send(JSON.stringify({
      jsonrpc: '2.0', id: reqId,
      method: 'logsSubscribe',
      params: [{ mentions: [mint] }, { commitment: 'confirmed' }],
    }));
    const state = tokenStates.get(mint);
    console.info(`[bonding-smart] 👁️ Logs track: ${state?.symbol || mint.slice(0, 8)}`);
  } catch (e: any) {
    console.warn('[bonding-smart] subscribeTokenLogs error: ' + String(e?.message).slice(0, 60));
  }
}

function unsubscribeTokenLogs(mint: string): void {
  const subId = heliusLogSubIds.get(mint);
  if (subId != null && heliusWs && heliusWs.readyState === WebSocket.OPEN) {
    heliusWs.send(JSON.stringify({ jsonrpc: '2.0', id: ++heliusReqId, method: 'logsUnsubscribe', params: [subId] }));
  }
  heliusLogSubIds.delete(mint);
  heliusLogPendingSubs.delete(mint);
}

// Parse full transaction to extract buyer address and SOL amount
// Debounced: max 1 call/s per token to respect Helius free tier limits
async function parseTransactionDebounced(signature: string, mint: string, isBuy: boolean): Promise<void> {
  const now = Date.now();
  if (now - (lastParsedTx.get(mint) || 0) < 1_000) return;
  lastParsedTx.set(mint, now);
  const state = tokenStates.get(mint);
  if (!state) return;
  try {
    // RPC fallback chain: Helius primary → Shyft backup (SHYFT_RPC_KEY in .env)
    const rpcList = [HELIUS_RPC];
    const shyftKey = process.env.SHYFT_RPC_KEY;
    if (shyftKey) rpcList.push(`https://rpc.shyft.to?api_key=${shyftKey}`);
    let tx: Awaited<ReturnType<Connection['getParsedTransaction']>> = null;
    for (const rpcUrl of rpcList) {
      try {
        const conn = new Connection(rpcUrl, 'confirmed');
        tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (tx?.meta) break;
      } catch { /* try next RPC */ }
    }
    if (!tx?.meta) return;
    const buyer = (tx.transaction.message as any).accountKeys?.[0]?.pubkey?.toBase58?.() as string | undefined;
    if (!buyer) return;
    const preBalance  = tx.meta.preBalances?.[0]  ?? 0;
    const postBalance = tx.meta.postBalances?.[0] ?? 0;
    const solAmount   = Math.abs(preBalance - postBalance) / 1e9;
    const isSmart     = smartMoneySet.has(buyer);
    const event: TradeEvent = { ts: Date.now(), solAmount, buyer, isBuy, isSmart };
    state.events.push(event);
    // Keep only last 5 minutes of events
    const cutoff = Date.now() - 5 * 60_000;
    state.events = state.events.filter(e => e.ts >= cutoff);
    if (isSmart) {
      state.smConfirmations++;
      console.info(`[bonding-smart] 🔥 Smart Money: ${buyer.slice(0, 8)} ${isBuy ? 'BUY' : 'SELL'} ${solAmount.toFixed(3)} SOL in ${state.symbol}`);
    } else {
      console.debug(`[bonding-smart] 👁️ Trade: ${state.symbol} | ${isBuy ? 'BUY' : 'SELL'} ${solAmount.toFixed(3)} SOL | ${buyer.slice(0, 6)}`);
    }
  } catch { /* rate limit / network error — fail silently */ }
}

// ─── Auto SM wallet collector (v10) ──────────────────────────────────────────
// Called at TP1. Saves early buyers of winning tokens to smart_money_wallets.
// Self-bootstrapping: each win grows the SM list automatically.
async function collectWinnersAsSmartMoney(mint: string, symbol: string): Promise<void> {
  const state = tokenStates.get(mint);
  const pos = activePositions.get(mint);
  if (!state || !pos || state.events.length === 0) return;
  // Early buyers in first 5 min after our entry = smart money by definition
  const earlyWindow = pos.boughtAt + 5 * 60_000;
  const earlyBuyers = [...new Set(
    state.events
      .filter(e => e.isBuy && e.buyer && e.buyer !== 'curve' && e.ts <= earlyWindow)
      .map(e => e.buyer),
  )];
  if (earlyBuyers.length === 0) {
    console.debug(`[bonding-smart] 🧠 Auto-SM: no early buyers for ${symbol} (Anchor decoder active?)`);
    return;
  }
  let added = 0;
  const notes = `${symbol} TP1 ${new Date().toISOString().slice(0, 10)}`;
  for (const wallet of earlyBuyers) {
    try {
      await query(
        `INSERT INTO smart_money_wallets (wallet_address, chain, network, label, source, active, notes)
         VALUES ($1, 'SOLANA', 'solana', 'auto_winner', 'bonding_smart_tp1', true, $2)
         ON CONFLICT (chain, wallet_address) DO UPDATE SET
           reliability_weight = COALESCE(reliability_weight, 1.0) + 0.2,
           active = true,
           notes = COALESCE(smart_money_wallets.notes || ', ', '') || $2`,
        [wallet, notes],
      );
      if (!smartMoneySet.has(wallet)) { smartMoneySet.add(wallet); added++; }
    } catch { /* column not exist yet — silent */ }
  }
  console.info(`[bonding-smart] 🧠 Auto-SM: ${symbol} TP1 → ${added} new SM wallets (total: ${smartMoneySet.size})`);
}

// ─── Helius WS connection ─────────────────────────────────────────────────────
function connectHeliusWs(): void {
  const url = getHeliusWsUrl();
  if (!url.startsWith('ws')) {
    console.warn('[bonding-smart] Helius WS: invalid URL — price/log tracking disabled');
    return;
  }
  try { heliusWs = new WebSocket(url); } catch (e: any) {
    console.warn('[bonding-smart] Helius WS connect error: ' + String(e?.message).slice(0, 60));
    setTimeout(connectHeliusWs, 10_000); return;
  }
  heliusWs.on('open', () => {
    console.info('[bonding-smart] 📡 Helius WS connected — price + trade log tracking ACTIVE');
    for (const [mint] of activePositions) { subscribeBondingCurve(mint); subscribeTokenLogs(mint); }
  });
  heliusWs.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Subscription confirmation (both accountSubscribe and logsSubscribe return same format)
      if (typeof msg.id === 'number' && typeof msg.result === 'number') {
        // Check accountSubscribe confirmations
        for (const [mint, reqId] of heliusPendingSubs) {
          if (reqId === msg.id) {
            heliusSubIds.set(mint, msg.result);
            heliusPendingSubs.delete(mint);
            const s = tokenStates.get(mint);
            console.info(`[bonding-smart] ✅ Price sub: ${s?.symbol || mint.slice(0, 8)} id=${msg.result}`);
            return;
          }
        }
        // Check logsSubscribe confirmations
        for (const [mint, reqId] of heliusLogPendingSubs) {
          if (reqId === msg.id) {
            heliusLogSubIds.set(mint, msg.result);
            heliusLogPendingSubs.delete(mint);
            const s = tokenStates.get(mint);
            console.info(`[bonding-smart] ✅ Logs sub: ${s?.symbol || mint.slice(0, 8)} id=${msg.result}`);
            return;
          }
        }
        return;
      }
      if (msg.error) { console.warn('[bonding-smart] Helius WS err: ' + JSON.stringify(msg.error).slice(0, 80)); return; }
      // Price update (accountNotification)
      if (msg.method === 'accountNotification') {
        const subId = (msg.params as any)?.subscription as number;
        for (const [mint, sid] of heliusSubIds) {
          if (sid === subId) {
            const data = (msg.params as any)?.result?.value?.data;
            if (Array.isArray(data) && data[1] === 'base64') parseBondingCurveUpdate(mint, data[0] as string);
            return;
          }
        }
      }
      // Trade logs (logsNotification)
      if (msg.method === 'logsNotification') {
        const subId  = (msg.params as any)?.subscription as number;
        const value  = (msg.params as any)?.result?.value;
        if (!value) return;
        const logs: string[]  = value.logs ?? [];
        const signature: string = value.signature ?? '';
        if (!signature) return;
        // Find which mint this subscription belongs to
        for (const [mint, sid] of heliusLogSubIds) {
          if (sid !== subId) continue;
          const state = tokenStates.get(mint);
          if (!state) return;
          // Only process pump.fun instructions
          const hasPump = logs.some(l => l.includes(PUMP_PROGRAM_ID));
          if (!hasPump) return;
          const isBuy  = logs.some(l => l.includes('Instruction: Buy'));
          const isSell = logs.some(l => l.includes('Instruction: Sell'));
          // Try Anchor event decode first (free, real-time, gives buyer address)
          let anchorParsed = false;
          for (const logLine of logs) {
            const ev = parsePumpAnchorEvent(logLine);
            if (!ev || ev.mint !== mint) continue;
            state.events.push({ ts: Date.now(), solAmount: ev.solAmount, buyer: ev.buyer, isBuy: ev.isBuy, isSmart: smartMoneySet.has(ev.buyer) });
            state.events = state.events.filter(e => e.ts >= Date.now() - 5 * 60_000);
            if (ev.isBuy && smartMoneySet.has(ev.buyer)) {
              state.smConfirmations++;
              console.info(`[bonding-smart] 🔥 SM BUY: ${ev.buyer.slice(0, 8)} ${ev.solAmount.toFixed(3)} SOL → ${state.symbol}`);
            } else {
              console.debug(`[bonding-smart] 👁️ Trade: ${state.symbol} | ${ev.isBuy ? 'BUY' : 'SELL'} ${ev.solAmount.toFixed(3)} SOL | ${ev.buyer.slice(0, 6)}`);
            }
            if (ev.vSolReserves > 0) state.vSol = ev.vSolReserves;
            anchorParsed = true;
            break;
          }
          // Fallback: debounced getParsedTransaction if Anchor decode failed
          if (!anchorParsed && (isBuy || isSell)) parseTransactionDebounced(signature, mint, isBuy).catch(() => {});
          return;
        }
      }
    } catch { /* ignore */ }
  });
  heliusWs.on('close', () => {
    console.warn('[bonding-smart] Helius WS closed — reconnect 5s');
    // Clear ALL subscription maps — stale entries would block re-subscribe after reconnect
    heliusSubIds.clear(); heliusPendingSubs.clear();
    heliusLogSubIds.clear(); heliusLogPendingSubs.clear();
    heliusWs = null;
    setTimeout(connectHeliusWs, 5_000);
  });
  heliusWs.on('error', (err: Error) => console.warn('[bonding-smart] Helius WS err: ' + String(err?.message).slice(0, 60)));
}

// ─── Position rehydration from DB on restart ──────────────────────────────────
async function rehydrateActivePositions(): Promise<void> {
  if (DRY_RUN) return;
  try {
    const { rows } = await query(
      `SELECT mint_address, label, amount_sol, entry_price_sol, token_amount_bought, bought_at
       FROM autobuy_jobs
       WHERE active = true AND total_sold_sol = 0 AND label LIKE 'auto:bonding:smart%'
       AND bought_at > NOW() - INTERVAL '30 minutes'`
    );
    for (const row of rows) {
      if (activePositions.has(row.mint_address)) continue;
      const entryPrice = Number(row.entry_price_sol) || (Number(row.amount_sol) / 1e9);
      if (!entryPrice || entryPrice <= 0) continue;
      const symbol = row.label?.split(':')?.[3] || 'UNKNOWN';
      activePositions.set(row.mint_address, {
        mint: row.mint_address, symbol, entryPrice,
        tokenAmount: Number(row.token_amount_bought) || 0,
        boughtAt: new Date(row.bought_at).getTime(), peakPrice: entryPrice,
        stage1Done: false, stage2Done: false, lastVolumeSol: 0, pool: 'pump',
      });
      subscribeBondingCurve(row.mint_address);
      subscribeTokenLogs(row.mint_address);
      console.info(`[bonding-smart] 🔄 Rehydrated: ${symbol} (${row.mint_address.slice(0, 8)})`);
    }
    if (rows.length > 0) console.info(`[bonding-smart] 🔄 Rehydrated ${activePositions.size}/${rows.length} positions`);
  } catch (err: any) {
    console.error('[bonding-smart] Rehydrate error: ' + String(err?.message).slice(0, 100));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function fetchMetadataSocials(metadataUri: string) {
  const empty = { hasTwitter: false, hasTelegram: false };
  if (!metadataUri) return empty;
  try {
    const res = await axios.get(metadataUri.replace('ipfs://', 'https://ipfs.io/ipfs/'), { timeout: 4_000 });
    const links = JSON.stringify(res.data ?? {}).toLowerCase();
    return {
      hasTwitter:  links.includes('twitter') || links.includes('x.com'),
      hasTelegram: links.includes('t.me') || links.includes('telegram'),
    };
  } catch { return empty; }
}

async function checkDevHistory(devWallet: string): Promise<void> {
  try {
    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: [devWallet, { limit: 50 }],
    }, { timeout: 5_000 });
    if ((res.data?.result ?? []).length >= 50)
      console.debug(`[bonding-smart] Dev ${devWallet.slice(0, 8)} is very active (≥50 TXs)`);
  } catch { /* fail open */ }
}

function checkDailyReset(): void {
  const today = Math.floor(Date.now() / 86_400_000);
  if (today !== lastDailyReset) { dailySpent = 0; lastDailyReset = today; }
}

// ─── Entry decision ───────────────────────────────────────────────────────────
async function shouldBuy(state: TokenState): Promise<{ buy: boolean; reason: string }> {
  const skip = (r: string) => ({ buy: false, reason: r });
  const ageSec = (Date.now() - state.createdAt) / 1000;
  if (ageSec > MAX_TOKEN_AGE_SEC) return skip(`too_old: ${(ageSec / 60).toFixed(0)}min`);
  if (state.bundleDetected)       return skip('bundle: dev bought >5% of curve');

  // Curve progress: 0-100% toward graduation (588 SOL)
  const curveProgress = state.vSol > BONDING_BASE_SOL
    ? ((state.vSol - BONDING_BASE_SOL) / (GRADUATION_SOL - BONDING_BASE_SOL)) * 100
    : 0;
  if (curveProgress > 25)             return skip(`sniper_trap: curve ${curveProgress.toFixed(1)}% pumped`);
  if (ageSec < 15 && curveProgress > 15) return skip(`early_spike: curve ${curveProgress.toFixed(1)}% in ${ageSec.toFixed(1)}s`);

  const requireSocial = process.env.BONDING_SMART_REQUIRE_SOCIAL !== 'false';
  console.info(`[bonding-smart] shouldBuy ${state.symbol}: curve=${curveProgress.toFixed(1)}% social=${requireSocial} X=${state.hasTwitter} TG=${state.hasTelegram} dev=${state.devSolInvested.toFixed(3)}SOL`);
  if (requireSocial && !state.hasTwitter && !state.hasTelegram) return skip('no_socials');

  const minDevBuy = Number(process.env.BONDING_SMART_MIN_DEV_BUY || '0.5');
  if (state.devSolInvested < minDevBuy) return skip(`dev_low: ${state.devSolInvested.toFixed(3)} < ${minDevBuy} SOL`);
  const maxDevBuy = Number(process.env.BONDING_SMART_MAX_DEV_BUY || '5.0');
  if (state.devSolInvested > maxDevBuy) return skip(`dev_high: ${state.devSolInvested.toFixed(2)} > ${maxDevBuy} SOL`);

  const maxDevPct = Number(process.env.BONDING_SMART_MAX_DEV_PCT || '3');
  const devHoldingPct = (state.devSolInvested / GRADUATION_SOL) * 100;
  if (devHoldingPct > maxDevPct) return skip(`dev_holding: ${devHoldingPct.toFixed(1)}% > ${maxDevPct}%`);

  // Smart money required (only meaningful if we have logsSubscribe data)
  const requireSM = process.env.BONDING_SMART_REQUIRE_SM === 'true';
  if (requireSM && state.smConfirmations < 1) return skip(`no_smart_money: ${state.smConfirmations} confirmations`);

  await checkDevHistory(state.devWallet);
  return {
    buy: true,
    reason: `dev=${state.devSolInvested.toFixed(3)}SOL curve=${curveProgress.toFixed(1)}% socials=${state.hasTwitter ? 'X' : ''}${state.hasTelegram ? 'TG' : ''} sm=${state.smConfirmations}`,
  };
}

// ─── Buy ──────────────────────────────────────────────────────────────────────
async function doBuy(state: TokenState, context: string): Promise<void> {
  const walletPk = process.env.WALLET_PRIVATE_KEY;
  if (!walletPk) return;
  try {
    let secretKey: Uint8Array;
    try { secretKey = Uint8Array.from(JSON.parse(walletPk)); }
    catch { secretKey = decode(walletPk); }
    const kp = Keypair.fromSecretKey(secretKey);
    const entryPrice = state.vSol / 800_000_000;
    const label = `auto:bonding:smart:${state.symbol}:pump`;
    if (DRY_RUN) {
      console.info(`[bonding-smart] 🔵 DRY BUY ${state.symbol} (${state.mint.slice(0, 8)}) ${BUY_SOL} SOL — ${context}`);
      activePositions.set(state.mint, {
        mint: state.mint, symbol: state.symbol, entryPrice, tokenAmount: 0,
        boughtAt: Date.now(), peakPrice: entryPrice,
        stage1Done: false, stage2Done: false, lastVolumeSol: 0, pool: 'pump', dryRun: true,
      });
      dailySpent += BUY_SOL;
      // Save to shadow_trades for WR tracking (v10b)
      query(
        `INSERT INTO shadow_trades
           (chain, strategy, symbol, contract_address, entry_price, entry_mcap_usd,
            filter_params, tp1_target, stop_pct, status)
         VALUES ('SOLANA','bonding-smart',$1,$2,$3,$4,$5,$6,$7,'open')`,
        [state.symbol, state.mint, entryPrice, state.vSol * 2,
         JSON.stringify({ context, devBuy: state.devSolInvested, vSol: state.vSol }), 1.25, 8],
      ).catch(() => {});
      subscribeBondingCurve(state.mint);
      subscribeTokenLogs(state.mint);
      return;
    }
    const connection = new Connection(HELIUS_RPC, 'confirmed');
    const params = { publicKey: kp.publicKey.toBase58(), action: 'buy', mint: state.mint,
      denominatedInSol: 'true', amount: BUY_SOL, slippage: 10, priorityFee: PRIORITY_FEE, pool: 'pump' };
    const res = await axios.post(PUMPPORTAL_BUY, params, { responseType: 'arraybuffer', timeout: 10_000 });
    if (res.status !== 200) throw new Error(`PumpPortal ${res.status}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(res.data as ArrayBuffer));
    tx.sign([kp]);
    const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    console.info(`[bonding-smart] ✅ BUY ${state.symbol} ${BUY_SOL} SOL — ${context} sig=${sig.slice(0, 12)}`);
    await query(
      `INSERT INTO autobuy_jobs
         (mint_address, label, amount_sol, slippage_bps, interval_seconds,
          wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled,
          entry_price_sol, bought_at)
       VALUES ($1,$2,$3,$4,86400,$5,false,$6,true,$7,now())`,
      [state.mint, label, BUY_SOL, BASE_SLIPPAGE_BPS, '', VOLUME_WATCH_SEC, entryPrice]
    );
    dailySpent += BUY_SOL;
    activePositions.set(state.mint, {
      mint: state.mint, symbol: state.symbol, entryPrice,
      tokenAmount: Math.floor(BUY_SOL / entryPrice),
      boughtAt: Date.now(), peakPrice: entryPrice,
      stage1Done: false, stage2Done: false, lastVolumeSol: 0, pool: 'pump',
    });
    subscribeBondingCurve(state.mint);
    subscribeTokenLogs(state.mint);
  } catch (err: any) {
    console.warn(`[bonding-smart] Buy failed ${state.symbol}: ${String(err?.message).slice(0, 150)}`);
  }
}

// ─── Sell ─────────────────────────────────────────────────────────────────────
async function doSell(mint: string, symbol: string, pct: number, reason: string, slippage = BASE_SLIPPAGE_BPS): Promise<void> {
  const pos = activePositions.get(mint);
  if (pos?.dryRun) {
    const mult = pos.peakPrice > 0 ? (pos.peakPrice / pos.entryPrice) : 1;
    console.info(`[bonding-smart] 🔵 DRY SELL ${pct}% ${symbol} — ${reason} (peak ${mult.toFixed(2)}x)`);
    // Auto-collect early buyers of winning tokens as SM candidates (v10)
    if (pct === 50 && mult >= 1.20) {
      collectWinnersAsSmartMoney(mint, symbol).catch(() => {});
    }
    if (pct === 100) {
      // Update shadow_trades on full close (v10b)
      const isWin = mult >= 1.20;
      query(
        `UPDATE shadow_trades SET
           status = $1, outcome_pct = $2, outcome_price = entry_price * $3, outcome_at = NOW()
         WHERE contract_address = $4 AND strategy = 'bonding-smart' AND status = 'open'`,
        [isWin ? 'win' : 'stopped', ((mult - 1) * 100).toFixed(4), mult, mint],
      ).catch(() => {});
      unsubscribeBondingCurve(mint);
      unsubscribeTokenLogs(mint);
    }
    return;
  }
  const walletPk = process.env.WALLET_PRIVATE_KEY;
  if (!walletPk) return;
  try {
    let secretKey: Uint8Array;
    try { secretKey = Uint8Array.from(JSON.parse(walletPk)); }
    catch { secretKey = decode(walletPk); }
    const kp = Keypair.fromSecretKey(secretKey);
    const connection = new Connection(HELIUS_RPC, 'confirmed');
    // Dynamic Jito: higher fee for emergency exits to beat competing bots
    const sellFee = (reason.includes('dump') || reason.includes('stop_loss') ||
      reason.includes('pre_grad') || reason.includes('breakeven')) ? 0.0012 : PRIORITY_FEE;
    const params = { publicKey: kp.publicKey.toBase58(), action: 'sell', mint,
      denominatedInSol: 'false', amount: pct === 100 ? '100%' : `${pct}%`,
      slippage: slippage / 100, priorityFee: sellFee, pool: 'pump' };
    const res = await axios.post(PUMPPORTAL_BUY, params, { responseType: 'arraybuffer', timeout: 10_000 });
    if (res.status !== 200) { console.warn(`[bonding-smart] Sell HTTP ${res.status} ${symbol}`); return; }
    const tx = VersionedTransaction.deserialize(Buffer.from(res.data as ArrayBuffer));
    tx.sign([kp]);
    const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    console.info(`[bonding-smart] 💰 SELL ${pct}% ${symbol} — ${reason} sig=${sig.slice(0, 12)}`);
    try {
      const est = BUY_SOL * (pct / 100) * 0.9;
      await query('UPDATE autobuy_jobs SET total_sold_sol=$1, active=false WHERE mint_address=$2 AND label LIKE $3',
        [est, mint, 'auto:bonding:smart%']);
    } catch { /* non-critical */ }
    // Unsubscribe both curve price and logs tracking on full position close
    if (pct === 100) { unsubscribeBondingCurve(mint); unsubscribeTokenLogs(mint); }
  } catch (err: any) {
    console.warn(`[bonding-smart] Sell error ${symbol}: ${String(err?.message).slice(0, 60)}`);
  }
}

// ─── Position monitor (1s poll) ───────────────────────────────────────────────
async function monitorPositions(): Promise<void> {
  const now = Date.now();
  const minBuyers = Number(process.env.BONDING_SMART_MIN_BUYERS || '0');
  for (const [mint, pos] of activePositions) {
    const state = tokenStates.get(mint);
    if (!state) continue;
    const currentPrice = state.vSol / 800_000_000;
    if (!currentPrice || currentPrice <= 0) continue;
    if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
    const mult    = currentPrice / pos.entryPrice;
    const holdSec = (now - pos.boughtAt) / 1000;

    // TP1: +25% → sell 50%
    if (!pos.stage1Done && mult >= 1.25) {
      await doSell(mint, pos.symbol, 50, `TP1 +${(mult * 100 - 100).toFixed(0)}%`);
      pos.stage1Done = true;
    }
    // TP2: +50% → sell 50% of remaining (25% original)
    if (pos.stage1Done && !pos.stage2Done && mult >= 1.50) {
      await doSell(mint, pos.symbol, 50, `TP2 +${(mult * 100 - 100).toFixed(0)}%`);
      pos.stage2Done = true;
    }
    // Trailing stop: -12% from peak (after TP1)
    if (pos.stage1Done && currentPrice < pos.peakPrice * 0.88) {
      await doSell(mint, pos.symbol, 100, `trail_stop -${((pos.peakPrice - currentPrice) / pos.peakPrice * 100).toFixed(0)}%`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint); continue;
    }
    // Hard stop-loss: -8% before TP1
    if (!pos.stage1Done && currentPrice < pos.entryPrice * (1 - STOP_PCT)) {
      await doSell(mint, pos.symbol, 100, `stop_loss -${(100 - mult * 100).toFixed(0)}%`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint); continue;
    }
    // Breakeven stop: price rose ≥+10% then returned to entry → exit flat (avoid -8% loss)
    if (!pos.stage1Done && pos.peakPrice >= pos.entryPrice * 1.10 && currentPrice < pos.entryPrice * 1.01) {
      await doSell(mint, pos.symbol, 100, `breakeven: peak=${(pos.peakPrice / pos.entryPrice).toFixed(2)}x fell to ${mult.toFixed(2)}x`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint); continue;
    }
    // Time-exit: volume too low after VOL_WATCH_SEC
    if (holdSec > VOLUME_WATCH_SEC) {
      const recentVol = state.events.filter(e => e.isBuy && now - e.ts <= 60_000)
        .reduce((s, e) => s + e.solAmount, 0);
      if (recentVol < MIN_VOLUME_TO_STAY) {
        await doSell(mint, pos.symbol, 100, `time-exit: vol ${recentVol.toFixed(2)}/${MIN_VOLUME_TO_STAY} SOL (${mult.toFixed(2)}x)`, DUMP_SLIPPAGE_BPS);
        activePositions.delete(mint); continue;
      }
      // Unique buyer check (if we have logsSubscribe data)
      if (minBuyers > 0) {
        const uniqueBuyers = new Set(state.events.filter(e => e.isBuy && now - e.ts <= 5 * 60_000).map(e => e.buyer)).size;
        if (uniqueBuyers < minBuyers) {
          await doSell(mint, pos.symbol, 100, `low_buyers: ${uniqueBuyers}/${minBuyers} unique`, DUMP_SLIPPAGE_BPS);
          activePositions.delete(mint); continue;
        }
      }
    }
    // Dump guard: sell pressure > buy 3:1 in last 30s
    const last30   = state.events.filter(e => now - e.ts <= 30_000);
    const buyVol   = last30.filter(e => e.isBuy).reduce((s, e) => s + e.solAmount, 0);
    const sellVol  = last30.filter(e => !e.isBuy).reduce((s, e) => s + e.solAmount, 0);
    if (sellVol > buyVol * 3 && sellVol > 2) {
      await doSell(mint, pos.symbol, 100, `dump: sell/buy=${(sellVol / Math.max(buyVol, 0.01)).toFixed(1)}x`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint); continue;
    }
    // Pre-graduation guard
    if (state.vSol > 488) {
      await doSell(mint, pos.symbol, 100, `pre_grad: vSol=${state.vSol.toFixed(0)}`, DUMP_SLIPPAGE_BPS);
      activePositions.delete(mint); continue;
    }
  }
}

// ─── PumpPortal WS event handlers ────────────────────────────────────────────
async function handleCreate(ev: any): Promise<void> {
  const mint        = ev.mint as string;
  const devWallet   = ev.traderPublicKey as string;
  const symbol      = (ev.symbol ?? 'UNKNOWN') as string;
  const metaUri     = (ev.uri ?? '') as string;
  const devSolBuy   = Number(ev.solAmount ?? 0);
  const initialVSol = Number(ev.vSolInBondingCurve ?? 0);
  const bundleDetected = devSolBuy > GRADUATION_SOL * 0.05;
  const socials = await fetchMetadataSocials(metaUri);
  const state: TokenState = {
    mint, symbol, devWallet, createdAt: Date.now(),
    hasTwitter: socials.hasTwitter, hasTelegram: socials.hasTelegram,
    bundleDetected, events: [], vSol: initialVSol, devSolInvested: devSolBuy, smConfirmations: 0,
  };
  tokenStates.set(mint, state);
  const flags = [bundleDetected && '🚨bundle', !socials.hasTwitter && !socials.hasTelegram && '❌nosocial', socials.hasTwitter && '🐦X', socials.hasTelegram && '📱TG'].filter(Boolean).join(' ');
  console.debug(`[bonding-smart] 🆕 ${symbol} dev:${devWallet.slice(0, 6)} buy:${devSolBuy.toFixed(3)}SOL ${flags}`);
  // Prune states older than 2h
  const cutoff = Date.now() - 2 * 3_600_000;
  for (const [k, v] of tokenStates) { if (v.createdAt < cutoff) tokenStates.delete(k); }
  if (!ENABLED) return;
  checkDailyReset();
  if (activePositions.size >= MAX_POSITIONS || dailySpent + BUY_SOL > DAILY_MAX_SOL || buyInProgress) return;
  buyInProgress = true;
  try {
    const decision = await shouldBuy(state);
    if (decision.buy) await doBuy(state, decision.reason);
    else console.info(`[bonding-smart] skip ${symbol.slice(0, 12)} — ${decision.reason}`);
  } finally { buyInProgress = false; }
}

async function handleTrade(ev: any): Promise<void> {
  const mint  = ev.mint as string;
  const isBuy = ev.txType === 'buy';
  const vSol  = Number(ev.vSolInBondingCurve ?? 0);
  const state = tokenStates.get(mint);
  if (!state) return;
  if (vSol > 0) state.vSol = vSol;
  // Pre-graduation exit
  if (vSol > 488 && activePositions.has(mint)) {
    const pos = activePositions.get(mint)!;
    await doSell(mint, pos.symbol, 100, 'pre_grad', DUMP_SLIPPAGE_BPS);
    activePositions.delete(mint);
  }
}

// ─── PumpPortal WS ────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let wsReconnectTimer: NodeJS.Timeout | null = null;

function connectWS(): void {
  if (ws) { try { ws.terminate(); } catch {} ws = null; }
  ws = new WebSocket(PUMPPORTAL_WS);
  ws.on('open', () => {
    console.info('[bonding-smart] WebSocket connected to PumpPortal');
    ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });
  ws.on('message', async (raw: Buffer) => {
    try {
      const ev = JSON.parse(raw.toString());
      if (ev.txType === 'create') await handleCreate(ev);
      else if (ev.txType === 'buy' || ev.txType === 'sell') await handleTrade(ev);
    } catch { /* ignore parse errors */ }
  });
  ws.on('close', () => {
    console.warn('[bonding-smart] PumpPortal WS closed — reconnect 5s');
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWS, 5_000);
  });
  ws.on('error', (err: Error) => console.warn(`[bonding-smart] PumpPortal WS err: ${err.message?.slice(0, 60)}`));
}

function startPositionMonitor(): void {
  setInterval(() => {
    if (activePositions.size > 0) monitorPositions().catch(() => {});
  }, 1_000);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
export function startBondingSmart(): void {
  if (ENABLED) {
    console.info(`[bonding-smart] ${DRY_RUN ? '🔵 DRY-RUN' : '🚀 LIVE'} — bundle<5% curve<25% social=${process.env.BONDING_SMART_REQUIRE_SOCIAL !== 'false'} devSOL=${process.env.BONDING_SMART_MIN_DEV_BUY || '0.5'}-${process.env.BONDING_SMART_MAX_DEV_BUY || '5.0'} SL=${STOP_PCT * 100}% TP1=1.25x TP2=1.50x trail=12% exit=${VOLUME_WATCH_SEC}s`);
    console.info(`[bonding-smart] Price source: Helius accountSubscribe | Trade source: Helius logsSubscribe | Smart money: ${smartMoneySet.size} wallets`);
  }
  connectHeliusWs();
  loadSmartMoneyWallets().then(() =>
    rehydrateActivePositions().then(() => { connectWS(); startPositionMonitor(); }).catch(() => { connectWS(); startPositionMonitor(); })
  ).catch(() => {
    rehydrateActivePositions().then(() => { connectWS(); startPositionMonitor(); }).catch(() => { connectWS(); startPositionMonitor(); });
  });
}

/**
 * DriftTrader — wraps Drift Protocol SDK for SOL-PERP trading.
 *
 * MODES:
 *   FUTURES_LIVE_MODE=false (default) → paper trading, no real money, no SDK calls
 *   FUTURES_LIVE_MODE=true            → real Drift on Solana mainnet via WALLET_PRIVATE_KEY
 *
 * Drift Protocol: https://drift.trade
 * SDK docs: https://docs.drift.trade/developer-resources/sdk-documentation
 *
 * Phantom wallet ↔ Drift: same keypair (WALLET_PRIVATE_KEY JSON array).
 * Requires: USDC deposited to Drift account on-chain before live trading.
 */

import { query } from '@lib/db';
import { randomUUID } from 'crypto';
import { OpenPosition, Side, PositionSize, TradingMode, CloseReason } from './types';

const LIVE_MODE: TradingMode = process.env.FUTURES_LIVE_MODE === 'true' ? 'live' : 'paper';

// ── Drift SDK — lazy-loaded only in live mode ─────────────────────────────────
let driftClient: any = null;
let driftInitialized = false;

async function getDriftClient(): Promise<any> {
  if (driftInitialized) return driftClient;

  if (LIVE_MODE !== 'live') {
    driftInitialized = true;
    return null;
  }

  try {
    // Dynamic import so paper mode never requires the heavy Drift SDK
    const { Connection, Keypair } = await import('@solana/web3.js');
    const {
      DriftClient,
      User,
      BulkAccountLoader,
      PerpMarkets,
      getMarketsAndOraclesForSubscription,
      MarketType,
    } = await import('@drift-labs/sdk');

    const rpcUrl = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    const rawKey = JSON.parse(process.env.WALLET_PRIVATE_KEY!);
    const keypair = Keypair.fromSecretKey(Uint8Array.from(rawKey));
    const connection = new Connection(rpcUrl, 'confirmed');

    const accountLoader = new BulkAccountLoader(connection, 'confirmed', 1000);
    const { oracleInfos, perpMarketIndexes, spotMarketIndexes } =
      getMarketsAndOraclesForSubscription([MarketType.PERP]);

    driftClient = new DriftClient({
      connection,
      wallet: { publicKey: keypair.publicKey, signTransaction: async (tx: any) => { tx.sign(keypair); return tx; }, signAllTransactions: async (txs: any[]) => { txs.forEach(tx => tx.sign(keypair)); return txs; } } as any,
      programID: undefined as any, // SDK resolves from network
      accountSubscription: { type: 'polling', accountLoader },
      perpMarketIndexes,
      spotMarketIndexes,
      oracleInfos,
    });

    await driftClient.subscribe();
    console.log('[drift] ✅ Drift client subscribed (LIVE MODE)');
    driftInitialized = true;
  } catch (err: any) {
    console.error('[drift] ❌ Failed to init Drift SDK:', err.message);
    driftInitialized = true; // prevent retry loops
    driftClient = null;
  }

  return driftClient;
}

// ── Paper trade helpers ───────────────────────────────────────────────────────
async function paperOpen(
  side: Side,
  entryPrice: number,
  ps: PositionSize,
  macroScore: number,
  signalScore: number,
  ema21: number,
  ema50: number,
  rsi14: number,
  volRatio: number
): Promise<OpenPosition> {
  const tradeId = `paper-${Date.now()}-${randomUUID().slice(0, 8)}`;

  await query(
    `INSERT INTO futures_positions
       (trade_id, symbol, side, mode, entry_price, size_usdc, leverage, notional_usdc,
        macro_score, signal_score, ema21, ema50, rsi14, vol_ratio)
     VALUES ($1,'SOL-PERP',$2,'paper',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [tradeId, side, entryPrice, ps.sizeUsdc, ps.leverage, ps.notionalUsdc,
     macroScore, signalScore, ema21, ema50, rsi14, volRatio]
  );

  console.log(`[paper] 📝 OPEN ${side}  entry=$${entryPrice}  size=$${ps.sizeUsdc}  lev=x${ps.leverage}  TP=$${ps.tpPrice}  SL=$${ps.slPrice}`);

  return {
    id:           0,
    tradeId,
    symbol:       'SOL-PERP',
    side,
    mode:         'paper',
    entryPrice,
    sizeUsdc:     ps.sizeUsdc,
    leverage:     ps.leverage,
    notionalUsdc: ps.notionalUsdc,
    openedAt:     new Date(),
  };
}

async function paperClose(
  tradeId: string,
  exitPrice: number,
  reason: CloseReason
): Promise<number> {
  const res = await query<any>(
    `SELECT * FROM futures_positions WHERE trade_id=$1 AND status='open'`, [tradeId]
  );
  if (!res.rows.length) return 0;

  const pos = res.rows[0];
  const side        = pos.side as Side;
  const entryPrice  = parseFloat(pos.entry_price);
  const notional    = parseFloat(pos.notional_usdc);

  const priceDiff = side === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const pnlPct    = priceDiff / entryPrice;
  const pnlUsdc   = notional * pnlPct;
  const feeUsdc   = notional * 0.001; // 0.1% taker fee × 2 sides
  const netPnl    = pnlUsdc - feeUsdc;

  await query(
    `UPDATE futures_positions
     SET status='closed', exit_price=$2, closed_at=NOW(), close_reason=$3,
         pnl_usdc=$4, pnl_pct=$5, fee_usdc=$6
     WHERE trade_id=$1`,
    [tradeId, exitPrice, reason, netPnl.toFixed(6), (pnlPct * 100).toFixed(4), feeUsdc.toFixed(6)]
  );

  console.log(`[paper] 📝 CLOSE ${side}  exit=$${exitPrice}  pnl=${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)} (${reason})`);
  return netPnl;
}

// ── Live Drift helpers ────────────────────────────────────────────────────────
async function driftOpen(
  side: Side,
  entryPrice: number,
  ps: PositionSize
): Promise<{ orderId: string; txSig: string }> {
  const client = await getDriftClient();
  if (!client) throw new Error('Drift client not initialized');

  const {
    OrderType,
    PositionDirection,
    BASE_PRECISION,
    PRICE_PRECISION,
  } = await import('@drift-labs/sdk');

  const direction = side === 'LONG' ? PositionDirection.LONG : PositionDirection.SHORT;
  // SOL-PERP market index = 0 on Drift mainnet
  const SOL_PERP_INDEX = 0;
  // Convert notional to base amount (SOL quantity)
  const baseAmount = BigInt(Math.floor((ps.notionalUsdc / entryPrice) * Number(BASE_PRECISION)));

  const txSig = await client.placePerpOrder({
    orderType:   OrderType.MARKET,
    marketIndex: SOL_PERP_INDEX,
    direction,
    baseAssetAmount: baseAmount,
    reduceOnly: false,
  });

  return { orderId: String(Date.now()), txSig };
}

async function driftClose(
  driftOrderId: string,
  side: Side
): Promise<string> {
  const client = await getDriftClient();
  if (!client) throw new Error('Drift client not initialized');

  const {
    OrderType,
    PositionDirection,
  } = await import('@drift-labs/sdk');

  const closeDirection = side === 'LONG' ? PositionDirection.SHORT : PositionDirection.LONG;
  const SOL_PERP_INDEX = 0;

  const txSig = await client.placePerpOrder({
    orderType:   OrderType.MARKET,
    marketIndex: SOL_PERP_INDEX,
    direction:   closeDirection,
    reduceOnly:  true,
  } as any);

  return txSig;
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function openPosition(
  side: Side,
  currentPrice: number,
  ps: PositionSize,
  context: {
    macroScore: number;
    signalScore: number;
    ema21: number;
    ema50: number;
    rsi14: number;
    volRatio: number;
  }
): Promise<OpenPosition | null> {
  try {
    if (LIVE_MODE === 'live') {
      const { orderId, txSig } = await driftOpen(side, currentPrice, ps);
      const tradeId = `live-${Date.now()}-${orderId.slice(0, 8)}`;
      await query(
        `INSERT INTO futures_positions
           (trade_id, symbol, side, mode, entry_price, size_usdc, leverage, notional_usdc,
            macro_score, signal_score, ema21, ema50, rsi14, vol_ratio,
            drift_order_id, drift_tx_sig)
         VALUES ($1,'SOL-PERP',$2,'live',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [tradeId, side, currentPrice, ps.sizeUsdc, ps.leverage, ps.notionalUsdc,
         context.macroScore, context.signalScore, context.ema21, context.ema50,
         context.rsi14, context.volRatio, orderId, txSig]
      );
      console.log(`[drift] ✅ LIVE OPEN ${side}  tx=${txSig}`);
      return {
        id: 0, tradeId, symbol: 'SOL-PERP', side, mode: 'live',
        entryPrice: currentPrice, sizeUsdc: ps.sizeUsdc,
        leverage: ps.leverage, notionalUsdc: ps.notionalUsdc, openedAt: new Date(),
        driftOrderId: orderId,
      };
    }

    return await paperOpen(
      side, currentPrice, ps,
      context.macroScore, context.signalScore,
      context.ema21, context.ema50, context.rsi14, context.volRatio
    );
  } catch (err: any) {
    console.error(`[trader] openPosition error:`, err.message);
    return null;
  }
}

export async function closePosition(
  tradeId: string,
  exitPrice: number,
  reason: CloseReason
): Promise<number> {
  const posRes = await query<any>(
    `SELECT * FROM futures_positions WHERE trade_id=$1 AND status='open'`, [tradeId]
  );
  if (!posRes.rows.length) return 0;
  const pos = posRes.rows[0];

  if (LIVE_MODE === 'live' && pos.drift_order_id) {
    try {
      await driftClose(pos.drift_order_id, pos.side as Side);
    } catch (err: any) {
      console.error(`[drift] closePosition error:`, err.message);
    }
  }

  return await paperClose(tradeId, exitPrice, reason);
}

export async function getOpenPositions(): Promise<OpenPosition[]> {
  const res = await query<any>(
    `SELECT * FROM futures_positions WHERE status='open' ORDER BY opened_at DESC`
  );
  return res.rows.map(r => ({
    id:           r.id,
    tradeId:      r.trade_id,
    symbol:       r.symbol,
    side:         r.side as Side,
    mode:         r.mode as TradingMode,
    entryPrice:   parseFloat(r.entry_price),
    sizeUsdc:     parseFloat(r.size_usdc),
    leverage:     r.leverage,
    notionalUsdc: parseFloat(r.notional_usdc),
    openedAt:     new Date(r.opened_at),
    driftOrderId: r.drift_order_id,
  }));
}

export async function getRecentTrades(limit = 10): Promise<any[]> {
  const res = await query<any>(
    `SELECT * FROM futures_positions WHERE status='closed'
     ORDER BY closed_at DESC LIMIT $1`, [limit]
  );
  return res.rows;
}

export { LIVE_MODE };

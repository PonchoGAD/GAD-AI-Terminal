import axios from 'axios';
import crypto from 'crypto';
import { query } from '@lib/db';
import { ScoredSignal } from './scorer';
import { getMidPrice } from './markets';

const DRY_RUN    = process.env.POLYMARKET_DRY_RUN !== 'false';
const MAX_USDC   = Number(process.env.POLYMARKET_MAX_USDC  || '10');  // max USDC per trade
const CLOB_HOST  = 'https://clob.polymarket.com';

// CLOB API credentials (required for live mode only)
const API_KEY        = process.env.POLYMARKET_API_KEY        ?? '';
const API_SECRET     = process.env.POLYMARKET_API_SECRET     ?? '';
const API_PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE ?? '';

// HMAC-SHA256 signature for CLOB API auth
function clobSign(ts: number, method: string, path: string, body = ''): string {
  const msg = `${ts}${method}${path}${body}`;
  return crypto.createHmac('sha256', API_SECRET).update(msg).digest('base64');
}

function clobHeaders(method: string, path: string, body = '') {
  const ts = Math.floor(Date.now() / 1000);
  return {
    'POLY-API-KEY':     API_KEY,
    'POLY-PASSPHRASE':  API_PASSPHRASE,
    'POLY-TIMESTAMP':   String(ts),
    'POLY-SIGNATURE':   clobSign(ts, method, path, body),
    'Content-Type':     'application/json',
  };
}

export async function openPosition(
  signal: ScoredSignal,
  signalId: number | null
): Promise<void> {
  const tokenId   = signal.outcome === 'YES' ? signal.tokenIdYes : signal.tokenIdNo;
  const usdcSpend = Math.min(MAX_USDC, 10);
  const shares    = parseFloat((usdcSpend / signal.entryPrice).toFixed(4));

  let orderId: string | null = null;

  if (DRY_RUN) {
    console.info(
      `[poly-trader] 🎯 DRY-RUN  ${signal.outcome} "${signal.marketTitle.slice(0, 50)}"` +
      ` @ $${signal.entryPrice.toFixed(3)} | ${shares.toFixed(2)} shares | EV=${(signal.evScore*100).toFixed(0)}% | ${signal.confidence}`
    );
  } else {
    if (!API_KEY || !API_SECRET) {
      console.error('[poly-trader] POLYMARKET_API_KEY / POLYMARKET_API_SECRET not set — cannot trade live');
      return;
    }
    try {
      const body = JSON.stringify({
        tokenID:     tokenId,
        price:       signal.entryPrice,
        side:        'BUY',
        size:        shares,
        feeRateBps:  0,
        nonce:       0,
        expiration:  0,
        orderType:   'GTC',
      });
      const path = '/order';
      const { data } = await axios.post(`${CLOB_HOST}${path}`, body, {
        headers: clobHeaders('POST', path, body),
        timeout: 15000,
      });
      if (data?.errorMsg) throw new Error(data.errorMsg);
      orderId = data?.orderID ?? null;
      console.info(`[poly-trader] ✅ LIVE order ${orderId} — ${signal.outcome} ${shares} @ $${signal.entryPrice}`);
    } catch (e: any) {
      console.error(`[poly-trader] Order failed: ${e.message}`);
      return;
    }
  }

  await query(
    `INSERT INTO polymarket_positions
       (market_id, signal_id, outcome, amount_usdc, shares, entry_price, token_id, is_dry_run, order_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
    [signal.marketId, signalId, signal.outcome, usdcSpend, shares, signal.entryPrice,
     tokenId, DRY_RUN, orderId]
  );
}

interface CloseResult { ok: boolean; executedPrice: number; error?: string }

export async function closePosition(
  posId:   number,
  tokenId: string,
  shares:  number,
  reason:  string,
  isDryRun: boolean
): Promise<CloseResult> {
  const currentPrice = await getMidPrice(tokenId);
  if (!currentPrice) return { ok: false, executedPrice: 0, error: 'no price' };

  if (isDryRun) {
    console.info(`[poly-trader] 🏁 DRY-RUN sell ${shares} shares @ $${currentPrice.toFixed(3)} (${reason})`);
    return { ok: true, executedPrice: currentPrice };
  }

  try {
    const body = JSON.stringify({
      tokenID:    tokenId,
      price:      currentPrice,
      side:       'SELL',
      size:       shares,
      feeRateBps: 0,
      nonce:      0,
      expiration: 0,
      orderType:  'GTC',
    });
    const path = '/order';
    const { data } = await axios.post(`${CLOB_HOST}${path}`, body, {
      headers: clobHeaders('POST', path, body),
      timeout: 15000,
    });
    if (data?.errorMsg) throw new Error(data.errorMsg);
    return { ok: true, executedPrice: currentPrice };
  } catch (e: any) {
    return { ok: false, executedPrice: 0, error: e.message };
  }
}

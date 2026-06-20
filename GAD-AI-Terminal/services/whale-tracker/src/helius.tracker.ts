import axios from 'axios';
import { query } from '@lib/db';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const BASE_URL   = 'https://api.helius.xyz/v0';

const WHALE_THRESHOLD_USD = Number(process.env.WHALE_THRESHOLD_USD || '5000');

// Backoff state — Helius REST API is Cloudflare-blocked from VPS (403). Back off 2h on 403.
let _heliusBlockedUntil = 0;

export interface WhaleTx {
  walletAddress: string;
  tokenMint: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  usdValue: number;
  timestamp: number;
  signature: string;
}

/** Fetch recent large transactions from Helius */
export async function fetchLargeTransactions(): Promise<WhaleTx[]> {
  if (!HELIUS_KEY) {
    console.warn('[whale-tracker] HELIUS_API_KEY not set, skipping Helius fetch.');
    return [];
  }

  // Cloudflare blocks api.helius.xyz from VPS — back off 2h after 403 to avoid log spam
  if (_heliusBlockedUntil > Date.now()) {
    return [];
  }

  try {
    // Use Helius enhanced transactions endpoint
    const url = `${BASE_URL}/transactions?api-key=${HELIUS_KEY}`;
    const res = await axios.post(url, {
      query: { types: ['SWAP'], source: 'RAYDIUM' },
      options: { limit: 100 }
    }, { timeout: 15_000 });

    const txs: WhaleTx[] = [];
    for (const tx of (res.data ?? [])) {
      const nativeTransfers = tx.nativeTransfers ?? [];
      const tokenTransfers  = tx.tokenTransfers ?? [];

      for (const transfer of tokenTransfers) {
        const usdValue = Number(transfer.tokenAmount ?? 0) * Number(transfer.tokenPrice ?? 0);
        if (usdValue < WHALE_THRESHOLD_USD) continue;

        txs.push({
          walletAddress: transfer.fromUserAccount ?? tx.feePayer,
          tokenMint: transfer.mint,
          side: transfer.fromUserAccount === tx.feePayer ? 'sell' : 'buy',
          amount: Number(transfer.tokenAmount ?? 0),
          price: Number(transfer.tokenPrice ?? 0),
          usdValue,
          timestamp: tx.timestamp,
          signature: tx.signature
        });
      }
      // Also consider native SOL as proxy for large buy/sell
      for (const t of nativeTransfers) {
        const solAmount = Number(t.amount ?? 0) / 1e9;
        const usd = solAmount * 170; // approximate SOL price proxy
        if (usd < WHALE_THRESHOLD_USD) continue;
        // If native SOL is sent, treat as potential buy from the receiver side
        if (!t.toUserAccount) continue;
        txs.push({
          walletAddress: t.toUserAccount,
          tokenMint: 'So11111111111111111111111111111111111111112',
          side: 'buy',
          amount: solAmount,
          price: 170,
          usdValue: usd,
          timestamp: tx.timestamp,
          signature: tx.signature
        });
      }
    }
    return txs;
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      _heliusBlockedUntil = Date.now() + 2 * 60 * 60 * 1000; // back off 2h
      console.warn(`[whale-tracker] Helius API blocked (${status}) — backing off 2h (VPS IP blocked by Cloudflare)`);
    } else {
      console.warn('[whale-tracker] Helius fetch failed:', err.message);
    }
    return [];
  }
}

/** Upsert wallet and return its ID */
export async function upsertWallet(address: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO wallets (address, last_activity)
     VALUES ($1, now())
     ON CONFLICT (address) DO UPDATE SET last_activity = now()
     RETURNING id`,
    [address]
  );
  return rows[0].id;
}

/** Persist a whale transaction as a wallet trade */
export async function saveWhaleTx(tx: WhaleTx): Promise<void> {
  const walletId = await upsertWallet(tx.walletAddress);

  // Find token
  const tokenQ = await query<{ id: string }>(
    'SELECT id FROM tokens WHERE mint_address = $1', [tx.tokenMint]
  );
  const tokenId = tokenQ.rows[0]?.id ?? null;

  // Dedup by signature
  await query(
    `INSERT INTO wallet_trades (wallet_id, token_id, signature, side, amount, price, usd_value, executed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8))
     ON CONFLICT (signature) DO NOTHING`,
    [walletId, tokenId, tx.signature, tx.side, tx.amount, tx.price, tx.usdValue, tx.timestamp]
  );
}

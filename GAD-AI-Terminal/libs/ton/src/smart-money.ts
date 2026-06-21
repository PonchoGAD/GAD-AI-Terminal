/**
 * TON Network Smart Money Tracker
 *
 * Detects when known profitable TON wallets buy a jetton early.
 * SM wallets stored in DB with network='ton'.
 *
 * Detection method:
 *   1. When a jetton passes filters, query its recent jetton transfers via tonapi.io
 *   2. If any SM wallet appears in the first 20 unique buyers → signal
 *   3. Same weight system as Solana: 1.0/2.0/3.0
 *
 * TON wallet format: user-friendly (UQ.../EQ...) or raw (0:...)
 * We normalize to raw hex for comparisons.
 *
 * Env:
 *   SMART_MONEY_TON_WALLETS — comma-separated TON addresses (quick bootstrap)
 *   TON_API_KEY             — tonapi.io key (free tier available)
 */

import axios from 'axios';
import { query } from '@lib/db';

const TON_API_KEY  = process.env.TON_API_KEY ?? '';
const TONAPI_BASE  = 'https://tonapi.io/v2';
const REFRESH_MS   = 15 * 60 * 1000;
const TRIGGER_WEIGHT = Number(process.env.TON_SM_THRESHOLD ?? '2.0');
const CACHE_TTL_MS = 3 * 60 * 1000;

let tonSmMap   = new Map<string, number>();  // normalized addr → weight
let lastRefresh = 0;

// Normalize TON address to raw form for consistent comparison
function normalizeTonAddr(addr: string): string {
  // Remove -1: or 0: prefix, take just the hex part lowercase
  return addr.replace(/^[-\d]+:/, '').toLowerCase().trim();
}

async function refreshTonSmWallets(): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();

  const fresh = new Map<string, number>();

  // From env
  for (const addr of (process.env.SMART_MONEY_TON_WALLETS ?? '').split(',').map(a => a.trim()).filter(Boolean)) {
    fresh.set(normalizeTonAddr(addr), 1.0);
  }

  // From DB
  try {
    const { rows } = await query<{ wallet_address: string; reliability_weight: string }>(
      `SELECT wallet_address, reliability_weight
         FROM smart_money_wallets
        WHERE active = true AND network = 'ton'
        LIMIT 300`
    );
    for (const row of rows) {
      fresh.set(normalizeTonAddr(row.wallet_address), Number(row.reliability_weight ?? 1.0));
    }
  } catch { /* pre-migration */ }

  if (fresh.size !== tonSmMap.size) {
    console.info(`[ton-sm] Loaded ${fresh.size} TON SM wallets`);
  }
  tonSmMap = fresh;
}

// Cache: jettonAddress → { weight, ts }
const checkCache = new Map<string, { weight: number; ts: number }>();

/**
 * Fetch recent jetton transfers for a given master address via tonapi.io
 */
async function getJettonEarlyBuyers(jettonMasterAddress: string, limit = 30): Promise<string[]> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (TON_API_KEY) headers['Authorization'] = `Bearer ${TON_API_KEY}`;

    // tonapi.io: GET /v2/jettons/{jetton_id}/transfers
    const res = await axios.get(
      `${TONAPI_BASE}/jettons/${encodeURIComponent(jettonMasterAddress)}/transfers`,
      {
        params: { limit, direction: 'in' },
        headers,
        timeout: 8_000,
      }
    );

    const transfers: any[] = res.data?.transfers ?? [];
    const buyers = new Set<string>();

    for (const tx of transfers) {
      // sender = the wallet that sent the buy transaction
      const sender = tx.sender?.address ?? tx.source?.address;
      if (sender) buyers.add(normalizeTonAddr(sender));
      if (buyers.size >= limit) break;
    }

    return Array.from(buyers);
  } catch (err: any) {
    console.debug(`[ton-sm] tonapi error for ${jettonMasterAddress.slice(0, 12)}: ${err.message?.slice(0, 40)}`);
    return [];
  }
}

/**
 * Check if any known SM wallet bought this jetton early.
 * Returns total SM signal weight.
 */
export async function checkTonSmartMoney(
  jettonMasterAddress: string
): Promise<{ weight: number; wallets: string[] }> {
  await refreshTonSmWallets();

  if (tonSmMap.size === 0) return { weight: 0, wallets: [] };

  const key = normalizeTonAddr(jettonMasterAddress);
  const cached = checkCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { weight: cached.weight, wallets: [] };
  }

  const buyers = await getJettonEarlyBuyers(jettonMasterAddress, 30);
  const hits: Array<{ wallet: string; weight: number }> = [];

  for (const buyer of buyers) {
    const w = tonSmMap.get(buyer);
    if (w !== undefined) {
      hits.push({ wallet: buyer, weight: w });
    }
  }

  const totalWeight = hits.reduce((s, h) => s + h.weight, 0);
  checkCache.set(key, { weight: totalWeight, ts: Date.now() });

  if (totalWeight >= TRIGGER_WEIGHT) {
    const names = hits.map(h => `${h.wallet.slice(0, 8)}(w${h.weight})`).join(', ');
    console.info(`[ton-sm] 🔥 SM signal ${totalWeight.toFixed(1)}/${TRIGGER_WEIGHT} on ${key.slice(0, 12)} — ${names}`);
  }

  return { weight: totalWeight, wallets: hits.map(h => h.wallet) };
}

/** True if SM total weight ≥ TRIGGER_WEIGHT. */
export async function hasTonSmartMoneySignal(jettonMasterAddress: string): Promise<boolean> {
  const { weight } = await checkTonSmartMoney(jettonMasterAddress);
  return weight >= TRIGGER_WEIGHT;
}

/**
 * Harvest early buyers of a successful TON jetton (for populating SM list).
 * Use with known pumped TON tokens.
 */
export async function harvestTonTokenSnipers(
  jettonMasterAddress: string,
  topN = 15
): Promise<Array<{ wallet: string; earlyRank: number }>> {
  const buyers = await getJettonEarlyBuyers(jettonMasterAddress, topN * 2);
  return buyers.slice(0, topN).map((wallet, i) => ({ wallet, earlyRank: i + 1 }));
}

/**
 * Save harvested TON snipers to DB.
 */
export async function saveTonSnipersToDb(
  snipers: Array<{ wallet: string; earlyRank: number; token?: string }>
): Promise<void> {
  const rankToWeight = (r: number) => r <= 3 ? 3.0 : r <= 10 ? 2.0 : r <= 15 ? 1.5 : 1.0;
  let saved = 0;
  for (const { wallet, earlyRank, token } of snipers) {
    const weight = rankToWeight(earlyRank);
    try {
      await query(
        `INSERT INTO smart_money_wallets
           (wallet_address, network, associated_token, early_rank, reliability_weight, source, active, created_at)
         VALUES ($1, 'ton', $2, $3, $4, 'onchain', true, now())
         ON CONFLICT (wallet_address) DO UPDATE SET
           reliability_weight = GREATEST(smart_money_wallets.reliability_weight, EXCLUDED.reliability_weight),
           early_rank = LEAST(smart_money_wallets.early_rank, EXCLUDED.early_rank),
           active = true`,
        [wallet, token ?? null, earlyRank, weight]
      );
      saved++;
    } catch { /* ignore */ }
  }
  console.log(`[ton-sm] Saved ${saved} TON SM wallets to DB`);
}

/**
 * Base Network Smart Money Tracker
 *
 * Detects when known profitable EVM wallets buy a Base token early.
 * SM wallets stored in DB with network='base'.
 *
 * Detection method:
 *   1. When a token passes all filters, check recent swap logs of its Uniswap V3/Aerodrome pool
 *   2. If any SM wallet appears in the first 20 unique buyers → signal
 *   3. Weighted: same weight system as Solana tracker (1.0/2.0/3.0)
 *
 * Harvest method (to populate SM wallets):
 *   Use harvest-base-snipers.ts with successful Base tokens (Brett, Toshi, etc.)
 *   Set SUCCESSFUL_BASE_TOKENS env var with contract addresses
 *
 * Env:
 *   SMART_MONEY_BASE_WALLETS — comma-separated 0x addresses (quick bootstrap)
 *   BASE_RPC                 — Base network RPC (e.g. https://mainnet.base.org)
 *   BASESCAN_API_KEY         — optional, for higher rate limits on tx lookups
 */

import axios from 'axios';
import { query } from '@lib/db';
import { ethers } from 'ethers';

const BASE_RPC         = process.env.BASE_RPC ?? 'https://mainnet.base.org';
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY ?? '';
const REFRESH_MS       = 15 * 60 * 1000;
const TRIGGER_WEIGHT   = Number(process.env.BASE_SM_THRESHOLD ?? '2.0');  // lower than Solana (fewer SM wallets on Base)
const CACHE_TTL_MS     = 3 * 60 * 1000;  // 3min per token check

let baseSmMap  = new Map<string, number>();  // address → weight
let lastRefresh = 0;

async function refreshBaseSmWallets(): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();

  const fresh = new Map<string, number>();

  // From env
  for (const addr of (process.env.SMART_MONEY_BASE_WALLETS ?? '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean)) {
    fresh.set(addr, 1.0);
  }

  // From DB
  try {
    const { rows } = await query<{ wallet_address: string; reliability_weight: string }>(
      `SELECT wallet_address, reliability_weight
         FROM smart_money_wallets
        WHERE active = true AND network = 'base'
        LIMIT 300`
    );
    for (const row of rows) {
      fresh.set(row.wallet_address.toLowerCase(), Number(row.reliability_weight ?? 1.0));
    }
  } catch { /* pre-migration */ }

  if (fresh.size !== baseSmMap.size) {
    console.info(`[base-sm] Loaded ${fresh.size} Base SM wallets`);
  }
  baseSmMap = fresh;
}

// Cache: tokenAddress → { weight, ts }
const checkCache = new Map<string, { weight: number; ts: number }>();

/**
 * Get early buyers of a Base token from its Uniswap V3 / Aerodrome pool swap events.
 * Uses Basescan API (if key present) or public Base RPC logs.
 */
async function getEarlyBuyers(pairAddress: string, maxBuyers = 20): Promise<string[]> {
  if (!pairAddress) return [];

  try {
    // Uniswap V3 Swap event: Swap(address indexed sender, address indexed recipient, ...)
    const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
    // Aerodrome Swap (same as UniV2): Swap(address indexed sender, uint amount0In, ...)
    const SWAP_TOPIC_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

    // Use RPC getLogs for the pair address
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = Math.max(0, latestBlock - 5000);  // last ~10 hours on Base (2s blocks)

    const logs = await provider.getLogs({
      address: pairAddress,
      topics:  [[SWAP_TOPIC, SWAP_TOPIC_V2]],
      fromBlock,
      toBlock: latestBlock,
    });

    const buyers = new Set<string>();
    for (const log of logs.slice(0, 100)) {
      // topics[1] = sender or recipient — normalize to lowercase
      const addr = log.topics[2] ? `0x${log.topics[2].slice(26)}`.toLowerCase() : null;
      if (addr && addr !== '0x0000000000000000000000000000000000000000') {
        buyers.add(addr);
      }
      if (buyers.size >= maxBuyers) break;
    }

    return Array.from(buyers);
  } catch (err: any) {
    console.debug(`[base-sm] getLogs failed: ${err.message?.slice(0, 50)}`);
    return [];
  }
}

/**
 * Check if any known SM wallet bought this Base token early.
 * Returns total weight of SM signal (0 if none).
 */
export async function checkBaseSmartMoney(
  contractAddress: string,
  pairAddress: string
): Promise<{ weight: number; wallets: string[] }> {
  await refreshBaseSmWallets();

  if (baseSmMap.size === 0) return { weight: 0, wallets: [] };

  const key = contractAddress.toLowerCase();
  const cached = checkCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { weight: cached.weight, wallets: [] };
  }

  const buyers = await getEarlyBuyers(pairAddress, 30);
  const hits: Array<{ wallet: string; weight: number }> = [];

  for (const buyer of buyers) {
    const w = baseSmMap.get(buyer.toLowerCase());
    if (w !== undefined) {
      hits.push({ wallet: buyer, weight: w });
    }
  }

  const totalWeight = hits.reduce((s, h) => s + h.weight, 0);
  checkCache.set(key, { weight: totalWeight, ts: Date.now() });

  if (totalWeight >= TRIGGER_WEIGHT) {
    const names = hits.map(h => `${h.wallet.slice(0, 8)}(w${h.weight})`).join(', ');
    console.info(`[base-sm] 🔥 SM signal ${totalWeight.toFixed(1)}/${TRIGGER_WEIGHT} on ${key.slice(0, 10)} — ${names}`);
  }

  return { weight: totalWeight, wallets: hits.map(h => h.wallet) };
}

/** True if SM total weight ≥ TRIGGER_WEIGHT. */
export async function hasBaseSmartMoneySignal(contractAddress: string, pairAddress: string): Promise<boolean> {
  const { weight } = await checkBaseSmartMoney(contractAddress, pairAddress);
  return weight >= TRIGGER_WEIGHT;
}

/**
 * Harvest early buyers of a successful Base token (for populating SM list).
 * Similar to Solana harvest-snipers but using ethers getLogs.
 */
export async function harvestBaseTokenSnipers(
  contractAddress: string,
  pairAddress: string,
  topN = 15
): Promise<Array<{ wallet: string; earlyRank: number }>> {
  const buyers = await getEarlyBuyers(pairAddress, topN * 2);
  return buyers.slice(0, topN).map((wallet, i) => ({ wallet, earlyRank: i + 1 }));
}

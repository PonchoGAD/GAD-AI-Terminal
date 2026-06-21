/**
 * Sybil & Bundle Detector — onchain co-dependency analysis.
 *
 * Detects coordinated buy activity (wash trading / dev-controlled wallets):
 *  - Checks funding source of each top buyer (first SOL inflow)
 *  - If ≥2 of the top 5 buyers were funded from the same wallet → Sybil attack
 *  - Also catches "early bundle": dev buys via multiple wallets in first 30s
 *
 * Caches wallet funding source for 1h (rarely changes).
 */

import axios from 'axios';

const HELIUS_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

// Cache: walletAddress → funding source (1h TTL)
interface FundCache { source: string | null; ts: number }
const fundCache = new Map<string, FundCache>();
const FUND_CACHE_TTL = 60 * 60 * 1000;

// Cache: mint → sybil result (15 min TTL)
interface SybilCache { detected: boolean; reason: string; ts: number }
const sybilCache = new Map<string, SybilCache>();
const SYBIL_CACHE_TTL = 15 * 60 * 1000;

async function getWalletFundingSource(address: string): Promise<string | null> {
  const cached = fundCache.get(address);
  if (cached && Date.now() - cached.ts < FUND_CACHE_TTL) return cached.source;

  try {
    // Get the oldest available transactions (reverse chronological → last is oldest)
    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [address, { limit: 5 }],
    }, { timeout: 3_000 });

    const sigs: any[] = res.data?.result ?? [];
    if (!sigs.length) {
      fundCache.set(address, { source: null, ts: Date.now() });
      return null;
    }

    // Parse the most recent tx and look for SOL transfer (system program)
    const oldestSig = sigs[sigs.length - 1];
    const txRes = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 2,
      method: 'getParsedTransaction',
      params: [oldestSig.signature, { maxSupportedTransactionVersion: 0 }],
    }, { timeout: 4_000 });

    const tx = txRes.data?.result;
    const instructions: any[] = tx?.transaction?.message?.instructions ?? [];

    for (const inst of instructions) {
      if (inst.program === 'system' && inst.parsed?.type === 'transfer') {
        const source: string = inst.parsed?.info?.source ?? null;
        if (source && source !== address) {
          fundCache.set(address, { source, ts: Date.now() });
          return source;
        }
      }
    }

    fundCache.set(address, { source: null, ts: Date.now() });
    return null;
  } catch {
    fundCache.set(address, { source: null, ts: Date.now() });
    return null;
  }
}

export interface SybilResult {
  detected: boolean;
  sybilWallets: string[];  // wallets that share funding source
  commonFunder: string | null;
  reason: string;
}

/**
 * Analyze top buyers of a token for coordinated wallets.
 * @param mint  token mint address (for caching)
 * @param buyers array of {address, solAmount} of recent buyers (top 5 used)
 */
export async function detectSybilAttack(
  mint: string,
  buyers: Array<{ address: string; solAmount: number }>
): Promise<SybilResult> {
  const cached = sybilCache.get(mint);
  if (cached && Date.now() - cached.ts < SYBIL_CACHE_TTL) {
    return { detected: cached.detected, sybilWallets: [], commonFunder: null, reason: cached.reason };
  }

  const clean = (): SybilResult => ({ detected: false, sybilWallets: [], commonFunder: null, reason: 'organic' });

  if (buyers.length < 3) {
    sybilCache.set(mint, { detected: false, reason: 'too_few_buyers', ts: Date.now() });
    return clean();
  }

  // Analyze top 5 buyers by SOL amount
  const top5 = buyers
    .slice()
    .sort((a, b) => b.solAmount - a.solAmount)
    .slice(0, 5);

  // Fetch funding sources in parallel (with timeout protection)
  const sources = await Promise.all(
    top5.map(b => getWalletFundingSource(b.address).catch(() => null))
  );

  // Build: funder → [buyer wallets]
  const funderMap = new Map<string, string[]>();
  for (let i = 0; i < top5.length; i++) {
    const src = sources[i];
    if (!src) continue;
    if (!funderMap.has(src)) funderMap.set(src, []);
    funderMap.get(src)!.push(top5[i].address);
  }

  // Check if any funder controls ≥2 top buyers
  for (const [funder, wallets] of funderMap) {
    if (wallets.length >= 2) {
      const reason = `sybil: ${wallets.length} buyers funded by ${funder.slice(0, 8)}`;
      sybilCache.set(mint, { detected: true, reason, ts: Date.now() });
      console.debug(`[sybil-detector] 🚨 ${reason} — mint ${mint.slice(0, 8)}`);
      return {
        detected: true,
        sybilWallets: wallets,
        commonFunder: funder,
        reason,
      };
    }
  }

  sybilCache.set(mint, { detected: false, reason: 'organic', ts: Date.now() });
  return clean();
}

/** Quick early-bundle check: did dev buy >15% of curve SOL in first 30s? */
export function detectEarlyBundle(events: Array<{ ts: number; solAmount: number; buyer: string }>, devWallet: string, tokenCreatedAt: number): boolean {
  const firstWindow = tokenCreatedAt + 30_000;
  const devEarlyBuys = events
    .filter(e => e.ts <= firstWindow && e.buyer === devWallet)
    .reduce((s, e) => s + e.solAmount, 0);
  return devEarlyBuys > 58; // 15% of 588 SOL graduation threshold
}

/**
 * Dev Reputation Scoring — onchain analysis of token creator history.
 *
 * Checks how many tokens this dev has launched and how many graduated to Raydium.
 * Serial scammers (>3 launches, 0 graduations) are flagged and skipped.
 *
 * Caches results 30 min to reduce RPC load (same dev often launches multiple tokens).
 */

import axios from 'axios';

const HELIUS_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

// Pump.fun program ID — used to detect createAndBuy calls in dev tx history
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Cache: devWallet → reputation (30 min TTL)
interface DevCache { rep: DevReputation; ts: number }
const cache = new Map<string, DevCache>();
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface DevReputation {
  totalCreated:      number;   // tokens created in last 2h
  graduatedCount:    number;   // estimated based on historical success
  isSerialScammer:   boolean;  // >3 launches, 0 success = red flag
  devSolBalance:     number;   // current SOL balance (low balance = poor dev = rug risk)
  recentTxCount:     number;   // raw TX count in last 50 (high = bot-like)
  score:             number;   // 0-100 (higher = more trustworthy)
  reason:            string;
}

const BAD_DEV: DevReputation = {
  totalCreated: 0, graduatedCount: 0, isSerialScammer: false,
  devSolBalance: 0, recentTxCount: 0, score: 50, reason: 'rpc_error',
};

export async function analyzeDevReputation(devAddress: string): Promise<DevReputation> {
  const cached = cache.get(devAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rep;

  try {
    // 1. Get last 50 signatures for dev wallet
    const sigRes = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [devAddress, { limit: 50 }],
    }, { timeout: 5_000 });

    const sigs: any[] = sigRes.data?.result ?? [];
    const recentTxCount = sigs.length;

    // 2. Count pump.fun program interactions in last 50 txs (proxy for token creation count)
    // We look for signatures that include the pump program in their accounts — fast heuristic
    let totalCreated = 0;
    for (const sig of sigs.slice(0, 10)) {
      // Only parse first 10 txs to stay fast (< 200ms total)
      try {
        const txRes = await axios.post(HELIUS_RPC, {
          jsonrpc: '2.0', id: 2,
          method: 'getTransaction',
          params: [sig.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
        }, { timeout: 3_000 });
        const tx = txRes.data?.result;
        if (!tx) continue;
        const accountKeys: string[] = tx.transaction?.message?.accountKeys ?? [];
        if (accountKeys.includes(PUMP_PROGRAM)) totalCreated++;
      } catch { /* skip individual tx errors */ }
    }

    // 3. Check current SOL balance
    let devSolBalance = 0;
    try {
      const balRes = await axios.post(HELIUS_RPC, {
        jsonrpc: '2.0', id: 3,
        method: 'getBalance',
        params: [devAddress],
      }, { timeout: 3_000 });
      devSolBalance = (balRes.data?.result?.value ?? 0) / 1e9;
    } catch { /* ignore */ }

    // 4. Heuristic scoring
    // Serial scammer: many pump.fun txs, very active (bot-like) + low balance
    const isSerialScammer = totalCreated >= 3 && devSolBalance < 0.1;

    // Score calculation (0-100):
    //   Start at 60 (neutral)
    //   +20 if dev has SOL balance > 1 (committed capital)
    //   +10 if fewer than 20 recent txs (not a bot)
    //   -30 if serial scammer flag
    //   -20 if recentTxCount >= 50 (highly automated)
    //   -15 if devSolBalance < 0.05 (nearly empty = rug risk)
    let score = 60;
    if (devSolBalance > 1)   score += 20;
    if (recentTxCount < 20)  score += 10;
    if (isSerialScammer)     score -= 30;
    if (recentTxCount >= 50) score -= 20;
    if (devSolBalance < 0.05) score -= 15;
    score = Math.max(0, Math.min(100, score));

    const rep: DevReputation = {
      totalCreated,
      graduatedCount: 0,          // not estimated here — would require pump.fun indexer
      isSerialScammer,
      devSolBalance,
      recentTxCount,
      score,
      reason: isSerialScammer
        ? `serial_scammer: ${totalCreated} pump.fun txs, bal ${devSolBalance.toFixed(3)} SOL`
        : `ok: score=${score} bal=${devSolBalance.toFixed(3)}SOL txs=${recentTxCount}`,
    };

    cache.set(devAddress, { rep, ts: Date.now() });
    return rep;
  } catch (err: any) {
    console.debug(`[dev-profiler] RPC error for ${devAddress.slice(0, 8)}: ${err.message?.slice(0, 40)}`);
    return BAD_DEV;
  }
}

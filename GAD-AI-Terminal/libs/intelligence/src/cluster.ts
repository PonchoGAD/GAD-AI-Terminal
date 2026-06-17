import axios from 'axios';
import type { ClusterResult } from './types';

const clusterCache = new Map<string, { data: ClusterResult; expires: number }>();

export async function detectClusters(
  mint: string,
  heliusApiKey: string,
): Promise<ClusterResult> {
  const cached = clusterCache.get(mint);
  if (cached && Date.now() < cached.expires) return cached.data;

  try {
    // Fetch recent token transfers to find buyer wallets
    const res = await axios.post(
      `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${heliusApiKey}&type=TRANSFER&limit=50`,
      {},
      { timeout: 8000 }
    );

    const txs: any[] = res.data ?? [];
    const buyers: string[] = [];
    const fundingWallets: string[] = [];
    const timestamps: number[] = [];

    for (const tx of txs) {
      for (const t of tx.tokenTransfers ?? []) {
        if (t.mint === mint && t.toUserAccount) {
          buyers.push(t.toUserAccount);
          timestamps.push(tx.timestamp ?? 0);
        }
      }
      for (const nt of tx.nativeTransfers ?? []) {
        if (nt.toUserAccount && buyers.includes(nt.fromUserAccount ?? '')) {
          fundingWallets.push(nt.fromUserAccount);
        }
      }
    }

    const patterns: string[] = [];
    let bundledWallets = 0;
    let coordinatedBuyPct = 0;

    // Check for same-funder pattern
    const funderCounts: Record<string, number> = {};
    for (const fw of fundingWallets) {
      funderCounts[fw] = (funderCounts[fw] ?? 0) + 1;
    }
    const suspiciousFunders = Object.values(funderCounts).filter(c => c >= 3).length;
    if (suspiciousFunders > 0) {
      patterns.push('SAME_FUNDER');
      bundledWallets += suspiciousFunders * 3;
    }

    // Check for same-timing pattern (multiple buys within 5 seconds)
    const sortedTs = [...timestamps].sort((a, b) => a - b);
    let timingClusters = 0;
    for (let i = 0; i < sortedTs.length - 2; i++) {
      if (sortedTs[i + 2] - sortedTs[i] < 5) timingClusters++;
    }
    if (timingClusters >= 3) {
      patterns.push('SAME_TIMING');
      bundledWallets += timingClusters;
    }

    // Estimate coordinated buy %
    if (buyers.length > 0) {
      coordinatedBuyPct = Math.min(100, Math.round((bundledWallets / buyers.length) * 100));
    }

    const clusterRisk: ClusterResult['clusterRisk'] =
      bundledWallets >= 20 || coordinatedBuyPct >= 60 ? 'HIGH' :
      bundledWallets >= 10 || coordinatedBuyPct >= 30 ? 'MEDIUM' :
      bundledWallets >= 3  || coordinatedBuyPct >= 10 ? 'LOW' : 'NONE';

    const result: ClusterResult = { bundledWallets, clusterRisk, coordinatedBuyPct, patterns };
    clusterCache.set(mint, { data: result, expires: Date.now() + 300_000 });
    return result;
  } catch {
    return { bundledWallets: 0, clusterRisk: 'NONE', coordinatedBuyPct: 0, patterns: [] };
  }
}

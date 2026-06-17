import axios from 'axios';
import type { DevIntelligence } from './types';

const HELIUS_BASE = 'https://mainnet.helius-rpc.com';

// Cache dev wallet results for 5 min
const cache = new Map<string, { data: DevIntelligence; expires: number }>();

export async function analyzeDevBehavior(
  mint: string,
  devWallet: string,
  heliusApiKey: string,
): Promise<DevIntelligence> {
  if (!devWallet) {
    return {
      devWallet: '', devHolding: false, devSoldPct: 0,
      devInitialBuySol: 0, devTransferCount: 0,
      devConviction: 'UNKNOWN', riskFlag: false,
    };
  }

  const cacheKey = `${mint}:${devWallet}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.data;

  try {
    // Fetch recent transactions for dev wallet related to this mint
    const res = await axios.post(
      `${HELIUS_BASE}/?api-key=${heliusApiKey}`,
      {
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [devWallet, { limit: 50 }],
      },
      { timeout: 8000 }
    );

    const sigs: string[] = (res.data?.result ?? []).map((s: any) => s.signature);

    // Fetch parsed transactions to find token transfers
    let devSoldPct = 0;
    let devTransferCount = 0;
    let devInitialBuySol = 0;

    if (sigs.length > 0) {
      const txRes = await axios.post(
        `https://api.helius.xyz/v0/transactions?api-key=${heliusApiKey}`,
        { transactions: sigs.slice(0, 20) },
        { timeout: 10000 }
      );

      const txs: any[] = txRes.data ?? [];
      for (const tx of txs) {
        const transfers: any[] = tx.tokenTransfers ?? [];
        for (const t of transfers) {
          if (t.mint !== mint) continue;
          if (t.fromUserAccount === devWallet) devTransferCount++;
          if (t.toUserAccount === devWallet && devInitialBuySol === 0) {
            devInitialBuySol = t.tokenAmount ?? 0;
          }
        }
        // Estimate sol spent in native transfers
        const nativeTransfers: any[] = tx.nativeTransfers ?? [];
        for (const nt of nativeTransfers) {
          if (nt.fromUserAccount === devWallet && devInitialBuySol === 0) {
            devInitialBuySol = (nt.amount ?? 0) / 1e9;
          }
        }
      }

      // Rough sold % estimate from transfer count vs initial amount
      devSoldPct = Math.min(100, devTransferCount > 0 ? devTransferCount * 20 : 0);
    }

    const devHolding = devSoldPct < 80;
    const devConviction: DevIntelligence['devConviction'] =
      devSoldPct === 0   ? 'HOLDING' :
      devSoldPct < 30    ? 'HOLDING' :
      devSoldPct < 70    ? 'PARTIAL_SELL' :
      devSoldPct < 100   ? 'PARTIAL_SELL' : 'DUMPED';

    const result: DevIntelligence = {
      devWallet, devHolding, devSoldPct,
      devInitialBuySol, devTransferCount,
      devConviction,
      riskFlag: devSoldPct >= 50,
    };

    cache.set(cacheKey, { data: result, expires: Date.now() + 300_000 });
    return result;
  } catch {
    return {
      devWallet, devHolding: true, devSoldPct: 0,
      devInitialBuySol: 0, devTransferCount: 0,
      devConviction: 'UNKNOWN', riskFlag: false,
    };
  }
}

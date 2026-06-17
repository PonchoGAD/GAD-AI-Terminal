import axios from 'axios';
import type { HolderVelocity } from './types';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// Stores holder counts over time per mint (in-memory, refreshed hourly)
const holderHistory = new Map<string, Array<{ ts: number; count: number }>>();

export function recordHolderCount(mint: string, count: number): void {
  const history = holderHistory.get(mint) ?? [];
  history.push({ ts: Date.now(), count });
  // Keep last 2 hours of data
  const cutoff = Date.now() - 2 * 3600_000;
  holderHistory.set(mint, history.filter(h => h.ts > cutoff));
}

export async function fetchHolderCount(mint: string, apiKey: string): Promise<number> {
  try {
    const r = await axios.get(`${BIRDEYE_BASE}/defi/v3/token/holder`, {
      params: { address: mint, offset: 0, limit: 1 },
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
      timeout: 5000,
    });
    return r.data?.data?.total ?? 0;
  } catch { return 0; }
}

export function calculateHolderVelocity(mint: string, currentCount: number): HolderVelocity {
  const history = holderHistory.get(mint) ?? [];
  const now = Date.now();

  const at = (msAgo: number) => {
    const target = now - msAgo;
    const closest = history
      .filter(h => h.ts <= target + 30_000)
      .sort((a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target))[0];
    return closest?.count ?? currentCount;
  };

  const count5m  = at(5 * 60_000);
  const count15m = at(15 * 60_000);
  const count1h  = at(60 * 60_000);

  const per5m  = Math.max(0, currentCount - count5m);
  const per15m = Math.max(0, currentCount - count15m);
  const per1h  = Math.max(0, currentCount - count1h);

  // Score: 20+ new holders/5min = 100
  const velocityScore = Math.min(100, Math.round(
    (per5m / 20) * 40 +
    (per15m / 50) * 30 +
    (per1h / 150) * 30
  ));

  return { per5m, per15m, per1h, velocityScore };
}

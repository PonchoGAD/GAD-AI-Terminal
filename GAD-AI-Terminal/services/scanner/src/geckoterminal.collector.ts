/**
 * GeckoTerminal Collector
 * Free public API — no auth, no IP blocks, supports VPS.
 * Docs: https://www.geckoterminal.com/dex-api
 * Rate limit: ~30 req/min
 */

import { fetchJson, retry, buildDefaultMetrics, TokenMetricsPayload } from './scanner';

const BASE = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { 'Accept': 'application/json;version=20230302' };

interface GeckoPool {
  id: string;
  attributes: {
    base_token_price_usd?: string;
    volume_usd?: { h1?: string; h24?: string; h6?: string };
    price_change_percentage?: { h1?: string; h24?: string; h6?: string };
    transactions?: { h1?: { buys?: number; sells?: number } };
    reserve_in_usd?: string;
    market_cap_usd?: string | null;
    pool_created_at?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
  };
}

interface GeckoResponse {
  data?: GeckoPool[];
}

function extractMint(pool: GeckoPool): string | null {
  // id format: "solana_MINTADDRESS"
  const tokenId = pool.relationships?.base_token?.data?.id ?? '';
  const parts = tokenId.split('_');
  return parts.length === 2 ? parts[1] : null;
}

/** Returns mint addresses of trending Solana tokens from GeckoTerminal */
export async function discoverGeckoTerminalTokens(): Promise<string[]> {
  const [trending, newPools, raydiumPools] = await Promise.allSettled([
    retry(() => fetchJson<GeckoResponse>(
      `${BASE}/networks/solana/trending_pools?page=1`,
      { headers: HEADERS }
    )),
    retry(() => fetchJson<GeckoResponse>(
      `${BASE}/networks/solana/new_pools?page=1`,
      { headers: HEADERS }
    )),
    // Raydium pools specifically — these are already graduated from pump.fun
    retry(() => fetchJson<GeckoResponse>(
      `${BASE}/networks/solana/dexes/raydium/pools?sort=h24_volume_percent_change_desc&page=1`,
      { headers: HEADERS }
    ))
  ]);

  const mints = new Set<string>();

  if (trending.status === 'fulfilled') {
    for (const pool of trending.value?.data ?? []) {
      const mint = extractMint(pool);
      if (mint) mints.add(mint);
    }
  }
  if (newPools.status === 'fulfilled') {
    for (const pool of newPools.value?.data ?? []) {
      const mint = extractMint(pool);
      if (mint) mints.add(mint);
    }
  }
  if (raydiumPools.status === 'fulfilled') {
    for (const pool of raydiumPools.value?.data ?? []) {
      const mint = extractMint(pool);
      if (mint) mints.add(mint);
    }
  }

  const result = [...mints].slice(0, 80);
  console.info(`[geckoterminal] Discovered ${result.length} tokens`);
  return result;
}

/** Fetch token metrics from GeckoTerminal */
export async function fetchGeckoTerminalMetrics(mintAddress: string): Promise<TokenMetricsPayload> {
  try {
    const res = await retry(() =>
      fetchJson<GeckoResponse>(
        `${BASE}/networks/solana/tokens/${mintAddress}/pools?page=1`,
        { headers: HEADERS }
      )
    );

    const pools = res?.data ?? [];
    if (!pools.length) return buildDefaultMetrics();

    // Pick best pool by 24h volume
    const best = pools.sort((a, b) => {
      const va = Number(a.attributes.volume_usd?.h24 ?? 0);
      const vb = Number(b.attributes.volume_usd?.h24 ?? 0);
      return vb - va;
    })[0];

    const attr = best.attributes;
    const txH1 = attr.transactions?.h1;

    return {
      volume_5m:        0,
      volume_1h:        Number(attr.volume_usd?.h1  ?? 0),
      volume_24h:       Number(attr.volume_usd?.h24 ?? 0),
      tx_count_5m:      0,
      tx_count_1h:      (txH1?.buys ?? 0) + (txH1?.sells ?? 0),
      tx_count_24h:     0,
      liquidity_change: 0,
      price_change_1h:  Number(attr.price_change_percentage?.h1  ?? 0),
      price_change_24h: Number(attr.price_change_percentage?.h24 ?? 0),
    };
  } catch {
    return buildDefaultMetrics();
  }
}

import axios from 'axios';

export interface TonToken {
  jetton_address: string;
  pool_address:   string;
  symbol:         string;
  name:           string;
  dex:            string;
  liquidity_usd:  number;
  volume_1h:      number;
  volume_24h:     number;
  price_change_1h: number;
  price_change_5m: number;
  price_ton:      number;
  mcap_usd:       number;
  age_sec:        number;
  txns_h1_buys:   number;
  buy_sell_ratio: number;
}

// ─── GeckoTerminal ────────────────────────────────────────────────────────────
async function fetchGeckoTerminal(): Promise<TonToken[]> {
  const tokens: TonToken[] = [];
  try {
    const r = await axios.get(
      'https://api.geckoterminal.com/api/v2/networks/ton/new_pools?include=base_token&page=1',
      { timeout: 10000 }
    );
    const pools: any[] = r.data?.data ?? [];

    for (const pool of pools) {
      try {
        const attr = pool.attributes ?? {};
        const liq  = Number(attr.reserve_in_usd ?? 0);
        if (liq < 500) continue;

        const createdAt = attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : Date.now();
        const age_sec   = Math.floor((Date.now() - createdAt) / 1000);

        const pc1h = Number(attr.price_change_percentage?.h1 ?? 0);
        const pc5m = Number(attr.price_change_percentage?.m5 ?? 0);
        const vol1h  = Number(attr.volume_usd?.h1  ?? 0);
        const vol24h = Number(attr.volume_usd?.h24 ?? 0);
        const buys1h = Number(attr.transactions?.h1?.buys  ?? 0);
        const sells1h = Number(attr.transactions?.h1?.sells ?? 1);
        const bsRatio = buys1h / Math.max(sells1h, 1);
        const priceTon = Number(attr.base_token_price_native_currency ?? 0);
        const mcap = Number(attr.market_cap_usd ?? attr.fdv_usd ?? 0);

        // Extract jetton address from relationships
        const baseToken = pool.relationships?.base_token?.data;
        const jettonAddress = baseToken?.id?.replace('ton_', '') ?? '';
        if (!jettonAddress || jettonAddress.length < 10) continue;

        const poolAddress = attr.address ?? pool.id?.replace('ton_', '') ?? '';

        tokens.push({
          jetton_address:  jettonAddress,
          pool_address:    poolAddress,
          symbol:          attr.name?.split(' / ')?.[0] ?? '???',
          name:            attr.name ?? '',
          dex:             attr.dex_id ?? 'stonfi',
          liquidity_usd:   liq,
          volume_1h:       vol1h,
          volume_24h:      vol24h,
          price_change_1h: pc1h,
          price_change_5m: pc5m,
          price_ton:       priceTon,
          mcap_usd:        mcap,
          age_sec,
          txns_h1_buys:    buys1h,
          buy_sell_ratio:  bsRatio,
        });
      } catch { continue; }
    }
  } catch { /* network error */ }
  return tokens;
}

// ─── DexScreener TON ──────────────────────────────────────────────────────────
async function fetchDexScreenerTon(): Promise<TonToken[]> {
  const tokens: TonToken[] = [];
  const queries = [
    'ton meme', 'ton dog', 'ton pepe', 'ton ai', 'ton cat',
    'ton token', 'ton new', 'ton coin', 'toncoin gem',
  ];

  for (const q of queries) {
    try {
      const r = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { timeout: 6000 }
      );
      const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'ton');
      for (const p of pairs) {
        const liq = Number(p.liquidity?.usd ?? 0);
        if (liq < 500) continue;

        const createdAt = p.pairCreatedAt ? new Date(p.pairCreatedAt).getTime() : Date.now();
        const age_sec   = Math.floor((Date.now() - createdAt) / 1000);

        const txns = p.txns?.h1 ?? {};
        const buys  = Number(txns.buys  ?? 0);
        const sells = Number(txns.sells ?? 1);

        tokens.push({
          jetton_address:  p.baseToken?.address ?? '',
          pool_address:    p.pairAddress ?? '',
          symbol:          p.baseToken?.symbol ?? '???',
          name:            p.baseToken?.name ?? '',
          dex:             p.dexId ?? 'stonfi',
          liquidity_usd:   liq,
          volume_1h:       Number(p.volume?.h1 ?? 0),
          volume_24h:      Number(p.volume?.h24 ?? 0),
          price_change_1h: Number(p.priceChange?.h1 ?? 0),
          price_change_5m: Number(p.priceChange?.m5 ?? 0),
          price_ton:       Number(p.priceNative ?? 0),
          mcap_usd:        Number(p.marketCap ?? p.fdv ?? 0),
          age_sec,
          txns_h1_buys:    buys,
          buy_sell_ratio:  buys / Math.max(sells, 1),
        });
      }
    } catch { continue; }
  }
  return tokens;
}

// Deduplicate by jetton_address, keep highest liquidity
function dedupe(tokens: TonToken[]): TonToken[] {
  const map = new Map<string, TonToken>();
  for (const t of tokens) {
    if (!t.jetton_address) continue;
    const existing = map.get(t.jetton_address);
    if (!existing || t.liquidity_usd > existing.liquidity_usd) {
      map.set(t.jetton_address, t);
    }
  }
  return [...map.values()];
}

export async function discoverTonTokens(): Promise<TonToken[]> {
  const [gecko, dex] = await Promise.allSettled([fetchGeckoTerminal(), fetchDexScreenerTon()]);
  const all: TonToken[] = [];
  if (gecko.status === 'fulfilled') all.push(...gecko.value);
  if (dex.status   === 'fulfilled') all.push(...dex.value);
  return dedupe(all);
}

// Get current price from DexScreener for a pool
export async function getPoolPrice(poolAddress: string): Promise<number | null> {
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/ton/${poolAddress}`,
      { timeout: 5000 }
    );
    const pair = r.data?.pair ?? r.data?.pairs?.[0];
    if (!pair) return null;
    return Number(pair.priceNative ?? 0) || null;
  } catch {
    return null;
  }
}

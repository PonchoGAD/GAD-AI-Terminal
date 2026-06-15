import axios from 'axios';
import { query } from '@lib/db';
import { checkTokenSafety } from '@lib/base';

// ─── Config ─────────────────────────────────────────────────────────────────
// Adapted from Raydium scanner thresholds (58% WR in FEAR market):
// - pc1h min 5% (Raydium: 5%), vol/liq 15% (Raydium: 15%), B/S ≤3.0 (Raydium: 3.5)
// - Age ≤6h: Base memes die fast — fresh entries outperform aged ones
// - Liq $10k-$200k: Base has less TVL than Solana, upper bound lower
const MIN_LIQ        = Number(process.env.BASE_MIN_LIQUIDITY_USD  || '10000');
const MAX_LIQ        = Number(process.env.BASE_MAX_LIQUIDITY_USD  || '200000');
const MIN_PC1H       = Number(process.env.BASE_MIN_PC1H           || '5');
const MAX_PC1H       = Number(process.env.BASE_MAX_PC1H           || '80');
// Fresh launches (< 1h) routinely spike 100-400% in the first hour — don't cap them
const MAX_PC1H_FRESH = Number(process.env.BASE_MAX_PC1H_FRESH     || '400');
const FRESH_AGE_SEC  = Number(process.env.BASE_FRESH_AGE_SEC      || '3600'); // 1h = "fresh launch"
const MIN_PC5M       = Number(process.env.BASE_MIN_PC5M           || '1');
const MIN_VOL_LIQ    = Number(process.env.BASE_MIN_VOL_LIQ_RATIO  || '0.15');
const MAX_BS_RATIO   = Number(process.env.BASE_MAX_BUY_SELL_RATIO  || '3.0');
const MAX_AGE_SEC    = Number(process.env.BASE_MAX_AGE_SEC        || '21600'); // 6h — Base memes move fast
const MIN_SAFE_SCORE = Number(process.env.BASE_MIN_SAFE_SCORE     || '35');
const MIN_BUYS_H1    = Number(process.env.BASE_MIN_BUYS_H1        || '5');    // min unique buys in last hour
const SCAN_INTERVAL = Number(process.env.BASE_SCAN_INTERVAL_SEC  || '30') * 1000;

export interface BaseToken {
  contract_address: string;
  symbol:           string;
  name:             string;
  pair_address:     string;
  dex_id:           string;
  liquidity_usd:    number;
  volume_1h:        number;
  volume_24h:       number;
  price_change_1h:  number;
  price_change_5m:  number;
  price_eth:        number;
  mcap_usd:         number;
  holders:          number;
  age_sec:          number;
  buy_sell_ratio:   number;
  txns_h1_buys:     number; // unique buy count in last 1h — filters dead/fake volume
  is_verified:      boolean;
  lp_locked:        boolean;
  safe_score:       number;
}

// ─── DexScreener ─────────────────────────────────────────────────────────────
async function fetchDexScreener(): Promise<BaseToken[]> {
  const tokens: BaseToken[] = [];
  const urls = [
    'https://api.dexscreener.com/token-profiles/latest/v1',
    'https://api.dexscreener.com/token-boosts/latest/v1',
  ];

  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 8000 });
      const items: any[] = Array.isArray(r.data) ? r.data : (r.data?.data ?? []);
      const baseItems = items.filter((x: any) => x.chainId === 'base');

      for (const item of baseItems) {
        const addr = item.tokenAddress || item.address;
        if (!addr) continue;
        const pair = await fetchPairData(addr);
        if (pair) tokens.push(pair);
      }
    } catch { continue; }
  }

  // Also search DexScreener directly for new Base pairs
  try {
    const searches = ['base meme', 'base new', 'base ai', 'base dog', 'base pepe'];
    for (const q of searches) {
      const r = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { timeout: 6000 });
      const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
      for (const p of pairs) {
        const token = mapDexPair(p);
        if (token) tokens.push(token);
      }
    }
  } catch { }

  return dedupeByAddress(tokens);
}

async function fetchPairData(tokenAddress: string): Promise<BaseToken | null> {
  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
    const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
    if (!pairs.length) return null;
    return mapDexPair(pairs[0]);
  } catch { return null; }
}

function mapDexPair(p: any): BaseToken | null {
  const addr = p.baseToken?.address;
  if (!addr) return null;
  const createdAt = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 1000 : 0;
  return {
    contract_address: addr.toLowerCase(),
    symbol:           p.baseToken?.symbol ?? '',
    name:             p.baseToken?.name ?? '',
    pair_address:     p.pairAddress ?? '',
    dex_id:           p.dexId ?? 'unknown',
    liquidity_usd:    Math.max(0, Number(p.liquidity?.usd ?? 0)),  // guard drained pools
    volume_1h:        Math.max(0, Number(p.volume?.h1 ?? 0)),
    volume_24h:       Math.max(0, Number(p.volume?.h24 ?? 0)),
    price_change_1h:  Number(p.priceChange?.h1 ?? 0),
    price_change_5m:  Number(p.priceChange?.m5 ?? 0),
    price_eth:        Number(p.priceNative ?? 0),
    mcap_usd:         Math.max(0, Number(p.marketCap ?? 0)),
    holders:          0,
    age_sec:          Math.max(0, createdAt),
    buy_sell_ratio:   Number(p.txns?.h1?.buys ?? 1) / Math.max(1, Number(p.txns?.h1?.sells ?? 1)),
    txns_h1_buys:     Number(p.txns?.h1?.buys ?? 0),
    is_verified:      false,
    lp_locked:        false,
    safe_score:       50,
  };
}

// ─── GeckoTerminal ───────────────────────────────────────────────────────────
async function fetchGeckoTerminal(): Promise<BaseToken[]> {
  const tokens: BaseToken[] = [];
  try {
    const r = await axios.get(
      'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=1',
      { timeout: 8000, headers: { Accept: 'application/json;version=20230302' } }
    );
    const pools: any[] = r.data?.data ?? [];
    for (const pool of pools) {
      const attrs = pool.attributes ?? {};
      const baseToken = pool.relationships?.base_token?.data?.id ?? '';
      const addr = baseToken.replace('base_', '');
      if (!addr) continue;
      const createdAt = attrs.pool_created_at ? (Date.now() - new Date(attrs.pool_created_at).getTime()) / 1000 : 0;
      tokens.push({
        contract_address: addr.toLowerCase(),
        symbol:           attrs.name?.split('/')[0] ?? '',
        name:             attrs.name ?? '',
        pair_address:     attrs.address ?? '',
        dex_id:           pool.relationships?.dex?.data?.id ?? 'unknown',
        liquidity_usd:    Math.max(0, Number(attrs.reserve_in_usd ?? 0)),
        volume_1h:        Math.max(0, Number(attrs.volume_usd?.h1 ?? 0)),
        volume_24h:       Math.max(0, Number(attrs.volume_usd?.h24 ?? 0)),
        price_change_1h:  Number(attrs.price_change_percentage?.h1 ?? 0),
        price_change_5m:  Number(attrs.price_change_percentage?.m5 ?? 0),
        price_eth:        Number(attrs.base_token_price_native_currency ?? 0),
        mcap_usd:         Math.max(0, Number(attrs.market_cap_usd ?? 0)),
        holders:          0,
        age_sec:          Math.max(0, createdAt),
        buy_sell_ratio:   Number(attrs.transactions?.h1?.buys ?? 1) / Math.max(1, Number(attrs.transactions?.h1?.sells ?? 1)),
        txns_h1_buys:     Number(attrs.transactions?.h1?.buys ?? 0),
        is_verified:      false,
        lp_locked:        false,
        safe_score:       50,
      });
    }
  } catch { }
  return tokens;
}

// DEX IDs we can actually trade on Base (V3 and Aerodrome V2 only)
// 'uniswap' = Uniswap V2 on Base — no V3 or Aerodrome pool → buy always fails → exclude
// 'uniswap-v4-base' = V4 not yet supported → exclude
// 'aerodrome-cl' = concentrated liquidity (different factory) → our router doesn't find pool → exclude
const TRADEABLE_DEX_IDS = new Set([
  'uniswap-v3', 'uniswap-v3-base', 'aerodrome-v2', 'aerodrome',
]);

// ─── Filter ──────────────────────────────────────────────────────────────────
function passesFilter(t: BaseToken): string | null {
  if (t.liquidity_usd < MIN_LIQ)            return `liq:$${t.liquidity_usd.toFixed(0)} < $${MIN_LIQ}`;
  if (t.liquidity_usd > MAX_LIQ)            return `liq:$${t.liquidity_usd.toFixed(0)} > $${MAX_LIQ}`;
  // Only allow DEX IDs we can actually trade (V3 + Aerodrome V2 only)
  // 'uniswap' = V2 (no V3/Aerodrome pool → buy always fails)
  // 'uniswap-v4*' = V4 (no router support)
  // 'aerodrome-cl' = concentrated liquidity (different factory, router fails)
  if (!TRADEABLE_DEX_IDS.has(t.dex_id)) {
    return `dex:${t.dex_id} (not supported)`;
  }
  if (t.price_change_1h < MIN_PC1H)         return `pc1h:${t.price_change_1h.toFixed(1)}% < ${MIN_PC1H}%`;
  // Fresh launches (< FRESH_AGE_SEC) use higher cap — first-hour spikes are normal on Base
  const maxPc1h = t.age_sec < FRESH_AGE_SEC ? MAX_PC1H_FRESH : MAX_PC1H;
  if (t.price_change_1h > maxPc1h)          return `pc1h:${t.price_change_1h.toFixed(1)}% > ${maxPc1h}% (age:${(t.age_sec/60).toFixed(0)}min)`;
  if (t.price_change_5m < MIN_PC5M)         return `pc5m:${t.price_change_5m.toFixed(1)}% < ${MIN_PC5M}%`;
  if (t.volume_1h / Math.max(1, t.liquidity_usd) < MIN_VOL_LIQ) return `vol/liq:${(t.volume_1h / Math.max(1, t.liquidity_usd) * 100).toFixed(0)}% < ${MIN_VOL_LIQ * 100}%`;
  if (t.buy_sell_ratio > MAX_BS_RATIO)      return `bs:${t.buy_sell_ratio.toFixed(1)} > ${MAX_BS_RATIO}`;
  if (t.txns_h1_buys < MIN_BUYS_H1)        return `buys1h:${t.txns_h1_buys} < ${MIN_BUYS_H1}`;
  if (t.age_sec > MAX_AGE_SEC)              return `age:${(t.age_sec / 3600).toFixed(1)}h > ${MAX_AGE_SEC / 3600}h`;
  if (t.safe_score < MIN_SAFE_SCORE)        return `score:${t.safe_score} < ${MIN_SAFE_SCORE}`;
  return null;
}

// ─── Main scan cycle ─────────────────────────────────────────────────────────
const recentScanned = new Set<string>();

export async function runScanCycle(): Promise<BaseToken[]> {
  const [dex, gecko] = await Promise.all([fetchDexScreener(), fetchGeckoTerminal()]);
  const all = dedupeByAddress([...dex, ...gecko]);

  console.info(`[base-scan] ${all.length} candidates from ${dex.length} DexScreener + ${gecko.length} Gecko`);

  const passed: BaseToken[] = [];

  for (const token of all) {
    const reason = passesFilter(token);
    if (reason) {
      console.debug(`[base-scan] ✗ ${token.symbol} ${reason}`);
      continue;
    }
    if (recentScanned.has(token.contract_address)) continue;

    // Run safety check (async, non-blocking for speed — update token after)
    const safety = await checkTokenSafety(token.contract_address).catch(() => null);
    if (safety) {
      token.is_verified = safety.is_verified;
      token.lp_locked   = safety.lp_locked;
      token.safe_score  = safety.safe_score;
    }

    const postReason = passesFilter(token);
    if (postReason) {
      console.debug(`[base-scan] ✗ ${token.symbol} (post-safety) ${postReason}`);
      continue;
    }

    // Upsert to DB
    await upsertBaseToken(token);
    recentScanned.add(token.contract_address);
    passed.push(token);
    console.info(`[base-scan] ✅ ${token.symbol} liq:$${token.liquidity_usd.toFixed(0)} pc1h:${token.price_change_1h.toFixed(1)}% score:${token.safe_score}`);
  }

  return passed;
}

async function upsertBaseToken(t: BaseToken): Promise<void> {
  await query(
    `INSERT INTO base_tokens (contract_address, symbol, name, liquidity_usd, volume_1h, volume_24h,
       price_change_1h, price_change_5m, holders, is_verified, lp_locked, safe_score, dex_id, pair_address, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     ON CONFLICT (contract_address) DO UPDATE SET
       symbol=EXCLUDED.symbol, liquidity_usd=EXCLUDED.liquidity_usd, volume_1h=EXCLUDED.volume_1h,
       price_change_1h=EXCLUDED.price_change_1h, price_change_5m=EXCLUDED.price_change_5m,
       safe_score=EXCLUDED.safe_score, last_seen=NOW()`,
    [t.contract_address, t.symbol, t.name, t.liquidity_usd, t.volume_1h, t.volume_24h,
     t.price_change_1h, t.price_change_5m, t.holders, t.is_verified, t.lp_locked, t.safe_score, t.dex_id, t.pair_address]
  );
}

function dedupeByAddress(tokens: BaseToken[]): BaseToken[] {
  const seen = new Map<string, BaseToken>();
  for (const t of tokens) {
    const existing = seen.get(t.contract_address);
    if (!existing || t.liquidity_usd > existing.liquidity_usd) seen.set(t.contract_address, t);
  }
  return [...seen.values()];
}

export function startScanner(): void {
  console.info(`[base-scan] Starting — interval ${SCAN_INTERVAL / 1000}s | liq $${MIN_LIQ}-$${MAX_LIQ} | pc1h ${MIN_PC1H}-${MAX_PC1H}%`);
  runScanCycle().catch(console.error);
  setInterval(() => runScanCycle().catch(console.error), SCAN_INTERVAL);
}

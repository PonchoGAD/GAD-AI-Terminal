import axios from 'axios';
import { query } from '@lib/db';
import { checkTokenSafety, checkBaseSmartMoney } from '@lib/base';
import { checkLaunchpadOrigin } from './launcher-filter';
import { isBaseTokenImpersonator } from './impersonator-guard';

// ─── Inline impersonator guard ───────────────────────────────────────────────
// Blocks cross-chain scam tokens (cbADA, cbXRP, fake SOL, BNB, etc.)
// Inlined here because impersonator-guard.ts was not compiled into the original
// Docker image — this ensures the guard always ships with scanner.js.
const _EXACT_BLOCK = new Set([
  'SOL','BNB','ADA','XRP','AVAX','MATIC','DOT','TRX','NEAR','SUI',
  'ATOM','FTM','XLM','ALGO','EGLD','BTC','ETH',
  'WBTC','BITCOIN','ETHEREUM','WSOL','WBNB','WXRP','WADA','WFTM',
  'STETH','STSOL','CBETH','CBBTC','CBSOL',
  'CHAINLINK','UNISWAP','AAVE','MAKER',
]);
function isChainImpersonator(symbol: string): boolean {
  const up = symbol.toUpperCase().trim();
  const cbPrefix = up.startsWith('CB') && up.length >= 4;
  const wPrefix  = up.startsWith('W')  && up.length >= 4 && up.length <= 7;
  return _EXACT_BLOCK.has(up) || cbPrefix || (wPrefix && _EXACT_BLOCK.has(up.slice(1)));
}

// ─── Config ─────────────────────────────────────────────────────────────────
// Target: Base meme coins — new launches, tiny mcap, high momentum.
// Key insight: SOL/ADA/XRP/cbXRP scam tokens have $10M-$300B mcap.
// Real meme coins: mcap $5k-$2M. One mcap cap prevents ALL established-token buys.
const MIN_LIQ        = Number(process.env.BASE_MIN_LIQUIDITY_USD  || '5000');
const MAX_LIQ        = Number(process.env.BASE_MAX_LIQUIDITY_USD  || '200000');
const MIN_MCAP       = Number(process.env.BASE_MIN_MCAP_USD       || '1000');    // skip dead/empty tokens
const MAX_MCAP       = Number(process.env.BASE_MAX_MCAP_USD       || '2000000'); // $2M max — memes only
const MIN_PC1H       = Number(process.env.BASE_MIN_PC1H           || '5');
const MAX_PC1H       = Number(process.env.BASE_MAX_PC1H           || '30'); // 23.06.26: 100→30 (B20: +55%→-47%)
// Fresh launches (< 1h) routinely spike 100-400% in the first hour — don't cap them
const MAX_PC1H_FRESH = Number(process.env.BASE_MAX_PC1H_FRESH     || '1000');
const FRESH_AGE_SEC  = Number(process.env.BASE_FRESH_AGE_SEC      || '3600');
const MIN_PC5M       = Number(process.env.BASE_MIN_PC5M           || '1');
const MIN_VOL_LIQ    = Number(process.env.BASE_MIN_VOL_LIQ_RATIO  || '0.10');
const MAX_BS_RATIO   = Number(process.env.BASE_MAX_BUY_SELL_RATIO  || '4.0');
const MAX_AGE_SEC    = Number(process.env.BASE_MAX_AGE_SEC        || '172800'); // 48h default — mcap cap ($2M) prevents old token buys
const MIN_AGE_SEC    = Number(process.env.BASE_MIN_AGE_SEC        || '120');   // 2min min — avoid honeypot traps
const MIN_SAFE_SCORE = Number(process.env.BASE_MIN_SAFE_SCORE     || '30');
const MIN_BUYS_H1    = Number(process.env.BASE_MIN_BUYS_H1        || '5');
const SCAN_INTERVAL  = Number(process.env.BASE_SCAN_INTERVAL_SEC  || '30') * 1000;

const BASE_REQUIRE_SM = process.env.BASE_REQUIRE_SM_SIGNAL === 'true';

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
  volume_5m?:       number; // 5-min volume (not always available from DexScreener)
  is_verified:      boolean;
  lp_locked:        boolean;
  safe_score:       number;
  sm_weight:        number;  // smart money signal weight (0 = no signal)
  sm_wallets:       string[]; // SM wallets that bought this token
}

// ─── DexScreener ─────────────────────────────────────────────────────────────
// IMPORTANT: Do NOT use token-profiles or token-boosts endpoints — those return
// ANY established token on Base (cbADA, SOL impersonators, etc.) which are not memes.
// Use only new-pairs and trending-small-cap sources.
async function fetchDexScreener(): Promise<BaseToken[]> {
  const tokens: BaseToken[] = [];

  // Source 0: DexScreener token-profiles/latest — newly listed tokens (freshest)
  try {
    const r = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 8000 });
    const profiles: any[] = r.data ?? [];
    const baseProfiles = profiles.filter((p: any) => p.chainId === 'base');
    for (const profile of baseProfiles) {
      if (!profile.tokenAddress) continue;
      try {
        const pr = await axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${profile.tokenAddress}`,
          { timeout: 5000 },
        );
        const pairs: any[] = (pr.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
        for (const p of pairs) {
          const token = mapDexPair(p);
          if (token) tokens.push(token);
        }
      } catch { }
    }
  } catch { }

  // Source 1: DexScreener trending Base pairs — small cap, high momentum memes
  try {
    const r = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=base%20meme%20new',
      { timeout: 8000 },
    );
    const pairs: any[] = (r.data?.pairs ?? [])
      .filter((p: any) => p.chainId === 'base')
      .sort((a: any, b: any) => (b.priceChange?.h1 ?? 0) - (a.priceChange?.h1 ?? 0));
    for (const p of pairs) {
      const token = mapDexPair(p);
      if (token) tokens.push(token);
    }
  } catch { }

  // Source 2: Keyword searches for Base meme launches
  const searches = ['base meme launch', 'base pump fun', 'base coin new', 'base pepe', 'base ai agent', 'clanker new'];
  for (const q of searches) {
    try {
      const r = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { timeout: 6000 },
      );
      const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
      for (const p of pairs) {
        const token = mapDexPair(p);
        if (token) tokens.push(token);
      }
    } catch { }
  }

  // Source 3: Clanker launchpad tokens (viral memes on Farcaster/Base)
  // Clanker is the dominant meme launchpad on Base — tokens here are genuine community memes
  try {
    const r = await axios.get('https://api.dexscreener.com/latest/dex/search?q=clanker', { timeout: 6000 });
    const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
    for (const p of pairs) {
      const token = mapDexPair(p);
      if (token) { (token as any)._hintLaunchpad = 'clanker'; tokens.push(token); }
    }
  } catch { }

  // Source 4: Virtual.tech AI agent tokens on Base
  try {
    const r = await axios.get('https://api.dexscreener.com/latest/dex/search?q=virtual+base+agent', { timeout: 6000 });
    const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
    for (const p of pairs) {
      const token = mapDexPair(p);
      if (token) tokens.push(token);
    }
  } catch { }

  // Source 5: DexScreener /latest/dex/pairs/base/new — freshest Base pairs (real-time new listings)
  // This endpoint returns the newest pools on Base regardless of keyword — catches meme launches
  // that don't appear in search results yet (too new, no trading history)
  try {
    const r = await axios.get('https://api.dexscreener.com/latest/dex/pairs/base/new', { timeout: 8000 });
    const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
    for (const p of pairs) {
      const token = mapDexPair(p);
      if (token) tokens.push(token);
    }
  } catch { }

  return dedupeByAddress(tokens);
}

async function fetchPairData(tokenAddress: string): Promise<BaseToken | null> {
  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
    const allPairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
    if (!allPairs.length) return null;
    // Prefer ETH/WETH-quoted pairs to keep price_eth in ETH units (not USD from USDC pairs)
    const ethPairs = allPairs.filter((p: any) =>
      ['ETH', 'WETH'].includes((p.quoteToken?.symbol ?? '').toUpperCase())
    );
    return mapDexPair(ethPairs.length > 0 ? ethPairs[0] : allPairs[0]);
  } catch { return null; }
}

function mapDexPair(p: any): BaseToken | null {
  const addr = p.baseToken?.address;
  if (!addr) return null;
  // Unknown creation date → treat as very old (will fail MAX_AGE_SEC filter)
  // This prevents buying established tokens that lack pairCreatedAt metadata
  const createdAt = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 1000 : 999999;
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
    sm_weight:        0,
    sm_wallets:       [],
  };
}

// ─── GeckoTerminal ───────────────────────────────────────────────────────────
function mapGeckoPool(pool: any, dexOverride?: string): BaseToken | null {
  const attrs      = pool.attributes ?? {};
  const baseToken  = pool.relationships?.base_token?.data?.id ?? '';
  const addr       = baseToken.replace('base_', '');
  if (!addr) return null;
  const createdAt  = attrs.pool_created_at
    ? (Date.now() - new Date(attrs.pool_created_at).getTime()) / 1000 : 0;
  return {
    contract_address: addr.toLowerCase(),
    symbol:           attrs.name?.split('/')[0] ?? '',
    name:             attrs.name ?? '',
    pair_address:     attrs.address ?? '',
    dex_id:           dexOverride ?? (pool.relationships?.dex?.data?.id ?? 'unknown'),
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
    sm_weight:        0,
    sm_wallets:       [],
  };
}

// GeckoTerminal is rate-limited on shared VPS IPs. Call it at most once per 5 minutes.
let _geckoLastCallMs = 0;
const GECKO_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between GeckoTerminal calls

async function fetchGeckoTerminal(): Promise<BaseToken[]> {
  const now = Date.now();
  if (now - _geckoLastCallMs < GECKO_COOLDOWN_MS) return []; // skip if too recent
  _geckoLastCallMs = now;

  const tokens: BaseToken[] = [];
  const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };

  // Prioritise new_pools — this returns truly fresh pools sorted by creation time
  const dexEndpoints: Array<{ url: string; dexId: string }> = [
    { url: 'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=1', dexId: '' },
    { url: 'https://api.geckoterminal.com/api/v2/networks/base/dexes/uniswap-v3/pools?page=1', dexId: 'uniswap-v3' },
    { url: 'https://api.geckoterminal.com/api/v2/networks/base/dexes/aerodrome-v2/pools?page=1', dexId: 'aerodrome-v2' },
  ];

  for (const endpoint of dexEndpoints) {
    try {
      const r = await axios.get(endpoint.url, { timeout: 10_000, headers: GECKO_HEADERS });
      if (r.status === 429) { _geckoLastCallMs = now + GECKO_COOLDOWN_MS * 2; break; } // extend backoff on 429
      const pools: any[] = r.data?.data ?? [];
      for (const pool of pools) {
        const t = mapGeckoPool(pool, endpoint.dexId || undefined);
        if (t) tokens.push(t);
      }
    } catch { }
  }

  if (tokens.length > 0) console.debug(`[base-scan] GeckoTerminal: ${tokens.length} pools`);
  return tokens;
}

// ─── Extra DexScreener sources for fresh Base meme tokens ────────────────────
// Called less frequently (every 5 min) to avoid rate limits on expensive searches
let _dexFreshLastCallMs = 0;
const DEX_FRESH_COOLDOWN_MS = 5 * 60 * 1000;

async function fetchDexScreenerFresh(): Promise<BaseToken[]> {
  const now = Date.now();
  if (now - _dexFreshLastCallMs < DEX_FRESH_COOLDOWN_MS) return [];
  _dexFreshLastCallMs = now;

  const tokens: BaseToken[] = [];
  // Searches specifically targeting fresh launches (not popular/established tokens)
  const freshSearches = [
    'base launch today', 'base meme 2026', 'base coin just launched',
    'believe.app base', 'clanker launch',
  ];
  for (const q of freshSearches) {
    try {
      const r = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { timeout: 6000 },
      );
      const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'base');
      for (const p of pairs) {
        const token = mapDexPair(p);
        if (token) tokens.push(token);
      }
    } catch { }
  }
  return tokens;
}

// ─── Clanker API ─────────────────────────────────────────────────────────────
// Clanker is the dominant Farcaster-based meme launchpad on Base.
// Their public API returns new launches earlier than DexScreener (5-15 min head start).
// We fetch CAs, then enrich with DexScreener pair data (price/liq/volume).
let _clankerLastMs = 0;
const CLANKER_COOLDOWN_MS = 2 * 60 * 1000; // 2 min between Clanker API calls

async function fetchClankerApi(): Promise<BaseToken[]> {
  const now = Date.now();
  if (now - _clankerLastMs < CLANKER_COOLDOWN_MS) return [];
  _clankerLastMs = now;

  const tokens: BaseToken[] = [];
  try {
    const r = await axios.get(
      'https://www.clanker.world/api/tokens?sort=desc&page=1&limit=20',
      { timeout: 8000, headers: { 'Accept': 'application/json' } },
    );
    const items: any[] = Array.isArray(r.data?.data) ? r.data.data
                        : Array.isArray(r.data)      ? r.data : [];
    if (!items.length) return [];

    // Only look at last 48h to avoid re-processing established Clanker tokens
    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
    const recent = items.filter((t: any) => {
      const ts = t.created_at ? new Date(t.created_at).getTime() : Date.now();
      return ts > cutoffMs;
    });
    if (!recent.length) return [];
    console.debug(`[base-scan] Clanker: ${recent.length}/${items.length} tokens within 48h`);

    // Parallelize DexScreener enrichment — sequential would block scan cycle for up to 50s (10×5s)
    const toFetch = recent.slice(0, 10).filter((item: any) => {
      const ca = (item.contract_address ?? item.tokenAddress ?? item.address)?.toLowerCase();
      return ca && !recentScanned.has(ca);
    });

    const results = await Promise.allSettled(toFetch.map(async (item: any) => {
      const ca = (item.contract_address ?? item.tokenAddress ?? item.address)?.toLowerCase();
      let token: BaseToken | null = null;

      // Prefer pool endpoint — fetches the exact pair (avoids USDC pair ambiguity)
      const poolAddr = item.pool_address ?? item.poolAddress ?? item.pair_address;
      if (poolAddr) {
        try {
          const pr = await axios.get(
            `https://api.dexscreener.com/latest/dex/pairs/base/${poolAddr}`,
            { timeout: 5000 },
          );
          const pair = pr.data?.pair ?? pr.data?.pairs?.[0];
          if (pair) token = mapDexPair(pair);
        } catch { }
      }

      // Fallback: token endpoint with ETH pair preference
      if (!token) token = await fetchPairData(ca!);
      if (!token) return null;

      // DexScreener may not know the pair age yet for very new launches.
      // Use Clanker's created_at as authoritative age source in that case.
      if (token.age_sec >= 999999 && item.created_at) {
        token.age_sec = Math.max(0, (Date.now() - new Date(item.created_at).getTime()) / 1000);
      }
      return token;
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) tokens.push(r.value);
    }
    if (tokens.length > 0) console.debug(`[base-scan] Clanker enriched: ${tokens.length} tokens`);
  } catch (e: any) {
    console.warn(`[base-scan] Clanker API error: ${(e as any).message?.slice(0, 60)}`);
  }
  return tokens;
}

// DEX IDs we can actually trade on Base.
// V4: tokens listed as 'uniswap-v4-base' can be bought via Aerodrome fallback
// (quotes.ts tries V3 → V2 → Aerodrome; Aerodrome handles V4 tokens without native pool)
// Excluded: 'aerodrome-cl' (concentrated liquidity, different factory), 'sushiswap', 'alien-base'
const TRADEABLE_DEX_IDS = new Set([
  'uniswap', 'uniswap-v2', 'uniswap-v2-base',
  'uniswap-v3', 'uniswap-v3-base',
  'uniswap-v4', 'uniswap-v4-base',
  'aerodrome-v2', 'aerodrome',
]);

// ─── Tier 2: High-volume launch (mcap $300k–$2.5M with strong momentum) ──────
// Catches Clanker-style launches that spike past $300k quickly but have real volume.
// Requires: vol1h/liq > 2x AND liq > $25k AND age < 12h AND 80+ buyers in 1h.
const TIER2_MAX_MCAP = Number(process.env.BASE_TIER2_MAX_MCAP_USD  || '2500000');
const TIER2_MIN_LIQ  = Number(process.env.BASE_TIER2_MIN_LIQ_USD   || '25000');
const TIER2_VOL_LIQ  = Number(process.env.BASE_TIER2_VOL_LIQ_RATIO || '2.0');
const TIER2_MAX_AGE  = Number(process.env.BASE_TIER2_MAX_AGE_SEC   || '43200'); // 12h
const TIER2_MIN_BUYS = Number(process.env.BASE_TIER2_MIN_BUYS_H1   || '80');

// ─── Filter ──────────────────────────────────────────────────────────────────
function passesFilter(t: BaseToken): string | null {
  // ── GUARD 0: Impersonator check (03.07.26 — КРИТИЧЕСКИЙ ФИКС) ──────────────
  // БАГ: оба гарда (inline isChainImpersonator + модуль impersonator-guard.ts)
  // существовали в коде, но НИ ОДИН не вызывался из passesFilter — мёртвый код.
  // Именно поэтому cbXRP/cbADA/фейковый SOL покупались (все исторические убытки).
  // Теперь: проверка по СИМВОЛУ (оба гарда) И по ИМЕНИ токена ("Coinbase Wrapped
  // XRP" ловится паттерном \bXRP\b даже если символ замаскирован).
  if (isChainImpersonator(t.symbol)) return `IMPERSONATOR symbol:${t.symbol}`;
  if (isBaseTokenImpersonator(t.symbol, t.contract_address)) return `IMPERSONATOR pattern:${t.symbol}`;
  if (t.name && isBaseTokenImpersonator(t.name, t.contract_address)) return `IMPERSONATOR name:"${t.name.slice(0, 30)}"`;

  // ── GUARD 0b: Fake-mcap sanity (03.07.26) ───────────────────────────────────
  // «Реальная капа» = за mcap стоит реальный пул. У настоящих мемов на Base
  // liq/mcap обычно 5-50%. mcap $50k+ при пуле <2% от капы = нарисованный FDV
  // на пустом пуле (классический сетап рага) — выход из такой позиции невозможен.
  if (t.mcap_usd > 50000 && t.liquidity_usd > 0 && t.liquidity_usd / t.mcap_usd < 0.02) {
    return `FAKE_MCAP: liq/mcap ${(t.liquidity_usd / t.mcap_usd * 100).toFixed(1)}% < 2% (painted FDV, thin pool)`;
  }

  // PRIMARY GUARD: mcap cap — the only reliable way to exclude all established tokens.
  // SOL=$80B, ADA=$15B, cbXRP scams=$100M+. Real meme launches: $1k-$2.5M.
  // Tier 1: mcap ≤ MAX_MCAP (default $350k) — standard meme entry.
  // Tier 2: mcap $350k–$2.5M but must have vol1h/liq > 2x + liq $25k+ + age < 12h + 80+ buys/h.
  if (t.mcap_usd > 0 && t.mcap_usd > MAX_MCAP) {
    const isTier2 = t.mcap_usd <= TIER2_MAX_MCAP &&
                    t.liquidity_usd >= TIER2_MIN_LIQ &&
                    t.volume_1h / Math.max(1, t.liquidity_usd) >= TIER2_VOL_LIQ &&
                    t.age_sec <= TIER2_MAX_AGE &&
                    t.txns_h1_buys >= TIER2_MIN_BUYS;
    if (!isTier2) return `mcap:$${(t.mcap_usd/1e6).toFixed(1)}M > $${(MAX_MCAP/1e6).toFixed(1)}M`;
    console.info(`[base-scan] 🔥T2 ${t.symbol}: mcap $${(t.mcap_usd/1e3).toFixed(0)}k liq $${(t.liquidity_usd/1e3).toFixed(0)}k vol/liq ${(t.volume_1h/t.liquidity_usd).toFixed(1)}x buys1h:${t.txns_h1_buys}`);
  }
  if (t.mcap_usd > 0 && t.mcap_usd < MIN_MCAP)  return `mcap:$${t.mcap_usd.toFixed(0)} < $${MIN_MCAP} (dead)`;
  // Age: unknown creation date = established token (pairCreatedAt missing = age 999999)
  if (t.age_sec > MAX_AGE_SEC) return `age:${(t.age_sec / 3600).toFixed(1)}h > ${MAX_AGE_SEC / 3600}h`;
  if (t.age_sec < MIN_AGE_SEC && t.age_sec > 0)  return `age:${t.age_sec.toFixed(0)}s < ${MIN_AGE_SEC}s (too fresh)`;
  if (t.liquidity_usd < MIN_LIQ)   return `liq:$${t.liquidity_usd.toFixed(0)} < $${MIN_LIQ}`;
  if (t.liquidity_usd > MAX_LIQ)   return `liq:$${t.liquidity_usd.toFixed(0)} > $${MAX_LIQ}`;
  if (!TRADEABLE_DEX_IDS.has(t.dex_id)) return `dex:${t.dex_id} (not supported)`;
  // Ultra-fresh (<10 min) — no 1h history yet, use 5m momentum only
  if (t.age_sec >= 600 && t.price_change_1h < MIN_PC1H) return `pc1h:${t.price_change_1h.toFixed(1)}% < ${MIN_PC1H}%`;
  const maxPc1h = t.age_sec < FRESH_AGE_SEC ? MAX_PC1H_FRESH : MAX_PC1H;
  if (t.price_change_1h > maxPc1h)  return `pc1h:${t.price_change_1h.toFixed(1)}% > ${maxPc1h}%`;
  if (t.price_change_5m !== 0 && t.price_change_5m < MIN_PC5M) return `pc5m:${t.price_change_5m.toFixed(1)}% < ${MIN_PC5M}%`;
  if (t.volume_1h / Math.max(1, t.liquidity_usd) < MIN_VOL_LIQ) return `vol/liq:${(t.volume_1h / Math.max(1, t.liquidity_usd) * 100).toFixed(0)}% < ${MIN_VOL_LIQ * 100}%`;
  if (t.buy_sell_ratio > MAX_BS_RATIO)  return `bs:${t.buy_sell_ratio.toFixed(1)} > ${MAX_BS_RATIO}`;
  if (t.txns_h1_buys < MIN_BUYS_H1)    return `buys1h:${t.txns_h1_buys} < ${MIN_BUYS_H1}`;
  if (t.safe_score < MIN_SAFE_SCORE)    return `score:${t.safe_score} < ${MIN_SAFE_SCORE}`;
  return null;
}

// ─── Main scan cycle ─────────────────────────────────────────────────────────
const recentScanned = new Set<string>();

// On startup, load recently bought tokens (last 2h) so we don't re-buy after a restart.
export async function loadBaseRecentBuys(): Promise<void> {
  try {
    const result = await query<{ contract_address: string }>(
      `SELECT DISTINCT contract_address FROM base_positions WHERE bought_at > NOW() - INTERVAL '2 hours'`
    );
    for (const row of result.rows) recentScanned.add(row.contract_address);
    if (result.rows.length > 0) {
      console.info(`[base-scan] Cooldown: ${result.rows.length} recently bought tokens will be skipped`);
    }
  } catch { /* DB not ready yet */ }
}

export async function runScanCycle(): Promise<BaseToken[]> {
  const [dex, gecko, fresh, clanker] = await Promise.all([
    fetchDexScreener(), fetchGeckoTerminal(), fetchDexScreenerFresh(), fetchClankerApi(),
  ]);
  const all = dedupeByAddress([...dex, ...gecko, ...fresh, ...clanker]);

  const geckoNote   = gecko.length   > 0 ? ` + ${gecko.length} Gecko`   : '';
  const freshNote   = fresh.length   > 0 ? ` + ${fresh.length} DexFresh` : '';
  const clankerNote = clanker.length > 0 ? ` + ${clanker.length} Clanker` : '';
  console.info(`[base-scan] ${all.length} candidates from ${dex.length} DexScreener${geckoNote}${freshNote}${clankerNote}`);

  const passed: BaseToken[] = [];

  for (const token of all) {
    const reason = passesFilter(token);
    if (reason) {
      console.debug(`[base-scan] ✗ ${token.symbol} ${reason}`);
      continue;
    }
    if (recentScanned.has(token.contract_address)) continue;

    // Run safety check — REQUIRED, not optional (prevents honeypot buys)
    // If Basescan is unreliable, set BASE_SKIP_SAFETY_CHECK=true in .env to bypass (not recommended)
    const safety = await checkTokenSafety(token.contract_address).catch(() => null);
    if (!safety) {
      if (process.env.BASE_SKIP_SAFETY_CHECK === 'true') {
        console.debug(`[base-scan] ⚠️ ${token.symbol} safety check unavailable — proceeding (BASE_SKIP_SAFETY_CHECK=true)`);
      } else {
        console.debug(`[base-scan] ✗ ${token.symbol} safety check failed (Basescan unavailable) — skip`);
        continue;
      }
    } else {
      token.is_verified = safety.is_verified;
      token.lp_locked   = safety.lp_locked;
      token.safe_score  = safety.safe_score;
    }

    const postReason = passesFilter(token);
    if (postReason) {
      console.debug(`[base-scan] ✗ ${token.symbol} (post-safety) ${postReason}`);
      continue;
    }

    // Launchpad factory check (BASE_LAUNCHER_ONLY=true → require Clanker or Virtual factory)
    // This is the definitive filter against L1 impersonators: real meme launchpad tokens
    // are deployed by factory contracts, not random EOAs.
    const launchpadOnly = process.env.BASE_LAUNCHER_ONLY === 'true';
    if (launchpadOnly || process.env.BASESCAN_API_KEY) {
      const lp = await checkLaunchpadOrigin(token.contract_address);
      if (launchpadOnly && !lp.isLaunchpad) {
        console.debug(`[base-scan] ✗ ${token.symbol} not a launchpad token (creator:${lp.creator?.slice(0,10) ?? 'unknown'})`);
        continue;
      }
      if (lp.isLaunchpad) {
        console.info(`[base-scan] [${lp.launchpad?.toUpperCase()}] ${token.symbol} verified factory token`);
      }
    }

    // Smart Money signal check (non-blocking — fail open)
    try {
      const smResult = await checkBaseSmartMoney(token.contract_address, token.pair_address);
      token.sm_weight  = smResult.weight;
      token.sm_wallets = smResult.wallets;
    } catch { /* fail open */ }

    if (BASE_REQUIRE_SM && token.sm_weight < 2.0) {
      console.debug(`[base-scan] ✗ ${token.symbol} SM weight ${token.sm_weight} < 2.0 (BASE_REQUIRE_SM_SIGNAL=true)`);
      continue;
    }

    // ⛽ Gas Reserve Safeguard — block buy if B1 ETH < buy_amount + 0.002 reserve for sells
    const BUY_ETH = Number(process.env.BASE_BUY_ETH || '0.001');
    const BASE_ETH_RESERVE = Number(process.env.BASE_ETH_RESERVE || '0.002');
    const _ethWallet = process.env.BASE_WALLET_ADDRESS;
    if (_ethWallet) {
      try {
        const { getProvider } = await import('@lib/base/src/provider');
        const _ethRaw = await getProvider().getBalance(_ethWallet).catch(() => BigInt(Number.MAX_SAFE_INTEGER));
        const _ethBal = Number(_ethRaw) / 1e18;
        if (_ethBal - BUY_ETH < BASE_ETH_RESERVE) {
          console.warn(`[base-scan] ⛽ GAS_RESERVE: ${_ethBal.toFixed(5)} ETH — need buy ${BUY_ETH}+reserve ${BASE_ETH_RESERVE}. Pausing scan.`);
          return passed;
        }
      } catch { /* fail-open */ }
    }

    // Shadow Mode: if BASE_AUTO_BUY=false, record what we would buy for P&L analysis
    const autoBuyEnabled = process.env.BASE_AUTO_BUY === 'true';
    if (!autoBuyEnabled) {
      query(`INSERT INTO shadow_trades (chain,strategy,symbol,contract_address,entry_price,entry_mcap_usd,entry_liq_usd,entry_pc1h,filter_params,tp1_target,stop_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        ['base','base-scan',token.symbol,token.contract_address,token.price_eth,token.mcap_usd,token.liquidity_usd,token.price_change_1h,JSON.stringify({pc5m:token.price_change_5m,dex_id:token.dex_id,age_sec:token.age_sec}),30,8]
      ).catch(()=>{});
      console.info(`[base-scan] 📝 [SHADOW] WOULD BUY ${token.symbol} @ mcap:$${token.mcap_usd.toFixed(0)} liq:$${token.liquidity_usd.toFixed(0)} pc1h:${token.price_change_1h.toFixed(1)}%`);
      continue;
    }

    // Upsert to DB
    await upsertBaseToken(token);
    recentScanned.add(token.contract_address);
    passed.push(token);
    const smTag = token.sm_weight >= 2.0 ? ` 🔥SM(w${token.sm_weight})` : '';
    console.info(`[base-scan] ✅ ${token.symbol} liq:$${token.liquidity_usd.toFixed(0)} pc1h:${token.price_change_1h.toFixed(1)}% score:${token.safe_score}${smTag}`);
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

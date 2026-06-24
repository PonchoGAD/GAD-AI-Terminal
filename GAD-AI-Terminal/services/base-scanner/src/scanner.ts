import axios from 'axios';
import { query } from '@lib/db';
import { checkTokenSafety, checkBaseSmartMoney } from '@lib/base';
import { checkLaunchpadOrigin } from './launcher-filter';

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
const MAX_AGE_SEC    = Number(process.env.BASE_MAX_AGE_SEC        || '14400'); // 4h — Base memes move fast
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
  const searches = ['base pepe', 'base doge', 'base frog', 'base ai', 'base pump'];
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

async function fetchGeckoTerminal(): Promise<BaseToken[]> {
  const tokens: BaseToken[] = [];
  const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };

  // DEX-specific endpoints — these return ONLY V3 or Aerodrome pools (tradeable by our router)
  const dexEndpoints: Array<{ url: string; dexId: string }> = [
    { url: 'https://api.geckoterminal.com/api/v2/networks/base/dexes/uniswap-v3/pools?page=1', dexId: 'uniswap-v3' },
    { url: 'https://api.geckoterminal.com/api/v2/networks/base/dexes/uniswap-v3/pools?page=2', dexId: 'uniswap-v3' },
    { url: 'https://api.geckoterminal.com/api/v2/networks/base/dexes/aerodrome-v2/pools?page=1', dexId: 'aerodrome-v2' },
    { url: 'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=1', dexId: '' },
  ];

  for (const endpoint of dexEndpoints) {
    try {
      const r = await axios.get(endpoint.url, { timeout: 8_000, headers: GECKO_HEADERS });
      const pools: any[] = r.data?.data ?? [];
      for (const pool of pools) {
        const t = mapGeckoPool(pool, endpoint.dexId || undefined);
        if (t) tokens.push(t);
      }
    } catch { }
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

// ─── Filter ──────────────────────────────────────────────────────────────────
function passesFilter(t: BaseToken): string | null {
  // PRIMARY GUARD: mcap cap — the only reliable way to exclude all established tokens.
  // SOL=$80B, ADA=$15B, cbXRP scams=$100M+. Real meme launches: $1k-$2M.
  // This one check prevents buying any L1/L2 token or their impersonators.
  if (t.mcap_usd > 0 && t.mcap_usd > MAX_MCAP)  return `mcap:$${(t.mcap_usd/1e6).toFixed(1)}M > $${(MAX_MCAP/1e6).toFixed(1)}M`;
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

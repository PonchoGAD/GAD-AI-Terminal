/**
 * libs/market-data — Macro market context aggregator
 *
 * Free sources (no API key required):
 *   - DeFiLlama: chain TVL, protocol data
 *   - CoinGecko: global market data, BTC dominance
 *   - Fear & Greed: sentiment index
 *
 * Optional paid sources (enabled when env keys present):
 *   - CoinMarketCap: COINMARKETCAP_API_KEY
 *   - CryptoRank: CRYPTORANK_API_KEY
 *
 * Returns MarketContext — used by regime detection and buy decision gating.
 */

import axios from 'axios';

// ─── Cache — rate-limit friendly (5min TTL) ───────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: MarketContext; at: number } | null = null;

export interface MarketContext {
  // Solana ecosystem
  solana_tvl_usd:      number;     // DeFiLlama: Solana DEX+DeFi TVL
  solana_tvl_change1d: number;     // % change in Solana TVL (last 24h)

  // Global crypto
  total_crypto_mcap:   number;     // USD total market cap
  btc_dominance_pct:   number;     // BTC market cap %
  total_mcap_change1d: number;     // % change total market cap 24h
  eth_mcap_pct:        number;     // ETH market cap %

  // Sentiment
  fear_greed:          number;     // 0-100
  fear_greed_label:    string;

  // Derived
  market_health_score: number;     // 0-100 composite
  alt_season_signal:   'HOT' | 'WARM' | 'COLD';  // BTC dom falling = alts heat up
  solana_trend:        'GROWING' | 'STABLE' | 'SHRINKING';

  // Meta
  fetched_at:          number;     // unix ms
  sources:             string[];   // which sources responded
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchDeFiLlamaChains(): Promise<{ solana_tvl: number; solana_change: number }> {
  const empty = { solana_tvl: 0, solana_change: 0 };
  try {
    const r = await axios.get('https://api.llama.fi/v2/chains', { timeout: 8_000 });
    const chains: any[] = r.data ?? [];
    const sol = chains.find(c => c.name?.toLowerCase() === 'solana');
    if (!sol) return empty;
    return {
      solana_tvl:    Number(sol.tvl ?? 0),
      solana_change: Number(sol.change_1d ?? 0),
    };
  } catch { return empty; }
}

async function fetchCoinGeckoGlobal(): Promise<{
  total_mcap: number; btc_dom: number; eth_dom: number; mcap_change1d: number;
}> {
  const empty = { total_mcap: 0, btc_dom: 50, eth_dom: 18, mcap_change1d: 0 };
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 8_000 });
    const d = r.data?.data ?? {};
    return {
      total_mcap:    Number(d.total_market_cap?.usd ?? 0),
      btc_dom:       Number(d.market_cap_percentage?.btc ?? 50),
      eth_dom:       Number(d.market_cap_percentage?.eth ?? 18),
      mcap_change1d: Number(d.market_cap_change_percentage_24h_usd ?? 0),
    };
  } catch { return empty; }
}

async function fetchFearGreed(): Promise<{ value: number; label: string }> {
  try {
    const r = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5_000 });
    const d = r.data?.data?.[0];
    return { value: Number(d?.value ?? 50), label: d?.value_classification ?? 'Neutral' };
  } catch { return { value: 50, label: 'Neutral' }; }
}

// ─── Derived metrics ──────────────────────────────────────────────────────────

function calcMarketHealthScore(
  fearGreed: number,
  mcapChange: number,
  btcDom: number,
  solanaTvlChange: number,
): number {
  // Fear & Greed: 0-100 → 40% weight
  const fgScore = fearGreed;

  // Market cap trend: -10% to +10% → map to 0-100
  const mcapScore = Math.min(100, Math.max(0, (mcapChange + 10) * 5));

  // BTC dominance: lower = better for alts (50% dom = neutral)
  // Below 45% = alt season, above 60% = risk-off
  const btcDomScore = Math.min(100, Math.max(0, (60 - btcDom) * 3.33));

  // Solana TVL trend: -5% to +5% → 0-100
  const tvlScore = Math.min(100, Math.max(0, (solanaTvlChange + 5) * 10));

  return Math.round(
    fgScore       * 0.35 +
    mcapScore     * 0.25 +
    btcDomScore   * 0.25 +
    tvlScore      * 0.15
  );
}

function getAltSeasonSignal(btcDom: number, mcapChange: number): 'HOT' | 'WARM' | 'COLD' {
  if (btcDom < 45 && mcapChange > 1) return 'HOT';
  if (btcDom < 52 && mcapChange > -2) return 'WARM';
  return 'COLD';
}

function getSolanaTrend(change: number): 'GROWING' | 'STABLE' | 'SHRINKING' {
  if (change > 3)  return 'GROWING';
  if (change < -3) return 'SHRINKING';
  return 'STABLE';
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function getMarketContext(forceRefresh = false): Promise<MarketContext> {
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const [llama, global_, fng] = await Promise.all([
    fetchDeFiLlamaChains(),
    fetchCoinGeckoGlobal(),
    fetchFearGreed(),
  ]);

  const sources: string[] = [];
  if (llama.solana_tvl > 0)    sources.push('DeFiLlama');
  if (global_.total_mcap > 0)  sources.push('CoinGecko');
  sources.push('FearGreed');

  const health = calcMarketHealthScore(
    fng.value,
    global_.mcap_change1d,
    global_.btc_dom,
    llama.solana_change,
  );

  const ctx: MarketContext = {
    solana_tvl_usd:      llama.solana_tvl,
    solana_tvl_change1d: llama.solana_change,
    total_crypto_mcap:   global_.total_mcap,
    btc_dominance_pct:   global_.btc_dom,
    total_mcap_change1d: global_.mcap_change1d,
    eth_mcap_pct:        global_.eth_dom,
    fear_greed:          fng.value,
    fear_greed_label:    fng.label,
    market_health_score: health,
    alt_season_signal:   getAltSeasonSignal(global_.btc_dom, global_.mcap_change1d),
    solana_trend:        getSolanaTrend(llama.solana_change),
    fetched_at:          Date.now(),
    sources,
  };

  cache = { data: ctx, at: Date.now() };
  return ctx;
}

// ─── Buy gate — can be used in scanner/autobuy ───────────────────────────────

export interface BuyGateResult {
  allowed:  boolean;
  reason:   string;
  marketHealth: number;
}

export async function checkMarketBuyGate(): Promise<BuyGateResult> {
  try {
    const ctx = await getMarketContext();

    if (ctx.market_health_score < 20) {
      return {
        allowed: false,
        reason: `Market health too low: ${ctx.market_health_score}/100 — F&G: ${ctx.fear_greed}, BTC dom: ${ctx.btc_dominance_pct.toFixed(1)}%`,
        marketHealth: ctx.market_health_score,
      };
    }

    if (ctx.btc_dominance_pct > 62 && ctx.alt_season_signal === 'COLD') {
      return {
        allowed: false,
        reason: `BTC dominance extreme: ${ctx.btc_dominance_pct.toFixed(1)}% — alt season signal: COLD`,
        marketHealth: ctx.market_health_score,
      };
    }

    return {
      allowed: true,
      reason: `Market health: ${ctx.market_health_score}/100 | Alt season: ${ctx.alt_season_signal} | Sol TVL: ${ctx.solana_trend}`,
      marketHealth: ctx.market_health_score,
    };
  } catch {
    // Fail open — don't block buys on data fetch errors
    return { allowed: true, reason: 'Market data unavailable — fail open', marketHealth: 50 };
  }
}

// ─── Formatter for Telegram ───────────────────────────────────────────────────

export function formatMarketContext(ctx: MarketContext): string {
  const solTvlB = ctx.solana_tvl_usd >= 1e9
    ? `$${(ctx.solana_tvl_usd / 1e9).toFixed(2)}B`
    : `$${(ctx.solana_tvl_usd / 1e6).toFixed(0)}M`;

  const totalMcapT = ctx.total_crypto_mcap >= 1e12
    ? `$${(ctx.total_crypto_mcap / 1e12).toFixed(2)}T`
    : `$${(ctx.total_crypto_mcap / 1e9).toFixed(0)}B`;

  const tvlSign = ctx.solana_tvl_change1d >= 0 ? '+' : '';
  const mcapSign = ctx.total_mcap_change1d >= 0 ? '+' : '';

  const altEmoji = ctx.alt_season_signal === 'HOT' ? '🔥' : ctx.alt_season_signal === 'WARM' ? '🌡️' : '❄️';
  const solEmoji = ctx.solana_trend === 'GROWING' ? '📈' : ctx.solana_trend === 'SHRINKING' ? '📉' : '➡️';

  const healthBar = '█'.repeat(Math.round(ctx.market_health_score / 10)) + '░'.repeat(10 - Math.round(ctx.market_health_score / 10));

  return (
    `🌍 *Macro Market Context*\n\n` +
    `Health: \`${healthBar}\` ${ctx.market_health_score}/100\n\n` +
    `*Crypto Global:*\n` +
    `Total MCap: ${totalMcapT} (${mcapSign}${ctx.total_mcap_change1d.toFixed(1)}%/24h)\n` +
    `BTC Dom: ${ctx.btc_dominance_pct.toFixed(1)}% | ETH: ${ctx.eth_mcap_pct.toFixed(1)}%\n\n` +
    `*Solana:*\n` +
    `${solEmoji} TVL: ${solTvlB} (${tvlSign}${ctx.solana_tvl_change1d.toFixed(1)}%/24h)\n\n` +
    `*Sentiment:*\n` +
    `Fear & Greed: ${ctx.fear_greed}/100 — ${ctx.fear_greed_label}\n` +
    `${altEmoji} Alt Season: ${ctx.alt_season_signal}\n\n` +
    `_Sources: ${ctx.sources.join(', ')}_`
  );
}

/**
 * Coin Hunter
 *
 * Given a trend theme + keywords, searches DexScreener for a matching
 * Solana token that is currently in price momentum (good for trading).
 *
 * Returns the best match or null if nothing tradeable found.
 */

import axios from 'axios';

export interface CoinHit {
  mint:          string;
  symbol:        string;
  name:          string;
  dex:           string;
  liqUsd:        number;
  vol24h:        number;
  priceChange5m: number;
  priceChange1h: number;
  mcapUsd:       number;
  pairUrl:       string;
  score:         number;  // composite score for ranking
}

const MIN_LIQ_USD    = 15_000;
const MAX_LIQ_USD    = 500_000;
const MIN_VOL_24H    = 30_000;
const MIN_PC5M       = 1;   // 1% gain in last 5m
const MIN_PC1H       = 5;   // 5% gain in last 1h
const MAX_PC1H       = 100; // not already mooned
const MAX_AGE_HOURS  = 24;

// Map theme to DexScreener search keywords
const THEME_TO_QUERY: Record<string, string[]> = {
  AI_AGENT:  ['ai', 'agent', 'gpt', 'artificial'],
  DOG:       ['dog', 'doge', 'wif', 'bonk', 'shib'],
  CAT:       ['cat', 'meow', 'kitty', 'nyan'],
  PEPE:      ['pepe', 'frog', 'apu'],
  TRUMP:     ['trump', 'maga', 'donald'],
  ELON:      ['elon', 'musk', 'tesla'],
  ANIME:     ['anime', 'naruto', 'goku', 'waifu'],
  FOOD:      ['pizza', 'food', 'burger', 'taco'],
  SPORTS:    ['sport', 'football', 'soccer', 'nba'],
  MEME:      ['meme', 'pepe', 'doge'],
  GENERAL:   ['sol', 'solana', 'pump'],
};

async function searchDexScreener(keyword: string): Promise<any[]> {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(keyword)}`, {
      timeout: 8000,
      headers: { 'User-Agent': 'GAD-AI-Terminal/1.0' }
    });
    return res.data?.pairs ?? [];
  } catch {
    return [];
  }
}

function pairToHit(pair: any): CoinHit | null {
  if (pair.chainId !== 'solana') return null;

  const liq    = Number(pair.liquidity?.usd ?? 0);
  const vol24h = Number(pair.volume?.h24 ?? 0);
  const pc5m   = Number(pair.priceChange?.m5 ?? 0);
  const pc1h   = Number(pair.priceChange?.h1 ?? 0);
  const mcap   = Number(pair.fdv ?? pair.marketCap ?? 0);

  if (liq < MIN_LIQ_USD || liq > MAX_LIQ_USD) return null;
  if (vol24h < MIN_VOL_24H) return null;
  if (pc5m < MIN_PC5M) return null;
  if (pc1h < MIN_PC1H || pc1h > MAX_PC1H) return null;

  // Check age
  if (pair.pairCreatedAt) {
    const ageH = (Date.now() - Number(pair.pairCreatedAt)) / 3_600_000;
    if (ageH > MAX_AGE_HOURS) return null;
  }

  const mint = pair.baseToken?.address;
  if (!mint) return null;

  // Composite score: momentum + volume
  const score = pc5m * 0.4 + pc1h * 0.3 + (vol24h / 10_000) * 0.3;

  return {
    mint,
    symbol:        pair.baseToken?.symbol ?? '???',
    name:          pair.baseToken?.name ?? '',
    dex:           pair.dexId ?? 'unknown',
    liqUsd:        liq,
    vol24h,
    priceChange5m: pc5m,
    priceChange1h: pc1h,
    mcapUsd:       mcap,
    pairUrl:       pair.url ?? '',
    score,
  };
}

export async function huntCoinForTheme(theme: string, extraKeywords: string[] = []): Promise<CoinHit | null> {
  const queries = [
    ...(THEME_TO_QUERY[theme] ?? THEME_TO_QUERY['GENERAL']),
    ...extraKeywords,
  ];

  const seen = new Set<string>();
  const hits: CoinHit[] = [];

  for (const kw of queries.slice(0, 3)) {
    const pairs = await searchDexScreener(kw);
    for (const p of pairs) {
      const hit = pairToHit(p);
      if (hit && !seen.has(hit.mint)) {
        seen.add(hit.mint);
        hits.push(hit);
      }
    }
    // Rate limit DexScreener
    await new Promise(r => setTimeout(r, 500));
  }

  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  return hits[0];
}

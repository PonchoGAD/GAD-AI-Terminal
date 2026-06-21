/**
 * External data sources for Polymarket signal enrichment.
 * All sources: free, no API key required.
 */

import axios from 'axios';

const UA = 'GADPolymarketBot/1.0 (contact@gadai.shop)';

// ── Wikipedia Pageviews API ───────────────────────────────────────────────────
// Detects interest spikes: +50%+ views in last 3 days vs prior period.
// Use case: pop-culture, politics, sports markets ("Will X win...?")

interface WikiResult {
  views:  number[];
  spike:  boolean;
  trend:  number;   // % change: 0.5 = 50% increase
}

export async function getWikipediaPageviews(
  articleName: string,
  daysAgo: number = 7
): Promise<WikiResult> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const end = new Date();
  const start = new Date(); start.setDate(end.getDate() - daysAgo);
  const article = encodeURIComponent(articleName.replace(/\s+/g, '_'));
  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/` +
    `en.wikipedia/all-access/all-agents/${article}/daily/${fmt(start)}/${fmt(end)}`;

  try {
    const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': UA } });
    const views: number[] = (res.data?.items ?? []).map((i: any) => i.views as number);
    if (views.length < 4) return { views, spike: false, trend: 0 };
    const recent = views.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const historical = views.slice(0, -3).reduce((a, b) => a + b, 0) / (views.length - 3);
    const trend = historical > 0 ? (recent - historical) / historical : 0;
    return { views, spike: trend > 0.5, trend };
  } catch {
    return { views: [], spike: false, trend: 0 };
  }
}

// ── GDELT v2 Doc Search ───────────────────────────────────────────────────────
// Targeted keyword search for specific market topics.
// Returns article titles as ready-to-score news texts.

export async function searchGdeltNews(keyword: string, maxResults = 5): Promise<string[]> {
  const q = encodeURIComponent(`"${keyword}"`);
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}` +
    `&mode=ArtList&maxrecords=${maxResults}&format=json&sort=Date`;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    return ((res.data?.articles ?? []) as any[])
      .map((a: any) => a.title as string)
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── US Fiscal Data API (Treasury) ────────────────────────────────────────────
// Official free API: interest rates, debt data.
// Use case: macro markets ("Will Fed rate exceed X%?")

export async function getUSMacroSignal(): Promise<string | null> {
  const url =
    'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates' +
    '?filter=record_date:gte:2026-01-01&sort=-record_date&page[number]=1&page[size]=3';
  try {
    const res = await axios.get(url, { timeout: 8000 });
    const row = res.data?.data?.[0];
    if (!row) return null;
    return `US Treasury avg rate ${row.record_date}: ${row.avg_interest_rate_amt}% (${row.security_desc})`;
  } catch {
    return null;
  }
}

// ── Entity extractor ─────────────────────────────────────────────────────────
// Extract searchable names from market titles for Wikipedia lookups.

export function extractEntitiesFromMarket(marketTitle: string): string[] {
  const out: string[] = [];

  // "Will [Entity] win/lose/be/reach..."
  const willM = marketTitle.match(/Will\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s/);
  if (willM) out.push(willM[1].trim());

  // Countries / teams
  const geo = marketTitle.match(
    /\b(France|Germany|Brazil|Argentina|England|Spain|Italy|Portugal|Mexico|Ukraine|Russia|China|Japan|India)\b/
  );
  if (geo) out.push(geo[0]);

  // Public figures
  const person = marketTitle.match(
    /\b(Trump|Biden|Harris|Musk|Zelensky|Putin|Macron|Modi|Xi\s+Jinping)\b/
  );
  if (person) out.push(person[0]);

  // Crypto
  const crypto = marketTitle.match(/\b(Bitcoin|Ethereum|BTC|ETH|Solana|SOL|XRP)\b/i);
  if (crypto) out.push(crypto[0]);

  return [...new Set(out)].slice(0, 2);
}

/**
 * RSS News Fetcher for Polymarket signal generation.
 *
 * Uses free RSS feeds (no API key required):
 *   - CoinDesk, CoinTelegraph, Decrypt — crypto news
 *   - Reuters Top News                  — global events
 *   - BBC World News                    — politics / elections
 *
 * CryptoPanic is now paid-only ($50/week) — not used here.
 */

import axios from 'axios';

const FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',   source: 'coindesk',      maxItems: 5 },
  { url: 'https://cointelegraph.com/rss',                     source: 'cointelegraph', maxItems: 5 },
  { url: 'https://decrypt.co/feed',                          source: 'decrypt',       maxItems: 4 },
  { url: 'https://feeds.reuters.com/reuters/topNews',         source: 'reuters',       maxItems: 4 },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',      source: 'bbc_world',     maxItems: 3 },
];

export interface RssItem {
  title:     string;
  source:    string;
  pubDate?:  string;
}

/** Parse <title> tags from raw RSS/Atom XML — no xml2js dependency. */
function parseHeadlines(xml: string, maxItems: number): string[] {
  const titles: string[] = [];

  // Match both CDATA-wrapped and plain titles
  const re = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g;
  let m: RegExpExecArray | null;
  let skipped = false; // first <title> is the feed name itself

  while ((m = re.exec(xml)) !== null && titles.length < maxItems) {
    const t = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (!t || t.length < 15) continue;
    if (!skipped) { skipped = true; continue; } // skip feed title
    titles.push(t);
  }

  return titles;
}

/**
 * Fetch all configured RSS feeds and return a flat list of recent headlines.
 * Silently skips failing feeds — never throws.
 */
export async function fetchRssHeadlines(): Promise<RssItem[]> {
  const items: RssItem[] = [];

  for (const feed of FEEDS) {
    try {
      const res = await axios.get<string>(feed.url, {
        timeout: 10_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GAD-Bot/1.0; +https://gadai.shop)',
          'Accept':     'application/rss+xml, application/xml, text/xml, */*',
        },
        responseType: 'text',
      });

      const headlines = parseHeadlines(res.data, feed.maxItems);
      for (const title of headlines) {
        items.push({ title, source: feed.source });
      }

      if (headlines.length) {
        console.debug(`[poly-rss] ${feed.source}: ${headlines.length} headlines`);
      }
    } catch (err: any) {
      console.debug(`[poly-rss] ${feed.source} failed: ${err.message}`);
    }
  }

  return items;
}

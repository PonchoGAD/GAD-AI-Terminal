import axios from 'axios';
import { TrendItem } from '../types';

// Google News RSS — free, no API key, updates every ~15 min
const GNEWS_BASE = 'https://news.google.com/rss/search';

const GNEWS_QUERIES = [
  'Elon Musk viral',
  'crypto Solana meme viral',
  'AI AGI viral breakthrough',
  'viral internet trend 2026',
  'celebrity scandal viral',
  'NASA space viral',
  'Trump viral',
  'viral meme coin crypto',
];

export async function fetchGoogleNews(query?: string): Promise<TrendItem[]> {
  const items: TrendItem[] = [];
  const queries = query ? [query] : GNEWS_QUERIES;

  for (const q of queries) {
    try {
      const r = await axios.get(GNEWS_BASE, {
        params: { q, hl: 'en-US', gl: 'US', ceid: 'US:en' },
        headers: { 'Accept': 'application/rss+xml,text/xml,*/*' },
        timeout: 8_000,
      });

      const articles = parseRss(r.data as string);
      for (const a of articles) {
        items.push({
          source: 'google_news',
          title: a.title,
          summary: a.description,
          url: a.link,
          author: a.source ?? '',
          published_at: new Date(a.pubDate ?? Date.now()),
          language: 'en',
          engagement: { likes: 0, reposts: 0, comments: 0, views: 0 },
          entities: extractEntities(a.title),
          raw: a,
        });
      }
    } catch { /* skip failed query */ }

    await new Promise(r => setTimeout(r, 200));
  }

  return items;
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  source?: string;
  [key: string]: unknown;
}

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];

  for (const item of itemMatches) {
    const title = extractTag(item, 'title');
    const link  = extractTag(item, 'link');
    const desc  = extractTag(item, 'description');
    const pub   = extractTag(item, 'pubDate');
    const src   = extractAttr(item, 'source');

    if (!title) continue;
    items.push({ title, link, description: desc, pubDate: pub, source: src });
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function extractAttr(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function extractEntities(title: string): string[] {
  const caps = title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) ?? [];
  return [...new Set(caps)].slice(0, 5);
}

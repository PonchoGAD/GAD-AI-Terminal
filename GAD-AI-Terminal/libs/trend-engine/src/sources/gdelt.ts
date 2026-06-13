import axios from 'axios';
import { TrendItem } from '../types';

const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

// Top-level keywords that signal memeable events
const GDELT_QUERIES = [
  'Elon Musk OR SpaceX viral',
  'AI breakthrough viral meme',
  'crypto Solana viral',
  'celebrity controversy viral',
  'Trump viral announcement',
  'viral internet meme trend',
  'NASA breakthrough viral',
];

export async function fetchGdelt(query?: string): Promise<TrendItem[]> {
  const items: TrendItem[] = [];
  const queries = query ? [query] : GDELT_QUERIES;

  for (const q of queries) {
    try {
      const r = await axios.get(GDELT_BASE, {
        params: {
          query: q,
          mode: 'artlist',
          maxrecords: 20,
          format: 'json',
          sort: 'DateDesc',
          timespan: '6h',
        },
        timeout: 8_000,
      });

      const articles: any[] = r.data?.articles ?? [];
      for (const a of articles) {
        const publishedAt = parseGdeltDate(a.seendate);
        items.push({
          source: 'gdelt',
          title: a.title ?? '',
          summary: '',
          url: a.url ?? '',
          author: a.domain ?? '',
          published_at: publishedAt,
          language: a.language ?? 'en',
          engagement: { likes: 0, reposts: 0, comments: 0, views: 0 },
          entities: extractEntitiesFromTitle(a.title ?? ''),
          raw: a,
        });
      }
    } catch { /* skip failed queries */ }

    await new Promise(r => setTimeout(r, 200));
  }

  return items;
}

function parseGdeltDate(s: string): Date {
  if (!s) return new Date();
  // GDELT format: "20240613123456" or ISO
  if (s.length === 14 && /^\d+$/.test(s)) {
    return new Date(
      `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}Z`
    );
  }
  return new Date(s);
}

function extractEntitiesFromTitle(title: string): string[] {
  const capitalized = title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) ?? [];
  return [...new Set(capitalized)].slice(0, 5);
}

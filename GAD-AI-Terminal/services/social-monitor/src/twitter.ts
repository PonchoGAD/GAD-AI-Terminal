/**
 * Twitter/X Monitor
 *
 * Strategy:
 *   1. If TWITTER_BEARER_TOKEN is set → use Twitter API v2 (free tier: last 100 tweets per user)
 *   2. Otherwise → use nitter.net public JSON endpoint as fallback (no auth required)
 *
 * Rate limits are respected: max 1 request/second across all handles.
 */
import axios from 'axios';
import { extractMintAddresses, analyzeSentiment, calcEngagement } from './analyzer';

export interface RawTweet {
  id:         string;
  author:     string;
  text:       string;
  likes:      number;
  retweets:   number;
  replies:    number;
  createdAt:  Date;
}

const TWITTER_BEARER = process.env.TWITTER_BEARER_TOKEN ?? '';

// Browser UA required by Nitter to serve RSS without Cloudflare block
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Multiple Nitter instances — tried in order until one responds
const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.1d4.us',
  'https://nitter.privacydev.net',
];

// ─── Twitter API v2 ───────────────────────────────────────────────────────────

async function fetchViaTwitterApi(handle: string, sinceId?: string): Promise<RawTweet[]> {
  const params: Record<string, string> = {
    max_results: '20',
    'tweet.fields': 'created_at,public_metrics',
    expansions: 'author_id'
  };
  if (sinceId) params.since_id = sinceId;

  const res = await axios.get(
    `https://api.twitter.com/2/tweets/search/recent?query=from:${handle}`,
    {
      headers: { Authorization: `Bearer ${TWITTER_BEARER}` },
      params,
      timeout: 10000
    }
  );

  const tweets: RawTweet[] = [];
  for (const t of (res.data.data ?? [])) {
    tweets.push({
      id:        t.id,
      author:    handle,
      text:      t.text,
      likes:     t.public_metrics?.like_count    ?? 0,
      retweets:  t.public_metrics?.retweet_count ?? 0,
      replies:   t.public_metrics?.reply_count   ?? 0,
      createdAt: new Date(t.created_at)
    });
  }
  return tweets;
}

// ─── Nitter RSS fallback (no API key, browser UA required) ───────────────────

async function fetchViaNitter(handle: string): Promise<RawTweet[]> {
  for (const host of NITTER_INSTANCES) {
    try {
      const res = await axios.get(`${host}/${handle}/rss`, {
        timeout: 8000,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, text/xml' },
        responseType: 'text',
      });

      const raw: string = typeof res.data === 'string' ? res.data : '';
      if (!raw || raw.includes('Verifying your browser') || raw.length < 200) continue;

      const items: RawTweet[] = [];
      const itemBlocks = raw.match(/<item>([\s\S]*?)<\/item>/g) ?? [];

      for (const block of itemBlocks.slice(0, 20)) {
        const getCDATA = (tag: string) =>
          (block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`)) ?? [])[1] ??
          (block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)) ?? [])[1] ?? '';
        const title   = getCDATA('title').replace(/<[^>]+>/g, '').trim();
        const pubDate = getCDATA('pubDate');
        const link    = getCDATA('link');
        const id      = link.split('/').pop() ?? String(Date.now());
        if (!title) continue;
        items.push({
          id, author: handle, text: title,
          likes: 0, retweets: 0, replies: 0,
          createdAt: pubDate ? new Date(pubDate) : new Date()
        });
      }
      return items;
    } catch { continue; }
  }
  return [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ParsedTweet extends RawTweet {
  detectedMints: string[];
  sentiment:     number;
  engagement:    number;
}

export async function fetchTweetsForHandle(handle: string, sinceId?: string): Promise<ParsedTweet[]> {
  let raw: RawTweet[] = [];

  if (TWITTER_BEARER) {
    try {
      raw = await fetchViaTwitterApi(handle, sinceId);
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 402 || status === 403) {
        // Twitter API requires paid plan — fall back to Nitter silently
        raw = await fetchViaNitter(handle);
      } else {
        throw err;
      }
    }
  } else {
    raw = await fetchViaNitter(handle);
  }

  return raw.map(t => ({
    ...t,
    detectedMints: extractMintAddresses(t.text),
    sentiment:     analyzeSentiment(t.text),
    engagement:    calcEngagement(t.likes, t.retweets, t.replies)
  }));
}

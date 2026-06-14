/**
 * X (Twitter) Trend Scanner
 *
 * Searches Twitter API v2 for high-engagement crypto content,
 * detects narrative themes, and returns ranked opportunities.
 *
 * Rate limit: max 1 search per 15 minutes (free tier respect).
 */

import axios from 'axios';

const BEARER = process.env.TWITTER_BEARER_TOKEN ?? '';

// 15 min between full search cycles
const SEARCH_INTERVAL_MS = 15 * 60 * 1000;
let lastSearchAt = 0;

export interface XTrend {
  theme:       string;
  keywords:    string[];
  topTweet:    string;
  tweetUrl:    string;
  engagement:  number;
  retweets:    number;
  likes:       number;
  authorId:    string;
  tweetId:     string;
  detectedAt:  Date;
}

// Narrative → detection keywords (checked against tweet text lowercased)
const NARRATIVE_KEYWORDS: Record<string, string[]> = {
  AI_AGENT:  ['ai', 'artificial intelligence', 'agent', 'gpt', 'claude', 'openai', 'robot', 'sentient'],
  DOG:       ['dog', 'doge', 'shib', 'wif', 'corgi', 'puppy', 'woof', 'bonk', 'dogwif'],
  CAT:       ['cat', 'meow', 'kitty', 'nyan', 'kitten', 'popcat'],
  PEPE:      ['pepe', 'frog', 'feels', 'apu', 'gigachad', 'chad'],
  TRUMP:     ['trump', 'maga', 'america first', 'donald', 'maga'],
  ELON:      ['elon', 'musk', 'tesla', 'spacex', 'x.com'],
  ANIME:     ['anime', 'manga', 'naruto', 'goku', 'dragon', 'waifu', 'kawaii'],
  FOOD:      ['pizza', 'burger', 'chicken', 'taco', 'food', 'hungry', 'sandwich'],
  SPORTS:    ['football', 'soccer', 'nfl', 'nba', 'mma', 'ufc', 'world cup', 'goal'],
  MEME:      ['meme', 'viral', 'trending', 'based', 'gigabrain', 'alpha'],
  DEFI:      ['defi', 'yield', 'staking', 'liquidity', 'apy', 'protocol'],
};

// Queries to run each cycle (one per call, rotating to stay within rate limits)
const SEARCH_QUERIES = [
  '(meme coin OR memecoin OR solana OR "pump fun") lang:en -is:retweet min_retweets:25',
  '(#solana OR #sol OR #memecoins) lang:en -is:retweet min_retweets:15',
];
let queryIndex = 0;

function detectNarrative(text: string): { theme: string; keywords: string[] } {
  const lower = text.toLowerCase();
  for (const [theme, kws] of Object.entries(NARRATIVE_KEYWORDS)) {
    const matched = kws.filter(k => lower.includes(k));
    if (matched.length > 0) return { theme, keywords: matched };
  }
  return { theme: 'GENERAL', keywords: [] };
}

export async function scanXTrends(): Promise<XTrend[]> {
  if (!BEARER) return [];
  if (Date.now() - lastSearchAt < SEARCH_INTERVAL_MS) return [];

  const query = SEARCH_QUERIES[queryIndex % SEARCH_QUERIES.length];
  queryIndex++;
  lastSearchAt = Date.now();

  try {
    const res = await axios.get('https://api.twitter.com/2/tweets/search/recent', {
      headers: { Authorization: `Bearer ${BEARER}` },
      params: {
        query,
        max_results: 10,
        'tweet.fields': 'created_at,public_metrics,author_id',
        sort_order: 'relevancy',
      },
      timeout: 10000,
    });

    const tweets: any[] = res.data?.data ?? [];
    if (!tweets.length) return [];

    const trends: XTrend[] = [];

    for (const t of tweets) {
      const metrics = t.public_metrics ?? {};
      const rt    = metrics.retweet_count ?? 0;
      const likes = metrics.like_count ?? 0;
      const rep   = metrics.reply_count ?? 0;
      const engagement = rt * 3 + likes + rep * 2;

      // Skip low-engagement tweets
      if (engagement < 50) continue;

      const { theme, keywords } = detectNarrative(t.text);
      trends.push({
        theme,
        keywords,
        topTweet:   t.text,
        tweetUrl:   `https://twitter.com/i/web/status/${t.id}`,
        engagement,
        retweets:   rt,
        likes,
        authorId:   t.author_id ?? '',
        tweetId:    t.id,
        detectedAt: new Date(),
      });
    }

    // Sort by engagement descending
    trends.sort((a, b) => b.engagement - a.engagement);
    console.info(`[social] X scan: ${trends.length} trending signals (query: "${query.slice(0, 50)}...")`);
    return trends;

  } catch (err: any) {
    if (err.response?.status === 429) {
      console.warn('[social] X API rate limit — backing off 15min');
      lastSearchAt = Date.now(); // prevent retry spam
    } else {
      console.warn(`[social] X scan error: ${err.message}`);
    }
    return [];
  }
}

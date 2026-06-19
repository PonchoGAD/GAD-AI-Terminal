/**
 * X (Twitter) Trend Scanner — MULTI-SOURCE
 *
 * Source 1: Nitter RSS — monitors @elonmusk, @cz_binance, @pumpdotfun + 8 crypto KOLs
 *   Works with browser User-Agent on nitter.net (free, no API key needed)
 *   RSS parsing: pure regex — no xml2js or external parser needed
 * Source 2: DexScreener pump.fun narrative extraction (word frequency from token names/descriptions)
 * Source 3: CoinGecko trending (free, no key)
 * Source 4: Twitter API v2 search (5 queries ready — needs Basic plan $100/mo, auto-activates)
 * Source 5: GDELT/trend_clusters fallback (populated by trend-engine, always available)
 */

import axios from 'axios';
import { query as dbQuery } from '@lib/db';

const BEARER = process.env.TWITTER_BEARER_TOKEN ?? '';

const SEARCH_INTERVAL_MS = 15 * 60 * 1000;
const NITTER_INTERVAL_MS = 20 * 60 * 1000;
let lastSearchAt  = 0;
let lastNitterAt  = 0;
let lastDexAt     = 0;
let lastCGAt      = 0;

// ─── Nitter instances — tried in order, rotated on failure ───────────────────
const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.1d4.us',
  'https://nitter.privacydev.net',
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Influential accounts — tier 1 = always scanned, tier 2/3 = every other cycle
const INFLUENCER_ACCOUNTS = [
  { handle: 'elonmusk',      tier: 1, theme: 'ELON'   },
  { handle: 'cz_binance',    tier: 1, theme: 'CRYPTO' },
  { handle: 'pumpdotfun',    tier: 1, theme: 'PUMPFUN'},
  { handle: 'aeyakovenko',   tier: 2, theme: 'SOLANA' },
  { handle: 'solana',        tier: 2, theme: 'SOLANA' },
  { handle: 'toly',          tier: 2, theme: 'SOLANA' },
  { handle: 'MustStopMurad', tier: 3, theme: 'MEME'   },
  { handle: 'inversebrah',   tier: 3, theme: 'MEME'   },
  { handle: 'ansemtrades',   tier: 3, theme: 'CRYPTO' },
  { handle: 'blknoiz06',     tier: 3, theme: 'MEME'   },
  { handle: 'cobie',         tier: 3, theme: 'CRYPTO' },
];

export interface XTrend {
  theme:      string;
  keywords:   string[];
  topTweet:   string;
  tweetUrl:   string;
  engagement: number;
  retweets:   number;
  likes:      number;
  authorId:   string;
  tweetId:    string;
  detectedAt: Date;
}

// Narrative detection keywords
const NARRATIVE_KEYWORDS: Record<string, string[]> = {
  AI_AGENT: ['ai', 'artificial intelligence', 'agent', 'gpt', 'claude', 'openai', 'robot', 'llm', 'chatbot', 'sentient'],
  DOG:      ['dog', 'doge', 'shib', 'wif', 'corgi', 'puppy', 'woof', 'bonk', 'dogwif'],
  CAT:      ['cat', 'meow', 'kitty', 'nyan', 'kitten', 'popcat'],
  PEPE:     ['pepe', 'frog', 'feels', 'apu', 'gigachad', 'chad'],
  TRUMP:    ['trump', 'maga', 'america first', 'donald'],
  ELON:     ['elon', 'musk', 'tesla', 'spacex', 'x.com'],
  ANIME:    ['anime', 'manga', 'naruto', 'goku', 'dragon ball', 'waifu', 'kawaii'],
  FOOD:     ['pizza', 'burger', 'chicken', 'taco', 'food', 'sandwich'],
  SPORTS:   ['football', 'soccer', 'nfl', 'nba', 'mma', 'ufc', 'world cup', 'goal'],
  MEME:     ['meme', 'viral', 'trending', 'based', 'gigabrain', 'alpha', 'wagmi', 'gm'],
  DEFI:     ['defi', 'yield', 'staking', 'liquidity', 'apy', 'protocol'],
  CRYPTO:   ['bitcoin', 'crypto', 'btc', 'eth', 'blockchain', 'web3', 'altcoin'],
  GAMING:   ['gaming', 'game', 'play', 'nft game', 'p2e', 'metaverse'],
  SCIENCE:  ['science', 'space', 'nasa', 'rocket', 'satellite', 'galaxy'],
};

// Twitter API v2 search queries (5 queries, rotating; activate when Basic plan purchased)
// Thresholds set for TRULY VIRAL posts (реально массовые):
// min_retweets:500 = top 0.1% of crypto posts, min_faves:5000 = proven viral
const SEARCH_QUERIES = [
  '"just launched" (sol OR solana OR "pump fun") -is:retweet min_retweets:500',
  '"100x" (memecoin OR meme) solana -is:retweet min_faves:5000',
  'site:pump.fun -is:retweet min_retweets:200',
  '(meme coin OR memecoin OR solana) lang:en -is:retweet min_retweets:500',
  '(#solana OR #sol OR #memecoins) (100x OR moon OR launch) lang:en -is:retweet min_retweets:200',
];
let queryIndex = 0;

// Stop-words for DexScreener word frequency analysis
// URL fragments and CDN paths pollute token descriptions: "https://cdn.dex.ag/..." splits to
// ["https","cdn","dex","com"] — all pass length>2 check. Add explicit URL noise words.
const STOP_WORDS = new Set([
  'the','a','an','is','to','and','of','in','on','for','with','at','by','this','that',
  'it','as','be','has','not','or','sol','solana','token','coin','pump','fun','meme',
  'inu','swap','crypto','web3','nft','dao','defi','block','chain','new','are','you',
  'your','our','its','we','can','will','get','have','just','all','from','was','com',
  // URL-derived noise (token descriptions contain CDN image URLs):
  'https','http','www','cdn','api','img','png','jpg','gif','jpeg','svg','webp',
  'net','xyz','io','app','pro','auto','bot','dev','dex','via','buy','let',
  // DexScreener API response noise (token description fields contain these):
  'dexscreener','cms','images','width','height','size','style','color','type',
  'data','src','href','alt','div','span','class','id',
]);

function detectNarrative(text: string): { theme: string; keywords: string[] } {
  const lower = text.toLowerCase();
  for (const [theme, kws] of Object.entries(NARRATIVE_KEYWORDS)) {
    const matched = kws.filter(k => lower.includes(k));
    if (matched.length > 0) return { theme, keywords: matched };
  }
  return { theme: 'GENERAL', keywords: [] };
}

// ─── RSS XML parser — pure regex, no external deps ────────────────────────────
function parseRssItems(xml: string): Array<{ title: string; link: string; pubDate: string; description: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; description: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string): string => {
      // Try CDATA first, then plain text
      const cd = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
      if (cd) return cd[1].trim();
      const plain = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
      return plain ? plain[1].trim() : '';
    };
    items.push({
      title:       get('title'),
      link:        get('link'),
      pubDate:     get('pubDate'),
      description: get('description'),
    });
  }
  return items;
}

function parseStat(s: string): number {
  if (!s) return 0;
  const clean = s.replace(/,/g, '').trim();
  if (/k$/i.test(clean)) return Math.round(parseFloat(clean) * 1000);
  if (/m$/i.test(clean)) return Math.round(parseFloat(clean) * 1_000_000);
  return parseInt(clean) || 0;
}

// ─── Source 1: Nitter RSS ─────────────────────────────────────────────────────
interface NitterTweet {
  handle: string; title: string; link: string;
  pubDate: Date; likes: number; retweets: number;
}

async function fetchNitterRSS(handle: string): Promise<NitterTweet[]> {
  for (const host of NITTER_INSTANCES) {
    try {
      const res = await axios.get(`${host}/${handle}/rss`, {
        timeout: 8000,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml' },
        responseType: 'text',
      });
      const xml: string = typeof res.data === 'string' ? res.data : '';
      if (!xml || xml.includes('Verifying your browser') || xml.length < 200) continue;

      const rawItems = parseRssItems(xml);
      return rawItems.slice(0, 15).map(it => {
        // Nitter RSS does NOT include engagement stats in the feed — only pubDate + text.
        // Engagement numbers (likes/retweets) are synthesized from account tier in scanInfluencers().
        const twitterLink = it.link
          .replace(/^https?:\/\/[^/]+/, 'https://twitter.com')
          .replace('https://twitter.com/https://twitter.com', 'https://twitter.com');
        return {
          handle,
          title:    it.title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
          link:     twitterLink,
          pubDate:  it.pubDate ? new Date(it.pubDate) : new Date(),
          likes:    0,    // not available in Nitter RSS
          retweets: 0,    // not available in Nitter RSS
        } as NitterTweet;
      }).filter(t => t.title.length > 10);
    } catch { continue; }
  }
  return [];
}

let nitterCycleCount = 0;

// Minimum follower-tier engagement score (synthetic — based on account importance since
// Nitter RSS does not expose engagement stats). These values represent expected audience reach.
// "Реально массовые" = posts that matter at a global scale:
//   Tier 1 (@elonmusk, @cz_binance): every post reaches millions — all crypto-relevant accepted
//   Tier 2 (Solana official): high signal for SOL ecosystem news
//   Tier 3 (crypto KOLs): only posts with strong crypto narrative signals
const TIER_BASE_ENGAGEMENT = { 1: 50000, 2: 5000, 3: 2000 };

// Cutoff: how far back to look (tier 1 = 24h, others = 12h)
const TIER_CUTOFF_HOURS    = { 1: 24, 2: 12, 3: 12 };

// Tier 3 require strong narrative to be included (avoid signal noise)
const TIER3_REQUIRED_THEMES = new Set(['AI_AGENT','DOG','CAT','PEPE','TRUMP','ELON','MEME','CRYPTO','DEFI','GAMING']);

async function scanInfluencers(): Promise<XTrend[]> {
  nitterCycleCount++;
  // Tier 1 always scanned; tier 2/3 scanned on alternate cycles
  const accounts = INFLUENCER_ACCOUNTS.filter(a => a.tier === 1 || nitterCycleCount % 2 === 0);
  const results: XTrend[] = [];

  for (const account of accounts) {
    try {
      const tweets = await fetchNitterRSS(account.handle);
      const cutoffMs = Date.now() - TIER_CUTOFF_HOURS[account.tier as 1|2|3] * 3600 * 1000;

      for (const t of tweets) {
        const pubMs = t.pubDate.getTime();
        if (isNaN(pubMs) || pubMs < cutoffMs) continue;

        const { theme, keywords } = detectNarrative(t.title);
        const finalTheme = (theme === 'GENERAL') ? account.theme : theme;

        // Tier 3: skip posts with no strong crypto narrative (too much noise)
        if (account.tier === 3 && !TIER3_REQUIRED_THEMES.has(theme)) continue;

        // Synthetic engagement score based on account tier — since Nitter has no engagement data,
        // we use tiered base values so tier 1 accounts always rank above tier 2/3.
        const syntheticEngagement = TIER_BASE_ENGAGEMENT[account.tier as 1|2|3];

        results.push({
          theme: finalTheme,
          keywords: keywords.length ? keywords : [account.handle],
          topTweet:   `@${account.handle}: ${t.title}`,
          tweetUrl:   t.link,
          engagement: syntheticEngagement,
          retweets:   0,
          likes:      0,
          authorId:   account.handle,
          tweetId:    t.link.split('/').pop() ?? String(pubMs),
          detectedAt: new Date(),
        });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch { /* ignore per-account errors */ }
  }
  console.info(`[social] Nitter influencers: ${results.length} signals from ${accounts.length} accounts`);
  return results;
}

// ─── Source 2: DexScreener pump.fun narrative extraction ──────────────────────
async function fetchDexScreenerNarratives(): Promise<XTrend[]> {
  try {
    const [boostRes, profileRes] = await Promise.all([
      axios.get('https://api.dexscreener.com/token-boosts/top/v1', {
        timeout: 8000, headers: { 'User-Agent': BROWSER_UA },
      }).catch(() => ({ data: [] })),
      axios.get('https://api.dexscreener.com/token-profiles/latest/v1', {
        timeout: 8000, headers: { 'User-Agent': BROWSER_UA },
      }).catch(() => ({ data: [] })),
    ]);

    const tokens: Array<{ text: string; xUrl?: string }> = [];

    for (const t of (boostRes.data as any[] ?? [])) {
      if (t.chainId !== 'solana') continue;
      const xLink = (t.links ?? []).find((l: any) =>
        typeof l.url === 'string' && (l.url.includes('twitter.com') || l.url.includes('x.com'))
      );
      tokens.push({ text: `${t.symbol ?? ''} ${t.description ?? ''} ${t.header ?? ''}`, xUrl: xLink?.url });
    }

    for (const t of (profileRes.data as any[] ?? [])) {
      if (t.chainId !== 'solana') continue;
      const xLink = (t.links ?? []).find((l: any) =>
        typeof l.url === 'string' && (l.url.includes('twitter.com') || l.url.includes('x.com'))
      );
      tokens.push({ text: `${t.symbol ?? ''} ${t.description ?? ''}`, xUrl: xLink?.url });
    }

    if (tokens.length < 5) return [];

    // Word frequency analysis
    const freq: Record<string, number> = {};
    const urls: Record<string, string> = {};
    for (const { text, xUrl } of tokens) {
      const words = text.toLowerCase()
        .replace(/[^a-z\s]/g, ' ')  // strip numbers too — "300 SOL" → "    SOL", "100x" → "x"
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
      for (const w of words) {
        freq[w] = (freq[w] ?? 0) + 1;
        if (xUrl && !urls[w]) urls[w] = xUrl;
      }
    }

    const topWords = Object.entries(freq)
      .filter(([, c]) => c >= 3)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([w]) => w);

    const results: XTrend[] = [];
    const seen = new Set<string>();

    for (const word of topWords) {
      const { theme, keywords } = detectNarrative(word);
      // Skip GENERAL matches — they produce garbage themes ("AUTO", "300", "CDN") that
      // coin-hunter then searches for, always returning NO_COIN. Only emit known narratives.
      if (theme === 'GENERAL') continue;
      const finalTheme = theme;
      if (seen.has(finalTheme)) continue;
      seen.add(finalTheme);
      results.push({
        theme: finalTheme,
        keywords: [...keywords, word],
        topTweet:  `DexScreener pump.fun: "${word}" appears in ${freq[word]}/${tokens.length} tokens — active narrative`,
        tweetUrl:  urls[word] ?? '',
        engagement: freq[word] * 100,
        retweets:  0,
        likes:     freq[word],
        authorId:  'dexscreener',
        tweetId:   `dx_${Date.now()}_${word}`,
        detectedAt: new Date(),
      });
      if (results.length >= 3) break;
    }
    console.info(`[social] DexScreener narratives: top words [${topWords.slice(0, 5).join(', ')}] → ${results.length} themes`);
    return results;
  } catch (err: any) {
    console.warn(`[social] DexScreener narrative error: ${err.message}`);
    return [];
  }
}

// ─── Source 3: CoinGecko trending ────────────────────────────────────────────
async function fetchCoinGeckoTrending(): Promise<XTrend[]> {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/search/trending', {
      timeout: 8000,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    });
    const coins: any[] = res.data?.coins ?? [];
    const results: XTrend[] = [];
    const seen = new Set<string>();

    for (const c of coins.slice(0, 10)) {
      const item = c.item ?? {};
      const { theme, keywords } = detectNarrative(`${item.name ?? ''} ${item.symbol ?? ''}`);
      if (seen.has(theme)) continue;
      seen.add(theme);
      results.push({
        theme,
        keywords: keywords.length ? keywords : [item.symbol?.toLowerCase() ?? ''],
        topTweet:   `CoinGecko trending #${results.length + 1}: ${item.name} (${item.symbol}) — rank #${item.market_cap_rank ?? '?'}`,
        tweetUrl:   `https://www.coingecko.com/en/coins/${item.id ?? ''}`,
        engagement: (10 - results.length) * 500,
        retweets:   0,
        likes:      item.score ?? 0,
        authorId:   'coingecko',
        tweetId:    `cg_${item.id ?? Date.now()}`,
        detectedAt: new Date(),
      });
      if (results.length >= 3) break;
    }
    console.info(`[social] CoinGecko trending: ${results.length} narratives`);
    return results;
  } catch (err: any) {
    console.warn(`[social] CoinGecko error: ${err.message}`);
    return [];
  }
}

// ─── Source 4: Twitter API v2 search (activates when Basic plan purchased) ───
async function scanTwitterAPI(): Promise<XTrend[]> {
  if (!BEARER) return [];
  if (Date.now() - lastSearchAt < SEARCH_INTERVAL_MS) return [];

  const q = SEARCH_QUERIES[queryIndex % SEARCH_QUERIES.length];
  queryIndex++;
  lastSearchAt = Date.now();

  try {
    const res = await axios.get('https://api.twitter.com/2/tweets/search/recent', {
      headers: { Authorization: `Bearer ${BEARER}` },
      params: {
        query: q,
        max_results: 10,
        'tweet.fields': 'created_at,public_metrics,author_id',
        sort_order: 'relevancy',
      },
      timeout: 10000,
    });

    const tweets: any[] = res.data?.data ?? [];
    const trends: XTrend[] = [];

    for (const t of tweets) {
      const m = t.public_metrics ?? {};
      const rt = m.retweet_count ?? 0;
      const likes = m.like_count ?? 0;
      const rep = m.reply_count ?? 0;
      const engagement = rt * 3 + likes + rep * 2;
      // "Реально массовые" threshold: 500 retweets OR 5k likes = truly viral
      if (engagement < 500 * 3 + 0) continue; // min_retweets:500 equivalent
      const { theme, keywords } = detectNarrative(t.text);
      trends.push({
        theme, keywords,
        topTweet:   t.text,
        tweetUrl:   `https://twitter.com/i/web/status/${t.id}`,
        engagement, retweets: rt, likes,
        authorId:   t.author_id ?? '',
        tweetId:    t.id,
        detectedAt: new Date(),
      });
    }

    trends.sort((a, b) => b.engagement - a.engagement);
    console.info(`[social] Twitter API: ${trends.length} signals (query: "${q.slice(0, 50)}...")`);
    return trends;
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 402 || status === 403) {
      console.warn(`[social] Twitter API ${status} — upgrade to Basic plan ($100/mo) to activate search`);
    } else if (status === 429) {
      console.warn('[social] Twitter API rate limit — backing off 15min');
    } else {
      console.warn(`[social] Twitter API: ${err.message}`);
    }
    return [];
  }
}

// ─── Source 5: GDELT/trend_clusters fallback ──────────────────────────────────
async function fromTrendClusters(): Promise<XTrend[]> {
  try {
    const { rows } = await dbQuery<any>(`
      SELECT id, main_title, final_score, total_mentions
      FROM trend_clusters
      WHERE final_score >= 55
        AND created_at > now() - interval '2 hours'
      ORDER BY final_score DESC
      LIMIT 5
    `);

    return rows.map((r: any) => {
      const title: string = r.main_title ?? '';
      const { theme, keywords } = detectNarrative(title);
      return {
        theme, keywords,
        topTweet:   title,
        tweetUrl:   '',
        engagement: Math.round(Number(r.total_mentions) * 3 + Number(r.final_score) * 2),
        retweets:   Number(r.total_mentions) ?? 0,
        likes:      0,
        authorId:   'gdelt',
        tweetId:    String(r.id),
        detectedAt: new Date(),
      } as XTrend;
    });
  } catch {
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function scanXTrends(): Promise<XTrend[]> {
  const now = Date.now();

  const [twitterT, nitterT, dexT, cgT] = await Promise.all([
    // Twitter API — always try if BEARER set; rate-limited internally
    scanTwitterAPI().catch(() => [] as XTrend[]),

    // Nitter RSS — 20min interval to be respectful
    (now - lastNitterAt > NITTER_INTERVAL_MS)
      ? scanInfluencers().then(r => { lastNitterAt = Date.now(); return r; }).catch(() => [] as XTrend[])
      : Promise.resolve([] as XTrend[]),

    // DexScreener narrative — 15min interval
    (now - lastDexAt > SEARCH_INTERVAL_MS)
      ? fetchDexScreenerNarratives().then(r => { lastDexAt = Date.now(); return r; }).catch(() => [] as XTrend[])
      : Promise.resolve([] as XTrend[]),

    // CoinGecko — 15min interval
    (now - lastCGAt > SEARCH_INTERVAL_MS)
      ? fetchCoinGeckoTrending().then(r => { lastCGAt = Date.now(); return r; }).catch(() => [] as XTrend[])
      : Promise.resolve([] as XTrend[]),
  ]);

  // Merge all sources, dedup by theme (highest engagement wins)
  const all = [...twitterT, ...nitterT, ...dexT, ...cgT];
  const byTheme = new Map<string, XTrend>();
  for (const t of all) {
    const ex = byTheme.get(t.theme);
    if (!ex || t.engagement > ex.engagement) byTheme.set(t.theme, t);
  }

  const deduped = Array.from(byTheme.values()).sort((a, b) => b.engagement - a.engagement);

  if (deduped.length === 0) {
    const fb = await fromTrendClusters();
    console.info(`[social] All sources empty — GDELT fallback: ${fb.length} trends`);
    return fb;
  }

  console.info(
    `[social] Trends merged: ${deduped.length} themes ` +
    `(twitter:${twitterT.length} nitter:${nitterT.length} dex:${dexT.length} cg:${cgT.length})`
  );
  return deduped;
}

/**
 * Free Alpha Aggregator — zero API-key cost signal pipeline.
 *
 * Sources (all free, no auth):
 *   1. Reddit JSON API — r/CryptoMoonShots, r/SatoshiStreetBets, r/memecoin
 *   2. DexScreener Token Profiles — recently boosted/featured tokens
 *   3. Telegram web mirrors — t.me/s/<channel> public posts
 *   4. (CryptoPanic replaced — now paid $50/wk. Using free alternatives above.)
 *
 * Cost control:
 *   - Local keyword classifier runs FIRST (zero cost)
 *   - Claude is only called for AI_AGENT + POLITICS hits (≤2% of posts)
 *   - All other narratives are labelled locally and stored without LLM
 */

import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '@lib/db';

const claude      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OPENAI_KEY  = process.env.OPENAI_API_KEY ?? '';
const DRY_RUN     = process.env.FREE_ALPHA_DRY_RUN !== 'false';

// Narratives: keyword → narrative label
const KEYWORD_MAP: Array<{ keys: string[]; narrative: string }> = [
  { keys: ['ai agent', 'artificial intelligence', 'gpt', 'llm', 'openai', 'anthropic', 'neural', 'agi', 'deep learning', 'machine learning'], narrative: 'AI_AGENT' },
  { keys: ['trump', 'biden', 'election', 'congress', 'senate', 'president', 'federal reserve', 'fed rate', 'sec crypto', 'regulation', 'whitehouse', 'executive order'], narrative: 'POLITICS' },
  { keys: ['dog', 'doge', 'shib', 'shiba', 'floki', 'corgi', 'husky', 'poodle', 'puppy', 'woof', 'bonk'], narrative: 'DOG' },
  { keys: ['cat', 'meow', 'kitten', 'feline', 'nyan', 'purr'], narrative: 'CAT' },
  { keys: ['pepe', 'frog', 'wojak', 'chad', 'meme coin', 'memecoin', 'ded'], narrative: 'PEPE' },
  { keys: ['elon', 'musk', 'spacex', 'tesla', 'mars', 'doge father', 'grok'], narrative: 'ELON' },
  { keys: ['pizza', 'burger', 'taco', 'beer', 'coffee', 'sushi', 'donut', 'food coin'], narrative: 'FOOD' },
  { keys: ['football', 'soccer', 'basketball', 'nba', 'nfl', 'fifa', 'world cup', 'olympics', 'sports'], narrative: 'SPORTS' },
  { keys: ['anime', 'manga', 'naruto', 'dragon ball', 'pokemon', 'otaku', 'waifu'], narrative: 'ANIME' },
];

// Only these narratives are worth an LLM call (political + AI = real money events)
const LLM_WORTHY = new Set(['AI_AGENT', 'POLITICS']);

// Solana mint address regex
const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// ─── Local classifier ─────────────────────────────────────────────────────────

function classifyNarrative(text: string): string {
  const lower = text.toLowerCase();
  for (const { keys, narrative } of KEYWORD_MAP) {
    if (keys.some(k => lower.includes(k))) return narrative;
  }
  return 'GENERAL';
}

function extractMints(text: string): string[] {
  const candidates = text.match(MINT_RE) ?? [];
  // Filter: Solana mints are 32-44 chars, base58 chars only, all caps/mixed case
  return [...new Set(candidates.filter(c => c.length >= 32 && c.length <= 44))];
}

// ─── LLM enhancement (Claude → OpenAI fallback) ───────────────────────────────

async function callLLM(content: string): Promise<string> {
  try {
    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 150,
      messages: [{ role: 'user', content }],
    });
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  } catch (err: any) {
    const isCredits = err.status === 400 || (err.message ?? '').toLowerCase().includes('credit');
    if (!isCredits) throw err;
    if (!OPENAI_KEY) return '';
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', max_tokens: 150,
      messages: [{ role: 'user', content }],
    }, { headers: { Authorization: `Bearer ${OPENAI_KEY}` }, timeout: 12000 });
    return res.data.choices[0]?.message?.content ?? '';
  }
}

async function enrichWithLLM(title: string, body: string): Promise<{ score: number; reason: string }> {
  const prompt =
    `You are a crypto alpha analyst. Rate this crypto social post for trading signal potential.\n` +
    `Title: "${title.slice(0, 200)}"\nText: "${body.slice(0, 300)}"\n` +
    `Return JSON only: {"score":0-100,"reason":"one sentence"}`;
  try {
    const text = await callLLM(prompt);
    const j = JSON.parse(text.match(/\{[\s\S]*?\}/)?.[0] ?? 'null');
    return { score: j?.score ?? 0, reason: (j?.reason ?? '').slice(0, 150) };
  } catch {
    return { score: 0, reason: '' };
  }
}

// ─── Source 1: Reddit RSS ─────────────────────────────────────────────────────
// Uses Reddit's public RSS feeds (/r/sub/new.rss) — avoids JSON API 403 on datacenter IPs

async function fetchRedditRss(subreddit: string): Promise<Array<{ id: string; title: string; body: string }>> {
  const res = await axios.get(`https://www.reddit.com/r/${subreddit}/new.rss?limit=15`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RssBot/1.0)' },
    timeout: 8000,
  });
  const xml = res.data as string;
  const items: Array<{ id: string; title: string; body: string }> = [];

  const titleRe   = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g;
  const idRe      = /<id>([\s\S]*?)<\/id>/g;
  const contentRe = /<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/g;

  const titles   = [...xml.matchAll(titleRe)].map(m => m[1].trim()).slice(1);   // skip feed title
  const ids      = [...xml.matchAll(idRe)].map(m => m[1].trim()).slice(1);
  const contents = [...xml.matchAll(contentRe)].map(m => m[1].replace(/<[^>]+>/g, ' ').trim());

  for (let i = 0; i < titles.length; i++) {
    if (!titles[i]) continue;
    const postId = ids[i]?.split('/').filter(Boolean).pop() ?? `${subreddit}_${i}`;
    items.push({ id: postId, title: titles[i], body: (contents[i] ?? '').slice(0, 500) });
  }
  return items;
}

async function processReddit(): Promise<number> {
  const SUBS = ['CryptoMoonShots', 'SatoshiStreetBets', 'memecoin'];
  let saved = 0;

  for (const sub of SUBS) {
    let posts: Array<{ id: string; title: string; body: string }> = [];
    try { posts = await fetchRedditRss(sub); } catch (err: any) {
      console.debug(`[free-alpha] Reddit r/${sub} unavailable: ${err.message}`);
      continue;
    }

    for (const p of posts) {
      const full      = `${p.title} ${p.body}`;
      const narrative = classifyNarrative(full);
      const mints     = extractMints(full);
      let   score     = narrative !== 'GENERAL' ? 40 : 10;

      if (LLM_WORTHY.has(narrative)) {
        const enriched = await enrichWithLLM(p.title, p.body).catch(() => ({ score: 0, reason: '' }));
        score = enriched.score;
      }

      if (!DRY_RUN) {
        await query(
          `INSERT INTO raw_alpha_feeds (source, source_id, title, body, narrative, mentioned_mints, mentioned_symbols, engagement, score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (source, source_id) DO NOTHING`,
          ['reddit', p.id, p.title.slice(0, 400), p.body.slice(0, 2000),
           narrative, mints, [], 0, score]
        ).catch(() => {});
        saved++;
      } else if (score > 30 || mints.length > 0) {
        console.debug(`[free-alpha] Reddit r/${sub}: "${p.title.slice(0,60)}" narrative=${narrative} mints=${mints.length}`);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return saved;
}

// ─── Source 2: DexScreener Token Profiles ────────────────────────────────────

interface DexProfile { url: string; chainId: string; tokenAddress: string; description?: string; links?: any[] }

async function processDexProfiles(): Promise<number> {
  let profiles: DexProfile[] = [];
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 8000 });
    profiles = Array.isArray(res.data) ? res.data : [];
  } catch (err: any) {
    console.debug(`[free-alpha] DexScreener profiles unavailable: ${err.message}`);
    return 0;
  }

  // Only Solana tokens
  const solProfiles = profiles.filter(p => p.chainId === 'solana').slice(0, 20);
  let saved = 0;

  for (const p of solProfiles) {
    const text      = p.description ?? '';
    const narrative = classifyNarrative(text);
    const mints     = [p.tokenAddress, ...extractMints(text)].filter(Boolean);

    if (!DRY_RUN) {
      await query(
        `INSERT INTO raw_alpha_feeds (source, source_id, title, body, narrative, mentioned_mints, mentioned_symbols, engagement, score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (source, source_id) DO NOTHING`,
        ['dexscreener_profile', p.tokenAddress, `Profile: ${p.tokenAddress.slice(0, 12)}...`,
         text.slice(0, 1000), narrative, [...new Set(mints)], [], 0, 30]
      ).catch(() => {});
      saved++;
    } else {
      console.debug(`[free-alpha] DexProfile ${p.tokenAddress.slice(0,10)} narrative=${narrative}`);
    }
  }

  return saved;
}

// ─── Source 3: Telegram web mirrors ──────────────────────────────────────────
// Public channels accessible via t.me/s/<channel> as HTML page

const TG_CHANNELS = [
  'cryptosignalsforyou',   // general crypto signals
  'defi_alpha',            // DeFi alpha
  'pumpfunsol',            // pump.fun monitoring
];

async function processTelegramChannel(channel: string): Promise<number> {
  let html = '';
  try {
    const res = await axios.get(`https://t.me/s/${channel}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' },
      timeout: 10000,
    });
    html = res.data as string;
  } catch {
    return 0;
  }

  // Extract message texts from <div class="tgme_widget_message_text">
  const msgRe = /<div[^>]*class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let match: RegExpExecArray | null;
  let saved = 0;

  while ((match = msgRe.exec(html)) !== null) {
    const raw  = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (raw.length < 20) continue;

    const narrative = classifyNarrative(raw);
    if (narrative === 'GENERAL') continue; // skip generic messages

    const mints = extractMints(raw);
    if (!DRY_RUN) {
      const msgId = `${channel}_${Buffer.from(raw.slice(0, 50)).toString('base64').slice(0, 20)}`;
      await query(
        `INSERT INTO raw_alpha_feeds (source, source_id, title, body, narrative, mentioned_mints, mentioned_symbols, engagement, score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (source, source_id) DO NOTHING`,
        ['telegram_web', msgId, raw.slice(0, 200), raw.slice(0, 1000),
         narrative, mints, [], 0, 20]
      ).catch(() => {});
      saved++;
    }
  }

  return saved;
}

async function processTelegram(): Promise<number> {
  let total = 0;
  for (const ch of TG_CHANNELS) {
    total += await processTelegramChannel(ch).catch(() => 0);
    await new Promise(r => setTimeout(r, 500));
  }
  return total;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runFreeAlphaCycle(): Promise<void> {
  if (DRY_RUN) console.info('[free-alpha] DRY-RUN mode (FREE_ALPHA_DRY_RUN=false to enable DB writes)');

  const [reddit, dex, tg] = await Promise.allSettled([
    processReddit(),
    processDexProfiles(),
    processTelegram(),
  ]);

  const r = reddit.status === 'fulfilled' ? reddit.value : 0;
  const d = dex.status    === 'fulfilled' ? dex.value    : 0;
  const t = tg.status     === 'fulfilled' ? tg.value     : 0;

  if (r + d + t > 0) {
    console.info(`[free-alpha] Cycle complete: reddit=${r} dex=${d} telegram=${t}`);
  }
}

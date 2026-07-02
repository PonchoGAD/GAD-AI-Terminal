import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { query } from '@lib/db';
import { getMarketsFromDb, Market } from './markets';
import { matchNewsToMarketKeyword, detectVolumeSpikeMarkets, preFilterTrend, isMacroTrend } from './keyword-matcher';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MIN_EV         = Number(process.env.POLYMARKET_MIN_EV           || '0.12');
const MIN_EV_MACRO   = Number(process.env.POLYMARKET_MIN_EV_MACRO     || '0.10'); // lower threshold for macro (FED/CPI/elections)
const MIN_CONFIDENCE = process.env.POLYMARKET_MIN_CONFIDENCE           || 'MEDIUM'; // HIGH | MEDIUM

// In-memory LLM result cache — prevents duplicate API calls for the same news headline
// The same news item may arrive from GDELT + X Trends within the same hour.
// Key: first 200 chars of news text (unique enough for dedup). TTL: 4 hours.
const LLM_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const _llmCache = new Map<string, { result: ScoredSignal | null; expiresAt: number }>();
function _llmCacheKey(newsText: string): string { return newsText.slice(0, 200).toLowerCase().trim(); }

// Lazy-init OpenAI-compatible clients — all share the same SDK interface
let _geminiClient: OpenAI | null = null;
let _groqClient: OpenAI | null = null;
let _dsClient: OpenAI | null = null;
let _oaiClient: OpenAI | null = null;

// Gemini Flash via OpenAI-compatible endpoint (free tier, 15 RPM / 1M TPD)
function geminiClient(): OpenAI {
  if (!_geminiClient) _geminiClient = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY ?? 'no-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    timeout: 20000,
  });
  return _geminiClient;
}
function groqClient(): OpenAI {
  if (!_groqClient) _groqClient = new OpenAI({
    apiKey: process.env.GROQ_API_KEY ?? 'no-key',
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: 15000,
  });
  return _groqClient;
}
function dsClient(): OpenAI {
  if (!_dsClient) _dsClient = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY ?? 'no-key',
    baseURL: 'https://api.deepseek.com/v1',
    timeout: 25000,
  });
  return _dsClient;
}
function oaiClient(): OpenAI {
  if (!_oaiClient) _oaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? 'no-key',
    timeout: 20000,
  });
  return _oaiClient;
}

// Groq free tier: 6,000 TPM. Sequential promise chain serializer ensures 5.5s
// between each call (10.9 calls/min × ~470 tokens = ~5,100 TPM, under 6k limit).
// .then() is atomic in JS single-thread — no race condition possible.
let _groqNextAt = 0;
let _groqChain: Promise<void> = Promise.resolve();
function acquireGroqToken(): Promise<void> {
  const token = _groqChain.then(() => {
    const now = Date.now();
    const delay = Math.max(0, _groqNextAt - now);
    _groqNextAt = Math.max(now, _groqNextAt) + 5500;
    return delay > 0 ? new Promise<void>(r => setTimeout(r, delay)) : undefined;
  });
  _groqChain = token;
  return token;
}

// Gemini free tier: 15 RPM = 1 call every 4s
let _geminiNextAt = 0;
let _geminiChain: Promise<void> = Promise.resolve();
function acquireGeminiToken(): Promise<void> {
  const token = _geminiChain.then(() => {
    const now = Date.now();
    const delay = Math.max(0, _geminiNextAt - now);
    _geminiNextAt = Math.max(now, _geminiNextAt) + 4200;
    return delay > 0 ? new Promise<void>(r => setTimeout(r, delay)) : undefined;
  });
  _geminiChain = token;
  return token;
}

// ── FREE LLM: Gemini → Groq → DeepSeek → Claude Haiku ──────────────────────
// Chain priority: cheapest/free first, paid Claude only as last resort.
// Gemini Flash free tier: 15 RPM, 1M TPD — handles most load without cost.
// Used for matchNewsToMarket + scorePosition (many calls per cycle).
async function callLLMFree(userContent: string, maxTokens: number): Promise<string> {
  // 0. Gemini Flash 2.0 (FREE — 15 RPM, 1M tokens/day, via OpenAI-compatible API)
  if (process.env.GEMINI_API_KEY) {
    for (const geminiModel of ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-latest']) {
      try {
        await acquireGeminiToken();
        const res = await geminiClient().chat.completions.create({
          model: geminiModel, max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: userContent }],
        });
        return res.choices[0]?.message?.content ?? '';
      } catch (err: any) {
        if (err.status !== 404) {
          console.debug(`[poly-scorer] Gemini/${geminiModel} (${err.status ?? err.message?.slice(0,30)}) — trying Groq`);
          break;
        }
        // 404 = model not found, try next model name
      }
    }
  }

  // 1. Groq (FREE — TPM rate limited)
  if (process.env.GROQ_API_KEY) {
    for (const groqModel of ['llama3-8b-8192', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']) {
      try {
        await acquireGroqToken();
        const res = await groqClient().chat.completions.create({
          model: groqModel, max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: userContent }],
        });
        return res.choices[0]?.message?.content ?? '';
      } catch (err: any) {
        if (err.status === 429) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const res2 = await groqClient().chat.completions.create({
              model: groqModel, max_tokens: maxTokens,
              response_format: { type: 'json_object' },
              messages: [{ role: 'user', content: userContent }],
            });
            return res2.choices[0]?.message?.content ?? '';
          } catch { /* fall through to next model */ }
        }
        if (err.status !== 404 && err.status !== 400) {
          console.debug(`[poly-scorer] Groq/${groqModel} (${err.status ?? err.message?.slice(0,30)}) — trying DeepSeek`);
          break;
        }
      }
    }
  }

  // 2. DeepSeek (requires balance on platform.deepseek.com)
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const res = await dsClient().chat.completions.create({
        model: 'deepseek-chat', max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: userContent }],
      });
      return res.choices[0]?.message?.content ?? '';
    } catch (err: any) {
      console.debug(`[poly-scorer] DeepSeek (${err.status ?? err.message?.slice(0,30)}) — trying OpenAI`);
    }
  }

  // 3. Claude (ANTHROPIC_API_KEY set on VPS) — try multiple model IDs
  if (process.env.ANTHROPIC_API_KEY) {
    for (const claudeModel of ['claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307']) {
      try {
        const msg = await claude.messages.create({
          model: claudeModel, max_tokens: maxTokens,
          messages: [{ role: 'user', content: userContent }],
        });
        return msg.content[0].type === 'text' ? msg.content[0].text : '';
      } catch (err: any) {
        if (err.status !== 400 && err.status !== 404) {
          console.warn(`[poly-scorer] Claude ${claudeModel} failed (${err.status}) — graceful fallback`);
          break;
        }
        // 400/404 = model not available, try next
      }
    }
    console.warn('[poly-scorer] All Claude models failed — graceful fallback');
  }
  // 4. All LLMs failed — graceful no-match
  console.warn('[poly-scorer] All LLMs unavailable (Groq/DeepSeek/Claude) — returning no-match');
  return JSON.stringify({match:false,ev:0});
}

// ── PREMIUM LLM: Claude → DeepSeek → Groq ───────────────────────────────────
// Used ONLY for finalTradeValidation() — called once per actual trade entry.
// Claude provides highest accuracy for the moment that costs real money.
async function callLLMPremium(userContent: string, maxTokens: number): Promise<string> {
  // 1a. Claude Haiku 4.5
  try {
    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens,
      messages: [{ role: 'user', content: userContent }],
    });
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  } catch (err: any) {
    const isTransient = err.status === 400 || err.status === 403 || err.status === 404
      || err.status === 429 || err.status === 529
      || (err.message ?? '').toLowerCase().includes('credit')
      || (err.message ?? '').toLowerCase().includes('overload');
    if (!isTransient) throw err;
    console.warn(`[poly-scorer] Claude Haiku 4.5 unavailable (${err.status}) — trying claude-3-5-haiku`);
  }
  // 1b. Claude 3.5 Haiku
  try {
    const msg = await claude.messages.create({
      model: 'claude-3-5-haiku-20241022', max_tokens: maxTokens,
      messages: [{ role: 'user', content: userContent }],
    });
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  } catch (err: any) {
    const isTransient = err.status === 400 || err.status === 403 || err.status === 404
      || err.status === 429 || err.status === 529
      || (err.message ?? '').toLowerCase().includes('credit');
    if (!isTransient) throw err;
    console.warn(`[poly-scorer] Claude 3.5 Haiku unavailable (${err.status}) — falling back to free LLM for validation`);
  }
  // Fallback: DeepSeek/Groq if Claude completely unavailable
  return callLLMFree(userContent, maxTokens);
}

export interface ScoredSignal {
  marketId:      string;
  marketTitle:   string;
  tokenIdYes:    string;
  tokenIdNo:     string;
  outcome:       'YES' | 'NO';
  entryPrice:    number;
  aiProbability: number;
  evScore:       number;
  confidence:    'HIGH' | 'MEDIUM' | 'LOW';
  reasoning:     string;
}

// Prompt 1: Match news text to the best Polymarket market
async function matchNewsToMarket(
  newsText: string,
  markets: Market[]
): Promise<{ marketId: string; outcome: 'YES' | 'NO'; relevance: number } | null> {
  // Top 30 markets by volume — broader set improves match rate. Numeric index keeps tokens low (~600 total).
  const top30 = markets.slice(0, 30);
  const marketList = top30.map((m, i) => ({ i, q: m.title.slice(0, 60), y: +m.priceYes.toFixed(3) }));

  const prompt =
    `Match news to most relevant Polymarket market. Return ONLY JSON.\n` +
    `NEWS: "${newsText.slice(0, 200)}"\n` +
    `MARKETS: ${JSON.stringify(marketList)}\n` +
    `{"match":true/false,"idx":0-29,"outcome":"YES"/"NO","relevance":0-100} or {"match":false}`;

  const text = await callLLMFree(prompt, 120);
  const json = JSON.parse(text.match(/\{[\s\S]*?\}/)?.[0] ?? 'null');
  if (!json?.match || json.relevance < 50) return null;
  const mkt = top30[Number(json.idx)];
  if (!mkt) return null;
  return { marketId: mkt.id, outcome: json.outcome as 'YES' | 'NO', relevance: json.relevance };
}

// Prompt 2: EV scoring — should we trade?
async function scorePosition(
  market: Market,
  outcome: 'YES' | 'NO',
  newsContext: string
): Promise<Omit<ScoredSignal, 'marketId' | 'marketTitle' | 'tokenIdYes' | 'tokenIdNo' | 'outcome' | 'entryPrice'> | null> {
  const currentPrice = outcome === 'YES' ? market.priceYes : market.priceNo;

  const prompt =
    `Prediction market EV calculator.\n` +
    `MARKET: "${market.title.slice(0, 80)}"\n` +
    `SIGNAL: "${newsContext.slice(0, 200)}"\n` +
    `BUY ${outcome} at $${currentPrice.toFixed(3)} (market: ${(currentPrice * 100).toFixed(0)}%)\n` +
    `EV=(p_yes-price_${outcome}). Trade if EV≥${MIN_EV} and confidence MEDIUM+.\n` +
    `JSON only: {"ai_prob_yes":0-1,"recommended":"YES"/"NO"/"HOLD","ev":float,"confidence":"HIGH"/"MEDIUM"/"LOW","reasoning":"<10 words"}`;

  const text = await callLLMFree(prompt, 350);
  const j = JSON.parse(text.match(/\{[\s\S]*?\}/)?.[0] ?? 'null');
  if (!j || j.recommended === 'HOLD') return null;
  if (j.ev < MIN_EV) return null;
  if (j.confidence === 'LOW') return null;
  if (MIN_CONFIDENCE === 'HIGH' && j.confidence !== 'HIGH') return null;

  return {
    aiProbability: j.ai_prob_yes,
    evScore:       j.ev,
    confidence:    j.confidence,
    reasoning:     (j.reasoning ?? '').slice(0, 200),
  };
}

async function saveAndReturnSignal(
  market: Market,
  outcome: 'YES' | 'NO',
  entryPrice: number,
  aiProbability: number,
  evScore: number,
  confidence: 'HIGH' | 'MEDIUM' | 'LOW',
  reasoning: string,
  source: string,
  sourceSignalId: number | null,
): Promise<ScoredSignal> {
  // Dedup: skip INSERT if same market+source already signaled in last 24h
  // (RSS/GDELT runs every 10 min — 24h window prevents same market spam across cycles)
  const { rows: recent } = await query(
    `SELECT 1 FROM polymarket_signals WHERE market_id=$1 AND news_source=$2 AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
    [market.id, source]
  );
  if (!recent.length) {
    await query(
      `INSERT INTO polymarket_signals
         (market_id, outcome, entry_price, ai_probability, ev_score, confidence, reasoning, news_source, news_text, source_signal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [market.id, outcome, entryPrice, aiProbability, evScore,
       confidence, reasoning.slice(0, 500), source, null,
       sourceSignalId !== null ? String(sourceSignalId) : null]
    );
  } else {
    console.debug(`[poly-scorer] dedup: ${market.id.slice(0, 12)} already signaled by ${source} in last 24h — skip DB insert`);
  }
  return {
    marketId:      market.id,
    marketTitle:   market.title,
    tokenIdYes:    market.tokenIdYes,
    tokenIdNo:     market.tokenIdNo,
    outcome,
    entryPrice,
    aiProbability,
    evScore,
    confidence,
    reasoning,
  };
}

export async function processNewsSignal(
  newsText:       string,
  source:         string,
  sourceSignalId: number | null = null
): Promise<ScoredSignal | null> {
  const markets = await getMarketsFromDb();
  if (!markets.length) {
    console.warn('[poly-scorer] No markets in DB — run market sync first');
    return null;
  }

  // ── Orderbook depth gate: skip markets with < $5000 liquidity (slippage risk) ─
  // At $1000 liquidity, a $50-100 position causes severe slippage on entry AND exit.
  // $5000 minimum ensures position size ($10 default) is < 0.2% of available depth.
  // Gamma API provides `liquidity` field; we use volumeUsd as floor if liquidity=0.
  const MIN_MARKET_LIQUIDITY = Number(process.env.POLY_MIN_MARKET_LIQUIDITY || '5000');
  const tradeableMarkets = markets.filter(m => {
    const liq = (m as any).liquidityUsd ?? 0;
    const effectiveLiq = liq > 0 ? liq : m.volumeUsd * 0.01; // 1% of 24h vol as fallback floor
    return effectiveLiq >= MIN_MARKET_LIQUIDITY;
  });
  if (tradeableMarkets.length < markets.length) {
    console.debug(`[poly-scorer] Liquidity gate: ${markets.length - tradeableMarkets.length} markets filtered (liq < $${MIN_MARKET_LIQUIDITY})`);
  }

  // ── FAST PATH: keyword matcher (zero API calls, instant) ─────────────────
  const kwResult = matchNewsToMarketKeyword(newsText, tradeableMarkets as any);
  const isMacro = isMacroTrend(newsText);
  const matchedMarket = kwResult ? tradeableMarkets.find(m => m.id === kwResult.marketId) : null;
  // Belt-and-suspenders: macro lower EV threshold only when BOTH conditions hold:
  // 1) historical volume >= $50k (liquid enough to have good price discovery)
  // 2) current liquidityUsd >= $1000 (orderbook not empty right now)
  // Note: tradeableMarkets already filters by liquidityUsd >= $5000, so check (2)
  // can only fail if the Gamma API returned liquidityUsd=0 with high volumeUsd fallback.
  const currentLiq = (matchedMarket as any)?.liquidityUsd ?? 0;
  const macroHighVol = isMacro
    && (matchedMarket?.volumeUsd ?? 0) >= 50_000
    && (currentLiq >= 1_000 || currentLiq === 0); // 0 = field missing, rely on volume fallback filter
  const effectiveMinEv = macroHighVol ? MIN_EV_MACRO : MIN_EV;
  if (kwResult && kwResult.ev >= effectiveMinEv && kwResult.confidence !== 'LOW') {
    const macroTag = macroHighVol ? ' 🌍MACRO' : '';
    console.info(`[poly-scorer] 🔑 keyword match: "${matchedMarket?.title?.slice(0,50)}" ev:${kwResult.ev.toFixed(2)} conf:${kwResult.confidence}${macroTag} minEV:${effectiveMinEv}`);
    const market = matchedMarket;
    if (market) {
      const entryPrice = kwResult.outcome === 'YES' ? market.priceYes : market.priceNo;
      return saveAndReturnSignal(market, kwResult.outcome, entryPrice, kwResult.aiProb, kwResult.ev, kwResult.confidence, kwResult.reasoning, source, sourceSignalId);
    }
  }

  // ── Pre-filter: skip LLM entirely for crypto/AI/DeFi trends ────────────────
  // These never match Polymarket (political/sports/macro markets).
  // Saves API credits and eliminates 429/402 noise in logs.
  if (!preFilterTrend(newsText)) {
    console.debug('[poly-scorer] 🚫 Pre-filter: crypto/AI trend — skipping LLM (no Polymarket match expected)');
    return null;
  }

  // ── LLM cache check: same headline within 4h → reuse result ─────────────
  const cacheKey = _llmCacheKey(newsText);
  const cached = _llmCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.debug(`[poly-scorer] LLM cache hit for "${newsText.slice(0, 60)}" — reusing result`);
    return cached.result;
  }

  // ── SLOW PATH: LLM matching (may fail if providers are down) ─────────────
  const match = await matchNewsToMarket(newsText, tradeableMarkets).catch(e => {
    console.debug('[poly-scorer] LLM matchNewsToMarket failed:', e.message);
    return null;
  });
  if (!match) {
    _llmCache.set(cacheKey, { result: null, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
    return null;
  }

  const market = tradeableMarkets.find(m => m.id === match.marketId);
  if (!market) {
    _llmCache.set(cacheKey, { result: null, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
    return null;
  }

  const score = await scorePosition(market, match.outcome, newsText).catch(e => {
    console.error('[poly-scorer] scorePosition error:', e.message);
    return null;
  });
  if (!score) {
    _llmCache.set(cacheKey, { result: null, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
    return null;
  }

  const entryPrice = match.outcome === 'YES' ? market.priceYes : market.priceNo;

  // ── FINAL GATE: Claude validates only when we're about to commit a trade ──
  // All broad analysis (matchNews + scorePosition) already ran on free LLMs.
  // Claude is called ONCE per actual trade signal to catch reasoning errors.
  const finalPrompt =
    `Prediction market trade validator. A free-tier AI already scored this signal.\n` +
    `Perform a final sanity check before executing a real-money position.\n\n` +
    `MARKET: "${market.title}"\n` +
    `SIGNAL: "${newsText.slice(0, 300)}"\n` +
    `TRADE: BUY ${match.outcome} at $${entryPrice.toFixed(3)} | AI prob_yes=${score.aiProbability.toFixed(2)} | EV=${score.evScore.toFixed(3)}\n` +
    `REASONING: ${score.reasoning}\n\n` +
    `Is this trade logically sound? Any red flags (fake news, reversed causality, stale data)?\n` +
    `Reply ONLY JSON: {"approve":true/false,"reason":"one sentence"}`;
  try {
    const finalText = await callLLMPremium(finalPrompt, 150);
    const fj = JSON.parse(finalText.match(/\{[\s\S]*?\}/)?.[0] ?? 'null');
    if (fj && fj.approve === false) {
      console.info(`[poly-scorer] 🚫 Claude final gate REJECTED: ${fj.reason ?? 'no reason'}`);
      _llmCache.set(cacheKey, { result: null, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
      return null;
    }
    if (fj?.approve) console.info(`[poly-scorer] ✅ Claude final gate APPROVED: ${fj.reason ?? ''}`);
  } catch (e: any) {
    console.debug(`[poly-scorer] Final gate skipped (${e.message?.slice(0,40)})`);
    // Non-blocking: if Claude completely unavailable, proceed with free-LLM score
  }

  const { rows } = await query<{ id: number }>(
    `INSERT INTO polymarket_signals
       (market_id, outcome, entry_price, ai_probability, ev_score, confidence, reasoning, news_source, news_text, source_signal_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [match.marketId, match.outcome, entryPrice, score.aiProbability, score.evScore,
     score.confidence, score.reasoning, source, newsText.slice(0, 500),
     sourceSignalId !== null ? String(sourceSignalId) : null]
  );

  const signal: ScoredSignal = {
    marketId:      match.marketId,
    marketTitle:   market.title,
    tokenIdYes:    market.tokenIdYes,
    tokenIdNo:     market.tokenIdNo,
    outcome:       match.outcome,
    entryPrice,
    ...score,
  };
  _llmCache.set(cacheKey, { result: signal, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
  return signal;
}

// GDELT/trend_clusters as secondary signal source
export async function processGdeltSignal(clusterSummary: string): Promise<ScoredSignal | null> {
  return processNewsSignal(clusterSummary, 'gdelt_trends', null);
}

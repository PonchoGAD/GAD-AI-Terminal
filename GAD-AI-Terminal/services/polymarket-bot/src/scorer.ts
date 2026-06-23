import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { query } from '@lib/db';
import { getMarketsFromDb, Market } from './markets';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MIN_EV         = Number(process.env.POLYMARKET_MIN_EV           || '0.12');
const MIN_CONFIDENCE = process.env.POLYMARKET_MIN_CONFIDENCE           || 'MEDIUM'; // HIGH | MEDIUM

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

// ── FREE LLM: Gemini → Groq → DeepSeek → Claude Haiku ──────────────────────
// Chain priority: cheapest/free first, paid Claude only as last resort.
// Gemini Flash free tier: 15 RPM, 1M TPD — handles most load without cost.
// Used for matchNewsToMarket + scorePosition (many calls per cycle).
async function callLLMFree(userContent: string, maxTokens: number): Promise<string> {
  // 0. Gemini Flash (FREE — 15 RPM, 1M tokens/day, via OpenAI-compatible API)
  if (process.env.GEMINI_API_KEY) {
    try {
      const res = await geminiClient().chat.completions.create({
        model: 'gemini-1.5-flash', max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: userContent }],
      });
      return res.choices[0]?.message?.content ?? '';
    } catch (err: any) {
      console.debug(`[poly-scorer] Gemini (${err.status ?? err.message?.slice(0,30)}) — trying Groq`);
    }
  }

  // 1. Groq (FREE — TPM rate limited)
  if (process.env.GROQ_API_KEY) {
    try {
      await acquireGroqToken();
      const res = await groqClient().chat.completions.create({
        model: 'llama-3.1-8b-instant', max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: userContent }],
      });
      return res.choices[0]?.message?.content ?? '';
    } catch (err: any) {
      if (err.status === 429) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const res2 = await groqClient().chat.completions.create({
            model: 'llama-3.1-8b-instant', max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: userContent }],
          });
          return res2.choices[0]?.message?.content ?? '';
        } catch { /* fall through */ }
      }
      console.debug(`[poly-scorer] Groq (${err.status ?? err.message?.slice(0,30)}) — trying DeepSeek`);
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

  // 3. Claude Haiku (ANTHROPIC_API_KEY set on VPS)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const msg = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens,
        messages: [{ role: 'user', content: userContent }],
      });
      return msg.content[0].type === 'text' ? msg.content[0].text : '';
    } catch (err: any) {
      console.warn(`[poly-scorer] Claude Haiku failed (${err.status}) — graceful fallback`);
    }
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

  const match = await matchNewsToMarket(newsText, markets).catch(e => {
    console.error('[poly-scorer] matchNewsToMarket error:', e.message);
    return null;
  });
  if (!match) return null;

  const market = markets.find(m => m.id === match.marketId);
  if (!market) return null;

  const score = await scorePosition(market, match.outcome, newsText).catch(e => {
    console.error('[poly-scorer] scorePosition error:', e.message);
    return null;
  });
  if (!score) return null;

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

  return {
    marketId:      match.marketId,
    marketTitle:   market.title,
    tokenIdYes:    market.tokenIdYes,
    tokenIdNo:     market.tokenIdNo,
    outcome:       match.outcome,
    entryPrice,
    ...score,
  };
}

// GDELT/trend_clusters as secondary signal source
export async function processGdeltSignal(clusterSummary: string): Promise<ScoredSignal | null> {
  return processNewsSignal(clusterSummary, 'gdelt_trends', null);
}

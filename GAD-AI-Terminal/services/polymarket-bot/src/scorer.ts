import Anthropic from '@anthropic-ai/sdk';
import { query } from '@lib/db';
import { getMarketsFromDb, Market } from './markets';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MIN_EV         = Number(process.env.POLYMARKET_MIN_EV           || '0.12');
const MIN_CONFIDENCE = process.env.POLYMARKET_MIN_CONFIDENCE           || 'MEDIUM'; // HIGH | MEDIUM

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
  const marketList = markets.slice(0, 60).map(m => ({
    id: m.id,
    q:  m.title,
    cat: m.category,
    yes: m.priceYes,
  }));

  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content:
        `You are a Polymarket analyst. Match this news to the SINGLE most relevant active prediction market.\n\n` +
        `NEWS: "${newsText.slice(0, 400)}"\n\n` +
        `MARKETS: ${JSON.stringify(marketList)}\n\n` +
        `Return ONLY valid JSON (no extra text):\n` +
        `{"match":true/false,"market_id":"...","affected_outcome":"YES"/"NO","relevance":0-100}\n` +
        `If no clear match, return {"match":false}`,
    }],
  });

  const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
  const json = JSON.parse(text.match(/\{[\s\S]*?\}/)?.[0] ?? 'null');
  if (!json?.match || json.relevance < 50) return null;
  return { marketId: json.market_id, outcome: json.affected_outcome, relevance: json.relevance };
}

// Prompt 2: EV scoring — should we trade?
async function scorePosition(
  market: Market,
  outcome: 'YES' | 'NO',
  newsContext: string
): Promise<Omit<ScoredSignal, 'marketId' | 'marketTitle' | 'tokenIdYes' | 'tokenIdNo' | 'outcome' | 'entryPrice'> | null> {
  const currentPrice = outcome === 'YES' ? market.priceYes : market.priceNo;

  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    messages: [{
      role: 'user',
      content:
        `You are a prediction market EV calculator. Analyze this Polymarket position.\n\n` +
        `MARKET: "${market.title}"\n` +
        `CATEGORY: ${market.category}\n` +
        `NEWS/SIGNAL: "${newsContext.slice(0, 400)}"\n` +
        `CURRENT PRICE of ${outcome}: $${currentPrice.toFixed(3)} (market implies ${(currentPrice * 100).toFixed(0)}% probability)\n\n` +
        `EV = (your_estimated_P_YES × $1.00) − current_price_of_${outcome}\n` +
        `Only trade if EV ≥ ${MIN_EV} AND you are at least MEDIUM confidence.\n` +
        `Anti-fake-news: if the news refutes/denies/is unverified, do NOT recommend trading.\n\n` +
        `Return ONLY valid JSON:\n` +
        `{"ai_prob_yes":0.0-1.0,"recommended":"YES"/"NO"/"HOLD","target_entry":0.01-0.99,"ev":float,"confidence":"HIGH"/"MEDIUM"/"LOW","reasoning":"one sentence"}`,
    }],
  });

  const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
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

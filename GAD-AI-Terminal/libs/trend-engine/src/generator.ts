import Anthropic from '@anthropic-ai/sdk';
import { TrendCluster, CoinIdea } from './types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateCoinIdeas(cluster: TrendCluster, count = 3): Promise<CoinIdea[]> {
  if (cluster.risk_score >= 60) {
    return [{
      ticker: 'N/A',
      name: 'Blocked',
      description: 'Topic blocked — high risk score (tragedy/harm/sensitive content).',
      meme_angle: '',
      logo_prompt: '',
      twitter_posts: [],
      risk_notes: `Risk score: ${cluster.risk_score}/100 — blocked by safety filter`,
      score: 0,
    }];
  }

  const prompt = `You are a creative Solana memecoin strategist.

TREND EVENT: "${cluster.main_title}"
Summary: ${cluster.summary || '(no summary)'}
Key entities: ${cluster.entities.join(', ') || '(none)'}
Keywords: ${cluster.keywords.join(', ')}
Sources: ${cluster.sources.join(', ')}
Total mentions: ${cluster.total_mentions}
Trend score: ${cluster.trend_score.toFixed(0)}/100
Meme score: ${cluster.meme_score.toFixed(0)}/100

Generate exactly ${count} memecoin concepts for pump.fun launch based on this trend.

Rules:
- ticker: 3-6 chars, ALL CAPS, memorable, relevant to the event
- name: short, punchy (max 20 chars)
- description: max 240 chars, no "moon guaranteed", no "100x guaranteed", no financial promises
- meme_angle: what makes this funny/viral in ONE sentence
- logo_prompt: DALL-E prompt for logo image (simple, bold, iconic)
- twitter_posts: array of 3 tweet texts (max 280 chars each), no financial promises
- risk_notes: any concerns about this concept
- score: 0-100 your confidence this meme will resonate

Respond ONLY with valid JSON array, no markdown:
[
  {
    "ticker": "...",
    "name": "...",
    "description": "...",
    "meme_angle": "...",
    "logo_prompt": "...",
    "twitter_posts": ["...", "...", "..."],
    "risk_notes": "...",
    "score": 0
  }
]`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');

    const ideas: any[] = JSON.parse(jsonMatch[0]);
    return ideas.map(idea => ({
      trend_cluster_id: cluster.id,
      ticker:        idea.ticker        ?? 'GEM',
      name:          idea.name          ?? 'Gem',
      description:   idea.description   ?? '',
      meme_angle:    idea.meme_angle    ?? '',
      logo_prompt:   idea.logo_prompt   ?? '',
      twitter_posts: idea.twitter_posts ?? [],
      risk_notes:    idea.risk_notes    ?? '',
      score:         Number(idea.score  ?? 0),
    }));
  } catch (e: any) {
    console.error('[trend-engine] generateCoinIdeas error:', e.message?.slice(0, 100));
    return [];
  }
}

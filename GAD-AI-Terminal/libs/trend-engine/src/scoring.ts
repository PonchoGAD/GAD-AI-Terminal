import { TrendItem, TrendCluster, TrendScore, MemeScore } from './types';

// Keywords that INCREASE risk score — block or heavily penalize
const HIGH_RISK_KEYWORDS = [
  'death', 'died', 'killed', 'murder', 'tragedy', 'disaster', 'earthquake',
  'hurricane', 'flood', 'terror', 'attack', 'bombing', 'shooting', 'war',
  'genocide', 'rape', 'abuse', 'child', 'minor', 'cancer', 'disease', 'pandemic',
  'suicide', 'overdose', 'hostage', 'refugee', 'starvation',
];

// Keywords that signal HIGH meme potential
const HIGH_MEME_KEYWORDS = [
  'elon', 'musk', 'trump', 'ai', 'robot', 'viral', 'meme', 'moon',
  'space', 'nasa', 'dog', 'cat', 'pepe', 'chad', 'based', 'giga',
  'trillion', 'billion', 'first', 'record', 'fastest', 'biggest',
  'crypto', 'solana', 'bitcoin', 'doge',
];

export function scoreTrendItem(item: TrendItem): number {
  const ageMs = Date.now() - item.published_at.getTime();
  const ageH  = ageMs / 3_600_000;
  if (ageH > 24) return 0;

  const recency = ageH < 1 ? 30 : ageH < 3 ? 25 : ageH < 6 ? 20 : ageH < 12 ? 12 : 5;

  const totalEng = (item.engagement.likes ?? 0)
    + (item.engagement.reposts ?? 0) * 2
    + (item.engagement.comments ?? 0) * 1.5
    + (item.engagement.views ?? 0) * 0.01
    + (item.engagement.upvotes ?? 0) * 1.2;

  const engagement = totalEng > 100000 ? 20 : totalEng > 10000 ? 15 : totalEng > 1000 ? 10 : totalEng > 100 ? 5 : 0;

  return recency + engagement;
}

export function calcTrendScore(items: TrendItem[]): TrendScore {
  if (!items.length) return { recency_score: 0, velocity_score: 0, engagement_score: 0, source_diversity: 0, entity_power: 0, total: 0 };

  const now = Date.now();
  const latest = Math.min(...items.map(i => now - i.published_at.getTime()));
  const latestH = latest / 3_600_000;

  const recency_score = latestH < 0.5 ? 30 : latestH < 1 ? 25 : latestH < 3 ? 20 : latestH < 6 ? 12 : 5;

  const mentionCount = items.length;
  const velocity_score = mentionCount >= 10 ? 25 : mentionCount >= 5 ? 18 : mentionCount >= 3 ? 12 : mentionCount >= 2 ? 6 : 0;

  const totalEng = items.reduce((sum, i) =>
    sum + (i.engagement.likes ?? 0) + (i.engagement.reposts ?? 0) * 2 + (i.engagement.upvotes ?? 0), 0
  );
  const engagement_score = totalEng > 50000 ? 20 : totalEng > 10000 ? 15 : totalEng > 1000 ? 10 : totalEng > 100 ? 5 : 0;

  const uniqueSources = new Set(items.map(i => i.source)).size;
  const source_diversity = uniqueSources >= 3 ? 15 : uniqueSources === 2 ? 10 : 3;

  const allEntities = items.flatMap(i => i.entities);
  const highPowerEntities = allEntities.filter(e =>
    HIGH_MEME_KEYWORDS.some(k => e.toLowerCase().includes(k))
  ).length;
  const entity_power = highPowerEntities >= 3 ? 10 : highPowerEntities >= 2 ? 7 : highPowerEntities >= 1 ? 4 : 0;

  const total = recency_score + velocity_score + engagement_score + source_diversity + entity_power;

  return { recency_score, velocity_score, engagement_score, source_diversity, entity_power, total };
}

export function calcMemeScore(cluster: Pick<TrendCluster, 'main_title' | 'keywords' | 'entities'>): MemeScore {
  const title = cluster.main_title.toLowerCase();
  const words = title.split(/\s+/);

  const simplicity = words.length <= 5 ? 25 : words.length <= 8 ? 18 : words.length <= 12 ? 10 : 3;

  const knownMemeEntity = cluster.entities.some(e =>
    HIGH_MEME_KEYWORDS.some(k => e.toLowerCase().includes(k))
  ) || HIGH_MEME_KEYWORDS.some(k => title.includes(k));
  const recognizability = knownMemeEntity ? 25 : 5;

  const tickerWords = words.filter(w => w.length >= 2 && w.length <= 6 && /^[a-z]+$/.test(w));
  const ticker_potential = tickerWords.length >= 1 ? 20 : 5;

  const humorWords = ['vs', 'wins', 'beats', 'breaks', 'first', 'record', 'never', 'always', 'literally'];
  const humor_potential = humorWords.some(h => title.includes(h)) ? 20 : 8;

  const visualWords = ['space', 'rocket', 'dog', 'cat', 'robot', 'fire', 'crown', 'money', 'doge', 'pepe'];
  const visual_potential = visualWords.some(v => title.includes(v)) ? 10 : 3;

  const total = simplicity + recognizability + ticker_potential + humor_potential + visual_potential;
  return { simplicity, recognizability, ticker_potential, humor_potential, visual_potential, total };
}

export function calcRiskScore(title: string): number {
  const t = title.toLowerCase();
  let risk = 0;
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (t.includes(kw)) risk += 15;
  }
  return Math.min(risk, 100);
}

export function calcFinalScore(trend_score: number, meme_score: number, risk_score: number): number {
  return Math.max(0, trend_score * 0.55 + meme_score * 0.35 - risk_score * 0.10);
}

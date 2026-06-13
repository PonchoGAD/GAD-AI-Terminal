import { TrendItem, TrendCluster } from './types';
import { calcTrendScore, calcMemeScore, calcRiskScore, calcFinalScore } from './scoring';

// Simple similarity: keyword overlap ratio
function similarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// Deduplicate items by URL and title similarity
export function deduplicate(items: TrendItem[]): TrendItem[] {
  const seen = new Set<string>();
  const result: TrendItem[] = [];

  for (const item of items) {
    if (item.url && seen.has(item.url)) continue;
    if (item.url) seen.add(item.url);

    const isDuplicate = result.some(existing =>
      similarity(existing.title, item.title) > 0.6
    );
    if (!isDuplicate) result.push(item);
  }

  return result;
}

// Group items into clusters by title similarity
export function cluster(items: TrendItem[]): TrendCluster[] {
  const clusters: { items: TrendItem[]; representative: TrendItem }[] = [];

  for (const item of items) {
    let matched = false;
    for (const c of clusters) {
      if (similarity(c.representative.title, item.title) > 0.35) {
        c.items.push(item);
        // Update representative to most recent
        if (item.published_at > c.representative.published_at) {
          c.representative = item;
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({ items: [item], representative: item });
    }
  }

  return clusters.map(c => {
    const allEntities = [...new Set(c.items.flatMap(i => i.entities))];
    const allSources  = [...new Set(c.items.map(i => i.source))];

    const keywords = extractKeywords(c.representative.title);

    const trendScore = calcTrendScore(c.items);
    const memeScore  = calcMemeScore({ main_title: c.representative.title, keywords, entities: allEntities });
    const riskScore  = calcRiskScore(c.representative.title);
    const finalScore = calcFinalScore(trendScore.total, memeScore.total, riskScore);

    const times = c.items.map(i => i.published_at.getTime());
    const totalEng = c.items.reduce((sum, i) =>
      sum + (i.engagement.likes ?? 0) + (i.engagement.reposts ?? 0) + (i.engagement.upvotes ?? 0), 0
    );

    return {
      main_title:       c.representative.title,
      summary:          c.representative.summary ?? '',
      keywords,
      entities:         allEntities.slice(0, 8),
      sources:          allSources,
      first_seen_at:    new Date(Math.min(...times)),
      last_seen_at:     new Date(Math.max(...times)),
      total_mentions:   c.items.length,
      total_engagement: totalEng,
      trend_score:      trendScore.total,
      meme_score:       memeScore.total,
      risk_score:       riskScore,
      final_score:      finalScore,
    } as TrendCluster;
  });
}

function extractKeywords(title: string): string[] {
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'has', 'have',
    'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'as', 'and', 'or', 'but', 'not',
    'it', 'its', 'this', 'that', 'from', 'into', 'be', 'been', 'being']);
  return title.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w))
    .slice(0, 8);
}

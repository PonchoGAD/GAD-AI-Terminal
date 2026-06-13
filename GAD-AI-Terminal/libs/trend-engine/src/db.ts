import { query } from '@lib/db';
import { TrendItem, TrendCluster, CoinIdea } from './types';

export async function saveTrendItems(items: TrendItem[]): Promise<void> {
  for (const item of items) {
    try {
      await query(
        `INSERT INTO trend_items (source, title, summary, url, author, published_at, language, engagement, entities, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          item.source, item.title, item.summary ?? '', item.url ?? '',
          item.author ?? '', item.published_at,
          item.language, JSON.stringify(item.engagement),
          JSON.stringify(item.entities), JSON.stringify(item.raw),
        ]
      );
    } catch { /* skip duplicates */ }
  }
}

export async function saveTrendCluster(cluster: TrendCluster): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO trend_clusters
       (main_title, summary, keywords, entities, sources, first_seen_at, last_seen_at,
        total_mentions, total_engagement, trend_score, meme_score, risk_score, final_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      cluster.main_title, cluster.summary ?? '',
      JSON.stringify(cluster.keywords), JSON.stringify(cluster.entities),
      JSON.stringify(cluster.sources), cluster.first_seen_at, cluster.last_seen_at,
      cluster.total_mentions, cluster.total_engagement,
      cluster.trend_score, cluster.meme_score, cluster.risk_score, cluster.final_score,
    ]
  );
  return res.rows[0].id;
}

export async function saveCoinIdea(idea: CoinIdea): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO coin_ideas
       (trend_cluster_id, ticker, name, description, meme_angle, logo_prompt, twitter_posts, risk_notes, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      idea.trend_cluster_id ?? null, idea.ticker, idea.name,
      idea.description, idea.meme_angle, idea.logo_prompt,
      JSON.stringify(idea.twitter_posts), idea.risk_notes, idea.score,
    ]
  );
  return res.rows[0].id;
}

export async function getTopClusters(limit = 10): Promise<TrendCluster[]> {
  const res = await query<any>(
    `SELECT * FROM trend_clusters
     WHERE status = 'active' AND last_seen_at > now() - interval '24 hours'
     ORDER BY final_score DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map(r => ({
    id: r.id,
    main_title: r.main_title,
    summary: r.summary,
    keywords: r.keywords ?? [],
    entities: r.entities ?? [],
    sources: r.sources ?? [],
    first_seen_at: new Date(r.first_seen_at),
    last_seen_at: new Date(r.last_seen_at),
    total_mentions: r.total_mentions,
    total_engagement: r.total_engagement,
    trend_score: parseFloat(r.trend_score),
    meme_score: parseFloat(r.meme_score),
    risk_score: parseFloat(r.risk_score),
    final_score: parseFloat(r.final_score),
  }));
}

export async function getClusterById(id: string): Promise<TrendCluster | null> {
  const res = await query<any>(`SELECT * FROM trend_clusters WHERE id = $1`, [id]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    main_title: r.main_title,
    summary: r.summary,
    keywords: r.keywords ?? [],
    entities: r.entities ?? [],
    sources: r.sources ?? [],
    first_seen_at: new Date(r.first_seen_at),
    last_seen_at: new Date(r.last_seen_at),
    total_mentions: r.total_mentions,
    total_engagement: r.total_engagement,
    trend_score: parseFloat(r.trend_score),
    meme_score: parseFloat(r.meme_score),
    risk_score: parseFloat(r.risk_score),
    final_score: parseFloat(r.final_score),
  };
}

export async function getIdeasForCluster(clusterId: string): Promise<CoinIdea[]> {
  const res = await query<any>(
    `SELECT * FROM coin_ideas WHERE trend_cluster_id = $1 AND status != 'rejected' ORDER BY score DESC`,
    [clusterId]
  );
  return res.rows.map(r => ({
    id: r.id,
    trend_cluster_id: r.trend_cluster_id,
    ticker: r.ticker,
    name: r.name,
    description: r.description,
    meme_angle: r.meme_angle,
    logo_prompt: r.logo_prompt,
    twitter_posts: r.twitter_posts ?? [],
    risk_notes: r.risk_notes,
    score: parseFloat(r.score),
  }));
}

export async function updateIdeaStatus(id: string, status: 'approved' | 'rejected'): Promise<void> {
  await query(`UPDATE coin_ideas SET status = $1, updated_at = now() WHERE id = $2`, [status, id]);
}

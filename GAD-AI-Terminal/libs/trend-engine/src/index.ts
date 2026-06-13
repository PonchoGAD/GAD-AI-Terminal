export * from './types';
export * from './scoring';
export * from './aggregator';
export * from './generator';
export * from './db';
export { fetchGdelt } from './sources/gdelt';
export { fetchGoogleNews } from './sources/google-news';

import { fetchGdelt } from './sources/gdelt';
import { fetchGoogleNews } from './sources/google-news';
import { deduplicate, cluster } from './aggregator';
import { saveTrendItems, saveTrendCluster, saveCoinIdea, getTopClusters } from './db';
import { generateCoinIdeas } from './generator';
import { TrendCluster } from './types';

// Run one full trend engine cycle:
// 1. Fetch from all sources
// 2. Deduplicate + cluster
// 3. Score and persist
// 4. Generate AI ideas for top clusters
// 5. Return top clusters
export async function runTrendCycle(generateIdeas = false): Promise<TrendCluster[]> {
  console.info('[trend-engine] Starting cycle...');

  const [gdelt, gnews] = await Promise.allSettled([
    fetchGdelt(),
    fetchGoogleNews(),
  ]);

  const items = [
    ...(gdelt.status === 'fulfilled' ? gdelt.value : []),
    ...(gnews.status === 'fulfilled' ? gnews.value : []),
  ];

  console.info(`[trend-engine] Fetched ${items.length} raw items`);
  if (!items.length) return getTopClusters();

  const unique   = deduplicate(items);
  const clusters = cluster(unique);
  console.info(`[trend-engine] ${unique.length} unique → ${clusters.length} clusters`);

  await saveTrendItems(unique);

  const topClusters = clusters
    .filter(c => c.final_score >= 20 && c.risk_score < 60)
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, 15);

  for (const c of topClusters) {
    const clusterId = await saveTrendCluster(c);
    c.id = clusterId;

    if (generateIdeas && c.final_score >= 50) {
      const ideas = await generateCoinIdeas(c, 3);
      for (const idea of ideas) {
        idea.trend_cluster_id = clusterId;
        await saveCoinIdea(idea);
      }
      console.info(`[trend-engine] Generated ${ideas.length} ideas for cluster: ${c.main_title.slice(0, 50)}`);
    }
  }

  console.info(`[trend-engine] Cycle complete. Top score: ${topClusters[0]?.final_score?.toFixed(1) ?? 'n/a'}`);
  return topClusters;
}

export interface TrendItem {
  source: 'gdelt' | 'google_news' | 'reddit' | 'x' | 'newsapi';
  title: string;
  summary?: string;
  url?: string;
  author?: string;
  published_at: Date;
  language: string;
  engagement: { likes: number; reposts: number; comments: number; views: number; upvotes?: number; };
  entities: string[];
  raw: Record<string, unknown>;
}

export interface TrendCluster {
  id?: string;
  main_title: string;
  summary?: string;
  keywords: string[];
  entities: string[];
  sources: string[];
  first_seen_at: Date;
  last_seen_at: Date;
  total_mentions: number;
  total_engagement: number;
  trend_score: number;
  meme_score: number;
  risk_score: number;
  final_score: number;
}

export interface CoinIdea {
  id?: string;
  trend_cluster_id?: string;
  ticker: string;
  name: string;
  description: string;
  meme_angle: string;
  logo_prompt: string;
  twitter_posts: string[];
  risk_notes: string;
  score: number;
}

export interface TrendScore {
  recency_score: number;
  velocity_score: number;
  engagement_score: number;
  source_diversity: number;
  entity_power: number;
  total: number;
}

export interface MemeScore {
  simplicity: number;
  recognizability: number;
  ticker_potential: number;
  humor_potential: number;
  visual_potential: number;
  total: number;
}

export declare function runTrendCycle(): Promise<void>;
export declare function getTopClusters(limit?: number): Promise<TrendCluster[]>;
export declare function getClusterById(id: string): Promise<TrendCluster | null>;
export declare function getIdeasForCluster(clusterId: string): Promise<CoinIdea[]>;
export declare function generateCoinIdeas(cluster: TrendCluster, count?: number): Promise<CoinIdea[]>;
export declare function saveCoinIdea(idea: CoinIdea): Promise<string>;
export declare function updateIdeaStatus(id: string, status: 'approved' | 'rejected'): Promise<void>;
export declare function saveTrendItems(items: TrendItem[]): Promise<void>;
export declare function saveTrendCluster(cluster: TrendCluster): Promise<string>;
export declare function deduplicate(items: TrendItem[]): TrendItem[];
export declare function cluster(items: TrendItem[]): TrendCluster[];
export declare function fetchGdelt(): Promise<TrendItem[]>;
export declare function fetchGoogleNews(): Promise<TrendItem[]>;

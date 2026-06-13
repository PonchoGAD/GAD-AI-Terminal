export interface TrendItem {
  source: 'gdelt' | 'google_news' | 'reddit' | 'x' | 'newsapi';
  title: string;
  summary?: string;
  url?: string;
  author?: string;
  published_at: Date;
  language: string;
  engagement: {
    likes: number;
    reposts: number;
    comments: number;
    views: number;
    upvotes?: number;
  };
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
  recency_score: number;     // 0-30
  velocity_score: number;    // 0-25
  engagement_score: number;  // 0-20
  source_diversity: number;  // 0-15
  entity_power: number;      // 0-10
  total: number;             // 0-100
}

export interface MemeScore {
  simplicity: number;        // 0-25
  recognizability: number;   // 0-25
  ticker_potential: number;  // 0-20
  humor_potential: number;   // 0-20
  visual_potential: number;  // 0-10
  total: number;             // 0-100
}

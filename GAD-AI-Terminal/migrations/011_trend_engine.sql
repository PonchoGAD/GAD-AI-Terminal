-- Trend-to-MemeCoin Engine tables
-- Phase 1: trend discovery, clustering, coin idea generation

CREATE TABLE IF NOT EXISTS trend_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source       TEXT NOT NULL,            -- gdelt | google_news | reddit | x
  title        TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  author       TEXT,
  published_at TIMESTAMPTZ,
  language     TEXT DEFAULT 'en',
  engagement   JSONB DEFAULT '{}',       -- {likes, reposts, comments, views}
  entities     JSONB DEFAULT '[]',       -- ["Elon Musk", "Tesla"]
  raw          JSONB DEFAULT '{}',
  cluster_id   UUID,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trend_items_source_idx ON trend_items(source);
CREATE INDEX IF NOT EXISTS trend_items_published_at_idx ON trend_items(published_at DESC);
CREATE INDEX IF NOT EXISTS trend_items_cluster_id_idx ON trend_items(cluster_id);

CREATE TABLE IF NOT EXISTS trend_clusters (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  main_title       TEXT NOT NULL,
  summary          TEXT,
  keywords         JSONB DEFAULT '[]',
  entities         JSONB DEFAULT '[]',
  sources          JSONB DEFAULT '[]',   -- ["gdelt", "google_news"]
  first_seen_at    TIMESTAMPTZ DEFAULT now(),
  last_seen_at     TIMESTAMPTZ DEFAULT now(),
  total_mentions   INTEGER DEFAULT 1,
  total_engagement BIGINT DEFAULT 0,
  trend_score      NUMERIC(5,2) DEFAULT 0,
  meme_score       NUMERIC(5,2) DEFAULT 0,
  risk_score       NUMERIC(5,2) DEFAULT 0,
  final_score      NUMERIC(5,2) DEFAULT 0,
  status           TEXT DEFAULT 'active', -- active | archived | banned
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trend_clusters_final_score_idx ON trend_clusters(final_score DESC);
CREATE INDEX IF NOT EXISTS trend_clusters_last_seen_idx ON trend_clusters(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS trend_clusters_status_idx ON trend_clusters(status);

CREATE TABLE IF NOT EXISTS coin_ideas (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trend_cluster_id UUID REFERENCES trend_clusters(id),
  ticker           TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  meme_angle       TEXT,
  logo_prompt      TEXT,
  twitter_posts    JSONB DEFAULT '[]',
  risk_notes       TEXT,
  score            NUMERIC(5,2) DEFAULT 0,
  status           TEXT DEFAULT 'pending', -- pending | approved | rejected | launched
  approved_by      TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coin_ideas_cluster_idx ON coin_ideas(trend_cluster_id);
CREATE INDEX IF NOT EXISTS coin_ideas_status_idx ON coin_ideas(status);
CREATE INDEX IF NOT EXISTS coin_ideas_score_idx ON coin_ideas(score DESC);

-- Migration 023: raw_alpha_feeds table for Free Alpha Aggregator
-- Sources: Reddit JSON API, DexScreener Token Profiles, Telegram web mirrors
-- Local keyword classifier first; Claude only for AI_AGENT + POLITICS narratives

CREATE TABLE IF NOT EXISTS raw_alpha_feeds (
  id              SERIAL PRIMARY KEY,
  source          VARCHAR(50)  NOT NULL,       -- reddit | dexscreener_profile | telegram_web | rss
  source_id       VARCHAR(200),                -- dedup key (reddit post id, token address, etc.)
  title           TEXT,
  body            TEXT,
  narrative       VARCHAR(50)  DEFAULT 'GENERAL', -- AI_AGENT | POLITICS | DOG | CAT | PEPE | ELON | FOOD | SPORTS | ANIME | GENERAL
  mentioned_mints TEXT[]       DEFAULT '{}',
  mentioned_symbols TEXT[]     DEFAULT '{}',
  engagement      INTEGER      DEFAULT 0,
  score           FLOAT        DEFAULT 0,
  processed       BOOLEAN      DEFAULT FALSE,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_alpha_source_id
  ON raw_alpha_feeds (source, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_alpha_narrative ON raw_alpha_feeds (narrative);
CREATE INDEX IF NOT EXISTS idx_raw_alpha_created   ON raw_alpha_feeds (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_alpha_score      ON raw_alpha_feeds (score DESC) WHERE score > 50;

-- Auto-cleanup: keep only last 7 days
CREATE OR REPLACE FUNCTION cleanup_old_alpha_feeds() RETURNS void AS $$
BEGIN
  DELETE FROM raw_alpha_feeds WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

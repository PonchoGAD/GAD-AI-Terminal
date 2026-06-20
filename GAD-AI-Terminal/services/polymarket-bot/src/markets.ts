import axios from 'axios';
import { query } from '@lib/db';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';

export interface Market {
  id:          string;
  title:       string;
  category:    string;
  volumeUsd:   number;
  endsAt:      Date;
  tokenIdYes:  string;
  tokenIdNo:   string;
  priceYes:    number;
  priceNo:     number;
}

export async function fetchActiveMarkets(minVolume = 50000): Promise<Market[]> {
  try {
    const { data } = await axios.get(`${GAMMA_API}/markets`, {
      params: { active: true, closed: false, limit: 200, _ts: Date.now() },
      timeout: 20000,
    });

    const markets: Market[] = [];
    for (const m of (data ?? [])) {
      if (!Array.isArray(m.clobTokenIds) || m.clobTokenIds.length < 2) continue;
      const vol = Number(m.volume ?? m.volumeClob ?? 0);
      if (vol < minVolume) continue;

      const endsAt = new Date(m.endDate ?? Date.now() + 86400000 * 7);
      // Skip markets ending within 2 hours
      if (endsAt.getTime() < Date.now() + 7200000) continue;

      markets.push({
        id:         m.conditionId ?? m.id,
        title:      (m.question ?? m.title ?? '').slice(0, 500),
        category:   (m.category ?? 'general').toLowerCase(),
        volumeUsd:  vol,
        endsAt,
        tokenIdYes: m.clobTokenIds[0],
        tokenIdNo:  m.clobTokenIds[1],
        priceYes:   Number(m.outcomePrices?.[0] ?? 0.5),
        priceNo:    Number(m.outcomePrices?.[1] ?? 0.5),
      });
    }
    return markets;
  } catch (e: any) {
    console.error('[poly-markets] fetchActiveMarkets error:', e.message);
    return [];
  }
}

export async function syncMarketsToDb(markets: Market[]): Promise<void> {
  for (const m of markets) {
    await query(
      `INSERT INTO polymarket_markets
         (market_id, title, category, volume_usd, token_id_yes, token_id_no, ends_at, price_yes, price_no, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (market_id) DO UPDATE SET
         title=EXCLUDED.title, volume_usd=EXCLUDED.volume_usd,
         price_yes=EXCLUDED.price_yes, price_no=EXCLUDED.price_no,
         ends_at=EXCLUDED.ends_at, updated_at=NOW()`,
      [m.id, m.title, m.category, m.volumeUsd, m.tokenIdYes, m.tokenIdNo, m.endsAt, m.priceYes, m.priceNo]
    );
  }
}

export async function getMarketsFromDb(minVolume = 50000): Promise<Market[]> {
  const { rows } = await query<any>(
    `SELECT market_id AS id, title, category,
            volume_usd::float AS "volumeUsd",
            token_id_yes AS "tokenIdYes", token_id_no AS "tokenIdNo",
            ends_at AS "endsAt",
            price_yes::float AS "priceYes", price_no::float AS "priceNo"
     FROM polymarket_markets
     WHERE volume_usd >= $1 AND ends_at > NOW() + INTERVAL '2 hours' AND is_active=true
     ORDER BY volume_usd DESC LIMIT 200`,
    [minVolume]
  );
  return rows;
}

// No auth needed for mid-point reads
export async function getMidPrice(tokenId: string): Promise<number> {
  try {
    const { data } = await axios.get(`${CLOB_API}/mid-point`, {
      params: { token_id: tokenId },
      timeout: 5000,
    });
    return Number(data?.mid ?? 0);
  } catch { return 0; }
}

// Check for price momentum: YES price trending upward over last N cached values
// Returns percent change since first data point
export async function getPriceMomentum(marketId: string): Promise<{ pctChange: number; direction: 'UP' | 'DOWN' | 'FLAT' }> {
  const { rows } = await query<{ price_yes: string }>(
    `SELECT price_yes FROM polymarket_markets WHERE market_id=$1`, [marketId]
  );
  if (!rows.length) return { pctChange: 0, direction: 'FLAT' };
  const current = Number(rows[0].price_yes);
  return { pctChange: 0, direction: 'FLAT' }; // single-point, no history yet
}
